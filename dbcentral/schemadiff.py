"""Schema compare and synchronization for MySQL / MariaDB (like Workbench's "Compare Schemas" / "Synchronize").

The source schema is the model ("make the target look like this"); the target schema is the one changed.
Objects are compared using the server's own SHOW CREATE output, which is canonical and line-oriented,
so a table can be split into columns, indexes, foreign keys, checks and options and diffed piece by piece.
"""
import re
import threading
import time

import pymysql

from .drivers import DBError

# Phases of the sync script. Statements are ordered by phase, then by object.
P_DROP_FK, P_DROP_TRIGGER, P_DROP_VIEW, P_DROP_ROUTINE, P_DROP_TABLE = 10, 20, 30, 40, 50
P_CREATE_TABLE, P_ALTER_TABLE, P_ADD_FK = 60, 70, 80
P_CREATE_ROUTINE, P_CREATE_VIEW, P_CREATE_TRIGGER = 90, 100, 110

DEFINER_RE = re.compile(r"\s*DEFINER\s*=\s*(`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s@]+)@(`(?:[^`]|``)*`|'(?:[^']|'')*'|\S+)", re.I)
INT_WIDTH_RE = re.compile(r"\b(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)", re.I)
AUTO_INC_RE = re.compile(r"\s+AUTO_INCREMENT=\d+")
OPTION_RE = re.compile(r"((?:DEFAULT )?[A-Z_]+)=('(?:[^'\\]|\\.|'')*'|\S+)")
IDENT = r"`(?:[^`]|``)+`"


def _name_of(line):
    m = re.match(r"\s*(?:CONSTRAINT\s+)?(" + IDENT + ")", line)
    return m.group(1)[1:-1].replace("``", "`") if m else None


def parse_table(ddl):
    """Split SHOW CREATE TABLE output into its parts."""
    lines = ddl.split("\n")
    body, tail = [], []
    i = 1
    while i < len(lines) and not lines[i].startswith(")"):
        body.append(lines[i].rstrip().rstrip(","))
        i += 1
    tail = lines[i:]
    t = {"columns": [], "coldefs": {}, "indexes": {}, "fks": {}, "checks": {}, "options": {}, "partition": ""}
    for ln in body:
        s = ln.strip()
        if s.startswith("`"):
            name = _name_of(s)
            t["columns"].append(name)
            t["coldefs"][name] = s
        elif s.startswith("PRIMARY KEY"):
            t["indexes"]["PRIMARY"] = s
        elif re.match(r"(UNIQUE |FULLTEXT |SPATIAL |VECTOR )?(KEY|INDEX) ", s):
            t["indexes"][_index_name(s)] = s
        elif s.startswith("CONSTRAINT"):
            name = _name_of(s)
            (t["fks"] if " FOREIGN KEY " in s else t["checks"])[name] = s
        elif s.startswith("CHECK"):
            t["checks"][s] = s
    if tail:
        head = tail[0][1:].strip()
        t["options"] = {k.upper(): v for k, v in OPTION_RE.findall(head) if k.upper() != "AUTO_INCREMENT"}
        t["partition"] = "\n".join(tail[1:]).strip()
    return t


def _index_name(line):
    """Name of an index from its SHOW CREATE line (PRIMARY for the primary key)."""
    if line.startswith("PRIMARY KEY"):
        return "PRIMARY"
    m = re.search(r"(?:KEY|INDEX)\s+(" + IDENT + ")", line)
    return m.group(1)[1:-1].replace("``", "`") if m else line


class Snapshot:
    def __init__(self, schema):
        self.schema = schema
        self.tables, self.views, self.routines, self.triggers = {}, {}, {}, {}
        self.warnings = []
        self.is_mariadb = False
        self.server = ""


def snapshot(driver, schema):
    """Read every table, view, routine and trigger definition of a schema (on its own connection)."""
    snap = Snapshot(schema)
    snap.is_mariadb = driver.is_mariadb
    snap.server = driver.server_version
    conn = driver._new_conn(None)
    q = driver.quote_ident

    def rows(sql, args=None):
        with conn.cursor(pymysql.cursors.DictCursor) as c:
            c.execute(sql, args)
            return list(c.fetchall())

    try:
        objs = rows("SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES "
                    "WHERE TABLE_SCHEMA=%s ORDER BY TABLE_NAME", (schema,))
        for o in objs:
            name = o["name"]
            try:
                if o["type"] == "VIEW":
                    r = rows(f"SHOW CREATE VIEW {q(schema)}.{q(name)}")
                    ddl = r[0].get("Create View") if r else None
                    if ddl:
                        snap.views[name] = ddl
                    else:
                        snap.warnings.append(f"No privilege to read the definition of view {name}.")
                elif o["type"] in ("BASE TABLE", "SYSTEM VERSIONED"):
                    r = rows(f"SHOW CREATE TABLE {q(schema)}.{q(name)}")
                    snap.tables[name] = r[0]["Create Table"]
                else:
                    snap.warnings.append(f"{o['type'].title()} {name} is not compared.")
            except pymysql.err.Error as e:
                snap.warnings.append(f"{name}: {e.args[-1]}")
        for r in rows("SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES "
                      "WHERE ROUTINE_SCHEMA=%s ORDER BY ROUTINE_TYPE, ROUTINE_NAME", (schema,)):
            kind = r["type"].lower()
            if kind not in ("procedure", "function"):
                continue
            try:
                rr = rows(f"SHOW CREATE {r['type']} {q(schema)}.{q(r['name'])}")
                ddl = rr[0].get(f"Create {r['type'].title()}") if rr else None
            except pymysql.err.Error as e:
                snap.warnings.append(f"{r['name']}: {e.args[-1]}")
                continue
            if ddl:
                snap.routines[(kind, r["name"])] = ddl
            else:
                snap.warnings.append(f"No privilege to read the definition of {kind} {r['name']}.")
        for r in rows("SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS tbl, "
                      "ACTION_TIMING AS timing, ACTION_STATEMENT AS stmt, ACTION_ORDER AS ord, DEFINER AS definer "
                      "FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=%s "
                      "ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER", (schema,)):
            snap.triggers[r["name"]] = r
    except pymysql.err.Error as e:
        raise DBError(f"Could not read schema {schema}: {e.args[-1]}") from None
    finally:
        conn.close()
    return snap


# ---------------------------------------------------------------------------- normalization
class Ctx:
    def __init__(self, src, tgt, opts, quote):
        self.src, self.tgt = src, tgt
        self.opts = opts
        self.q = quote
        self.T = quote(tgt.schema)
        self.mariadb_target = tgt.is_mariadb

    def norm(self, text, schema):
        """Comparable form of a definition: schema name neutralized, optional parts removed."""
        s = text.replace(f"{self.q(schema)}.", "`<schema>`.")
        if self.opts.get("ignore_definer", True):
            s = DEFINER_RE.sub("", s)
        if self.opts.get("ignore_int_width", True):
            s = INT_WIDTH_RE.sub(r"\1", s)
        return s

    def retarget(self, text):
        """Definition text from the source, adjusted to live in the target schema."""
        s = text.replace(f"{self.q(self.src.schema)}.", f"{self.T}.")
        if not self.opts.get("keep_definer", False):
            s = DEFINER_RE.sub("", s)
        return s

    def qn(self, name):
        return f"{self.T}.{self.q(name)}"

    def qualify_refs(self, line):
        """REFERENCES `t` (...) -> REFERENCES `target`.`t` (...) for same-schema foreign keys."""
        return re.sub(r"REFERENCES (" + IDENT + r") \(", lambda m: f"REFERENCES {self.T}.{m.group(1)} (", line)


def _item(kind, name, status, src=None, tgt=None):
    return {"id": f"{kind}:{name}", "type": kind, "name": name, "status": status,
            "source_ddl": src or "", "target_ddl": tgt or "", "statements": [], "warnings": [], "destructive": False}


# ---------------------------------------------------------------------------- tables
def diff_table(ctx, name, src_ddl, tgt_ddl):
    q = ctx.q
    item = _item("table", name, "same", src_ddl, tgt_ddl)
    if tgt_ddl is None:
        item["status"] = "create"
        body = ctx.retarget(src_ddl)
        body = re.sub(r"^CREATE TABLE " + IDENT, f"CREATE TABLE {ctx.qn(name)}", body, count=1)
        body = AUTO_INC_RE.sub("", body)
        body = "\n".join(ctx.qualify_refs(ln) if ln.strip().startswith("CONSTRAINT") else ln for ln in body.split("\n"))
        item["statements"].append((P_CREATE_TABLE, body))
        return item
    if src_ddl is None:
        item["status"] = "drop"
        item["destructive"] = True
        item["statements"].append((P_DROP_TABLE, f"DROP TABLE {ctx.qn(name)}"))
        return item

    s, t = parse_table(src_ddl), parse_table(tgt_ddl)
    ns = lambda x: ctx.norm(x, ctx.src.schema)  # noqa: E731
    nt = lambda x: ctx.norm(x, ctx.tgt.schema)  # noqa: E731
    pre, clauses, post = [], [], []

    # foreign keys: dropped first (phase 1), added last
    for fk, line in t["fks"].items():
        if fk not in s["fks"] or ns(s["fks"][fk]) != nt(line):
            pre.append(f"DROP FOREIGN KEY {q(fk)}")
    for fk, line in s["fks"].items():
        if fk not in t["fks"] or ns(line) != nt(t["fks"][fk]):
            post.append("ADD " + ctx.qualify_refs(ctx.retarget(line)))

    # checks
    drop_check = "DROP CONSTRAINT" if ctx.mariadb_target else "DROP CHECK"
    for ck, line in t["checks"].items():
        if ck not in s["checks"] or ns(s["checks"][ck]) != nt(line):
            clauses.append(f"{drop_check} {q(ck)}" if line.startswith("CONSTRAINT") else None)
    # indexes (drop before columns change)
    for ix, line in t["indexes"].items():
        if ix not in s["indexes"] or ns(s["indexes"][ix]) != nt(line):
            clauses.append("DROP PRIMARY KEY" if ix == "PRIMARY" else f"DROP INDEX {q(ix)}")

    # columns
    for c in t["columns"]:
        if c not in s["coldefs"]:
            clauses.append(f"DROP COLUMN {q(c)}")
            item["destructive"] = True
    cur = [c for c in t["columns"] if c in s["coldefs"]]
    ignore_order = ctx.opts.get("ignore_column_order", False)
    prev = None
    for i, c in enumerate(s["columns"]):
        pos = f" AFTER {q(prev)}" if prev else " FIRST"
        sdef = ctx.retarget(s["coldefs"][c])
        if c not in t["coldefs"]:
            clauses.append(f"ADD COLUMN {sdef}{pos}")
            cur.insert(cur.index(prev) + 1 if prev else 0, c)
        else:
            changed = ns(s["coldefs"][c]) != nt(t["coldefs"][c])
            moved = not ignore_order and cur.index(c) != (cur.index(prev) + 1 if prev else 0)
            if changed or moved:
                clauses.append(f"MODIFY COLUMN {sdef}" + (pos if moved or not ignore_order else ""))
                cur.remove(c)
                cur.insert(cur.index(prev) + 1 if prev else 0, c)
        prev = c

    for ix, line in s["indexes"].items():
        if ix not in t["indexes"] or ns(line) != nt(t["indexes"][ix]):
            clauses.append("ADD " + ctx.retarget(line))
    for ck, line in s["checks"].items():
        if ck not in t["checks"] or ns(line) != nt(t["checks"][ck]):
            clauses.append("ADD " + ctx.retarget(line))

    # table options
    so, to = dict(s["options"]), dict(t["options"])
    opt_changes = []
    cs_s = so.pop("DEFAULT CHARSET", None) or so.pop("CHARSET", None)
    cs_t = to.pop("DEFAULT CHARSET", None) or to.pop("CHARSET", None)
    so.pop("CHARSET", None)
    to.pop("CHARSET", None)
    if cs_s and cs_s != cs_t:
        opt_changes.append(f"DEFAULT CHARSET={cs_s}")
    for k in sorted(set(so) | set(to)):
        a, b = so.get(k), to.get(k)
        if a == b:
            continue
        if a is None:
            if k == "COMMENT":
                opt_changes.append("COMMENT=''")
            elif k == "ROW_FORMAT":
                opt_changes.append("ROW_FORMAT=DEFAULT")
            continue
        opt_changes.append(f"{k}={a}")
    clauses = [c for c in clauses if c]
    clauses += opt_changes
    if (s["partition"] or t["partition"]) and ns(s["partition"]) != nt(t["partition"]):
        item["warnings"].append("Partitioning differs. It is not synchronized; change it manually if needed.")

    tbl = ctx.qn(name)
    if pre:
        item["statements"].append((P_DROP_FK, f"ALTER TABLE {tbl}\n  " + ",\n  ".join(pre)))
    if clauses:
        item["statements"].append((P_ALTER_TABLE, f"ALTER TABLE {tbl}\n  " + ",\n  ".join(clauses)))
    if post:
        item["statements"].append((P_ADD_FK, f"ALTER TABLE {tbl}\n  " + ",\n  ".join(post)))
    if item["statements"] or item["warnings"]:
        item["status"] = "alter"
    return item


# ---------------------------------------------------------------------------- views, routines, triggers
def diff_view(ctx, name, src_ddl, tgt_ddl):
    item = _item("view", name, "same", src_ddl, tgt_ddl)
    if src_ddl is None:
        item.update(status="drop", destructive=True)
        item["statements"].append((P_DROP_VIEW, f"DROP VIEW {ctx.qn(name)}"))
        return item
    if tgt_ddl is not None and ctx.norm(src_ddl, ctx.src.schema) == ctx.norm(tgt_ddl, ctx.tgt.schema):
        return item
    item["status"] = "create" if tgt_ddl is None else "alter"
    body = ctx.retarget(src_ddl)
    body = re.sub(r"^CREATE\s", "CREATE OR REPLACE ", body, count=1)
    body = re.sub(r"\sVIEW (" + IDENT + r") AS ", lambda m: f" VIEW {ctx.T}.{m.group(1)} AS ", body, count=1)
    item["statements"].append((P_CREATE_VIEW, body))
    return item


def _delimited(sql):
    return f"DELIMITER $$\n{sql.rstrip().rstrip(';')}$$\nDELIMITER ;"


def diff_routine(ctx, kind, name, src_ddl, tgt_ddl):
    item = _item(kind, name, "same", src_ddl, tgt_ddl)
    drop = f"DROP {kind.upper()} IF EXISTS {ctx.qn(name)}"
    if src_ddl is None:
        item.update(status="drop", destructive=True)
        item["statements"].append((P_DROP_ROUTINE, drop))
        return item
    if tgt_ddl is not None and ctx.norm(src_ddl, ctx.src.schema) == ctx.norm(tgt_ddl, ctx.tgt.schema):
        return item
    item["status"] = "create" if tgt_ddl is None else "alter"
    body = ctx.retarget(src_ddl)
    body = re.sub(r"^(CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION)\s+)(" + IDENT + ")",
                  lambda m: f"{m.group(1)}{ctx.T}.{m.group(2)}", body, count=1, flags=re.I)
    if tgt_ddl is not None:
        item["statements"].append((P_DROP_ROUTINE, drop))
    item["statements"].append((P_CREATE_ROUTINE, _delimited(body)))
    return item


def _trigger_sql(ctx, t, schema_q, keep_definer):
    definer = ""
    if keep_definer and t.get("definer"):
        user, _, host = t["definer"].rpartition("@")
        definer = f"DEFINER={ctx.q(user)}@{ctx.q(host)} "
    return (f"CREATE {definer}TRIGGER {schema_q}.{ctx.q(t['name'])} {t['timing']} {t['event']} "
            f"ON {schema_q}.{ctx.q(t['tbl'])} FOR EACH ROW {t['stmt']}")


def diff_trigger(ctx, name, src, tgt):
    def show(t, schema):
        return _trigger_sql(ctx, t, ctx.q(schema), True) if t else ""
    item = _item("trigger", name, "same", show(src, ctx.src.schema), show(tgt, ctx.tgt.schema))
    drop = f"DROP TRIGGER IF EXISTS {ctx.qn(name)}"
    if src is None:
        item.update(status="drop", destructive=True)
        item["statements"].append((P_DROP_TRIGGER, drop))
        return item
    if tgt is not None:
        def key(t, schema):
            return (t["timing"], t["event"], t["tbl"], ctx.norm(t["stmt"], schema),
                    "" if ctx.opts.get("ignore_definer", True) else t.get("definer"))
        if key(src, ctx.src.schema) == key(tgt, ctx.tgt.schema):
            return item
        item["statements"].append((P_DROP_TRIGGER, drop))
    item["status"] = "create" if tgt is None else "alter"
    sql = _trigger_sql(ctx, src, ctx.T, ctx.opts.get("keep_definer", False))
    item["statements"].append((P_CREATE_TRIGGER, _delimited(ctx.retarget(sql))))
    return item


def _view_order(ctx, items):
    """Create views after the views they select from."""
    views = {i["name"]: i for i in items if i["type"] == "view" and i["status"] in ("create", "alter")}
    order, seen = [], set()

    def visit(n, depth=0):
        if n in seen or depth > 50:
            return
        seen.add(n)
        text = views[n]["source_ddl"]
        for other in views:
            if other != n and f"{ctx.q(ctx.src.schema)}.{ctx.q(other)}" in text:
                visit(other, depth + 1)
        order.append(n)
    for n in sorted(views):
        visit(n)
    return {n: i for i, n in enumerate(order)}


# ---------------------------------------------------------------------------- entry points
def compare(src_driver, src_schema, tgt_driver, tgt_schema, opts=None):
    opts = opts or {}
    if src_driver.kind != "mysql" or tgt_driver.kind != "mysql":
        raise DBError("Schema compare is available for MySQL and MariaDB connections.")
    if src_driver is tgt_driver and src_schema == tgt_schema:
        raise DBError("Choose two different schemas to compare.")
    t0 = time.time()
    snaps = {}

    def take(key, drv, schema):
        try:
            snaps[key] = snapshot(drv, schema)
        except Exception as e:  # noqa: BLE001
            snaps[key] = e
    threads = [threading.Thread(target=take, args=("src", src_driver, src_schema)),
               threading.Thread(target=take, args=("tgt", tgt_driver, tgt_schema))]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    for k in ("src", "tgt"):
        if isinstance(snaps[k], Exception):
            raise snaps[k]
    src, tgt = snaps["src"], snaps["tgt"]
    ctx = Ctx(src, tgt, opts, tgt_driver.quote_ident)

    items = []
    for name in sorted(set(src.tables) | set(tgt.tables), key=str.lower):
        items.append(diff_table(ctx, name, src.tables.get(name), tgt.tables.get(name)))
    for name in sorted(set(src.views) | set(tgt.views), key=str.lower):
        items.append(diff_view(ctx, name, src.views.get(name), tgt.views.get(name)))
    for key in sorted(set(src.routines) | set(tgt.routines), key=lambda k: (k[0], k[1].lower())):
        items.append(diff_routine(ctx, key[0], key[1], src.routines.get(key), tgt.routines.get(key)))
    for name in sorted(set(src.triggers) | set(tgt.triggers), key=str.lower):
        items.append(diff_trigger(ctx, name, src.triggers.get(name), tgt.triggers.get(name)))

    vorder = _view_order(ctx, items)
    for it in items:
        it["statements"] = [{"phase": p, "order": vorder.get(it["name"], 0) if it["type"] == "view" else 0, "sql": sql}
                            for p, sql in it["statements"]]
    if src.is_mariadb != tgt.is_mariadb:
        src.warnings.append("The schemas are on different server types (MySQL and MariaDB); "
                            "some differences may only be in how each server writes definitions.")
    counts = {}
    for it in items:
        counts[it["status"]] = counts.get(it["status"], 0) + 1
    return {"items": items, "counts": counts, "warnings": src.warnings + tgt.warnings,
            "source": {"schema": src_schema, "server": src.server}, "target": {"schema": tgt_schema, "server": tgt.server},
            "seconds": round(time.time() - t0, 2)}


def apply_script(driver, statements, stop_on_error=True):
    """Run a sync script on a separate connection, so session settings such as
    FOREIGN_KEY_CHECKS never leak into the user's own connection."""
    conn = driver._new_conn(None)
    results, ok = [], True
    try:
        for sql in statements:
            t0 = time.perf_counter()
            try:
                with conn.cursor() as c:
                    affected = c.execute(sql)
                    while c.nextset():
                        pass
                results.append({"ok": True, "sql": sql, "affected": affected,
                                "ms": round((time.perf_counter() - t0) * 1000, 1)})
            except pymysql.err.Error as e:
                ok = False
                msg = f"Error Code: {e.args[0]}. {e.args[1]}" if len(e.args) > 1 else str(e)
                results.append({"ok": False, "sql": sql, "error": msg, "ms": round((time.perf_counter() - t0) * 1000, 1)})
                if stop_on_error:
                    break
    finally:
        conn.close()
    return {"ok": ok, "results": results}
