"""Shared test setup.

Every test runs with its own temporary DBCentral data folder and an in-memory password vault, so the
real %APPDATA%\\DBCentral folder and Windows Credential Manager are never touched.

MySQL/MariaDB tests need a server you don't mind the tests creating and dropping schemas on:
    set DBCENTRAL_TEST_MYSQL=user:password@host:port
They are skipped when that variable is not set or the server can't be reached.
"""
import os
import sys
import uuid
from pathlib import Path

import keyring
import keyring.backend
import keyring.errors
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dbcentral import config  # noqa: E402
from dbcentral.drivers import make_driver  # noqa: E402
from dbcentral.sqlsplit import split_sql  # noqa: E402


# ---------------------------------------------------------------------------- isolation
class MemoryKeyring(keyring.backend.KeyringBackend):
    priority = 1

    def __init__(self):
        super().__init__()
        self.store = {}

    def get_password(self, service, username):
        return self.store.get((service, username))

    def set_password(self, service, username, password):
        self.store[(service, username)] = password

    def delete_password(self, service, username):
        if (service, username) not in self.store:
            raise keyring.errors.PasswordDeleteError("not found")
        del self.store[(service, username)]


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch):
    """A fresh data folder per test; also resets the one-time legacy-folder migration flag."""
    data = tmp_path / "appdata"
    monkeypatch.setenv("DBCENTRAL_DATA", str(data))
    monkeypatch.setattr(config, "_migrated", False)
    return data


@pytest.fixture(autouse=True)
def memory_vault():
    previous = keyring.get_keyring()
    vault = MemoryKeyring()
    keyring.set_keyring(vault)
    yield vault
    keyring.set_keyring(previous)


class FakeJob:
    """Stand-in for jobs.Job when calling export/import functions directly."""

    def __init__(self, cancel_after=None):
        self.log, self.updates, self.cancel_after = [], 0, cancel_after

    def update(self, progress=None, message=None):
        from dbcentral.jobs import JobCancelled
        self.updates += 1
        if self.cancel_after is not None and self.updates >= self.cancel_after:
            raise JobCancelled()

    def add_log(self, line):
        self.log.append(line)


@pytest.fixture
def job():
    return FakeJob()


# ---------------------------------------------------------------------------- SQLite
@pytest.fixture
def sqlite_path(tmp_path):
    return str(tmp_path / "test.db")


@pytest.fixture
def sqlite_driver(sqlite_path):
    d = make_driver({"driver": "sqlite", "file": sqlite_path, "create_if_missing": True})
    d.connect()
    yield d
    d.close()


# ---------------------------------------------------------------------------- MySQL / MariaDB
def _mysql_spec():
    spec = os.environ.get("DBCENTRAL_TEST_MYSQL", "").strip()
    if not spec or "@" not in spec:
        return None
    creds, hostport = spec.rsplit("@", 1)
    user, _, password = creds.partition(":")
    host, _, port = hostport.partition(":")
    return {"driver": "mysql", "host": host or "127.0.0.1", "port": int(port or 3306), "user": user or "root",
            "ssl_mode": "preferred"}, password


@pytest.fixture(scope="session")
def mysql_conf():
    spec = _mysql_spec()
    if spec is None:
        pytest.skip("MySQL tests need DBCENTRAL_TEST_MYSQL=user:password@host:port")
    profile, password = spec
    d = make_driver(profile, password)
    try:
        d.connect()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"MySQL test server not reachable: {e}")
    d.close()
    return profile, password


@pytest.fixture
def mysql_driver(mysql_conf):
    profile, password = mysql_conf
    d = make_driver(profile, password)
    d.connect()
    yield d
    d.close()


def run_sql(driver, script):
    """Run a script (DELIMITER-aware) on a separate connection."""
    conn = driver._new_conn(None)
    try:
        with conn.cursor() as cur:
            for stmt, _ in split_sql(script, dialect="mysql", backslash=True):
                cur.execute(stmt)
                while cur.nextset():
                    pass
    finally:
        conn.close()


@pytest.fixture
def make_schema(mysql_driver):
    """Factory for throwaway schemas, dropped after the test."""
    made = []

    def make(prefix="t"):
        name = f"dbcentral_{prefix}_{uuid.uuid4().hex[:8]}"
        run_sql(mysql_driver, f"CREATE DATABASE `{name}`")
        made.append(name)
        return name
    yield make
    for name in made:
        try:
            run_sql(mysql_driver, f"DROP DATABASE IF EXISTS `{name}`")
        except Exception:  # noqa: BLE001
            pass
