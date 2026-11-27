"""The local HTTP API, through Flask's test client, using a SQLite connection."""
import time

import pytest

from dbcentral import dialogs, sessions
from dbcentral.server import create_app

TOKEN = "test-token"
H = {"X-DBCentral-Token": TOKEN, "Host": "127.0.0.1:8765"}


@pytest.fixture
def client():
    app = create_app(TOKEN, 8765)
    c = app.test_client()
    yield c
    sessions.close_all()


def call(c, method, url, json=None, status=200):
    r = getattr(c, method)(url, json=json, headers=H)
    assert r.status_code == status, (url, r.status_code, r.get_json())
    return r.get_json()


@pytest.fixture
def session(client, sqlite_path):
    conn = call(client, "post", "/api/connections", {"profile": {"name": "t", "driver": "sqlite", "file": sqlite_path, "create_if_missing": True}})["connection"]
    s = call(client, "post", "/api/sessions", {"connection_id": conn["id"], "client_id": "tests"})
    return s["sid"]


def test_requests_need_the_token_and_local_host(client):
    assert client.get("/api/ping", headers={"Host": "127.0.0.1:8765"}).status_code == 200
    assert client.get("/api/connections", headers={"Host": "127.0.0.1:8765"}).status_code == 403
    assert client.get("/api/connections", headers={"X-DBCentral-Token": TOKEN, "Host": "evil.example:8765"}).status_code == 403
    assert client.get("/api/connections", headers={"X-DBCentral-Token": "wrong", "Host": "127.0.0.1:8765"}).status_code == 403


def test_connection_crud_and_groups(client):
    c = call(client, "post", "/api/connections", {"profile": {"name": "a", "driver": "mysql"}})["connection"]
    call(client, "post", "/api/connections/set-group", {"ids": [c["id"]], "group": "Prod"})
    assert call(client, "get", "/api/connections")["connections"][0]["group"] == "Prod"
    dup = call(client, "post", f"/api/connections/{c['id']}/duplicate")["connection"]
    assert dup["name"] == "a (copy)"
    call(client, "delete", f"/api/connections/{c['id']}")
    assert [x["name"] for x in call(client, "get", "/api/connections")["connections"]] == ["a (copy)"]


def test_mysql_session_without_password_asks_for_one(client):
    c = call(client, "post", "/api/connections", {"profile": {"name": "m", "driver": "mysql", "host": "127.0.0.1", "port": 1}})["connection"]
    r = call(client, "post", "/api/sessions", {"connection_id": c["id"], "client_id": "x"}, status=401)
    assert r["need_password"] and r["need"] == ["password"]


def test_query_and_metadata(client, session):
    call(client, "post", f"/api/sessions/{session}/execute", {"sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"})
    call(client, "post", f"/api/sessions/{session}/execute", {"sql": "INSERT INTO t (v) VALUES ('a'), ('b')"})
    r = call(client, "post", f"/api/sessions/{session}/execute", {"sql": "SELECT * FROM t ORDER BY id"})
    assert r["results"][0]["rows"] == [[1, "a"], [2, "b"]]
    err = call(client, "post", f"/api/sessions/{session}/execute", {"sql": "SELECT nope"}, status=400)
    assert "no such column" in err["error"]
    assert [x["name"] for x in call(client, "get", f"/api/sessions/{session}/objects?schema=main")["tables"]] == ["t"]
    assert "CREATE TABLE" in call(client, "get", f"/api/sessions/{session}/ddl?schema=main&name=t&type=table")["ddl"]
    assert call(client, "get", f"/api/sessions/{session}/routines?schema=main")["routines"] == []


def test_mysql_only_features_refuse_sqlite(client, session):
    call(client, "get", f"/api/sessions/{session}/perf/status", status=400)
    call(client, "post", "/api/schema-diff", {"source": {"sid": session, "schema": "main"}, "target": {"sid": session, "schema": "main"}}, status=400)


def test_files_need_dialog_approval(client, tmp_path):
    p = tmp_path / "x.sql"
    p.write_text("SELECT 1;", encoding="utf-8")
    call(client, "post", "/api/files/read", {"path": str(p)}, status=400)
    dialogs.approve(str(p))
    assert call(client, "post", "/api/files/read", {"path": str(p)})["content"] == "SELECT 1;"


def test_state_store(client):
    call(client, "put", "/api/state/prefs", {"value": {"theme": "dark"}})
    assert call(client, "get", "/api/state/prefs")["value"] == {"theme": "dark"}
    assert client.get("/api/state/..%2Fsecrets", headers=H).status_code in (400, 404)


def test_export_import_jobs(client, session, tmp_path):
    call(client, "post", f"/api/sessions/{session}/execute", {"sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"})
    call(client, "post", f"/api/sessions/{session}/execute", {"sql": "INSERT INTO t (v) VALUES ('kept')"})
    out = str(tmp_path / "d.sql")
    dialogs.approve(out)

    def wait(job):
        for _ in range(100):
            j = call(client, "get", f"/api/jobs/{job['id']}")["job"]
            if j["status"] != "running":
                return j
            time.sleep(0.05)
        raise AssertionError("job did not finish")
    assert wait(call(client, "post", f"/api/sessions/{session}/export", {"path": out, "schema": "main"})["job"])["status"] == "done"
    call(client, "post", f"/api/sessions/{session}/execute", {"sql": "DROP TABLE t"})
    assert wait(call(client, "post", f"/api/sessions/{session}/import", {"path": out})["job"])["status"] == "done"
    assert call(client, "post", f"/api/sessions/{session}/execute", {"sql": "SELECT v FROM t"})["results"][0]["rows"] == [["kept"]]
