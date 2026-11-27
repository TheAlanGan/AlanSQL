"""Against a real MySQL/MariaDB server (skipped unless DBCENTRAL_TEST_MYSQL is set).
Every test works in its own throwaway schema, which is dropped afterwards."""
import pytest

from dbcentral import dataimport, dump, perfreports, schemadiff
from dbcentral.drivers.base import DBError
from dbcentral.sqlsplit import split_sql
from conftest import FakeJob, run_sql

pytestmark = pytest.mark.mysql


def results(driver, sql, max_rows=0):
    return driver.execute(sql, max_rows)["results"]


def alive(driver):
    return results(driver, "SELECT 1")[0]["rows"] == [[1]]


# ---------------------------------------------------------------------------- queries
def test_query_kinds(mysql_driver, make_schema):
    s = make_schema()
    run_sql(mysql_driver, f"CREATE TABLE `{s}`.t (id INT PRIMARY KEY, v VARCHAR(10), d DECIMAL(10,2), b BIT(1))")
    st = results(mysql_driver, f"INSERT INTO `{s}`.t VALUES (1, 'a', 1.50, 1), (2, NULL, NULL, 0)")[0]
    assert st["kind"] == "status" and st["affected"] == 2
    r = results(mysql_driver, f"SELECT * FROM `{s}`.t ORDER BY id")[0]
    assert r["rows"] == [[1, "a", "1.50", 1], [2, None, None, 0]]
    assert r["editable"]["pk"] == ["id"]
    w = mysql_driver.execute("SELECT CAST('12abc' AS SIGNED) AS v")      # SIGNED works on MySQL and MariaDB
    assert w["warnings"] and w["warnings"][0]["code"] == 1292
    with pytest.raises(DBError):
        mysql_driver.execute("SELEC 1")
    assert alive(mysql_driver)


def test_row_cap_stops_reading_and_connection_survives(mysql_driver, make_schema):
    s = make_schema()
    run_sql(mysql_driver, f"""
        CREATE TABLE `{s}`.d (i INT);
        INSERT INTO `{s}`.d VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);
        CREATE TABLE `{s}`.n (i INT PRIMARY KEY);
        INSERT INTO `{s}`.n SELECT a.i + 10 * b.i + 100 * c.i + 1000 * e.i + 1
          FROM `{s}`.d a, `{s}`.d b, `{s}`.d c, `{s}`.d e WHERE e.i < 5;
    """)
    r = results(mysql_driver, f"SELECT * FROM `{s}`.n", 10)[0]
    assert len(r["rows"]) == 10 and r["truncated"]
    assert alive(mysql_driver)
    full = results(mysql_driver, f"SELECT * FROM `{s}`.n")[0]
    assert len(full["rows"]) == 5000 and not full["truncated"]


def test_procedure_results_are_drained_not_killed(mysql_driver, make_schema):
    s = make_schema()
    run_sql(mysql_driver, f"""
        CREATE TABLE `{s}`.n (i INT);
        INSERT INTO `{s}`.n VALUES (1), (2), (3), (4), (5);
        DELIMITER $$
        CREATE PROCEDURE `{s}`.two() BEGIN SELECT * FROM `{s}`.n; SELECT 'second' AS r; END$$
        DELIMITER ;
    """)
    res = results(mysql_driver, f"CALL `{s}`.two()", 2)
    assert [x["kind"] for x in res] == ["rows", "rows", "status"]
    assert res[0]["truncated"] and res[1]["rows"] == [["second"]]
    assert alive(mysql_driver)


def test_cancel_interrupts_a_running_query(mysql_driver):
    import threading
    import time
    t = threading.Timer(0.5, mysql_driver.cancel)
    t.start()
    start = time.time()
    try:
        r = mysql_driver.execute("SELECT SLEEP(10)")
        # MySQL: an interrupted SLEEP() returns 1 instead of failing
        assert r["results"][0]["rows"] == [[1]]
    except DBError as e:
        # MariaDB: reports the statement as interrupted
        assert "1317" in e.message or "interrupted" in e.message
    assert time.time() - start < 5 and alive(mysql_driver)


# ---------------------------------------------------------------------------- routines
def test_routines(mysql_driver, make_schema):
    s = make_schema()
    run_sql(mysql_driver, f"""
        DELIMITER $$
        CREATE PROCEDURE `{s}`.p(IN a INT, OUT b VARCHAR(5), INOUT c INT) COMMENT 'demo' BEGIN SET b = 'ok'; SET c = c + a; END$$
        CREATE FUNCTION `{s}`.p(x INT) RETURNS INT DETERMINISTIC RETURN x * 2$$
        DELIMITER ;
    """)
    rs = {(r["type"], r["name"]): r for r in mysql_driver.routines(s)}
    proc, func = rs[("procedure", "p")], rs[("function", "p")]
    assert [(x["mode"], x["name"]) for x in proc["params"]] == [("IN", "a"), ("OUT", "b"), ("INOUT", "c")]
    assert proc["comment"] == "demo" and func["deterministic"] == "YES" and func["returns"].startswith("int")
    mysql_driver.execute("SET @c = 4")
    mysql_driver.execute(f"CALL `{s}`.p(3, @b, @c)")
    assert results(mysql_driver, "SELECT @b, @c")[0]["rows"] == [["ok", 7]]


# ---------------------------------------------------------------------------- import
def test_csv_import_into_mysql(mysql_driver, make_schema, tmp_path):
    s = make_schema()
    p = tmp_path / "c.csv"
    p.write_text("id,name,joined,amount,active\n1,Ann,2024-01-02,12.50,true\n2,Bob,,7,false\n", encoding="utf-8")
    pv = dataimport.preview(mysql_driver, str(p), {})
    types = {c["name"]: c["type"] for c in pv["columns"]}
    assert types == {"id": "INT", "name": "VARCHAR(32)", "joined": "DATE", "amount": "DECIMAL(10,2)", "active": "TINYINT(1)"}
    cols = [{"name": c["name"], "type": c["type"], "pk": c["name"] == "id"} for c in pv["columns"]]
    opts = {"schema": s, "table": "people", "create": True, "columns": cols,
            "mapping": [{"source": i, "target": c["name"], "type": c["type"]} for i, c in enumerate(cols)], **pv["options"]}
    r = dataimport.import_data(mysql_driver, opts, str(p), FakeJob())
    assert r["inserted"] == 2
    rows = results(mysql_driver, f"SELECT * FROM `{s}`.people ORDER BY id")[0]["rows"]
    assert rows == [[1, "Ann", "2024-01-02", "12.50", 1], [2, "Bob", None, "7.00", 0]]


# ---------------------------------------------------------------------------- schema sync
SRC = """
CREATE TABLE {s}.customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(255),
  created DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_email (email), KEY idx_name (name)) COMMENT='Customers';
CREATE TABLE {s}.orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT, total DECIMAL(10,2),
  status ENUM('new','paid') DEFAULT 'new', KEY idx_cust (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES {s}.customers (id) ON DELETE CASCADE,
  CONSTRAINT chk_total CHECK (total >= 0));
CREATE TABLE {s}.products (id INT PRIMARY KEY, sku VARCHAR(32) NOT NULL UNIQUE);
CREATE VIEW {s}.v_totals AS SELECT c.name, SUM(o.total) AS total FROM {s}.orders o JOIN {s}.customers c ON c.id = o.customer_id GROUP BY c.name;
CREATE VIEW {s}.v_big AS SELECT * FROM {s}.v_totals WHERE total > 100;
DELIMITER $$
CREATE FUNCTION {s}.tax(x DECIMAL(10,2)) RETURNS DECIMAL(10,2) DETERMINISTIC RETURN x * 0.2$$
CREATE TRIGGER {s}.trg BEFORE INSERT ON {s}.orders FOR EACH ROW BEGIN IF NEW.status IS NULL THEN SET NEW.status = 'new'; END IF; END$$
DELIMITER ;
"""
TGT = """
CREATE TABLE {s}.customers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100), name VARCHAR(50) NOT NULL,
  legacy TINYINT, KEY idx_email (email));
CREATE TABLE {s}.orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT, total DECIMAL(8,2), KEY idx_cust (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES {s}.customers (id) ON DELETE RESTRICT);
CREATE TABLE {s}.old_table (id INT PRIMARY KEY);
CREATE VIEW {s}.v_totals AS SELECT 1 AS x;
CREATE VIEW {s}.v_old AS SELECT 2 AS y;
DELIMITER $$
CREATE PROCEDURE {s}.p_old() BEGIN SELECT 1; END$$
DELIMITER ;
INSERT INTO {s}.customers (email, name, legacy) VALUES ('a@x.com', 'Ann', 1), ('b@x.com', 'Bob', 0);
INSERT INTO {s}.orders (customer_id, total) VALUES (1, 10.5), (2, 250);
"""


def sync_script(r, include_drops=True):
    chosen = [it for it in r["items"] if it["status"] in ("create", "alter") or (include_drops and it["status"] == "drop")]
    order = {it["id"]: i for i, it in enumerate(r["items"])}
    stmts = sorted(((s["phase"], s["order"], order[it["id"]], s["sql"]) for it in chosen for s in it["statements"]))
    text = "SET FOREIGN_KEY_CHECKS = 0;\n" + "\n".join(x[3] if x[3].startswith("DELIMITER") else x[3] + ";" for x in stmts)
    return [s for s, _ in split_sql(text + "\nSET FOREIGN_KEY_CHECKS = 1;", dialect="mysql", backslash=True)]


def test_schema_sync_round_trip_keeps_data(mysql_driver, make_schema):
    src, tgt = make_schema("src"), make_schema("tgt")
    run_sql(mysql_driver, SRC.format(s=f"`{src}`"))
    run_sql(mysql_driver, TGT.format(s=f"`{tgt}`"))
    r = schemadiff.compare(mysql_driver, src, mysql_driver, tgt)
    status = {it["id"]: it["status"] for it in r["items"]}
    assert status["table:customers"] == "alter" and status["table:products"] == "create"
    assert status["table:old_table"] == "drop" and status["view:v_big"] == "create" and status["trigger:trg"] == "create"
    applied = schemadiff.apply_script(mysql_driver, sync_script(r))
    assert applied["ok"], [x for x in applied["results"] if not x["ok"]]
    again = schemadiff.compare(mysql_driver, src, mysql_driver, tgt)
    assert set(again["counts"]) == {"same"}, [it["id"] for it in again["items"] if it["status"] != "same"]
    rows = results(mysql_driver, f"SELECT id, name, email FROM `{tgt}`.customers ORDER BY id")[0]["rows"]
    assert rows == [[1, "Ann", "a@x.com"], [2, "Bob", "b@x.com"]]
    cols = results(mysql_driver, f"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '{tgt}' "
                                 "AND TABLE_NAME = 'customers' ORDER BY ORDINAL_POSITION")[0]["rows"]
    assert [c[0] for c in cols] == ["id", "name", "email", "created"]


def test_schema_sync_without_drops_leaves_extra_objects(mysql_driver, make_schema):
    src, tgt = make_schema("src"), make_schema("tgt")
    run_sql(mysql_driver, SRC.format(s=f"`{src}`"))
    run_sql(mysql_driver, TGT.format(s=f"`{tgt}`"))
    r = schemadiff.compare(mysql_driver, src, mysql_driver, tgt)
    assert schemadiff.apply_script(mysql_driver, sync_script(r, include_drops=False))["ok"]
    left = schemadiff.compare(mysql_driver, src, mysql_driver, tgt)["counts"]
    assert left.get("drop") == 3 and "create" not in left and "alter" not in left   # old_table, v_old, p_old


def test_compare_refuses_the_same_schema(mysql_driver, make_schema):
    s = make_schema()
    with pytest.raises(DBError):
        schemadiff.compare(mysql_driver, s, mysql_driver, s)


# ---------------------------------------------------------------------------- export / reports
def test_mysql_backup_and_restore(mysql_driver, make_schema, tmp_path):
    """Export, drop the schema, recreate it, import: everything comes back, including a view that
    reads another view (views must be written in dependency order) and the trigger."""
    s = make_schema()
    run_sql(mysql_driver, SRC.format(s=f"`{s}`"))
    run_sql(mysql_driver, f"INSERT INTO `{s}`.customers (name, email) VALUES ('O''Neil', 'o@x.com')")
    run_sql(mysql_driver, f"INSERT INTO `{s}`.orders (customer_id, total) VALUES (1, 150)")
    out = str(tmp_path / "d.sql")
    dump.export_mysql(mysql_driver, {"schema": s}, out, FakeJob())
    text = open(out, encoding="utf-8").read()
    assert text.index("View `v_totals`") < text.index("View `v_big`")
    run_sql(mysql_driver, f"DROP DATABASE `{s}`; CREATE DATABASE `{s}`")
    r = dump.import_sql(mysql_driver, {"schema": s}, out, FakeJob())
    assert not r["errors"], r["errors"]
    assert results(mysql_driver, f"SELECT name, total FROM `{s}`.v_big")[0]["rows"] == [["O'Neil", "150.00"]]
    assert results(mysql_driver, f"SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '{s}'")[0]["rows"] == [[1]]


def test_performance_reports_run(mysql_driver):
    st = perfreports.status(mysql_driver)
    for rep in st["reports"]:
        if rep["available"] and rep["id"] not in ("schema_overview", "schema_table_stats_buffer"):
            res = perfreports.run(mysql_driver, rep["id"], 5)
            assert len(res["rows"]) <= 5 and res["columns"], rep["id"]
