"""MySQL / MariaDB driver built on PyMySQL.

Each session owns two connections:
  * main - runs the user's SQL (keeps session state: current schema, variables, transactions)
  * aux  - metadata / admin queries, so the navigator works while a query is running
"""
import ssl as _ssl
import threading
import time

import pymysql
import pymysql.cursors
from pymysql import converters
from pymysql.constants import FIELD_TYPE as FT
from pymysql.constants import FLAG, SERVER_STATUS

from .base import HARD_ROW_CAP, DBError, Driver, to_json_value


def _make_conv():
    conv = dict(converters.conversions)
    # Keep exact server text for these types (precision, zero-dates, formatting).
    for t in (FT.DECIMAL, FT.NEWDECIMAL, FT.DATE, FT.NEWDATE, FT.DATETIME, FT.TIMESTAMP,
              FT.TIME, FT.SET, FT.ENUM, FT.JSON):
        conv.pop(t, None)
    return conv


CONV = _make_conv()

TYPE_NAMES = {
    FT.DECIMAL: "DECIMAL", FT.TINY: "TINYINT", FT.SHORT: "SMALLINT", FT.LONG: "INT",
    FT.FLOAT: "FLOAT", FT.DOUBLE: "DOUBLE", FT.NULL: "NULL", FT.TIMESTAMP: "TIMESTAMP",
    FT.LONGLONG: "BIGINT", FT.INT24: "MEDIUMINT", FT.DATE: "DATE", FT.TIME: "TIME",
    FT.DATETIME: "DATETIME", FT.YEAR: "YEAR", FT.NEWDATE: "DATE", FT.VARCHAR: "VARCHAR",
    FT.BIT: "BIT", FT.JSON: "JSON", FT.NEWDECIMAL: "DECIMAL", FT.ENUM: "ENUM", FT.SET: "SET",
    FT.TINY_BLOB: "TINYBLOB", FT.MEDIUM_BLOB: "MEDIUMBLOB", FT.LONG_BLOB: "LONGBLOB",
    FT.BLOB: "BLOB", FT.VAR_STRING: "VARCHAR", FT.STRING: "CHAR", FT.GEOMETRY: "GEOMETRY",
}
NUMERIC_TYPES = {FT.DECIMAL, FT.NEWDECIMAL, FT.TINY, FT.SHORT, FT.LONG, FT.FLOAT, FT.DOUBLE,
                 FT.LONGLONG, FT.INT24, FT.YEAR}
DATE_TYPES = {FT.DATE, FT.NEWDATE, FT.DATETIME, FT.TIMESTAMP, FT.TIME}
BLOB_TYPES = {FT.TINY_BLOB, FT.MEDIUM_BLOB, FT.LONG_BLOB, FT.BLOB}
DEAD_CODES = {0, 2006, 2013, 2055}

PRIV_COLUMNS = {
    "Select_priv": "SELECT", "Insert_priv": "INSERT", "Update_priv": "UPDATE", "Delete_priv": "DELETE",
    "Create_priv": "CREATE", "Drop_priv": "DROP", "Reload_priv": "RELOAD", "Shutdown_priv": "SHUTDOWN",
    "Process_priv": "PROCESS", "File_priv": "FILE", "Grant_priv": "GRANT OPTION",
    "References_priv": "REFERENCES", "Index_priv": "INDEX", "Alter_priv": "ALTER",
    "Show_db_priv": "SHOW DATABASES", "Super_priv": "SUPER",
    "Create_tmp_table_priv": "CREATE TEMPORARY TABLES", "Lock_tables_priv": "LOCK TABLES",
    "Execute_priv": "EXECUTE", "Repl_slave_priv": "REPLICATION SLAVE",
    "Repl_client_priv": "REPLICATION CLIENT", "Create_view_priv": "CREATE VIEW",
    "Show_view_priv": "SHOW VIEW", "Create_routine_priv": "CREATE ROUTINE",
    "Alter_routine_priv": "ALTER ROUTINE", "Create_user_priv": "CREATE USER", "Event_priv": "EVENT",
    "Trigger_priv": "TRIGGER", "Create_tablespace_priv": "CREATE TABLESPACE",
    "Create_role_priv": "CREATE ROLE", "Drop_role_priv": "DROP ROLE",
    "Delete_history_priv": "DELETE HISTORY",
}
SCHEMA_PRIV_NAMES = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "GRANT OPTION",
                     "REFERENCES", "INDEX", "ALTER", "CREATE TEMPORARY TABLES", "LOCK TABLES",
                     "EXECUTE", "CREATE VIEW", "SHOW VIEW", "CREATE ROUTINE", "ALTER ROUTINE",
                     "EVENT", "TRIGGER"]


def _is_dead(e):
    if isinstance(e, pymysql.err.InterfaceError):
        return True
    return bool(e.args) and e.args[0] in DEAD_CODES


def _dberr(e):
    if isinstance(e, DBError):
        return e
    if isinstance(e, pymysql.err.Error) and len(e.args) >= 2:
        if e.args[0] == 2059 and "auth_gssapi_client" in str(e.args[1]):
            # MariaDB falls back to Windows (GSSAPI) login after a wrong password; PyMySQL can't do that one
            return DBError("Error Code: 1045. Access denied: wrong password (the server then offered Windows "
                           "GSSAPI login, which DBCentral does not support).", code=1045)
        return DBError(f"Error Code: {e.args[0]}. {e.args[1]}", code=e.args[0])
    return DBError(str(e) or e.__class__.__name__)


def _fdb(f):
    db = f.db
    if isinstance(db, (bytes, bytearray)):
        db = db.decode("utf-8", "replace")
    return db or ""


def _first_word(sql):
    s = sql.lstrip()
    # skip leading comments
    while True:
        if s.startswith("--") or s.startswith("#"):
            nl = s.find("\n")
            s = "" if nl < 0 else s[nl + 1:].lstrip()
        elif s.startswith("/*") and not s.startswith("/*!"):
            end = s.find("*/")
            s = "" if end < 0 else s[end + 2:].lstrip()
        else:
            break
    word = ""
    for ch in s:
        if ch.isalpha() or ch == "_":
            word += ch
        else:
            break
    return word.lower()


# Statements whose result can safely be cut short by KILL QUERY (they change nothing).
READ_ONLY_WORDS = {"select", "with", "show", "table", "values", "explain", "describe", "desc", "help", "("}


class MySQLDriver(Driver):
    kind = "mysql"
    features = {
        "schemas": True, "create_schema": True, "routines": True, "admin": True, "users": True,
        "engines": True, "explain_json": True, "export": True,
    }

    def __init__(self, profile, password=None, ssh_secret=None, accept_host_key=None):
        super().__init__(profile, password)
        self.ssh_secret = ssh_secret
        self.accept_host_key = accept_host_key
        self.tunnel = None
        self.conn = None
        self.aux = None
        self.aux_lock = threading.RLock()
        self._closed = False
        self._dead = False
        self._pk_cache = {}
        self.server_version = ""
        self.is_mariadb = False
        self.no_backslash = False
        self.reconnected = False

    # ------------------------------------------------------------------ connect
    def _ssl_context(self):
        p = self.profile
        mode = (p.get("ssl_mode") or "preferred").lower()
        if mode == "disabled":
            return None
        ca = p.get("ssl_ca") or None
        if mode in ("verify_ca", "verify_identity") and not ca:
            raise DBError(f"SSL mode '{mode}' requires a CA certificate file.")
        ctx = _ssl.create_default_context(cafile=ca)
        if mode in ("preferred", "required"):
            ctx.check_hostname = False
            ctx.verify_mode = _ssl.CERT_NONE
        elif mode == "verify_ca":
            ctx.check_hostname = False
            ctx.verify_mode = _ssl.CERT_REQUIRED
        if p.get("ssl_cert"):
            ctx.load_cert_chain(p["ssl_cert"], p.get("ssl_key") or None)
        return ctx

    def _new_conn(self, database=None):
        p = self.profile
        kw = dict(
            host=p.get("host") or "127.0.0.1",
            port=int(p.get("port") or 3306),
            user=p.get("user") or "root",
            password=self.password or "",
            charset="utf8mb4",
            conv=CONV,
            autocommit=True,
            connect_timeout=int(p.get("connect_timeout") or 10),
            program_name="DBCentral",
            local_infile=False,
        )
        if database:
            kw["database"] = database
        if p.get("init_command"):
            kw["init_command"] = p["init_command"]
        sock = None
        if p.get("ssh"):
            if self.tunnel is None:
                from ..sshtunnel import SSHTunnel
                self.tunnel = SSHTunnel(p, self.ssh_secret, self.accept_host_key)
            sock = self.tunnel.open_socket()
        try:
            ctx = self._ssl_context()
            if ctx is not None:
                kw["ssl"] = ctx
            if sock is None:
                conn = pymysql.connect(**kw)
            else:   # through the SSH tunnel; host stays the real name, for SSL hostname checks
                conn = pymysql.connect(**kw, defer_connect=True)
                conn.connect(sock)
                conn.host_info = f"{kw['host']}:{kw['port']} via SSH {self.tunnel.label}"
        except (pymysql.err.Error, OSError, ValueError) as e:
            if sock is not None:
                sock.close()
            raise _dberr(e)
        if (p.get("ssl_mode") or "").lower() in ("required", "verify_ca", "verify_identity"):
            if not isinstance(getattr(conn, "_sock", None), _ssl.SSLSocket):
                conn.close()
                raise DBError("SSL is required, but the server does not support SSL connections.")
        return conn

    def connect(self):
        schema = self.profile.get("schema") or None
        try:
            self.conn = self._new_conn(schema)
        except DBError as e:
            if not schema or type(e).__name__ == "SSHError":
                raise
            self.conn = self._new_conn(None)  # default schema may have been dropped
            schema = None
        self.current_schema = schema
        cur = self.conn.cursor()
        cur.execute("SELECT VERSION(), @@version_comment, CURRENT_USER(), CONNECTION_ID(), @@sql_mode")
        version, comment, user, conn_id, sql_mode = cur.fetchone()
        cur.close()
        self.server_version = version or ""
        self.version_comment = comment or ""
        self.current_user = user
        self.is_mariadb = "mariadb" in (self.server_version + self.version_comment).lower()
        self.no_backslash = "NO_BACKSLASH_ESCAPES" in (sql_mode or "").upper()
        self.last_used = time.time()

    def warm_up(self):
        """Open the metadata connection in the background, so the first query doesn't wait for it."""
        def run():
            with self.aux_lock:
                if self._closed or self.aux is not None:
                    return
                try:
                    self.aux = self._new_conn(None)
                except Exception:   # it is opened on demand later anyway
                    self.aux = None
        threading.Thread(target=run, name="aux-warmup", daemon=True).start()

    def close(self):
        self._closed = True
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass
        with self.aux_lock:
            try:
                if self.aux:
                    self.aux.close()
            except Exception:
                pass
            self.conn = self.aux = None
        if self.tunnel is not None:
            self.tunnel.close()
            self.tunnel = None

    def info(self):
        p = self.profile
        return {
            "driver": "mysql",
            "server_version": self.server_version,
            "version_comment": getattr(self, "version_comment", ""),
            "is_mariadb": self.is_mariadb,
            "user": getattr(self, "current_user", p.get("user")),
            "host": p.get("host") or "127.0.0.1",
            "port": int(p.get("port") or 3306),
            "current_schema": self.current_schema,
            "autocommit": self.autocommit,
            "no_backslash_escapes": self.no_backslash,
            "ssl": isinstance(getattr(self.conn, "_sock", None), _ssl.SSLSocket),
            "ssh": self.tunnel.label if self.tunnel is not None else None,
            "features": self.features,
        }

    def _ensure_main(self):
        if self.conn is None:
            raise DBError("Not connected.")
        if self._dead or time.time() - self.last_used > 60:
            try:
                self.conn.ping(reconnect=False)
                self._dead = False
            except Exception:
                self._reconnect()

    def _reconnect(self):
        try:
            self.conn.close()
        except Exception:
            pass
        try:
            self.conn = self._new_conn(self.current_schema)
        except DBError:
            self.conn = self._new_conn(None)
            self.current_schema = None
        self.conn.autocommit(self.autocommit)
        self._dead = False
        self.reconnected = True

    # ------------------------------------------------------------------ quoting
    def quote_ident(self, name):
        return "`" + str(name).replace("`", "``") + "`"

    def quote_value(self, value):
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, (int, float)):
            return repr(value) if isinstance(value, float) else str(value)
        if isinstance(value, dict) and "$bin" in value:
            return "X'" + value["$bin"] + "'"
        s = str(value)
        if self.no_backslash:
            return "'" + s.replace("'", "''") + "'"
        return "'" + converters.escape_string(s) + "'"

    # ---------------------------------------------------------------- execution
    def _col_info(self, f):
        t = f.type_code
        binary = f.charsetnr == 63
        flags = f.flags
        if flags & FLAG.ENUM:
            name, kind = "ENUM", "enum"
        elif flags & FLAG.SET:
            name, kind = "SET", "enum"
        elif t in BLOB_TYPES:
            name = TYPE_NAMES[t] if binary else TYPE_NAMES[t].replace("BLOB", "TEXT")
            kind = "bin" if binary else "str"
        elif t == FT.VAR_STRING:
            name, kind = ("VARBINARY", "bin") if binary else ("VARCHAR", "str")
        elif t == FT.STRING:
            name, kind = ("BINARY", "bin") if binary else ("CHAR", "str")
        elif t == FT.BIT:
            name, kind = "BIT", "bit"
        elif t == FT.JSON:
            name, kind = "JSON", "json"
        elif t == FT.GEOMETRY:
            name, kind = "GEOMETRY", "bin"
        elif t in NUMERIC_TYPES:
            name, kind = TYPE_NAMES.get(t, str(t)), "num"
            if flags & FLAG.UNSIGNED:
                name += " UNSIGNED"
        elif t in DATE_TYPES:
            name, kind = TYPE_NAMES.get(t, str(t)), "date"
        else:
            name, kind = TYPE_NAMES.get(t, str(t)), "str"
        return {
            "name": f.name, "type": name, "kind": kind, "type_code": t,
            "schema": _fdb(f), "table": f.table_name or "", "org_table": f.org_table or "",
            "org_name": f.org_name or "", "length": f.length, "decimals": f.scale,
            "nullable": not (flags & FLAG.NOT_NULL), "pk": bool(flags & FLAG.PRI_KEY),
            "unsigned": bool(flags & FLAG.UNSIGNED), "auto_increment": bool(flags & FLAG.AUTO_INCREMENT),
            "binary": binary,
        }

    def _pk_columns(self, schema, table):
        key = (schema, table)
        if key not in self._pk_cache:
            rows = self._q(
                "SELECT COLUMN_NAME AS col FROM information_schema.KEY_COLUMN_USAGE "
                "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND CONSTRAINT_NAME='PRIMARY' "
                "ORDER BY ORDINAL_POSITION", (schema, table))
            self._pk_cache[key] = [r["col"] for r in rows]
        return self._pk_cache[key]

    def _editable(self, fields):
        sources = {(_fdb(f), f.org_table) for f in fields if f.org_table}
        if not sources:
            return None, "Read Only: the result is not based on a table."
        if len(sources) > 1:
            return None, "Read Only: the result contains columns from more than one table."
        schema, table = sources.pop()
        if not schema:
            return None, "Read Only: the result is not based on a table."
        try:
            pk = self._pk_columns(schema, table)
        except DBError:
            return None, "Read Only: could not determine the primary key."
        if not pk:
            return None, "Read Only: the table has no primary key (unique row identifier)."
        present = [f.org_name for f in fields if f.org_table == table]
        if not all(c in present for c in pk):
            return None, "Read Only: the primary key column(s) are not part of the result."
        if len(set(present)) != len(present):
            return None, "Read Only: the result contains the same column more than once."
        columns = [f.org_name if f.org_table == table else None for f in fields]
        return {"schema": schema, "table": table, "pk": pk, "columns": columns}, None

    def execute(self, sql, max_rows=0):
        with self.lock:
            self._ensure_main()
            self.reconnected_now = self.reconnected
            self.reconnected = False
            word = _first_word(sql)
            if word in ("alter", "create", "drop", "rename"):
                self._pk_cache.clear()
            # Unbuffered: rows are read as they arrive, so reading can stop at the row cap instead
            # of pulling a huge result into memory and discarding most of it.
            cur = self.conn.cursor(pymysql.cursors.SSCursor)
            t0 = time.perf_counter()
            try:
                cur.execute(sql)
            except pymysql.err.Error as e:
                if _is_dead(e):
                    self._dead = True
                raise _dberr(e)
            finally:
                self.last_used = time.time()
            exec_ms = (time.perf_counter() - t0) * 1000
            t1 = time.perf_counter()
            cap = max_rows if max_rows and max_rows > 0 else HARD_ROW_CAP
            cap = min(cap, HARD_ROW_CAP)
            results = []
            warning_count = 0
            while True:
                res = cur._result
                if cur.description:
                    fields = res.fields
                    cols = [self._col_info(f) for f in fields]
                    try:
                        raw = cur.fetchmany(cap + 1)
                    except pymysql.err.Error as e:
                        if _is_dead(e):
                            self._dead = True
                        if not results:          # same as a failing statement (e.g. stopped with KILL QUERY)
                            try:
                                cur.close()
                            except pymysql.err.Error:
                                self._dead = True
                            raise _dberr(e)
                        results.append({"kind": "error", **_dberr(e).to_dict()})
                        break
                    truncated = len(raw) > cap
                    if truncated:
                        raw = raw[:cap]
                        self._stop_result(res, word in READ_ONLY_WORDS)
                    else:
                        warning_count += res.warning_count or 0
                    bits = [c["kind"] == "bit" for c in cols]
                    rows = [[to_json_value(v, bits[i]) for i, v in enumerate(r)] for r in raw]
                    editable, ro_reason = self._editable(fields)
                    results.append({
                        "kind": "rows", "columns": cols, "rows": rows,
                        "row_count": len(rows) + (1 if truncated else 0),
                        "truncated": truncated, "editable": editable, "read_only_reason": ro_reason,
                    })
                else:
                    if res is not None:
                        warning_count += res.warning_count or 0
                    msg = res.message.decode("utf-8", "replace") if res is not None and res.message else ""
                    results.append({
                        "kind": "status", "affected": cur.rowcount if cur.rowcount is not None else 0,
                        "insert_id": cur.lastrowid or None, "info": msg,
                    })
                try:
                    more = cur.nextset()
                except pymysql.err.Error as e:
                    results.append({"kind": "error", **_dberr(e).to_dict()})
                    break
                if not more:
                    break
            try:
                cur.close()
            except pymysql.err.Error:
                self._dead = True
            warnings = []
            if warning_count:
                try:
                    wc = self.conn.cursor()
                    wc.execute("SHOW WARNINGS")
                    warnings = [{"level": r[0], "code": r[1], "message": r[2]} for r in wc.fetchall()]
                    wc.close()
                except pymysql.err.Error:
                    pass
            if word in ("use", "drop", "create") or self.reconnected_now:
                self._refresh_schema()
            fetch_ms = (time.perf_counter() - t1) * 1000
            return {
                "results": results,
                "exec_ms": round(exec_ms, 3),
                "fetch_ms": round(fetch_ms, 3),
                "warnings": warnings,
                "current_schema": self.current_schema,
                "in_transaction": bool(self.conn.server_status & SERVER_STATUS.SERVER_STATUS_IN_TRANS),
                "reconnected": self.reconnected_now,
            }

    def _stop_result(self, res, interruptible):
        """Stop reading a result set early. For read-only statements the server is asked to stop
        sending (KILL QUERY, like the Stop button); the rest is then skipped without decoding rows."""
        if res is None or not getattr(res, "unbuffered_active", False):
            return
        if interruptible:
            try:
                self.cancel()
            except DBError:
                pass
        try:
            res._finish_unbuffered_query()
        except pymysql.err.OperationalError as e:
            if e.args and e.args[0] == 1317:      # "Query execution was interrupted": expected
                res.unbuffered_active = False
                res.connection = None
            else:
                self._dead = True
                raise _dberr(e)

    def _refresh_schema(self):
        try:
            cur = self.conn.cursor()
            cur.execute("SELECT DATABASE()")
            self.current_schema = cur.fetchone()[0]
            cur.close()
        except pymysql.err.Error:
            pass

    def use_schema(self, schema):
        self.execute(f"USE {self.quote_ident(schema)}")
        return self.current_schema

    def cancel(self):
        if not self.conn:
            return False
        try:
            tid = int(self.conn.thread_id())
        except Exception:
            return False
        c = self._new_conn(None)
        try:
            with c.cursor() as cur:
                cur.execute(f"KILL QUERY {tid}")
        except pymysql.err.Error as e:
            raise _dberr(e)
        finally:
            c.close()
        return True

    def set_autocommit(self, enabled):
        with self.lock:
            self._ensure_main()
            try:
                self.conn.autocommit(bool(enabled))
            except pymysql.err.Error as e:
                raise _dberr(e)
            self.autocommit = bool(enabled)

    def commit(self):
        with self.lock:
            try:
                self.conn.commit()
            except pymysql.err.Error as e:
                raise _dberr(e)

    def rollback(self):
        with self.lock:
            try:
                self.conn.rollback()
            except pymysql.err.Error as e:
                raise _dberr(e)

    def in_transaction(self):
        return bool(self.conn and self.conn.server_status & SERVER_STATUS.SERVER_STATUS_IN_TRANS)

    # -------------------------------------------------------------- aux queries
    def _q(self, sql, args=None):
        with self.aux_lock:
            for attempt in (1, 2):
                try:
                    if self.aux is None:
                        self.aux = self._new_conn(None)
                    with self.aux.cursor(pymysql.cursors.DictCursor) as c:
                        c.execute(sql, args)
                        return list(c.fetchall())
                except pymysql.err.Error as e:
                    if attempt == 1 and _is_dead(e):
                        try:
                            self.aux.close()
                        except Exception:
                            pass
                        self.aux = None
                        continue
                    raise _dberr(e)
        return []

    # ------------------------------------------------------------ introspection
    def list_schemas(self):
        rows = self._q(
            "SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, "
            "DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
        system = {"information_schema", "performance_schema", "mysql", "sys"}
        for r in rows:
            r["system"] = r["name"].lower() in system
        return rows

    def _norm_default(self, c):
        dflt, extra = c["dflt"], (c.get("extra") or "")
        if self.is_mariadb:
            return dflt  # MariaDB already reports defaults as SQL expressions
        if dflt is None:
            return "NULL" if c["nullable"] == "YES" and not c.get("gen_expr") else None
        if "DEFAULT_GENERATED" in extra.upper():
            up = dflt.upper()
            if up.startswith("CURRENT_TIMESTAMP") or up.startswith("NOW("):
                return dflt
            return f"({dflt})"
        if c["data_type"] in ("tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal",
                              "numeric", "float", "double", "real", "bit", "year"):
            return dflt
        return self.quote_value(dflt)

    def schema_objects(self, schema):
        tables = self._q(
            "SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS row_estimate, "
            "DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length, TABLE_COMMENT AS comment, "
            "CREATE_TIME AS created, UPDATE_TIME AS updated, TABLE_COLLATION AS collation, "
            "AUTO_INCREMENT AS auto_increment FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s "
            "ORDER BY TABLE_NAME", (schema,))
        routines = self._q(
            "SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns, "
            "ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=%s "
            "ORDER BY ROUTINE_NAME", (schema,))
        columns = self._columns(schema)
        bycol = {}
        for c in columns:
            bycol.setdefault(c.pop("tbl"), []).append(c)
        return {
            "tables": [t for t in tables if t["type"] != "VIEW"],
            "views": [t for t in tables if t["type"] == "VIEW"],
            "procedures": [r for r in routines if r["type"] == "PROCEDURE"],
            "functions": [r for r in routines if r["type"] == "FUNCTION"],
            "columns": bycol,
        }

    def _columns(self, schema, table=None):
        base = ("SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, ORDINAL_POSITION AS pos, COLUMN_DEFAULT AS dflt, "
                "IS_NULLABLE AS nullable, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type, "
                "CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, COLUMN_KEY AS col_key, "
                "EXTRA AS extra, COLUMN_COMMENT AS comment{gen} FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA=%s{tbl} ORDER BY TABLE_NAME, ORDINAL_POSITION")
        args = (schema,) if table is None else (schema, table)
        tbl = "" if table is None else " AND TABLE_NAME=%s"
        try:
            rows = self._q(base.format(gen=", GENERATION_EXPRESSION AS gen_expr", tbl=tbl), args)
        except DBError:
            rows = self._q(base.format(gen="", tbl=tbl), args)
        for r in rows:
            r["default"] = self._norm_default(r)
            r.pop("dflt", None)
            r["nullable"] = r["nullable"] == "YES"
            if not r.get("gen_expr"):
                r["gen_expr"] = None
        return rows

    def table_details(self, schema, table):
        info = self._q(
            "SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, ROW_FORMAT AS row_format, "
            "TABLE_ROWS AS row_estimate, AVG_ROW_LENGTH AS avg_row_length, DATA_LENGTH AS data_length, "
            "INDEX_LENGTH AS index_length, DATA_FREE AS data_free, AUTO_INCREMENT AS auto_increment, "
            "CREATE_TIME AS created, UPDATE_TIME AS updated, TABLE_COLLATION AS collation, "
            "TABLE_COMMENT AS comment, CREATE_OPTIONS AS create_options FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s", (schema, table))
        if not info:
            raise DBError(f"Table '{schema}.{table}' was not found.")
        columns = self._columns(schema, table)
        for c in columns:
            c.pop("tbl", None)
        idx_rows = self._q(
            "SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, "
            "SUB_PART AS sub_part, INDEX_TYPE AS type, INDEX_COMMENT AS comment, COLLATION AS collation "
            "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s "
            "ORDER BY INDEX_NAME='PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX", (schema, table))
        indexes, by_name = [], {}
        for r in idx_rows:
            ix = by_name.get(r["name"])
            if ix is None:
                ix = {"name": r["name"], "unique": not int(r["non_unique"]), "type": r["type"],
                      "comment": r["comment"] or "", "primary": r["name"] == "PRIMARY", "columns": []}
                by_name[r["name"]] = ix
                indexes.append(ix)
            ix["columns"].append({"name": r["col"], "sub_part": r["sub_part"],
                                  "order": "DESC" if r.get("collation") == "D" else "ASC"})
        fk_rows = self._q(
            "SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS ref_schema, "
            "k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col, "
            "r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete "
            "FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r "
            "ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME "
            "AND r.TABLE_NAME=k.TABLE_NAME "
            "WHERE k.TABLE_SCHEMA=%s AND k.TABLE_NAME=%s AND k.REFERENCED_TABLE_NAME IS NOT NULL "
            "ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION", (schema, table))
        fks, fk_by = [], {}
        for r in fk_rows:
            fk = fk_by.get(r["name"])
            if fk is None:
                fk = {"name": r["name"], "ref_schema": r["ref_schema"], "ref_table": r["ref_table"],
                      "on_update": r["on_update"], "on_delete": r["on_delete"], "columns": [], "ref_columns": []}
                fk_by[r["name"]] = fk
                fks.append(fk)
            fk["columns"].append(r["col"])
            fk["ref_columns"].append(r["ref_col"])
        triggers = self._q(
            "SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, "
            "ACTION_STATEMENT AS body, ACTION_ORDER AS action_order FROM information_schema.TRIGGERS "
            "WHERE EVENT_OBJECT_SCHEMA=%s AND EVENT_OBJECT_TABLE=%s ORDER BY ACTION_TIMING, EVENT_MANIPULATION, "
            "ACTION_ORDER", (schema, table))
        is_view = info[0]["type"] == "VIEW"
        try:
            ddl = self.get_ddl(schema, table, "view" if is_view else "table")
        except DBError as e:
            ddl = f"-- {e.message}"
        return {"info": info[0], "columns": columns, "indexes": indexes, "foreign_keys": fks,
                "triggers": triggers, "ddl": ddl, "is_view": is_view}

    def schema_fks(self, schema):
        rows = self._q(
            "SELECT TABLE_NAME AS tbl, CONSTRAINT_NAME AS name, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS ref_schema, "
            "REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_col FROM information_schema.KEY_COLUMN_USAGE "
            "WHERE TABLE_SCHEMA=%s AND REFERENCED_TABLE_NAME IS NOT NULL "
            "ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION", (schema,))
        out, by = [], {}
        for r in rows:
            k = (r["tbl"], r["name"])
            if k not in by:
                by[k] = {"table": r["tbl"], "name": r["name"], "ref_schema": r["ref_schema"], "ref_table": r["ref_table"],
                         "columns": [], "ref_columns": []}
                out.append(by[k])
            by[k]["columns"].append(r["col"])
            by[k]["ref_columns"].append(r["ref_col"])
        return out

    def routines(self, schema, name=None):
        """Stored procedures and functions of a schema, with parameters and characteristics."""
        extra, args = "", (schema,)
        if name:
            extra, args = " AND ROUTINE_NAME = %s", (schema, name)
        rows = self._q(
            "SELECT ROUTINE_NAME AS name, LOWER(ROUTINE_TYPE) AS type, DTD_IDENTIFIER AS returns, "
            "IS_DETERMINISTIC AS `deterministic`, SQL_DATA_ACCESS AS data_access, SECURITY_TYPE AS `security`, "
            "DEFINER AS definer, CREATED AS created, LAST_ALTERED AS modified, ROUTINE_COMMENT AS comment "
            "FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = %s" + extra +
            " AND ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION') ORDER BY ROUTINE_TYPE DESC, ROUTINE_NAME", args)
        params = self._q(
            "SELECT SPECIFIC_NAME AS routine, LOWER(ROUTINE_TYPE) AS type, ORDINAL_POSITION AS pos, "
            "PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DTD_IDENTIFIER AS dtype, DATA_TYPE AS data_type "
            "FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = %s"
            + extra.replace("ROUTINE_NAME", "SPECIFIC_NAME") +
            " AND ORDINAL_POSITION > 0 ORDER BY SPECIFIC_NAME, ORDINAL_POSITION", args)
        by_key = {}
        for p in params:
            by_key.setdefault((p["type"], p["routine"]), []).append(
                {"mode": p["mode"] or "IN", "name": p["name"], "type": p["dtype"], "data_type": (p["data_type"] or "").lower()})
        for r in rows:
            r["params"] = by_key.get((r["type"], r["name"]), [])
            for k in ("created", "modified"):
                if r.get(k) is not None:
                    r[k] = str(r[k])
        return rows

    def get_ddl(self, schema, name, obj_type):
        kinds = {
            "table": ("TABLE", "Create Table"), "view": ("VIEW", "Create View"),
            "procedure": ("PROCEDURE", "Create Procedure"), "function": ("FUNCTION", "Create Function"),
            "trigger": ("TRIGGER", "SQL Original Statement"), "event": ("EVENT", "Create Event"),
        }
        if obj_type == "schema":
            rows = self._q(f"SHOW CREATE DATABASE {self.quote_ident(name)}")
            return rows[0].get("Create Database") if rows else ""
        kw, col = kinds[obj_type]
        rows = self._q(f"SHOW CREATE {kw} {self.qualified(schema, name)}")
        if not rows:
            raise DBError(f"{obj_type} {name} not found")
        ddl = rows[0].get(col)
        if ddl is None:
            raise DBError(f"You do not have the privileges needed to view the definition of {name}.")
        return ddl

    def explain(self, sql):
        with self.lock:
            tabular = self.execute("EXPLAIN " + sql)
            plan_json = None
            try:
                res = self.execute("EXPLAIN FORMAT=JSON " + sql)
                rows = res["results"][0]["rows"] if res["results"] else []
                plan_json = rows[0][0] if rows else None
            except DBError:
                plan_json = None
        table = next((r for r in tabular["results"] if r["kind"] == "rows"), None)
        return {"table": table, "json": plan_json}

    def meta(self):
        engines = self._q("SHOW ENGINES")
        charsets = self._q("SHOW CHARACTER SET")
        try:  # MariaDB 10.10+ lists UCA-14 collations here with their full names
            collations = [{"Collation": r["c"], "Charset": r["cs"]} for r in self._q(
                "SELECT FULL_COLLATION_NAME AS c, CHARACTER_SET_NAME AS cs "
                "FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY")]
        except DBError:
            collations = self._q("SHOW COLLATION")
        defaults = self._q("SELECT @@default_storage_engine AS engine, @@character_set_server AS charset, "
                           "@@collation_server AS collation")[0]
        return {
            "engines": [e["Engine"] for e in engines if str(e.get("Support", "")).upper() in ("YES", "DEFAULT")],
            "charsets": sorted(
                [{"name": c["Charset"], "default_collation": c["Default collation"],
                  "description": c.get("Description", "")} for c in charsets], key=lambda c: c["name"]),
            "collations": sorted([{"name": c["Collation"], "charset": c["Charset"]} for c in collations
                                  if c.get("Charset")], key=lambda c: c["name"]),
            "defaults": defaults,
        }

    def completion_columns(self, schema):
        rows = self._q("SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty FROM information_schema.COLUMNS "
                       "WHERE TABLE_SCHEMA=%s ORDER BY TABLE_NAME, ORDINAL_POSITION", (schema,))
        out = {}
        for r in rows:
            out.setdefault(r["t"], []).append([r["c"], r["ty"]])
        return out

    # ------------------------------------------------------------------- admin
    def admin_status(self):
        status = {r["Variable_name"]: r["Value"] for r in self._q("SHOW GLOBAL STATUS")}
        wanted = ("version", "version_comment", "version_compile_os", "version_compile_machine", "hostname",
                  "port", "socket", "datadir", "basedir", "tmpdir", "character_set_server", "collation_server",
                  "max_connections", "innodb_buffer_pool_size", "default_storage_engine", "sql_mode",
                  "log_bin", "general_log", "slow_query_log", "time_zone", "system_time_zone", "have_ssl",
                  "ssl_cipher", "lower_case_table_names", "max_allowed_packet", "wait_timeout")
        variables = {r["Variable_name"]: r["Value"] for r in self._q("SHOW GLOBAL VARIABLES")
                     if r["Variable_name"] in wanted}
        return {"status": status, "variables": variables, "time": time.time()}

    def processlist(self):
        try:
            rows = self._q("SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, "
                           "TIME AS time, STATE AS state, INFO AS info FROM information_schema.PROCESSLIST "
                           "ORDER BY ID")
        except DBError:
            rows = [{k.lower(): v for k, v in r.items()} for r in self._q("SHOW FULL PROCESSLIST")]
        own = {self._safe_thread_id(self.conn), self._safe_thread_id(self.aux)}
        for r in rows:
            r["own"] = r.get("id") in own
        return rows

    @staticmethod
    def _safe_thread_id(c):
        try:
            return int(c.thread_id()) if c else None
        except Exception:
            return None

    def kill(self, thread_id, query_only=False):
        self._q(f"KILL {'QUERY ' if query_only else ''}{int(thread_id)}")

    def variables(self, kind):
        sql = "SHOW GLOBAL STATUS" if kind == "status" else "SHOW GLOBAL VARIABLES"
        return [{"name": r["Variable_name"], "value": r["Value"]} for r in self._q(sql)]

    def users(self):
        return self._q("SELECT User AS user, Host AS host FROM mysql.user ORDER BY User, Host")

    def user_details(self, user, host):
        rows = self._q("SELECT * FROM mysql.user WHERE User=%s AND Host=%s", (user, host))
        if not rows:
            raise DBError(f"User '{user}'@'{host}' not found.")
        row = rows[0]
        available = [name for col, name in PRIV_COLUMNS.items() if col in row]
        granted = [name for col, name in PRIV_COLUMNS.items() if col in row and str(row[col]).upper() == "Y"]

        def num(col):
            try:
                return int(row.get(col) or 0)
            except (TypeError, ValueError):
                return 0

        limits = {"max_questions": num("max_questions"), "max_updates": num("max_updates"),
                  "max_connections": num("max_connections"), "max_user_connections": num("max_user_connections")}
        schema_privs = []
        for r in self._q("SELECT * FROM mysql.db WHERE User=%s AND Host=%s ORDER BY Db", (user, host)):
            schema_privs.append({
                "schema": r["Db"],
                "privileges": [name for col, name in PRIV_COLUMNS.items()
                               if col in r and str(r[col]).upper() == "Y"],
            })
        try:
            grants = [list(r.values())[0] for r in self._q("SHOW GRANTS FOR %s@%s", (user, host))]
        except DBError as e:
            grants = [f"-- {e.message}"]
        plugin = row.get("plugin") or ""
        return {"user": user, "host": host, "global_privileges": granted, "available_privileges": available,
                "schema_privileges": schema_privs, "schema_privilege_names": SCHEMA_PRIV_NAMES,
                "limits": limits, "grants": grants, "plugin": plugin,
                "locked": str(row.get("account_locked", "N")).upper() == "Y"}
