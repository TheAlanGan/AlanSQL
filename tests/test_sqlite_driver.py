"""SQLite driver: queries, row cap, result editing, transactions, and dump export / import."""
import pytest

from dbcentral import dump
from dbcentral.drivers.base import DBError
from conftest import FakeJob


@pytest.fixture
def db(sqlite_driver):
    sqlite_driver.execute("CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, data BLOB)")
    sqlite_driver.execute("INSERT INTO a (name, score, data) VALUES ('x', 1.5, x'0102'), ('y', NULL, NULL), ('z', 3, NULL)")
    return sqlite_driver


def test_select_and_types(db):
    r = db.execute("SELECT * FROM a ORDER BY id")["results"][0]
    assert [c["name"] for c in r["columns"]] == ["id", "name", "score", "data"]
    assert r["rows"][0] == [1, "x", 1.5, {"$bin": "0102", "size": 2}]
    assert r["rows"][1][2] is None


def test_row_cap(db):
    r = db.execute("SELECT * FROM a", 2)["results"][0]
    assert len(r["rows"]) == 2 and r["truncated"] is True


def test_status_and_errors(db):
    r = db.execute("UPDATE a SET score = 0 WHERE id > 1")["results"][0]
    assert r == {"kind": "status", "affected": 2, "insert_id": r["insert_id"], "info": ""}
    with pytest.raises(DBError, match="no such column"):
        db.execute("SELECT nope FROM a")


def test_editability(db):
    assert db.execute("SELECT * FROM a")["results"][0]["editable"]["pk"] == ["id"]
    joined = db.execute("SELECT a.name, b.name FROM a JOIN a b ON b.id = a.id")["results"][0]
    assert joined["editable"] is None and "Read Only" in joined["read_only_reason"]


def test_build_edits_and_apply(db):
    stmts = db.build_edits("main", "a", {
        "updates": [{"pk": {"id": 1}, "set": {"name": "it's"}}],
        "deletes": [{"pk": {"id": 3}}],
        "inserts": [{"name": "new", "score": 9}],
    })
    assert stmts[0].startswith("DELETE") and stmts[1].startswith("UPDATE") and stmts[2].startswith("INSERT")
    r = db.run_script(stmts, transaction=True)
    assert r["ok"]
    rows = db.execute("SELECT id, name FROM a ORDER BY id")["results"][0]["rows"]
    assert rows == [[1, "it's"], [2, "y"], [3, "new"]]   # SQLite reuses the freed id


def test_failed_script_in_a_transaction_rolls_back(db):
    r = db.run_script(["UPDATE a SET name = 'changed'", "INSERT INTO a (name) VALUES (NULL)"], transaction=True)
    assert not r["ok"] and r["rolled_back"]
    assert db.execute("SELECT COUNT(*) FROM a WHERE name = 'changed'")["results"][0]["rows"] == [[0]]


def test_manual_commit_mode(db):
    db.set_autocommit(False)
    db.execute("DELETE FROM a")
    assert db.in_transaction()
    db.rollback()
    assert db.execute("SELECT COUNT(*) FROM a")["results"][0]["rows"] == [[3]]
    db.execute("DELETE FROM a WHERE id = 1")
    db.commit()
    db.set_autocommit(True)
    assert db.execute("SELECT COUNT(*) FROM a")["results"][0]["rows"] == [[2]]


def test_introspection(db):
    db.execute("CREATE VIEW v AS SELECT name FROM a")
    o = db.schema_objects("main")
    assert [t["name"] for t in o["tables"]] == ["a"] and [v["name"] for v in o["views"]] == ["v"]
    t = db.table_details("main", "a")
    assert [c["name"] for c in t["columns"]] == ["id", "name", "score", "data"]
    assert "CREATE TABLE" in db.get_ddl("main", "a", "table")
    assert db.routines("main") == []


def test_dump_round_trip(db, tmp_path, sqlite_driver):
    out = str(tmp_path / "dump.sql")
    res = dump.export_sqlite(db, {"schema": "main"}, out, FakeJob())
    assert res["tables"] == 1
    db.execute("DROP TABLE a")
    r = dump.import_sql(db, {}, out, FakeJob())
    assert not r["errors"]
    rows = db.execute("SELECT id, name, score, data FROM a ORDER BY id")["results"][0]["rows"]
    assert rows[0] == [1, "x", 1.5, {"$bin": "0102", "size": 2}] and len(rows) == 3
