"""Data export (SQL dump) and import (run SQL file) for MySQL and SQLite."""
import datetime
import os
import sqlite3
import time

import pymysql
import pymysql.cursors
from pymysql import converters

from . import __version__
from .drivers.base import DBError
from .sqlsplit import split_sql

BATCH_BYTES = 512 * 1024


# --------------------------------------------------------------------------- literals
def _mysql_literal(v, no_backslash=False):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, (bytes, bytearray)):
        return "0x" + bytes(v).hex() if v else "''"
    s = str(v)
    if no_backslash:
        return "'" + s.replace("'", "''") + "'"
    return "'" + converters.escape_string(s) + "'"


def _sqlite_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v) if isinstance(v, float) else str(v)
    if isinstance(v, bytes):
        return "X'" + v.hex() + "'"
    return "'" + str(v).replace("'", "''") + "'"


def _bq(name):
    return "`" + str(name).replace("`", "``") + "`"


def _dq(name):
    return '"' + str(name).replace('"', '""') + '"'


# --------------------------------------------------------------------------- MySQL
def _views_in_dependency_order(views, ddls):
    """Views that select from other views must be created after them."""
    by_name = {v["name"]: v for v in views}
    order, done, visiting = [], set(), set()

    def visit(name):
        if name in done or name in visiting:
            return
        visiting.add(name)
        for other in by_name:
            if other != name and _bq(other) in ddls[name]:
                visit(other)
        visiting.discard(name)
        done.add(name)
        order.append(by_name[name])
    for v in views:
        visit(v["name"])
    return order


def export_mysql(driver, opts, out_path, job):
    schema = opts["schema"]
    content = opts.get("content", "both")  # both | structure | data
    want_structure = content in ("both", "structure")
    want_data = content in ("both", "data")
    conn = driver._new_conn(schema)
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as c:
            c.execute("SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS rows_est "
                      "FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s ORDER BY TABLE_NAME", (schema,))
            all_tables = c.fetchall()
        selected = set(opts.get("tables") or [t["name"] for t in all_tables])
        base_tables = [t for t in all_tables if t["type"] != "VIEW" and t["name"] in selected]
        views = [t for t in all_tables if t["type"] == "VIEW" and t["name"] in selected]
        total_rows = sum(int(t["rows_est"] or 0) for t in base_tables) or 1
        done_rows = 0
        written_rows = 0

        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(f"-- DBCentral {__version__} dump\n")
            f.write(f"-- Host: {driver.profile.get('host')}    Database: {schema}\n")
            f.write(f"-- Server version: {driver.server_version}\n")
            f.write(f"-- Date: {datetime.datetime.now():%Y-%m-%d %H:%M:%S}\n")
            f.write("-- ------------------------------------------------------\n\n")
            f.write("/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n")
            f.write("SET NAMES utf8mb4;\n")
            f.write("/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n")
            f.write("/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n")
            f.write("/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\n")
            if opts.get("create_schema"):
                with conn.cursor() as c:
                    c.execute(f"SHOW CREATE DATABASE {_bq(schema)}")
                    ddl = c.fetchone()[1]
                ddl = ddl.replace("CREATE DATABASE", "CREATE DATABASE /*!32312 IF NOT EXISTS*/", 1)
                f.write(f"{ddl};\nUSE {_bq(schema)};\n\n")

            for i, t in enumerate(base_tables):
                name = t["name"]
                job.update(message=f"Exporting table {name} ({i + 1}/{len(base_tables)})")
                f.write(f"--\n-- Table structure / data for table {_bq(name)}\n--\n\n")
                if want_structure:
                    with conn.cursor() as c:
                        c.execute(f"SHOW CREATE TABLE {_bq(schema)}.{_bq(name)}")
                        ddl = c.fetchone()[1]
                    if opts.get("drop_objects", True):
                        f.write(f"DROP TABLE IF EXISTS {_bq(name)};\n")
                    f.write(ddl + ";\n\n")
                if want_data:
                    with conn.cursor() as c:
                        c.execute("SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s "
                                  "AND TABLE_NAME=%s ORDER BY ORDINAL_POSITION", (schema, name))
                        cols = [r[0] for r in c.fetchall()
                                if "GENERATED" not in (r[1] or "").upper() or "DEFAULT_GENERATED" in (r[1] or "").upper()]
                    if not cols:
                        continue
                    col_list = ", ".join(_bq(c) for c in cols)
                    prefix = f"INSERT INTO {_bq(name)} ({col_list}) VALUES "
                    cur = conn.cursor(pymysql.cursors.SSCursor)
                    try:
                        cur.execute(f"SELECT {col_list} FROM {_bq(schema)}.{_bq(name)}")
                        batch, size, any_rows = [], 0, False
                        for row in cur:
                            lit = "(" + ",".join(_mysql_literal(v, driver.no_backslash) for v in row) + ")"
                            batch.append(lit)
                            size += len(lit)
                            any_rows = True
                            done_rows += 1
                            written_rows += 1
                            if size >= BATCH_BYTES:
                                f.write(prefix + ",\n".join(batch) + ";\n")
                                batch, size = [], 0
                                job.update(progress=min(done_rows / total_rows, 0.99) * 0.95,
                                           message=f"Exporting table {name}: {written_rows:,} rows written")
                        if batch:
                            f.write(prefix + ",\n".join(batch) + ";\n")
                        if any_rows:
                            f.write("\n")
                    finally:
                        cur.close()
                job.update(progress=min(done_rows / total_rows, 0.99) * 0.95)
                job.add_log(f"Table {name} exported.")

            if want_structure:
                ddls = {}
                for v in views:
                    with conn.cursor() as c:
                        c.execute(f"SHOW CREATE VIEW {_bq(schema)}.{_bq(v['name'])}")
                        ddls[v["name"]] = c.fetchone()[1]
                for v in _views_in_dependency_order(views, ddls):
                    ddl = ddls[v["name"]]
                    f.write(f"--\n-- View {_bq(v['name'])}\n--\n\n")
                    if opts.get("drop_objects", True):
                        f.write(f"DROP VIEW IF EXISTS {_bq(v['name'])};\n")
                    f.write(ddl + ";\n\n")
                    job.add_log(f"View {v['name']} exported.")

            if want_structure and opts.get("include_triggers", True) and base_tables:
                names = [t["name"] for t in base_tables]
                with conn.cursor() as c:
                    c.execute("SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS "
                              "WHERE TRIGGER_SCHEMA=%s ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER", (schema,))
                    triggers = [r[0] for r in c.fetchall() if r[1] in names]
                for trg in triggers:
                    with conn.cursor(pymysql.cursors.DictCursor) as c:
                        c.execute(f"SHOW CREATE TRIGGER {_bq(schema)}.{_bq(trg)}")
                        ddl = c.fetchone()["SQL Original Statement"]
                    f.write(f"DROP TRIGGER IF EXISTS {_bq(trg)};\nDELIMITER ;;\n{ddl};;\nDELIMITER ;\n\n")
                    job.add_log(f"Trigger {trg} exported.")

            if want_structure and opts.get("include_routines", True):
                with conn.cursor() as c:
                    c.execute("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES "
                              "WHERE ROUTINE_SCHEMA=%s ORDER BY ROUTINE_TYPE, ROUTINE_NAME", (schema,))
                    routines = c.fetchall()
                for rname, rtype in routines:
                    with conn.cursor(pymysql.cursors.DictCursor) as c:
                        c.execute(f"SHOW CREATE {rtype} {_bq(schema)}.{_bq(rname)}")
                        row = c.fetchone()
                    ddl = row.get(f"Create {rtype.capitalize()}")
                    if not ddl:
                        job.add_log(f"Skipped {rtype.lower()} {rname}: no privilege to read its definition.")
                        continue
                    f.write(f"DROP {rtype} IF EXISTS {_bq(rname)};\nDELIMITER ;;\n{ddl};;\nDELIMITER ;\n\n")
                    job.add_log(f"{rtype.capitalize()} {rname} exported.")

            f.write("/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n")
            f.write("/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n")
            f.write("/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n")
            f.write("/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n")
            f.write(f"\n-- Dump completed {datetime.datetime.now():%Y-%m-%d %H:%M:%S}\n")
    except pymysql.err.Error as e:
        raise DBError(f"Error Code: {e.args[0]}. {e.args[1]}" if len(e.args) > 1 else str(e))
    finally:
        conn.close()
    size = os.path.getsize(out_path)
    return {"path": out_path, "bytes": size, "tables": len(base_tables), "views": len(views),
            "rows": written_rows}


# --------------------------------------------------------------------------- SQLite
def export_sqlite(driver, opts, out_path, job):
    schema = opts.get("schema") or "main"
    content = opts.get("content", "both")
    want_structure = content in ("both", "structure")
    want_data = content in ("both", "data")
    driver.lock.acquire()
    conn = driver.conn
    try:
        master = f"{_dq(schema)}.sqlite_master"
        objs = conn.execute(f"SELECT type, name, tbl_name, sql FROM {master} WHERE name NOT LIKE 'sqlite_%' "
                            "AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 "
                            "WHEN 'view' THEN 2 ELSE 3 END, name").fetchall()
        selected = set(opts.get("tables") or [o[1] for o in objs if o[0] in ("table", "view")])
        tables = [o for o in objs if o[0] == "table" and o[1] in selected]
        written = 0
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(f"-- DBCentral {__version__} dump of {driver.path}\n")
            f.write(f"-- Date: {datetime.datetime.now():%Y-%m-%d %H:%M:%S}\n\n")
            f.write("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n")
            for i, (_, name, _, sql) in enumerate(tables):
                job.update(progress=i / max(len(tables), 1) * 0.95, message=f"Exporting table {name}")
                if want_structure:
                    if opts.get("drop_objects", True):
                        f.write(f"DROP TABLE IF EXISTS {_dq(name)};\n")
                    f.write(sql + ";\n")
                if want_data:
                    cols = [r[1] for r in conn.execute(f"PRAGMA {_dq(schema)}.table_xinfo({_sqlite_literal(name)})")
                            if r[6] == 0]
                    col_list = ", ".join(_dq(c) for c in cols)
                    for row in conn.execute(f"SELECT {col_list} FROM {_dq(schema)}.{_dq(name)}"):
                        f.write(f"INSERT INTO {_dq(name)} ({col_list}) VALUES("
                                + ",".join(_sqlite_literal(v) for v in row) + ");\n")
                        written += 1
                        if written % 5000 == 0:
                            job.update(message=f"Exporting table {name}: {written:,} rows written")
                job.add_log(f"Table {name} exported.")
            if want_structure:
                for typ, name, tbl, sql in objs:
                    if typ == "index" and tbl in selected:
                        f.write(sql + ";\n")
                    elif typ == "view" and name in selected:
                        if opts.get("drop_objects", True):
                            f.write(f"DROP VIEW IF EXISTS {_dq(name)};\n")
                        f.write(sql + ";\n")
                    elif typ == "trigger" and tbl in selected and opts.get("include_triggers", True):
                        f.write(sql + ";\n")
            f.write("COMMIT;\nPRAGMA foreign_keys=ON;\n")
    except sqlite3.Error as e:
        raise DBError(f"Error: {e}")
    finally:
        driver.lock.release()
    return {"path": out_path, "bytes": os.path.getsize(out_path), "tables": len(tables), "rows": written}


# --------------------------------------------------------------------------- import
def import_sql(driver, opts, path, job):
    with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
        text = fh.read()
    total = max(len(text), 1)
    stop_on_error = opts.get("stop_on_error", True)
    schema = opts.get("schema") or None
    errors = []
    executed = 0
    t0 = time.time()
    if driver.kind == "mysql":
        conn = driver._new_conn(schema)

        def run(stmt):
            with conn.cursor() as c:
                c.execute(stmt)
                while c.nextset():
                    pass

        dialect, backslash, err_types = "mysql", not driver.no_backslash, (pymysql.err.Error,)
    else:
        conn = sqlite3.connect(driver.path, isolation_level=None, check_same_thread=False)

        def run(stmt):
            conn.execute(stmt).fetchall()

        dialect, backslash, err_types = "sqlite", False, (sqlite3.Error,)
    try:
        for stmt, offset in split_sql(text, dialect=dialect, backslash=backslash):
            try:
                run(stmt)
                executed += 1
            except err_types as e:
                msg = (f"Error Code: {e.args[0]}. {e.args[1]}" if dialect == "mysql" and len(e.args) > 1
                       else str(e))
                line = text.count("\n", 0, offset) + 1
                errors.append({"line": line, "message": msg, "sql": stmt[:300]})
                job.add_log(f"Line {line}: {msg}")
                if stop_on_error:
                    break
            if executed % 50 == 0:
                job.update(progress=offset / total, message=f"{executed:,} statements executed")
    finally:
        conn.close()
    job.update(progress=1.0, message=f"{executed:,} statements executed, {len(errors)} error(s)")
    return {"executed": executed, "errors": errors[:100], "seconds": round(time.time() - t0, 2)}
