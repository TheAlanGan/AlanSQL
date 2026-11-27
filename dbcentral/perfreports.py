"""Performance Reports (like MySQL Workbench's), built on the server's `sys` schema.

Reports read the raw `x$` variants of the sys views, so times (picoseconds) and sizes (bytes) arrive as
numbers. They are converted to seconds and bytes here and formatted in the UI, which keeps sorting numeric.
"""
import datetime
import decimal
import time

import pymysql

from .drivers import DBError

# (id, category, title, view or SQL, needs performance_schema, description)
REPORTS = [
    # Memory
    ("memory_total", "Memory Usage", "Total Memory", "x$memory_global_total", True,
     "Total memory allocated by the server, as tracked by the Performance Schema memory instruments."),
    ("memory_by_event", "Memory Usage", "Top Memory by Event", "x$memory_global_by_current_bytes", True,
     "Memory currently allocated, per kind of allocation (memory instrument)."),
    ("memory_by_user", "Memory Usage", "Top Memory by User", "x$memory_by_user_by_current_bytes", True,
     "Memory currently allocated by each user's threads."),
    ("memory_by_host", "Memory Usage", "Top Memory by Host", "x$memory_by_host_by_current_bytes", True,
     "Memory currently allocated per client host."),
    ("memory_by_thread", "Memory Usage", "Top Memory by Thread", "x$memory_by_thread_by_current_bytes", True,
     "Memory currently allocated per thread (connection or background thread)."),
    # I/O
    ("io_file_bytes", "Hot Spots for I/O", "Top File I/O Activity", "x$io_global_by_file_by_bytes", True,
     "Files with the most read and write traffic. Shows which tables, logs and temporary files are busiest."),
    ("io_file_latency", "Hot Spots for I/O", "Top I/O by File by Time", "x$io_global_by_file_by_latency", True,
     "Files where the server spent the most time waiting for I/O."),
    ("io_wait_bytes", "Hot Spots for I/O", "Top I/O by Event Category", "x$io_global_by_wait_by_bytes", True,
     "I/O traffic grouped by kind of file I/O (InnoDB data, logs, temporary files, ...)."),
    ("io_wait_latency", "Hot Spots for I/O", "Top I/O in Time by Event Category", "x$io_global_by_wait_by_latency", True,
     "Time spent on I/O, grouped by kind of file I/O."),
    ("io_by_thread", "Hot Spots for I/O", "Top I/O Time by User/Thread", "x$io_by_thread_by_latency", True,
     "Threads (users and background threads) that spent the most time on I/O."),
    # Statements
    ("statement_analysis", "High Cost SQL Statements", "Statement Analysis", "x$statement_analysis", True,
     "All statements the server has seen, normalized (literals replaced by ?), with totals for executions, "
     "time, rows examined and sent, temporary tables and sorts. Start here to find expensive queries."),
    ("statements_95th", "High Cost SQL Statements", "Statements in Highest 5 Percent by Runtime",
     "x$statements_with_runtimes_in_95th_percentile", True,
     "Statements whose average runtime is in the slowest 5 percent."),
    ("statements_temp", "High Cost SQL Statements", "Using Temp Tables", "x$statements_with_temp_tables", True,
     "Statements that create temporary tables, especially ones written to disk."),
    ("statements_sorting", "High Cost SQL Statements", "With Sorting", "x$statements_with_sorting", True,
     "Statements that sort rows, including sorts that needed merge passes."),
    ("statements_full_scans", "High Cost SQL Statements", "Full Table Scans", "x$statements_with_full_table_scans", True,
     "Statements that read whole tables or used no good index. Candidates for new indexes."),
    ("statements_errors", "High Cost SQL Statements", "Errors or Warnings", "x$statements_with_errors_or_warnings", True,
     "Statements that produced errors or warnings."),
    # Schema
    ("largest_tables", "Database Schema Statistics", "Largest Tables",
     "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, ENGINE AS engine, TABLE_ROWS AS row_estimate, "
     "DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes, DATA_LENGTH + INDEX_LENGTH AS total_bytes, "
     "DATA_FREE AS free_bytes FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN "
     "('mysql', 'sys', 'performance_schema', 'information_schema') ORDER BY DATA_LENGTH + INDEX_LENGTH DESC", False,
     "Tables by size on disk (data plus indexes). Row counts are estimates for InnoDB."),
    ("schema_overview", "Database Schema Statistics", "Schema Object Overview", "schema_object_overview", False,
     "Number of tables, views, routines, triggers and indexes in each schema. Can be slow on servers with many objects."),
    ("schema_table_stats", "Database Schema Statistics", "Table Statistics", "x$schema_table_statistics", True,
     "Rows read and changed, and time spent, per table."),
    ("schema_table_stats_buffer", "Database Schema Statistics", "Table Statistics (with InnoDB Buffer)",
     "x$schema_table_statistics_with_buffer", True,
     "Table statistics plus how much of each table is in the InnoDB buffer pool. Can be slow with a large buffer pool."),
    ("schema_full_scans", "Database Schema Statistics", "Tables with Full Table Scans", "x$schema_tables_with_full_table_scans", True,
     "Tables that are read in full most often."),
    ("schema_index_stats", "Database Schema Statistics", "Index Statistics", "x$schema_index_statistics", True,
     "How often each index is used to read, insert, update and delete rows, and the time spent."),
    ("schema_unused_indexes", "Database Schema Statistics", "Unused Indexes", "schema_unused_indexes", True,
     "Indexes that have not been used since the server started (or since statistics were reset). "
     "They cost space and slow down writes; review before dropping."),
    ("schema_redundant_indexes", "Database Schema Statistics", "Redundant Indexes", "schema_redundant_indexes", False,
     "Indexes made redundant by another index that covers the same columns. The last column has the DROP statement."),
    ("schema_auto_increment", "Database Schema Statistics", "Auto Increment Columns", "schema_auto_increment_columns", False,
     "AUTO_INCREMENT columns and how much of their type's range is used. A high ratio means the column may soon run out of values."),
    # Waits
    ("waits_global", "Wait Event Times", "Global Waits by Time", "x$waits_global_by_latency", True,
     "What the server spends its time waiting on (locks, I/O, ...), across all threads."),
    ("waits_by_user", "Wait Event Times", "Waits by User by Time", "x$waits_by_user_by_latency", True,
     "Wait time per user."),
    ("waits_by_host", "Wait Event Times", "Waits by Host by Time", "x$waits_by_host_by_latency", True,
     "Wait time per client host."),
    ("wait_classes", "Wait Event Times", "Wait Classes by Time", "x$wait_classes_global_by_latency", True,
     "Wait time grouped into broad classes."),
    ("wait_classes_avg", "Wait Event Times", "Wait Classes by Average Time", "x$wait_classes_global_by_avg_latency", True,
     "Wait classes ordered by their average wait time."),
    # InnoDB
    ("innodb_buffer_schema", "InnoDB Statistics", "Buffer Pool by Schema", "x$innodb_buffer_stats_by_schema", False,
     "How much of the InnoDB buffer pool each schema uses. Scans the whole buffer pool; can be slow on large servers."),
    ("innodb_buffer_table", "InnoDB Statistics", "Buffer Pool by Table", "x$innodb_buffer_stats_by_table", False,
     "How much of the InnoDB buffer pool each table uses. Scans the whole buffer pool; can be slow on large servers."),
    ("innodb_lock_waits", "InnoDB Statistics", "Lock Waits", "x$innodb_lock_waits", False,
     "Transactions that are waiting right now for a row lock held by another transaction, and the statement to kill the blocker."),
    # Users
    ("user_summary", "User Resource Use", "Overview", "x$user_summary", True,
     "Statements, time, table scans, file I/O, connections and memory per user."),
    ("user_file_io", "User Resource Use", "I/O Statistics", "x$user_summary_by_file_io", True,
     "File I/O count and time per user."),
    ("user_statement_type", "User Resource Use", "Statement Statistics", "x$user_summary_by_statement_type", True,
     "Statement counts and time per user and statement type (select, insert, ...)."),
    ("host_summary", "User Resource Use", "Host Overview", "x$host_summary", True,
     "Statements, time, table scans, file I/O, connections and memory per client host."),
]
BY_ID = {r[0]: r for r in REPORTS}

BYTES_COLS = {
    "current_allocated", "current_avg_alloc", "current_max_alloc", "total_allocated", "high_water_alloc",
    "current_alloc", "high_alloc", "high_avg_alloc", "total_alloc",
    "total_read", "avg_read", "total_written", "avg_write", "avg_written", "total_requested", "io_read", "io_write",
    "innodb_buffer_allocated", "innodb_buffer_data", "innodb_buffer_free", "allocated", "data",
    "current_memory", "total_memory_allocated", "data_bytes", "index_bytes", "total_bytes", "free_bytes",
}
EXTRA_BYTES = {"io_file_bytes": {"total"}}
RATIO_COLS = {"auto_increment_ratio"}
SQL_COLS = {"query", "digest_text", "sample_query", "waiting_query", "blocking_query", "sql_kill_blocking_query",
            "sql_kill_blocking_connection", "sql_drop_index", "current_statement", "last_statement"}


def column_format(report_id, name):
    n = name.lower()
    if n in SQL_COLS:
        return "sql"
    if "latency" in n:
        return "time"
    if n in BYTES_COLS or n in EXTRA_BYTES.get(report_id, ()):
        return "bytes"
    if n in RATIO_COLS:
        return "ratio"
    if n.endswith("pct") or n.endswith("_percent"):
        return "pct"
    return None


def status(driver):
    if driver.kind != "mysql":
        raise DBError("Performance reports are available for MySQL and MariaDB connections.")
    row = driver._q("SELECT @@performance_schema AS ps")[0]
    ps = str(row.get("ps")).upper() in ("1", "ON")
    views = {r["n"] for r in driver._q(
        "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'sys'")}
    sys_version = None
    if views:
        try:
            sys_version = driver._q("SELECT sys_version AS v FROM sys.version")[0]["v"]
        except DBError:
            sys_version = "?"
    reports = []
    for rid, cat, title, src, needs_ps, desc in REPORTS:
        custom = src.upper().startswith("SELECT")
        missing = not custom and src not in views
        reports.append({"id": rid, "category": cat, "title": title, "description": desc, "needs_ps": needs_ps,
                        "available": not missing,
                        "reason": "This server has no sys schema (or not this view)." if missing else None})
    return {"performance_schema": ps, "sys_version": sys_version, "is_mariadb": driver.is_mariadb,
            "server": driver.server_version, "reports": reports}


def _value(v, fmt):
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray)):
        v = v.decode("utf-8", "replace")
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time, datetime.timedelta)):
        return str(v)
    if isinstance(v, decimal.Decimal) or (isinstance(v, str) and fmt in ("time", "bytes", "ratio", "pct", "num")):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return v
    if fmt == "time" and isinstance(v, (int, float)):
        return v / 1e12                        # picoseconds -> seconds
    if isinstance(v, float) and v.is_integer() and abs(v) < 2**53 and fmt != "ratio":
        return int(v)
    if isinstance(v, int) and abs(v) >= 2**53:
        return float(v)
    return v


def run(driver, report_id, limit=1000):
    if report_id not in BY_ID:
        raise DBError("Unknown report.")
    _rid, _cat, title, src, _ps, _desc = BY_ID[report_id]
    limit = max(1, min(int(limit or 1000), 100000))
    sql = src if src.upper().startswith("SELECT") else f"SELECT * FROM `sys`.`{src}`"
    sql = f"{sql} LIMIT {limit}"
    t0 = time.perf_counter()
    with driver.aux_lock:
        driver._q("SELECT 1")                  # make sure the metadata connection is open
        try:
            with driver.aux.cursor() as c:
                c.execute(sql)
                names = [d[0] for d in c.description] if c.description else []
                types = [d[1] for d in c.description] if c.description else []
                raw = c.fetchall()
        except pymysql.err.Error as e:
            msg = e.args[1] if len(e.args) > 1 else str(e)
            raise DBError(f"Error Code: {e.args[0]}. {msg}", code=e.args[0]) from None
    numeric = {pymysql.constants.FIELD_TYPE.DECIMAL, pymysql.constants.FIELD_TYPE.NEWDECIMAL,
               pymysql.constants.FIELD_TYPE.LONGLONG, pymysql.constants.FIELD_TYPE.LONG,
               pymysql.constants.FIELD_TYPE.TINY, pymysql.constants.FIELD_TYPE.SHORT,
               pymysql.constants.FIELD_TYPE.INT24, pymysql.constants.FIELD_TYPE.DOUBLE,
               pymysql.constants.FIELD_TYPE.FLOAT}
    cols = []
    for n, t in zip(names, types):
        fmt = column_format(report_id, n) or ("num" if t in numeric else None)
        cols.append({"name": n, "format": fmt})
    rows = [[_value(v, col["format"]) for v, col in zip(r, cols)] for r in raw]
    return {"title": title, "columns": cols, "rows": rows, "sql": sql, "truncated": len(rows) >= limit,
            "ms": round((time.perf_counter() - t0) * 1000, 1)}


def reset(driver):
    """Clear the collected Performance Schema statistics (sys.ps_truncate_all_tables)."""
    try:
        r = driver._q("CALL sys.ps_truncate_all_tables(FALSE)")
    except DBError as e:
        raise DBError(f"Could not reset the statistics: {e.message}") from None
    return {"tables": (r[0].get("summary") if r else None)}

