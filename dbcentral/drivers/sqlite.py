"""SQLite driver built on the standard library sqlite3 module."""
import os
import re
import sqlite3
import time

from .base import HARD_ROW_CAP, DBError, Driver, to_json_value

_IDENT = r'(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)'
_SIMPLE_SELECT = re.compile(
    r"^\s*select\s+(?P<cols>.+?)\s+from\s+(?P<tbl>" + _IDENT + r"(?:\s*\.\s*" + _IDENT + r")?)"
    r"(?:\s+(?:as\s+)?(?P<alias>(?!where\b|order\b|limit\b|group\b|join\b|inner\b|left\b|natural\b|cross\b"
    r"|union\b|window\b|having\b)" + _IDENT + r"))?"
    r"\s*(?P<rest>(?:where|order|limit)\b.*)?;?\s*$",
    re.I | re.S)
_FORBIDDEN = re.compile(r"\b(join|group\s+by|union|intersect|except|having|distinct|window)\b", re.I)
_COMMENTS = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)


def _unquote(ident):
    ident = ident.strip()
    if ident[:1] == '"' and ident[-1:] == '"':
        return ident[1:-1].replace('""', '"')
    if ident[:1] == "`" and ident[-1:] == "`":
        return ident[1:-1].replace("``", "`")
    if ident[:1] == "[" and ident[-1:] == "]":
        return ident[1:-1]
    return ident


def _split_ident_path(text):
    parts = re.findall(_IDENT, text)
    return [_unquote(p) for p in parts]


def _first_word(sql):
    s = _COMMENTS.sub(" ", sql).lstrip()
    m = re.match(r"[A-Za-z_]+", s)
    return m.group(0).lower() if m else ""


class SQLiteDriver(Driver):
    kind = "sqlite"
    features = {
        "schemas": False, "create_schema": False, "routines": False, "admin": False, "users": False,
        "engines": False, "explain_json": False, "export": True,
    }

    def __init__(self, profile, password=None):
        super().__init__(profile, password)
        self.conn = None
        self.path = profile.get("file") or ""

    def connect(self):
        path = self.path.strip()
        if not path:
            raise DBError("No database file was specified.")
        if path != ":memory:":
            path = os.path.abspath(os.path.expanduser(path))
            if not os.path.exists(path) and not self.profile.get("create_if_missing"):
                raise DBError(f"Database file not found: {path}")
            folder = os.path.dirname(path)
            if folder and not os.path.isdir(folder):
                raise DBError(f"Folder does not exist: {folder}")
        self.path = path
        try:
            self.conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=10)
            if self.profile.get("foreign_keys", True):
                self.conn.execute("PRAGMA foreign_keys = ON")
            self.conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except sqlite3.Error as e:
            raise DBError(f"Could not open database: {e}")
        self.current_schema = "main"
        self.last_used = time.time()

    def close(self):
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        self.conn = None

    def info(self):
        return {
            "driver": "sqlite",
            "server_version": "SQLite " + sqlite3.sqlite_version,
            "is_mariadb": False,
            "user": "",
            "host": self.path,
            "port": None,
            "file": self.path,
            "current_schema": self.current_schema,
            "autocommit": self.autocommit,
            "no_backslash_escapes": True,
            "features": self.features,
        }

    # ---- quoting --------------------------------------------------------
    def quote_ident(self, name):
        return '"' + str(name).replace('"', '""') + '"'

    def quote_value(self, value):
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            return repr(value)
        if isinstance(value, dict) and "$bin" in value:
            return "X'" + value["$bin"] + "'"
        return "'" + str(value).replace("'", "''") + "'"

    def empty_insert(self, qualified_table):
        return f"INSERT INTO {qualified_table} DEFAULT VALUES;"

    # ---- execution ------------------------------------------------------
    @staticmethod
    def _err(e):
        code = getattr(e, "sqlite_errorname", None) or e.__class__.__name__
        return DBError(f"Error: {e}", code=code)

    def _q(self, sql, args=()):
        with self.lock:
            try:
                cur = self.conn.execute(sql, args)
                cols = [d[0] for d in cur.description] if cur.description else []
                return [dict(zip(cols, r)) for r in cur.fetchall()]
            except sqlite3.Error as e:
                raise self._err(e)

    def _editable(self, sql, col_names):
        text = _COMMENTS.sub(" ", sql).strip()
        m = _SIMPLE_SELECT.match(text)
        if not m or _FORBIDDEN.search(m.group("cols") + " " + (m.group("rest") or "")):
            return None, "Read Only: only simple single-table SELECT results can be edited."
        path = _split_ident_path(m.group("tbl"))
        schema, table = (path[0], path[1]) if len(path) == 2 else ("main", path[0])
        try:
            info = self._q(f"PRAGMA {self.quote_ident(schema)}.table_info({self.quote_value(table)})")
        except DBError:
            return None, "Read Only: could not inspect the table."
        if not info:
            return None, "Read Only: the result is not based on a table (or is a view)."
        types = self._q(f"SELECT type, sql FROM {self.quote_ident(schema)}.sqlite_master WHERE name = ?", (table,))
        if types and types[0]["type"] != "table":
            return None, "Read Only: views cannot be edited."
        without_rowid = bool(types and types[0]["sql"] and re.search(r"without\s+rowid", types[0]["sql"], re.I))
        table_cols = {r["name"].lower(): r["name"] for r in info}
        pk = [r["name"] for r in sorted((r for r in info if r["pk"]), key=lambda r: r["pk"])]
        columns = []
        for name in col_names:
            low = name.lower()
            if low in table_cols:
                columns.append(table_cols[low])
            elif low in ("rowid", "_rowid_", "oid") and not without_rowid:
                columns.append("rowid")
            else:
                columns.append(None)
        if len([c for c in columns if c]) != len({c for c in columns if c}):
            return None, "Read Only: the result contains the same column more than once."
        if pk and all(c in columns for c in pk):
            key = pk
        elif "rowid" in columns:
            key = ["rowid"]
        else:
            return None, "Read Only: include the primary key (or rowid) in the result to edit rows."
        return {"schema": schema, "table": table, "pk": key, "columns": columns}, None

    def execute(self, sql, max_rows=0):
        with self.lock:
            if self.conn is None:
                raise DBError("Not connected.")
            word = _first_word(sql)
            cur = self.conn.cursor()
            t0 = time.perf_counter()
            try:
                if word not in ("begin", "commit", "end", "rollback", "savepoint", "release", "vacuum",
                                "attach", "detach"):
                    self.ensure_tx()
                cur.execute(sql)
            except sqlite3.Error as e:
                raise self._err(e)
            finally:
                self.last_used = time.time()
            exec_ms = (time.perf_counter() - t0) * 1000
            t1 = time.perf_counter()
            results = []
            if cur.description:
                names = [d[0] for d in cur.description]
                cap = max_rows if max_rows and max_rows > 0 else HARD_ROW_CAP
                cap = min(cap, HARD_ROW_CAP)
                try:
                    raw = cur.fetchmany(cap + 1)
                except sqlite3.Error as e:
                    raise self._err(e)
                truncated = len(raw) > cap
                raw = raw[:cap]
                rows = [[to_json_value(v) for v in r] for r in raw]
                kinds = []
                for i in range(len(names)):
                    kind = "str"
                    for r in raw:
                        v = r[i]
                        if v is None:
                            continue
                        kind = ("num" if isinstance(v, (int, float)) else
                                "bin" if isinstance(v, bytes) else "str")
                        break
                    kinds.append(kind)
                editable, ro_reason = (self._editable(sql, names) if word == "select"
                                       else (None, "Read Only"))
                decl = {}
                if editable:
                    try:
                        for r in self._q(f"PRAGMA {self.quote_ident(editable['schema'])}.table_info("
                                         f"{self.quote_value(editable['table'])})"):
                            decl[r["name"]] = r
                    except DBError:
                        pass
                cols = []
                for i, n in enumerate(names):
                    src = editable["columns"][i] if editable else None
                    d = decl.get(src) if src else None
                    cols.append({
                        "name": n, "type": (d["type"] if d and d["type"] else
                                            "INTEGER" if src == "rowid" else kinds[i].upper()),
                        "kind": kinds[i], "schema": editable["schema"] if src else "",
                        "table": editable["table"] if src else "", "org_table": editable["table"] if src else "",
                        "org_name": src or "", "nullable": not (d and d["notnull"]),
                        "pk": bool(d and d["pk"]) or src == "rowid",
                    })
                results.append({"kind": "rows", "columns": cols, "rows": rows,
                                "row_count": len(rows) + (1 if truncated else 0), "truncated": truncated,
                                "editable": editable, "read_only_reason": ro_reason})
            else:
                results.append({"kind": "status", "affected": max(cur.rowcount, 0),
                                "insert_id": cur.lastrowid or None, "info": ""})
            cur.close()
            if word in ("attach", "detach"):
                self.current_schema = "main"
            return {
                "results": results,
                "exec_ms": round(exec_ms, 3),
                "fetch_ms": round((time.perf_counter() - t1) * 1000, 3),
                "warnings": [],
                "current_schema": self.current_schema,
                "in_transaction": self.conn.in_transaction,
                "reconnected": False,
            }

    def cancel(self):
        if self.conn:
            self.conn.interrupt()
            return True
        return False

    def set_autocommit(self, enabled):
        with self.lock:
            if enabled and self.conn.in_transaction:
                self.conn.commit()
            self.autocommit = bool(enabled)

    def ensure_tx(self):
        """In manual-commit mode, statements run inside an explicit transaction."""
        if not self.autocommit and not self.conn.in_transaction:
            self.conn.execute("BEGIN")

    def commit(self):
        with self.lock:
            try:
                if self.conn.in_transaction:
                    self.conn.execute("COMMIT")
            except sqlite3.Error as e:
                raise self._err(e)

    def rollback(self):
        with self.lock:
            try:
                if self.conn.in_transaction:
                    self.conn.execute("ROLLBACK")
            except sqlite3.Error as e:
                raise self._err(e)

    def in_transaction(self):
        return bool(self.conn and self.conn.in_transaction)

    def after_script_failure(self):
        if self.conn and not self.conn.in_transaction:
            try:
                self.conn.execute(f"PRAGMA foreign_keys = {'ON' if self.profile.get('foreign_keys', True) else 'OFF'}")
            except sqlite3.Error:
                pass

    def use_schema(self, schema):
        self.current_schema = schema
        return schema

    # ---- introspection --------------------------------------------------
    def list_schemas(self):
        rows = self._q("PRAGMA database_list")
        return [{"name": r["name"], "file": r["file"], "system": False} for r in rows if r["name"] != "temp"]

    def _master(self, schema):
        return f"{self.quote_ident(schema)}.sqlite_master"

    def schema_objects(self, schema):
        objs = self._q(f"SELECT type, name, tbl_name, sql FROM {self._master(schema)} "
                       "WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        tables, views, columns = [], [], {}
        for o in objs:
            if o["type"] in ("table", "view"):
                entry = {"name": o["name"], "type": "BASE TABLE" if o["type"] == "table" else "VIEW",
                         "engine": None, "row_estimate": None, "comment": ""}
                (tables if o["type"] == "table" else views).append(entry)
                try:
                    columns[o["name"]] = self._columns(schema, o["name"])
                except DBError:
                    columns[o["name"]] = []
        return {"tables": tables, "views": views, "procedures": [], "functions": [], "columns": columns}

    def _columns(self, schema, table):
        rows = self._q(f"PRAGMA {self.quote_ident(schema)}.table_xinfo({self.quote_value(table)})")
        out = []
        for r in rows:
            hidden = r.get("hidden", 0)
            if hidden == 1:
                continue
            ctype = r["type"] or ""
            out.append({
                "name": r["name"], "pos": r["cid"] + 1, "default": r["dflt_value"],
                "nullable": not r["notnull"], "data_type": ctype.split("(")[0].lower(), "column_type": ctype,
                "charset": None, "collation": None, "col_key": "PRI" if r["pk"] else "",
                "pk_order": r["pk"], "extra": "GENERATED" if hidden in (2, 3) else "", "comment": "",
                "gen_expr": None,
            })
        return out

    def table_details(self, schema, table):
        master = self._q(f"SELECT type, sql FROM {self._master(schema)} WHERE name = ?", (table,))
        if not master:
            raise DBError(f"Table '{table}' was not found.")
        is_view = master[0]["type"] == "view"
        columns = self._columns(schema, table)
        ddl = master[0]["sql"] or ""
        if ddl and re.search(r"\bautoincrement\b", ddl, re.I):
            for c in columns:
                if c["col_key"] == "PRI" and c["data_type"] == "integer":
                    c["extra"] = "auto_increment"
        indexes = []
        if not is_view:
            pk_cols = [c["name"] for c in sorted((c for c in columns if c["pk_order"]), key=lambda c: c["pk_order"])]
            for ix in self._q(f"PRAGMA {self.quote_ident(schema)}.index_list({self.quote_value(table)})"):
                cols = self._q(f"PRAGMA {self.quote_ident(schema)}.index_xinfo({self.quote_value(ix['name'])})")
                indexes.append({
                    "name": ix["name"], "unique": bool(ix["unique"]), "type": "BTREE", "comment": "",
                    "primary": ix.get("origin") == "pk", "origin": ix.get("origin"),
                    "columns": [{"name": c["name"], "sub_part": None, "order": "DESC" if c["desc"] else "ASC"}
                                for c in cols if c["key"]],
                })
            if pk_cols and not any(i["primary"] for i in indexes):
                indexes.insert(0, {"name": "PRIMARY", "unique": True, "type": "ROWID", "comment": "",
                                   "primary": True, "origin": "pk",
                                   "columns": [{"name": c, "sub_part": None, "order": "ASC"} for c in pk_cols]})
        fks = []
        if not is_view:
            by_id = {}
            for r in self._q(f"PRAGMA {self.quote_ident(schema)}.foreign_key_list({self.quote_value(table)})"):
                fk = by_id.get(r["id"])
                if fk is None:
                    fk = {"name": f"fk_{table}_{r['id']}", "ref_schema": schema, "ref_table": r["table"],
                          "on_update": r["on_update"], "on_delete": r["on_delete"], "columns": [], "ref_columns": []}
                    by_id[r["id"]] = fk
                    fks.append(fk)
                fk["columns"].append(r["from"])
                fk["ref_columns"].append(r["to"])
        triggers = []
        for t in self._q(f"SELECT name, sql FROM {self._master(schema)} WHERE type='trigger' AND tbl_name = ?",
                         (table,)):
            m = re.search(r"\b(before|after|instead\s+of)\s+(insert|update|delete)", t["sql"] or "", re.I)
            triggers.append({"name": t["name"], "timing": (m.group(1).upper() if m else ""),
                             "event": (m.group(2).upper() if m else ""), "body": t["sql"]})
        try:
            count = self._q(f"SELECT count(*) AS n FROM {self.qualified(schema, table)}")[0]["n"]
        except DBError:
            count = None
        info = {"name": table, "type": "VIEW" if is_view else "BASE TABLE", "engine": "SQLite",
                "row_estimate": count, "comment": "", "collation": None, "auto_increment": None}
        for c in columns:
            c.pop("pk_order", None)
        return {"info": info, "columns": columns, "indexes": indexes, "foreign_keys": fks,
                "triggers": triggers, "ddl": (ddl + ";") if ddl else "", "is_view": is_view}

    def schema_fks(self, schema):
        out = []
        for t in self._q(f"SELECT name FROM {self._master(schema)} WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            by = {}
            for r in self._q(f"PRAGMA {self.quote_ident(schema)}.foreign_key_list({self.quote_value(t['name'])})"):
                fk = by.get(r["id"])
                if fk is None:
                    fk = {"table": t["name"], "name": f"fk_{t['name']}_{r['id']}", "ref_schema": schema,
                          "ref_table": r["table"], "columns": [], "ref_columns": []}
                    by[r["id"]] = fk
                    out.append(fk)
                fk["columns"].append(r["from"])
                fk["ref_columns"].append(r["to"])
        return out

    def get_ddl(self, schema, name, obj_type):
        rows = self._q(f"SELECT sql FROM {self._master(schema)} WHERE name = ?", (name,))
        if not rows or not rows[0]["sql"]:
            raise DBError(f"No definition found for {name}.")
        return rows[0]["sql"] + ";"

    def explain(self, sql):
        res = self.execute("EXPLAIN QUERY PLAN " + sql)
        table = next((r for r in res["results"] if r["kind"] == "rows"), None)
        return {"table": table, "json": None}

    def meta(self):
        return {"engines": [], "charsets": [], "collations": [{"name": "BINARY"}, {"name": "NOCASE"},
                                                              {"name": "RTRIM"}], "defaults": {}}

    def completion_columns(self, schema):
        out = {}
        for o in self._q(f"SELECT name FROM {self._master(schema)} WHERE type IN ('table','view') "
                         "AND name NOT LIKE 'sqlite_%'"):
            try:
                out[o["name"]] = [[c["name"], c["column_type"]] for c in self._columns(schema, o["name"])]
            except DBError:
                pass
        return out
