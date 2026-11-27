"""Table Data Import Wizard backend: read CSV / JSON files, infer column types, insert rows."""
import codecs
import csv
import json
import os
import re
import sqlite3
import time

import pymysql

from .drivers import DBError

csv.field_size_limit(2**31 - 1)

SAMPLE_BYTES = 256 * 1024
PREVIEW_ROWS = 100
FULL_SCAN_BYTES = 64 * 1024 * 1024     # files up to this size are scanned completely for row count / types
INFER_ROWS = 20000                     # rows used for type inference in bigger files
BATCH_ROWS = 500

JSON_EXTS = {".json", ".jsonl", ".ndjson"}
DELIMITERS = [",", ";", "\t", "|"]

_INT = re.compile(r"^[+-]?(0|[1-9]\d*)$")
_DEC = re.compile(r"^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)$")
_FLOAT = re.compile(r"^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.(\d{1,6}))?)?$")
_TIME = re.compile(r"^-?\d{1,3}:\d{2}(:\d{2})?$")
_BOOL = {"true", "false"}
_TYPE_OK = re.compile(r"^[A-Za-z][A-Za-z0-9_ ]*(\([0-9A-Za-z_ ,'\-]*\))?[A-Za-z0-9_ ]*$")
_INT_TYPES = {"tinyint", "smallint", "mediumint", "int", "integer", "bigint", "bit", "bool", "boolean", "year"}
_TEXT_TYPES = {"char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set", "json",
               "clob", "nchar", "nvarchar", "character", "varying character", "native character", ""}


# ---------------------------------------------------------------------------- file reading
def detect_format(path, fmt=None):
    if fmt in ("csv", "json"):
        return fmt
    return "json" if os.path.splitext(path)[1].lower() in JSON_EXTS else "csv"


def detect_encoding(raw):
    if raw.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    if raw.startswith(codecs.BOM_UTF16_LE) or raw.startswith(codecs.BOM_UTF16_BE):
        return "utf-16"
    try:
        codecs.getincrementaldecoder("utf-8")().decode(raw, final=False)
        return "utf-8"
    except UnicodeDecodeError:
        return "cp1252"


def detect_delimiter(text):
    lines = [ln for ln in text.splitlines()[:50] if ln.strip()]
    if not lines:
        return ","
    try:
        return csv.Sniffer().sniff("\n".join(lines), delimiters="".join(DELIMITERS)).delimiter
    except csv.Error:
        counts = {d: lines[0].count(d) for d in DELIMITERS}
        best = max(counts, key=counts.get)
        return best if counts[best] else ","


def _open_text(path, encoding):
    return open(path, "r", encoding=encoding, newline="", errors="strict")


def _decode_error(e, encoding):
    return DBError(f"The file is not valid {encoding} text (byte {e.start:,} in the current block). "
                   "Choose a different encoding.")


def resolve_options(path, opts):
    """Fill in auto-detected settings (format, encoding, delimiter)."""
    o = dict(opts or {})
    o["format"] = detect_format(path, o.get("format"))
    with open(path, "rb") as fh:
        raw = fh.read(SAMPLE_BYTES)
    if not o.get("encoding") or o["encoding"] == "auto":
        o["encoding"] = detect_encoding(raw)
    if o["format"] == "csv":
        if not o.get("delimiter") or o["delimiter"] == "auto":
            text = codecs.getincrementaldecoder(o["encoding"])(errors="replace").decode(raw, final=False)
            o["delimiter"] = detect_delimiter(text)
        if o.get("quotechar") in (None, "", "auto"):
            o["quotechar"] = '"'
        elif o["quotechar"] == "none":
            o["quotechar"] = ""
        o.setdefault("header", True)
    o["skip_rows"] = max(0, int(o.get("skip_rows") or 0))
    return o


class Source:
    """Iterates the rows of a CSV or JSON file as lists, after the header (if any)."""

    def __init__(self, path, o):
        self.path = path
        self.o = o
        self.size = os.path.getsize(path)
        self.columns = []
        self._fh = None
        self._rows = None

    def position(self):
        try:
            return self._fh.buffer.tell() if self._fh else self.size
        except (OSError, ValueError, AttributeError):
            return 0

    def __enter__(self):
        o = self.o
        try:
            if o["format"] == "csv":
                self._open_csv()
            else:
                self._open_json()
        except UnicodeDecodeError as e:
            self.close()
            raise _decode_error(e, o["encoding"]) from None
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        if self._fh:
            self._fh.close()
            self._fh = None

    def _open_csv(self):
        o = self.o
        self._fh = _open_text(self.path, o["encoding"])
        quote = o.get("quotechar") or ""
        reader = csv.reader(self._fh, delimiter=o["delimiter"], quotechar=quote or None,
                            quoting=csv.QUOTE_MINIMAL if quote else csv.QUOTE_NONE, doublequote=True,
                            escapechar=o.get("escapechar") or None, skipinitialspace=False, strict=False)
        for _ in range(o["skip_rows"]):
            if next(reader, None) is None:
                break
        rows = (r for r in reader if r and not (len(r) == 1 and r[0] == ""))
        first = next(rows, None)
        if first is None:
            self._rows = iter(())
            return
        if o.get("header", True):
            self.columns = unique_names(first)
            self._rows = rows
        else:
            self.columns = [f"column_{i + 1}" for i in range(len(first))]
            self._rows = _chain([first], rows)

    def _open_json(self):
        o = self.o
        with _open_text(self.path, o["encoding"]) as fh:
            text = fh.read()
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            if "Extra data" not in e.msg:
                raise DBError(f"Invalid JSON: {e.msg} (line {e.lineno}, column {e.colno}).") from None
            data = []
            for n, line in enumerate(text.splitlines(), 1):
                if line.strip():
                    try:
                        data.append(json.loads(line))
                    except json.JSONDecodeError as e2:
                        raise DBError(f"Invalid JSON Lines file: {e2.msg} on line {n}.") from None
        if isinstance(data, dict):
            arrays = [v for v in data.values() if isinstance(v, list)]
            data = arrays[0] if arrays else [data]
        if not isinstance(data, list):
            raise DBError("The JSON file must contain an array of objects (or arrays).")
        data = data[o["skip_rows"]:]
        if data and all(isinstance(r, dict) for r in data):
            keys, seen = [], set()
            for r in data:
                for k in r:
                    if k not in seen:
                        seen.add(k)
                        keys.append(k)
            self.columns = unique_names([str(k) for k in keys])
            self._rows = ([r.get(k) for k in keys] for r in data)
        elif data and all(isinstance(r, list) for r in data):
            width = max(len(r) for r in data)
            if o.get("header") and all(isinstance(v, str) for v in data[0]):
                self.columns = unique_names(data[0] + [f"column_{i + 1}" for i in range(len(data[0]), width)])
                data = data[1:]
            else:
                self.columns = [f"column_{i + 1}" for i in range(width)]
            self._rows = iter(data)
        elif not data:
            self._rows = iter(())
        else:
            self.columns = ["value"]
            self._rows = ([v] for v in data)
        self.json_rows = len(data)

    def __iter__(self):
        try:
            for row in self._rows:
                yield row
        except UnicodeDecodeError as e:
            raise _decode_error(e, self.o["encoding"]) from None
        except csv.Error as e:
            raise DBError(f"CSV parse error: {e}") from None


def _chain(*its):
    for it in its:
        yield from it


def unique_names(names):
    out, seen = [], set()
    for i, n in enumerate(names):
        n = (n or "").strip().strip("﻿") or f"column_{i + 1}"
        base, k = n, 2
        while n.lower() in seen:
            n = f"{base}_{k}"
            k += 1
        seen.add(n.lower())
        out.append(n)
    return out


def cell_text(v):
    """Preview representation (strings, None, numbers stay as they are)."""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return v


# ---------------------------------------------------------------------------- type inference
class TypeGuess:
    def __init__(self):
        self.count = 0
        self.int = self.dec = self.float = self.date = self.datetime = self.time = self.bool = True
        self.json = True
        self.int_big = False
        self.int_digits = self.frac_digits = self.frac_dt = 0
        self.maxlen = 0

    def add(self, v):
        if v is None:
            return
        if isinstance(v, bool):
            s = "true" if v else "false"
        elif isinstance(v, (dict, list)):
            self.count += 1
            self.int = self.dec = self.float = self.date = self.datetime = self.time = self.bool = False
            self.maxlen = max(self.maxlen, len(json.dumps(v, ensure_ascii=False)))
            return
        elif isinstance(v, (int, float)):
            s = repr(v)
        else:
            s = str(v).strip()
            if s == "":
                return
        self.count += 1
        self.json = False
        self.maxlen = max(self.maxlen, len(s))
        if self.bool and s.lower() not in _BOOL:
            self.bool = False
        if self.int:
            if _INT.match(s):
                n = int(s)
                if not -2147483648 <= n <= 2147483647:
                    self.int_big = True
                if not -9223372036854775808 <= n <= 9223372036854775807:
                    self.int = False
            else:
                self.int = False
        if self.dec:
            m = _DEC.match(s)
            if m:
                whole, _, frac = s.lstrip("+-").partition(".")
                self.int_digits = max(self.int_digits, len(whole.lstrip("0")) or 1)
                self.frac_digits = max(self.frac_digits, len(frac))
            else:
                self.dec = False
        if self.float and not _FLOAT.match(s):
            self.float = False
        if self.date and not _DATE.match(s):
            self.date = False
        if self.datetime:
            m = _DATETIME.match(s)
            if m:
                self.frac_dt = max(self.frac_dt, len(m.group(3) or ""))
            elif not _DATE.match(s):
                self.datetime = False
        if self.time and not _TIME.match(s):
            self.time = False

    def sql_type(self, dialect):
        lite = dialect == "sqlite"
        if not self.count:
            return "TEXT" if lite else "VARCHAR(255)"
        if self.json:
            return "TEXT" if lite else "JSON"
        if self.bool:
            return "INTEGER" if lite else "TINYINT(1)"
        if self.int:
            return "INTEGER" if lite else ("BIGINT" if self.int_big else "INT")
        if self.dec:
            if lite:
                return "REAL"
            p = self.int_digits + self.frac_digits
            if p <= 65 and self.frac_digits <= 30:
                return f"DECIMAL({min(max(p + 2, 10), 65)},{self.frac_digits})"
            return "DOUBLE"
        if self.float:
            return "REAL" if lite else "DOUBLE"
        if lite:
            return "TEXT"
        if self.date:
            return "DATE"
        if self.datetime:
            return f"DATETIME({self.frac_dt})" if self.frac_dt else "DATETIME"
        if self.time:
            return "TIME"
        if self.maxlen <= 255:
            for n in (32, 64, 128, 255):
                if self.maxlen * 1.5 <= n or n == 255:
                    return f"VARCHAR({n})"
        if self.maxlen <= 16000:
            return "TEXT"
        if self.maxlen <= 4000000:
            return "MEDIUMTEXT"
        return "LONGTEXT"


def preview(driver, path, opts):
    o = resolve_options(path, opts)
    rows, total = [], 0
    full = os.path.getsize(path) <= FULL_SCAN_BYTES
    with Source(path, o) as src:
        guesses = [TypeGuess() for _ in src.columns]
        for row in src:
            total += 1
            if total <= PREVIEW_ROWS:
                rows.append([cell_text(v) for v in row])
            if full or total <= INFER_ROWS:
                if len(row) > len(guesses):
                    for i in range(len(guesses), len(row)):
                        src.columns.append(f"column_{i + 1}")
                        guesses.append(TypeGuess())
                for g, v in zip(guesses, row):
                    g.add(v)
            elif not full:
                break
        columns = src.columns
        estimated = False
        if not full and total > INFER_ROWS:
            pos = src.position()
            total = int(total * src.size / pos) if pos else total
            estimated = True
    dialect = driver.kind
    return {
        "options": {k: o.get(k) for k in ("format", "encoding", "delimiter", "quotechar", "header", "skip_rows")},
        "columns": [{"name": c, "type": g.sql_type(dialect)} for c, g in zip(columns, guesses)],
        "rows": rows,
        "total_rows": total,
        "estimated": estimated,
        "size": os.path.getsize(path),
    }


# ---------------------------------------------------------------------------- import
def _check_type(t):
    t = (t or "").strip()
    if not t or not _TYPE_OK.match(t):
        raise DBError(f"Invalid column type: {t or '(empty)'}")
    return t


def create_table_sql(driver, schema, table, columns, drop=False):
    q = driver.quote_ident
    name = f"{q(schema)}.{q(table)}" if schema else q(table)
    if not table:
        raise DBError("Enter a name for the new table.")
    if not columns:
        raise DBError("Select at least one column to import.")
    pk = [c["name"] for c in columns if c.get("pk")]
    lines = []
    for c in columns:
        if not (c.get("name") or "").strip():
            raise DBError("Every imported column needs a name.")
        lines.append(f"  {q(c['name'])} {_check_type(c.get('type'))}{' NOT NULL' if c.get('pk') else ''}")
    if pk:
        lines.append(f"  PRIMARY KEY ({', '.join(q(n) for n in pk)})")
    stmts = []
    if drop:
        stmts.append(f"DROP TABLE IF EXISTS {name}")
    stmts.append(f"CREATE TABLE {name} (\n" + ",\n".join(lines) + "\n)")
    return stmts


class _Conn:
    """Dedicated connection for the import, so the user's session stays usable."""

    def __init__(self, driver, schema, fk_checks):
        self.kind = driver.kind
        if self.kind == "mysql":
            self.conn = driver._new_conn(schema or None)
            self.ph = "%s"
            self.errors = (pymysql.err.Error,)
            if not fk_checks:
                self.execute("SET SESSION FOREIGN_KEY_CHECKS = 0")
        else:
            self.conn = sqlite3.connect(driver.path, isolation_level=None, check_same_thread=False, timeout=30)
            self.ph = "?"
            self.errors = (sqlite3.Error,)
            try:
                with driver.lock:
                    dbs = driver.conn.execute("PRAGMA database_list").fetchall() if driver.conn else []
            except sqlite3.Error:
                dbs = []
            for _seq, name, file in dbs:
                if name not in ("main", "temp") and file:
                    self.conn.execute("ATTACH DATABASE ? AS " + driver.quote_ident(name), (file,))
            self.conn.execute(f"PRAGMA foreign_keys = {'ON' if fk_checks else 'OFF'}")

    def execute(self, sql, args=None):
        if self.kind == "mysql":
            with self.conn.cursor() as c:
                c.execute(sql, args)
        else:
            self.conn.execute(sql, args or ())

    def executemany(self, sql, rows):
        if self.kind == "mysql":
            with self.conn.cursor() as c:
                c.executemany(sql, rows)
        else:
            self.conn.executemany(sql, rows)

    def begin(self):
        self.execute("START TRANSACTION" if self.kind == "mysql" else "BEGIN")

    def commit(self):
        self.execute("COMMIT")

    def rollback(self):
        try:
            self.execute("ROLLBACK")
        except Exception:  # noqa: BLE001
            pass

    def message(self, e):
        if self.kind == "mysql" and len(e.args) > 1:
            return f"Error Code: {e.args[0]}. {e.args[1]}"
        return str(e)

    def close(self):
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass


def _converter(target_type, opts):
    base = (target_type or "").lower().split("(")[0].strip()
    base = base.replace(" unsigned", "").replace(" zerofill", "").strip()
    is_int = base in _INT_TYPES
    is_text = base in _TEXT_TYPES or "char" in base or "text" in base or "clob" in base
    empty = opts.get("empty", "auto")           # auto | null | keep
    nulls = set(opts.get("null_strings") or [])
    trim = opts.get("trim", False)
    empty_null = empty == "null" or (empty == "auto" and not is_text)

    def conv(v):
        if v is None:
            return None
        if isinstance(v, bool):
            return 1 if v else 0
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
        if not isinstance(v, str):
            return v
        if trim:
            v = v.strip()
        if v in nulls:
            return None
        if v == "" and empty_null:
            return None
        if is_int and v.lower() in _BOOL:
            return 1 if v.lower() == "true" else 0
        return v
    return conv


def import_data(driver, opts, path, job):
    """Run the import. opts: file options + schema, table, create, columns, mapping, truncate, ..."""
    t0 = time.time()
    o = resolve_options(path, opts)
    schema = opts.get("schema") or None
    table = opts.get("table")
    mapping = [m for m in (opts.get("mapping") or []) if m.get("target")]
    if not table:
        raise DBError("No destination table.")
    if not mapping:
        raise DBError("No columns are mapped to the destination table.")
    on_error = opts.get("on_error", "stop")
    q = driver.quote_ident
    target = f"{q(schema)}.{q(table)}" if schema else q(table)
    types = {m["target"]: m.get("type") for m in mapping}
    convs = [(int(m["source"]), _converter(types[m["target"]], opts)) for m in mapping]
    conn = _Conn(driver, schema, opts.get("fk_checks", True))
    insert = (f"INSERT INTO {target} ({', '.join(q(m['target']) for m in mapping)}) "
              f"VALUES ({', '.join([conn.ph] * len(mapping))})")
    inserted = skipped = 0
    errors = []
    created = False
    try:
        if opts.get("create"):
            for stmt in create_table_sql(driver, schema, table, opts.get("columns") or [], opts.get("drop")):
                job.add_log(stmt.split("\n")[0] + (" ..." if "\n" in stmt else ""))
                try:
                    conn.execute(stmt)
                except conn.errors as e:
                    raise DBError(conn.message(e)) from None
            created = True
        conn.begin()
        if opts.get("truncate") and not opts.get("create"):
            job.add_log(f"DELETE FROM {target}")
            conn.execute(f"DELETE FROM {target}")

        def flush(batch, first_row):
            nonlocal inserted, skipped
            # The savepoint makes a failed batch all-or-nothing: SQLite's executemany keeps the rows
            # before the failing one, which would otherwise be inserted twice by the retry below.
            conn.execute("SAVEPOINT dbcentral_batch")
            try:
                conn.executemany(insert, batch)
                conn.execute("RELEASE SAVEPOINT dbcentral_batch")
                inserted += len(batch)
                return
            except conn.errors:
                conn.execute("ROLLBACK TO SAVEPOINT dbcentral_batch")
                conn.execute("RELEASE SAVEPOINT dbcentral_batch")
            for i, values in enumerate(batch):     # find the failing row(s)
                try:
                    conn.execute(insert, values)
                    inserted += 1
                except conn.errors as e:
                    n = first_row + i
                    msg = conn.message(e)
                    if on_error == "stop":
                        raise DBError(f"Row {n:,}: {msg}") from None
                    skipped += 1
                    if skipped <= 100:
                        errors.append({"row": n, "message": msg})
                        job.add_log(f"Row {n:,} skipped: {msg}")
                    elif skipped == 101:
                        job.add_log("More rows were skipped; only the first 100 are listed.")

        with Source(path, o) as src:
            size = max(src.size, 1)
            batch, n, first = [], 0, 1
            for row in src:
                n += 1
                batch.append([c(row[i] if i < len(row) else None) for i, c in convs])
                if len(batch) >= BATCH_ROWS:
                    flush(batch, first)
                    batch, first = [], n + 1
                    job.update(progress=min(src.position() / size, 0.99),
                               message=f"{inserted:,} rows imported" + (f", {skipped:,} skipped" if skipped else ""))
            if batch:
                flush(batch, first)
        job.update(message="Committing...")
        conn.commit()
    except BaseException as e:
        conn.rollback()
        if created:
            job.add_log("The new table was created, but no rows were kept.")
        if isinstance(e, DBError):
            job.add_log(e.message)
        raise
    finally:
        conn.close()
    secs = round(time.time() - t0, 2)
    job.update(progress=1.0, message=f"{inserted:,} rows imported in {secs}s" + (f", {skipped:,} skipped" if skipped else ""))
    return {"inserted": inserted, "skipped": skipped, "errors": errors, "seconds": secs, "created": created,
            "schema": schema, "table": table}
