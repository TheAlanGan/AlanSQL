"""Generic ODBC connections.

Unit tests run everywhere. The live tests use Microsoft's Access and Text ODBC drivers (part of the
Access Database Engine, which ships with Office); they are skipped on PCs without those drivers.
"""
import datetime
import decimal
import subprocess
import uuid

import pytest

from dbcentral.drivers import make_driver
from dbcentral.drivers.base import DBError
from dbcentral.drivers.odbc import NO_SCHEMA, ODBCDriver, _value, connection_string

ACCESS = "Microsoft Access Driver (*.mdb, *.accdb)"
TEXT = "Microsoft Access Text Driver (*.txt, *.csv)"


# ---------------------------------------------------------------------------- unit tests
def test_connection_string_from_dsn_and_login():
    p = {"odbc_mode": "dsn", "odbc_dsn": "Sales DB", "user": "app"}
    assert connection_string(p, "pa;ss") == "DSN={Sales DB};UID=app;PWD={pa;ss};"
    assert connection_string({"odbc_mode": "dsn", "odbc_dsn": "x"}) == "DSN=x;"


def test_connection_string_from_text():
    p = {"odbc_mode": "string", "odbc_connstr": "DRIVER={SQL Server};SERVER=db1;", "user": "sa"}
    assert connection_string(p, "x}y") == "DRIVER={SQL Server};SERVER=db1;UID=sa;PWD={x}}y};"
    assert connection_string({"odbc_mode": "string", "odbc_connstr": "DSN=a"}, "ignored-without-user") == "DSN=a;"


@pytest.mark.parametrize("profile", [{"odbc_mode": "dsn"}, {"odbc_mode": "string", "odbc_connstr": "  "}])
def test_connection_string_requires_a_source(profile):
    with pytest.raises(DBError):
        connection_string(profile)


def test_error_messages_are_cleaned_up():
    e = ODBCDriver._err(Exception("07002", "[Microsoft][ODBC Microsoft Access Driver] Too few parameters. Expected 1. (-3010) (SQLExecDirectW)"))
    assert e.message == "Too few parameters. Expected 1. [SQLSTATE 07002]" and e.code == "07002"


@pytest.mark.parametrize("quote, name, expected", [
    ('"', 'my "t"', '"my ""t"""'),
    ("`", "a`b", "`a``b`"),
    ("[", "a]b", "[a]]b]"),
])
def test_identifier_quoting_follows_the_driver(quote, name, expected):
    d = ODBCDriver({"driver": "odbc"})
    d.quote_char = quote
    assert d.quote_ident(name) == expected


def test_qualified_names_with_and_without_schemas():
    d = ODBCDriver({"driver": "odbc"})
    assert d.qualified("dbo", "t") == '"dbo"."t"'
    d.has_schemas = False
    assert d.qualified(NO_SCHEMA, "t") == '"t"' and d.qualified("anything", "t") == '"t"'


def test_value_conversion():
    u = uuid.uuid4()
    assert [_value(v) for v in (True, False, u, decimal.Decimal("1.50"), datetime.date(2024, 1, 2), None)] == \
        [1, 0, str(u), "1.50", "2024-01-02", None]


def test_mysql_only_tools_are_switched_off():
    f = ODBCDriver({"driver": "odbc"}).features
    assert not any(f[k] for k in ("table_editor", "object_editor", "import_wizard", "export", "admin", "edit_results"))


# ---------------------------------------------------------------------------- live tests
def _drivers():
    try:
        import pyodbc
        return pyodbc.drivers()
    except Exception:  # noqa: BLE001
        return []


needs_access = pytest.mark.skipif(ACCESS not in _drivers(), reason="needs Microsoft's Access ODBC driver")
needs_text = pytest.mark.skipif(TEXT not in _drivers(), reason="needs Microsoft's Access Text ODBC driver")


@pytest.fixture
def access_db(tmp_path):
    path = tmp_path / "test.accdb"
    ps = (f"$c = New-Object -ComObject ADOX.Catalog; "
          f"$c.Create('Provider=Microsoft.ACE.OLEDB.12.0;Data Source={path}') | Out-Null; $c.ActiveConnection.Close()")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not path.exists():
        pytest.skip("could not create an Access database file: " + r.stderr.strip()[:200])
    d = make_driver({"driver": "odbc", "odbc_mode": "string", "odbc_connstr": f"DRIVER={{{ACCESS}}};DBQ={path}"})
    d.connect()
    for sql in ["CREATE TABLE customers (id COUNTER PRIMARY KEY, name TEXT(100) NOT NULL, balance CURRENCY, "
                "joined DATETIME, active YESNO)",
                "CREATE TABLE orders (id COUNTER PRIMARY KEY, customer_id LONG, total DOUBLE)",
                "CREATE INDEX idx_name ON customers (name)",
                "INSERT INTO customers (name, balance, joined, active) VALUES ('Ann', 12.5, #2024-01-02#, True)",
                "INSERT INTO customers (name, balance, joined, active) VALUES ('O''Neil', NULL, NULL, False)",
                "CREATE VIEW rich AS SELECT name FROM customers WHERE balance > 10"]:
        d.execute(sql)
    for i in range(15):
        d.execute(f"INSERT INTO orders (customer_id, total) VALUES (1, {i})")
    yield d
    d.close()


@needs_access
def test_access_catalog(access_db):
    d = access_db
    assert d.info()["has_schemas"] is False and d.info()["quote_char"] == "`"
    assert d.list_schemas() == [{"name": NO_SCHEMA, "system": False}]
    o = d.schema_objects(NO_SCHEMA)
    assert sorted(t["name"] for t in o["tables"]) == ["customers", "orders"] and [v["name"] for v in o["views"]] == ["rich"]
    assert [c["name"] for c in o["columns"]["customers"]] == ["id", "name", "balance", "joined", "active"]


@needs_access
def test_access_primary_key_found_from_indexes(access_db):
    t = access_db.table_details(NO_SCHEMA, "customers")    # this driver can't report primary keys directly
    assert [c["col_key"] for c in t["columns"]][0] == "PRI"
    assert any(ix["primary"] and [c["name"] for c in ix["columns"]] == ["id"] for ix in t["indexes"])
    assert t["info"]["row_estimate"] == 2
    assert "PRIMARY KEY (`id`)" in t["ddl"] and t["ddl"].lstrip().startswith("-- Generated")
    assert access_db.table_details(NO_SCHEMA, "rich")["is_view"] is True


@needs_access
def test_access_queries(access_db):
    r = access_db.execute("SELECT name, balance, joined, active FROM customers ORDER BY id")["results"][0]
    assert r["rows"] == [["Ann", "12.5000", "2024-01-02 00:00:00", 1], ["O'Neil", None, None, 0]]
    assert [c["kind"] for c in r["columns"]] == ["str", "num", "date", "bit"] and r["editable"] is None
    capped = access_db.execute("SELECT * FROM orders", 10)["results"][0]
    assert len(capped["rows"]) == 10 and capped["truncated"]
    assert access_db.execute("UPDATE orders SET total = total + 1")["results"][0]["affected"] == 15
    with pytest.raises(DBError, match="SQLSTATE"):
        access_db.execute("SELECT nope FROM customers")


@needs_access
def test_access_transactions(access_db):
    r = access_db.run_script(["DELETE FROM orders", "INSERT INTO missing_table VALUES (1)"], transaction=True)
    assert not r["ok"] and r["rolled_back"]
    assert access_db.execute("SELECT COUNT(*) FROM orders")["results"][0]["rows"] == [[15]]
    assert access_db.conn.autocommit is True                 # back to normal after the script
    access_db.set_autocommit(False)
    access_db.execute("DELETE FROM orders")
    assert access_db.in_transaction()
    access_db.rollback()
    access_db.set_autocommit(True)
    assert access_db.execute("SELECT COUNT(*) FROM orders")["results"][0]["rows"] == [[15]]


@needs_text
def test_text_driver_reads_csv_files(tmp_path):
    (tmp_path / "people.csv").write_text("id,name,score\n1,Ann,1.5\n2,Bob,3\n", encoding="utf-8")
    d = make_driver({"driver": "odbc", "odbc_mode": "string", "odbc_connstr": f"DRIVER={{{TEXT}}};DBQ={tmp_path}"})
    d.connect()
    try:
        assert [t["name"] for t in d.schema_objects(NO_SCHEMA)["tables"]] == ["people.csv"]
        assert d.execute("SELECT name FROM `people.csv` WHERE score > 2")["results"][0]["rows"] == [["Bob"]]
    finally:
        d.close()


@needs_access
def test_api_session_and_password_rules(access_db, tmp_path):
    from dbcentral import sessions
    from dbcentral.server import create_app
    h = {"X-DBCentral-Token": "t", "Host": "127.0.0.1:8765"}
    c = create_app("t", 8765).test_client()
    connstr = access_db.profile["odbc_connstr"]
    try:
        assert c.get("/api/odbc/sources", headers=h).get_json()["drivers"]
        p = c.post("/api/connections", json={"profile": {"name": "a", "driver": "odbc", "odbc_mode": "string", "odbc_connstr": connstr}},
                   headers=h).get_json()["connection"]
        s = c.post("/api/sessions", json={"connection_id": p["id"], "client_id": "x"}, headers=h)
        assert s.status_code == 200, s.get_json()                   # no user name: no password prompt
        sid = s.get_json()["sid"]
        rows = c.post(f"/api/sessions/{sid}/execute", json={"sql": "SELECT COUNT(*) FROM customers"}, headers=h).get_json()
        assert rows["results"][0]["rows"] == [[2]]
        with_user = c.post("/api/connections", json={"profile": {"name": "b", "driver": "odbc", "odbc_mode": "dsn",
                                                                 "odbc_dsn": "x", "user": "app"}}, headers=h).get_json()["connection"]
        need = c.post("/api/sessions", json={"connection_id": with_user["id"], "client_id": "x"}, headers=h)
        assert need.status_code == 401 and need.get_json()["need"] == ["password"]
    finally:
        sessions.close_all()
