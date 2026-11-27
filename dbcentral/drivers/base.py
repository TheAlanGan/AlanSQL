"""Driver base class and helpers shared by the MySQL and SQLite drivers."""
import datetime
import decimal
import math
import threading
import time

HARD_ROW_CAP = 200_000      # never ship more rows than this to the UI
BIN_PREVIEW = 65_536        # bytes of binary data sent for preview
MAX_SAFE_INT = 2 ** 53 - 1


class DBError(Exception):
    def __init__(self, message, code=None, sqlstate=None):
        super().__init__(message)
        self.message = str(message)
        self.code = code
        self.sqlstate = sqlstate

    def to_dict(self):
        return {"message": self.message, "code": self.code, "sqlstate": self.sqlstate}


def to_json_value(v, bit=False):
    """Convert a DB value into something JSON can carry without losing information."""
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return str(v) if abs(v) > MAX_SAFE_INT else v
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return str(v)
        return v
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        if bit:
            return int.from_bytes(b, "big") if b else 0
        return {"$bin": b[:BIN_PREVIEW].hex(), "size": len(b)}
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, datetime.datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, (datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, datetime.timedelta):
        total = int(v.total_seconds())
        sign = "-" if total < 0 else ""
        total = abs(total)
        return f"{sign}{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"
    if isinstance(v, (set, frozenset)):
        return ",".join(sorted(str(x) for x in v))
    return str(v)


class Driver:
    """Interface every driver implements. All public methods are thread-safe."""

    kind = ""
    features = {}

    def __init__(self, profile: dict, password: str | None = None):
        self.profile = profile
        self.password = password
        self.lock = threading.RLock()
        self.autocommit = True
        self.current_schema = None
        self.last_used = time.time()

    # ---- lifecycle -------------------------------------------------------
    def connect(self):
        raise NotImplementedError

    def close(self):
        raise NotImplementedError

    def info(self) -> dict:
        raise NotImplementedError

    # ---- quoting ---------------------------------------------------------
    def quote_ident(self, name: str) -> str:
        raise NotImplementedError

    def quote_value(self, value) -> str:
        raise NotImplementedError

    def qualified(self, schema, name):
        if schema:
            return f"{self.quote_ident(schema)}.{self.quote_ident(name)}"
        return self.quote_ident(name)

    # ---- execution -------------------------------------------------------
    def execute(self, sql: str, max_rows: int = 0) -> dict:
        raise NotImplementedError

    def cancel(self):
        raise NotImplementedError

    def set_autocommit(self, enabled: bool):
        raise NotImplementedError

    def commit(self):
        raise NotImplementedError

    def rollback(self):
        raise NotImplementedError

    def use_schema(self, schema: str):
        raise NotImplementedError

    def run_script(self, statements, stop_on_error=True, transaction=False):
        """Run a list of statements, discarding result rows. Used for apply/review dialogs."""
        out = []
        ok = True
        with self.lock:
            use_tx = transaction and self.autocommit
            if use_tx:
                self.begin()
            for stmt in statements:
                if not stmt or not stmt.strip():
                    continue
                t0 = time.perf_counter()
                try:
                    res = self.execute(stmt, max_rows=1)
                    affected = None
                    for r in res["results"]:
                        if r["kind"] == "status":
                            affected = r.get("affected")
                    out.append({"ok": True, "sql": stmt, "affected": affected,
                                "ms": round((time.perf_counter() - t0) * 1000, 2)})
                except DBError as e:
                    ok = False
                    out.append({"ok": False, "sql": stmt, "error": e.message, "code": e.code,
                                "ms": round((time.perf_counter() - t0) * 1000, 2)})
                    if use_tx:
                        try:
                            self.rollback()
                        except DBError:
                            pass
                        return {"ok": False, "results": out, "rolled_back": True}
                    if stop_on_error:
                        # A script that opened its own transaction (BEGIN ... COMMIT) must not be left half-done.
                        began = any(s.strip().upper().startswith(("BEGIN", "START TRANSACTION")) for s in statements)
                        rolled = False
                        if began and self.in_transaction():
                            try:
                                self.rollback()
                                rolled = True
                            except DBError:
                                pass
                        self.after_script_failure()
                        return {"ok": False, "results": out, "rolled_back": rolled}
            if use_tx and ok:
                self.commit()
        return {"ok": ok, "results": out, "rolled_back": False}

    def in_transaction(self):
        return False

    def after_script_failure(self):
        """Hook to restore session settings after a failed script."""

    def begin(self):
        self.execute("BEGIN" if self.kind == "sqlite" else "START TRANSACTION")

    # ---- result editing --------------------------------------------------
    def build_edits(self, schema, table, changes: dict) -> list:
        t = self.qualified(schema, table)

        def where(pk: dict):
            return " AND ".join(f"{self.quote_ident(k)} = {self.quote_value(v)}" for k, v in pk.items())

        stmts = []
        for d in changes.get("deletes", []):
            stmts.append(f"DELETE FROM {t} WHERE ({where(d['pk'])});")
        for u in changes.get("updates", []):
            if not u.get("set"):
                continue
            sets = ", ".join(f"{self.quote_ident(k)} = {self.quote_value(v)}" for k, v in u["set"].items())
            stmts.append(f"UPDATE {t} SET {sets} WHERE ({where(u['pk'])});")
        for ins in changes.get("inserts", []):
            if ins:
                cols = ", ".join(self.quote_ident(k) for k in ins)
                vals = ", ".join(self.quote_value(v) for v in ins.values())
                stmts.append(f"INSERT INTO {t} ({cols}) VALUES ({vals});")
            else:
                stmts.append(self.empty_insert(t))
        return stmts

    def empty_insert(self, qualified_table):
        return f"INSERT INTO {qualified_table} () VALUES ();"

    # ---- introspection (overridden) ---------------------------------------
    def list_schemas(self):
        raise NotImplementedError

    def schema_objects(self, schema):
        raise NotImplementedError

    def table_details(self, schema, table):
        raise NotImplementedError

    def routines(self, schema, name=None):
        return []

    def get_ddl(self, schema, name, obj_type):
        raise NotImplementedError

    def explain(self, sql):
        raise NotImplementedError

    def meta(self):
        return {}
