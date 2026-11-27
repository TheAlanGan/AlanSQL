"""Generic ODBC connections (any database with an ODBC driver: SQL Server, Access, Oracle, PostgreSQL, ...).

Through ODBC only the common ground is available: browsing tables, views and columns, running queries
and transactions. Engine-specific tools (table designer, admin pages, dumps, result editing) stay
MySQL/SQLite-only. Catalog functions differ a lot between ODBC drivers, so every one is optional.
"""
import datetime
import decimal
import re
import threading
import time
import uuid

from .base import HARD_ROW_CAP, DBError, Driver, to_json_value

NO_SCHEMA = "default"     # shown as the only "schema" when the data source has no schemas (e.g. Access)
SYSTEM_SCHEMAS = {"sys", "information_schema", "guest", "pg_catalog", "pg_toast", "mysql", "performance_schema",
                  "sysibm", "syscat", "sysstat", "ctxsys", "mdsys", "outln", "system", "xdb", "dbsnmp"}
SYSTEM_PREFIXES = ("db_", "pg_temp", "pg_toast")


def _pyodbc():
    try:
        import pyodbc
    except ImportError:
        raise DBError("ODBC connections need the 'pyodbc' package. Run setup.bat again to install it.") from None
    return pyodbc


def connection_string(profile, password=None):
    """Build the ODBC connection string from a profile (DSN or full string, plus user and password)."""
    if (profile.get("odbc_mode") or "dsn") == "dsn":
        dsn = (profile.get("odbc_dsn") or "").strip()
        if not dsn:
            raise DBError("Choose an ODBC data source (DSN).")
        parts = [f"DSN={_braced(dsn)}"]
    else:
        text = (profile.get("odbc_connstr") or "").strip().rstrip(";")
        if not text:
            raise DBError("Enter an ODBC connection string.")
        parts = [text]
    if profile.get("user"):
        parts.append(f"UID={_braced(profile['user'])}")
        if password:
            parts.append(f"PWD={_braced(password)}")
    return ";".join(parts) + ";"


def _braced(v):
    v = str(v)
    return "{" + v.replace("}", "}}") + "}" if any(ch in v for ch in ";{}= ") else v


def list_sources():
    pyodbc = _pyodbc()
    return {"drivers": sorted(pyodbc.drivers()), "dsns": [{"name": k, "driver": v} for k, v in sorted(pyodbc.dataSources().items())]}


def _kind(type_code):
    if type_code in (int, float, decimal.Decimal):
        return "num"
    if type_code is bool:
        return "bit"
    if type_code in (datetime.datetime, datetime.date, datetime.time):
        return "date"
    if type_code in (bytes, bytearray):
        return "bin"
    return "str"


def _value(v):
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, uuid.UUID):
        return str(v)
    out = to_json_value(v)
    if out is v and not isinstance(v, (str, int, float, type(None))):
        return str(v)
    return out


class ODBCDriver(Driver):
    kind = "odbc"

    def __init__(self, profile, password=None):
        super().__init__(profile, password)
        self.conn = None
        self.aux = None
        self.aux_lock = threading.RLock()
        self.cursor = None
        self.dbms = ""
        self.quote_char = '"'
        self.has_schemas = True
        self.current_schema = None
        self._tx_from_script = False

    # ------------------------------------------------------------------ connection
    def _open(self):
        pyodbc = _pyodbc()
        timeout = int(self.profile.get("connect_timeout") or 15)
        try:
            return pyodbc.connect(connection_string(self.profile, self.password), autocommit=True, timeout=timeout)
        except pyodbc.Error as e:
            raise self._err(e) from None

    @staticmethod
    def _err(e):
        args = getattr(e, "args", ())
        state = args[0] if len(args) > 1 else None
        msg = args[1] if len(args) > 1 else str(e)
        # drop the driver-manager prefix noise: [Microsoft][ODBC Driver Manager] ...
        while msg.startswith("[") and "]" in msg:
            msg = msg[msg.index("]") + 1:].lstrip()
        msg = re.sub(r"\s*\(-?\d+\)\s*\(SQL\w+\)\s*$", "", msg)      # trailing "(0) (SQLExecDirectW)"
        return DBError(f"{msg} [SQLSTATE {state}]" if state else msg, code=state)

    def connect(self):
        pyodbc = _pyodbc()
        self.conn = self._open()
        try:
            self.dbms = f"{self.conn.getinfo(pyodbc.SQL_DBMS_NAME)} {self.conn.getinfo(pyodbc.SQL_DBMS_VER)}".strip()
        except pyodbc.Error:
            self.dbms = "ODBC"
        try:
            q = (self.conn.getinfo(pyodbc.SQL_IDENTIFIER_QUOTE_CHAR) or "").strip()
            self.quote_char = q if q else '"'
        except pyodbc.Error:
            pass
        try:
            self.has_schemas = bool((self.conn.getinfo(pyodbc.SQL_SCHEMA_TERM) or "").strip())
        except pyodbc.Error:
            self.has_schemas = True
        self.current_schema = (self.profile.get("schema") or None) if self.has_schemas else NO_SCHEMA
        self.last_used = time.time()

    def close(self):
        with self.aux_lock:
            for c in (self.conn, self.aux):
                try:
                    if c is not None:
                        c.close()
                except Exception:  # noqa: BLE001
                    pass
            self.conn = self.aux = None

    def info(self):
        p = self.profile
        source = p.get("odbc_dsn") if (p.get("odbc_mode") or "dsn") == "dsn" else "connection string"
        return {
            "driver": "odbc", "server_version": self.dbms or "ODBC", "dbms": self.dbms, "user": p.get("user") or "",
            "host": source, "port": None, "current_schema": self.current_schema, "autocommit": self.autocommit,
            "no_backslash_escapes": True, "quote_char": self.quote_char, "has_schemas": self.has_schemas,
            "features": self.features,
        }

    @property
    def features(self):
        return {"schemas": self.has_schemas, "create_schema": False, "routines": False, "admin": False, "users": False,
                "engines": False, "explain_json": False, "export": False, "table_editor": False,
                "object_editor": False, "import_wizard": False, "edit_results": False, "explain": False}

    # ------------------------------------------------------------------ quoting
    def quote_ident(self, name):
        q = self.quote_char
        if q == "[":
            return "[" + str(name).replace("]", "]]") + "]"
        return q + str(name).replace(q, q + q) + q

    def quote_value(self, value):
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, (int, float, decimal.Decimal)):
            return str(value)
        return "'" + str(value).replace("'", "''") + "'"

    def qualified(self, schema, name):
        s = self._schema(schema)
        return f"{self.quote_ident(s)}.{self.quote_ident(name)}" if s else self.quote_ident(name)

    def _schema(self, schema):
        return None if (not self.has_schemas or not schema or schema == NO_SCHEMA) else schema

    # ------------------------------------------------------------------ queries
    def execute(self, sql, max_rows=0):
        pyodbc = _pyodbc()
        with self.lock:
            if self.conn is None:
                raise DBError("Not connected.")
            cap = min(max_rows if max_rows and max_rows > 0 else HARD_ROW_CAP, HARD_ROW_CAP)
            cur = self.conn.cursor()
            self.cursor = cur
            t0 = time.perf_counter()
            try:
                cur.execute(sql)
            except pyodbc.Error as e:
                self.cursor = None
                cur.close()
                raise self._err(e) from None
            finally:
                self.last_used = time.time()
            exec_ms = (time.perf_counter() - t0) * 1000
            t1 = time.perf_counter()
            results = []
            try:
                while True:
                    if cur.description:
                        cols = [{"name": d[0], "type": getattr(d[1], "__name__", str(d[1])).upper(), "kind": _kind(d[1]),
                                 "length": d[3], "decimals": d[5], "nullable": bool(d[6])} for d in cur.description]
                        try:
                            raw = cur.fetchmany(cap + 1)
                        except pyodbc.Error as e:
                            if not results:
                                raise self._err(e) from None
                            results.append({"kind": "error", **self._err(e).to_dict()})
                            break
                        truncated = len(raw) > cap
                        if truncated:
                            raw = raw[:cap]
                            try:
                                cur.cancel()           # stop the rest of the result
                            except pyodbc.Error:
                                pass
                        rows = [[_value(v) for v in r] for r in raw]
                        results.append({"kind": "rows", "columns": cols, "rows": rows,
                                        "row_count": len(rows) + (1 if truncated else 0), "truncated": truncated,
                                        "editable": None,
                                        "read_only_reason": "Read Only: editing results isn't available for ODBC connections."})
                        if truncated:
                            break
                    else:
                        results.append({"kind": "status", "affected": max(cur.rowcount, 0) if cur.rowcount is not None else 0,
                                        "insert_id": None, "info": ""})
                    try:
                        if not cur.nextset():
                            break
                    except pyodbc.Error:
                        break
            finally:
                self.cursor = None
                try:
                    cur.close()
                except pyodbc.Error:
                    pass
            fetch_ms = (time.perf_counter() - t1) * 1000
            return {"results": results, "exec_ms": round(exec_ms, 3), "fetch_ms": round(fetch_ms, 3), "warnings": [],
                    "current_schema": self.current_schema, "in_transaction": self.in_transaction(), "reconnected": False}

    def cancel(self):
        cur = self.cursor
        if cur is None:
            return False
        try:
            cur.cancel()               # pyodbc allows this from another thread
            return True
        except Exception as e:  # noqa: BLE001
            raise DBError(f"Could not stop the query: {e}") from None

    # transactions: ODBC has no BEGIN statement, it switches autocommit off instead
    def set_autocommit(self, enabled):
        with self.lock:
            self.conn.autocommit = bool(enabled)
            self.autocommit = bool(enabled)
            self._tx_from_script = False

    def begin(self):
        self.conn.autocommit = False
        self._tx_from_script = True

    def _end_tx(self):
        if self._tx_from_script:
            self.conn.autocommit = True
            self._tx_from_script = False

    def commit(self):
        try:
            self.conn.commit()
        finally:
            self._end_tx()

    def rollback(self):
        try:
            self.conn.rollback()
        finally:
            self._end_tx()

    def in_transaction(self):
        return bool(self.conn is not None and not self.conn.autocommit)

    def use_schema(self, schema):
        self.current_schema = schema if self.has_schemas else NO_SCHEMA
        return self.current_schema

    def explain(self, sql):
        raise DBError("Explain isn't available for ODBC connections.")

    def meta(self):
        return {"engines": [], "charsets": [], "collations": [], "defaults": {}}

    def get_ddl(self, schema, name, obj_type):
        if obj_type != "table":
            raise DBError("Definitions of views and other objects aren't available through ODBC.")
        columns = self._columns(schema, name)
        if not columns:
            raise DBError(f"Table '{name}' was not found.")
        return self._ddl(schema, name, columns, self._indexes(schema, name, columns))

    def _ddl(self, schema, name, columns, indexes):
        lines = []
        for c in columns:
            lines.append(f"  {self.quote_ident(c['name'])} {c['column_type']}" + ("" if c["nullable"] else " NOT NULL"))
        pk = next((i for i in indexes if i.get("primary")), None)
        if pk:
            lines.append("  PRIMARY KEY (" + ", ".join(self.quote_ident(c["name"]) for c in pk["columns"]) + ")")
        return (f"-- Generated from the ODBC catalog ({self.dbms}); it may not match the original exactly.\n"
                f"CREATE TABLE {self.qualified(schema, name)} (\n" + ",\n".join(lines) + "\n)")

    # ------------------------------------------------------------------ catalog
    def _catalog(self, fn):
        """Run a catalog call on the separate metadata connection; unsupported calls return None."""
        pyodbc = _pyodbc()
        with self.aux_lock:
            for attempt in (1, 2):
                if self.aux is None:
                    self.aux = self._open()
                cur = self.aux.cursor()
                try:
                    return fn(cur)
                except pyodbc.InterfaceError as e:          # IM001: driver doesn't support the function
                    if e.args and e.args[0] in ("IM001", "HYC00"):
                        return None
                    raise self._err(e) from None
                except pyodbc.Error as e:
                    if attempt == 1 and e.args and str(e.args[0]).startswith("08"):   # connection lost
                        try:
                            self.aux.close()
                        except Exception:  # noqa: BLE001
                            pass
                        self.aux = None
                        continue
                    raise self._err(e) from None
                finally:
                    try:
                        cur.close()
                    except Exception:  # noqa: BLE001
                        pass
        return None

    def list_schemas(self):
        if not self.has_schemas:
            return [{"name": NO_SCHEMA, "system": False}]
        rows = self._catalog(lambda c: [r.table_schem for r in c.tables(tableType="TABLE,VIEW")]) or []
        names = sorted({r for r in rows if r}, key=str.lower)
        if not names:
            return [{"name": NO_SCHEMA, "system": False}]
        return [{"name": n, "system": n.lower() in SYSTEM_SCHEMAS or n.lower().startswith(SYSTEM_PREFIXES)} for n in names]

    def _columns(self, schema, table=None):
        s = self._schema(schema)
        rows = self._catalog(lambda c: [
            {"tbl": r.table_name, "name": r.column_name, "pos": r.ordinal_position, "type_name": r.type_name,
             "size": r.column_size, "digits": r.decimal_digits, "nullable": bool(r.nullable),
             "default": r.column_def, "comment": r.remarks or ""}
            for r in c.columns(table=table, schema=s)]) or []
        out = []
        for r in rows:
            tn = (r["type_name"] or "").upper()
            if r["size"] and tn in ("VARCHAR", "CHAR", "NVARCHAR", "NCHAR", "VARBINARY", "BINARY", "TEXT"):
                ctype = f"{tn}({r['size']})"
            elif tn in ("DECIMAL", "NUMERIC") and r["size"]:
                ctype = f"{tn}({r['size']},{r['digits'] or 0})"
            else:
                ctype = tn
            out.append({"tbl": r["tbl"], "name": r["name"], "pos": r["pos"], "default": r["default"],
                        "nullable": r["nullable"], "data_type": tn.lower(), "column_type": ctype,
                        "charset": None, "collation": None, "col_key": "", "extra": "", "comment": r["comment"],
                        "gen_expr": None})
        return out

    def schema_objects(self, schema):
        s = self._schema(schema)
        rows = self._catalog(lambda c: [(r.table_name, r.table_type, r.remarks) for r in c.tables(schema=s)]) or []
        tables, views = [], []
        for name, typ, remarks in rows:
            entry = {"name": name, "type": "BASE TABLE" if typ == "TABLE" else "VIEW", "engine": None,
                     "row_estimate": None, "comment": remarks or ""}
            if typ == "TABLE":
                tables.append(entry)
            elif typ == "VIEW":
                views.append(entry)
        cols = {}
        for c in self._columns(schema):
            cols.setdefault(c.pop("tbl"), []).append(c)
        return {"tables": tables, "views": views, "procedures": [], "functions": [], "columns": cols}

    def completion_columns(self, schema):
        out = {}
        for c in self._columns(schema):
            out.setdefault(c["tbl"], []).append([c["name"], c["column_type"]])
        return out

    def _indexes(self, schema, table, columns):
        s = self._schema(schema)
        stats = self._catalog(lambda c: [(r.index_name, r.column_name, r.non_unique, r.ordinal_position)
                                         for r in c.statistics(table, schema=s) if r.index_name]) or []
        by_name = {}
        for name, col, non_unique, pos in stats:
            ix = by_name.setdefault(name, {"name": name, "unique": not non_unique, "type": "", "comment": "",
                                           "primary": False, "columns": []})
            ix["columns"].append({"name": col, "sub_part": None, "order": "ASC", "_pos": pos or 0})
        for ix in by_name.values():
            ix["columns"].sort(key=lambda c: c.pop("_pos"))
        pk = self._catalog(lambda c: [(r.column_name, r.key_seq, r.pk_name) for r in c.primaryKeys(table, schema=s)])
        if pk:
            pk_cols = [r[0] for r in sorted(pk, key=lambda r: r[1] or 0)]
            match = next((ix for ix in by_name.values() if ix["unique"] and [c["name"] for c in ix["columns"]] == pk_cols), None)
            if match:
                match["primary"] = True
            else:
                by_name["PRIMARY"] = {"name": pk[0][2] or "PRIMARY", "unique": True, "type": "", "comment": "",
                                      "primary": True, "columns": [{"name": c, "sub_part": None, "order": "ASC"} for c in pk_cols]}
        elif pk is None:
            # driver can't report primary keys (e.g. Access): a unique index on NOT NULL columns is the best guess
            notnull = {c["name"] for c in columns if not c["nullable"]}
            guess = next((ix for ix in by_name.values()
                          if ix["unique"] and all(c["name"] in notnull for c in ix["columns"])), None)
            if guess:
                guess["primary"] = True
        return sorted(by_name.values(), key=lambda ix: (not ix["primary"], ix["name"]))

    def _foreign_keys(self, schema, table):
        s = self._schema(schema)
        rows = self._catalog(lambda c: [(r.fk_name, r.fkcolumn_name, r.pktable_schem, r.pktable_name, r.pkcolumn_name,
                                         r.update_rule, r.delete_rule, r.key_seq)
                                        for r in c.foreignKeys(foreignTable=table, foreignSchema=s)]) or []
        rules = {0: "CASCADE", 1: "RESTRICT", 2: "SET NULL", 3: "NO ACTION", 4: "SET DEFAULT"}
        fks = {}
        for name, col, ref_schema, ref_table, ref_col, upd, dele, seq in sorted(rows, key=lambda r: (r[0] or "", r[7] or 0)):
            fk = fks.setdefault(name or f"fk_{table}_{ref_table}", {
                "name": name or f"fk_{table}_{ref_table}", "ref_schema": ref_schema or schema, "ref_table": ref_table,
                "on_update": rules.get(upd, ""), "on_delete": rules.get(dele, ""), "columns": [], "ref_columns": []})
            fk["columns"].append(col)
            fk["ref_columns"].append(ref_col)
        return list(fks.values())

    def table_details(self, schema, table):
        columns = self._columns(schema, table)
        if not columns:
            raise DBError(f"Table '{table}' was not found.")
        for c in columns:
            c.pop("tbl", None)
        objs = self._catalog(lambda c: [r.table_type for r in c.tables(table=table, schema=self._schema(schema))]) or []
        is_view = bool(objs) and objs[0] == "VIEW"
        indexes = [] if is_view else self._indexes(schema, table, columns)
        pk_cols = {c["name"] for ix in indexes if ix["primary"] for c in ix["columns"]}
        for c in columns:
            c["col_key"] = "PRI" if c["name"] in pk_cols else ""
        try:
            count = self._catalog(lambda c: c.execute(f"SELECT COUNT(*) FROM {self.qualified(schema, table)}").fetchone()[0])
        except DBError:
            count = None
        info = {"name": table, "type": "VIEW" if is_view else "BASE TABLE", "engine": self.dbms,
                "row_estimate": count, "comment": "", "collation": None, "auto_increment": None}
        ddl = "" if is_view else self._ddl(schema, table, columns, indexes)
        return {"info": info, "columns": columns, "indexes": indexes,
                "foreign_keys": [] if is_view else self._foreign_keys(schema, table),
                "triggers": [], "ddl": ddl, "is_view": is_view}

    def schema_fks(self, schema):
        out = []
        tables = [t["name"] for t in self.schema_objects(schema)["tables"]][:300]
        for t in tables:
            for fk in self._foreign_keys(schema, t):
                out.append({"table": t, **fk})
        return out
