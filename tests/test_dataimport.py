"""CSV / JSON import: reading files, guessing column types, converting values, and full imports
into SQLite (stop vs skip on errors, truncate, cancel)."""
import json

import pytest

from dbcentral import dataimport
from dbcentral.drivers.base import DBError
from dbcentral.jobs import JobCancelled
from conftest import FakeJob


def write(tmp_path, name, text, encoding="utf-8"):
    p = tmp_path / name
    p.write_bytes(text.encode(encoding))
    return str(p)


# ---------------------------------------------------------------------------- detection
def test_detects_encoding_delimiter_and_format(tmp_path):
    p = write(tmp_path, "semi.csv", "code;city\n01234;München\n", "cp1252")
    o = dataimport.resolve_options(p, {})
    assert (o["format"], o["encoding"], o["delimiter"]) == ("csv", "cp1252", ";")
    p = write(tmp_path, "tabs.txt", "﻿a\tb\n1\t2\n")
    o = dataimport.resolve_options(p, {})
    assert (o["encoding"], o["delimiter"]) == ("utf-8-sig", "\t")
    assert dataimport.resolve_options(write(tmp_path, "x.jsonl", '{"a":1}\n'), {})["format"] == "json"


def test_unique_column_names():
    assert dataimport.unique_names(["id", "ID", "", "name", "name"]) == ["id", "ID_2", "column_3", "name", "name_2"]


# ---------------------------------------------------------------------------- type inference
@pytest.mark.parametrize("values, mysql, sqlite", [
    (["1", "2", "-3"], "INT", "INTEGER"),
    (["1", "9999999999"], "BIGINT", "INTEGER"),
    (["01234", "00999"], "VARCHAR(32)", "TEXT"),            # leading zeros: keep as text
    (["12.50", "7", "-0.5"], "DECIMAL(10,2)", "REAL"),
    (["1e3", "2.5E-2"], "DOUBLE", "REAL"),
    (["true", "FALSE"], "TINYINT(1)", "INTEGER"),
    (["2024-01-02", "2024-12-31"], "DATE", "TEXT"),
    (["2024-01-02", "2024-02-03 10:11:12"], "DATETIME", "TEXT"),
    (["2024-01-02T03:04:05.123"], "DATETIME(3)", "TEXT"),
    (["12:30", "08:00:00"], "TIME", "TEXT"),
    (["", None], "VARCHAR(255)", "TEXT"),
    (["x" * 300], "TEXT", "TEXT"),
])
def test_type_guess(values, mysql, sqlite):
    g = dataimport.TypeGuess()
    for v in values:
        g.add(v)
    assert g.sql_type("mysql") == mysql
    assert g.sql_type("sqlite") == sqlite


def test_json_values_guess_json_type():
    g = dataimport.TypeGuess()
    g.add({"x": 1})
    assert g.sql_type("mysql") == "JSON"


def test_value_conversion():
    conv = dataimport._converter("int(11)", {"null_strings": ["NULL"]})
    assert [conv(v) for v in ["5", "", "NULL", "true", True, None]] == ["5", None, None, 1, 1, None]
    text = dataimport._converter("varchar(10)", {"trim": True})
    assert [text(v) for v in ["  a ", "", {"k": 1}]] == ["a", "", '{"k": 1}']
    always = dataimport._converter("varchar(10)", {"empty": "null"})
    assert always("") is None


# ---------------------------------------------------------------------------- preview
def test_preview_csv(sqlite_driver, tmp_path):
    p = write(tmp_path, "a.csv", 'id,name,note\n1,"Smith, John","line1\nline2"\n2,Zoë,\n')
    r = dataimport.preview(sqlite_driver, p, {})
    assert [c["name"] for c in r["columns"]] == ["id", "name", "note"]
    assert r["rows"][0] == ["1", "Smith, John", "line1\nline2"] and r["total_rows"] == 2


def test_preview_json_variants(sqlite_driver, tmp_path):
    p = write(tmp_path, "w.json", json.dumps({"data": [{"a": 1, "b": {"x": 1}}, {"a": 2, "c": "hi"}]}))
    r = dataimport.preview(sqlite_driver, p, {})
    assert [c["name"] for c in r["columns"]] == ["a", "b", "c"]
    assert r["rows"][0] == [1, '{"x": 1}', None]
    lines = write(tmp_path, "l.jsonl", '{"a":1}\n{"a":2,"b":true}\n')
    assert dataimport.preview(sqlite_driver, lines, {})["total_rows"] == 2
    with pytest.raises(DBError):
        dataimport.preview(sqlite_driver, write(tmp_path, "bad.json", "[1, 2"), {})


def test_wrong_encoding_is_reported(sqlite_driver, tmp_path):
    p = write(tmp_path, "c.csv", "a\nM\xfcnchen\n", "cp1252")
    with pytest.raises(DBError, match="not valid utf-8"):
        dataimport.preview(sqlite_driver, p, {"encoding": "utf-8"})


# ---------------------------------------------------------------------------- full imports (SQLite)
def import_opts(driver, path, **extra):
    p = dataimport.preview(driver, path, {})
    cols = [{"name": c["name"], "type": c["type"], "pk": c["name"] == "id"} for c in p["columns"]]
    mapping = [{"source": i, "target": c["name"], "type": c["type"]} for i, c in enumerate(cols)]
    return {"schema": "main", "table": "people", "create": True, "columns": cols, "mapping": mapping, **p["options"], **extra}


def rows(driver, sql):
    return driver.conn.execute(sql).fetchall()


def test_import_into_new_table(sqlite_driver, tmp_path, job):
    p = write(tmp_path, "p.csv", "id,name,score\n1,Ann,1.5\n2,Bob,\n3,Cy,2\n")
    r = dataimport.import_data(sqlite_driver, import_opts(sqlite_driver, p), p, job)
    assert (r["inserted"], r["skipped"], r["created"]) == (3, 0, True)
    assert rows(sqlite_driver, "SELECT * FROM people ORDER BY id") == [(1, "Ann", 1.5), (2, "Bob", None), (3, "Cy", 2.0)]


def test_stop_on_error_rolls_everything_back(sqlite_driver, tmp_path, job):
    p = write(tmp_path, "p.csv", "id,name\n1,a\n2,b\n")
    dataimport.import_data(sqlite_driver, import_opts(sqlite_driver, p), p, job)
    dup = write(tmp_path, "dup.csv", "id,name\n3,c\n1,dup\n")
    opts = import_opts(sqlite_driver, dup, create=False)
    with pytest.raises(DBError, match="Row 2"):
        dataimport.import_data(sqlite_driver, opts, dup, FakeJob())
    assert rows(sqlite_driver, "SELECT COUNT(*) FROM people") == [(2,)]       # row 3 was rolled back too


def test_skip_failing_rows(sqlite_driver, tmp_path, job):
    p = write(tmp_path, "p.csv", "id,name\n1,a\n")
    dataimport.import_data(sqlite_driver, import_opts(sqlite_driver, p), p, job)
    dup = write(tmp_path, "dup.csv", "id,name\n2,b\n1,dup\n3,c\n")
    r = dataimport.import_data(sqlite_driver, import_opts(sqlite_driver, dup, create=False, on_error="skip"), dup, FakeJob())
    assert (r["inserted"], r["skipped"], r["errors"][0]["row"]) == (2, 1, 2)


def test_truncate_and_cancel_roll_back(sqlite_driver, tmp_path):
    p = write(tmp_path, "p.csv", "id,name\n" + "".join(f"{i},n{i}\n" for i in range(1, 2001)))
    dataimport.import_data(sqlite_driver, import_opts(sqlite_driver, p), p, FakeJob())
    opts = import_opts(sqlite_driver, p, create=False, truncate=True)
    with pytest.raises(JobCancelled):
        dataimport.import_data(sqlite_driver, opts, p, FakeJob(cancel_after=2))
    assert rows(sqlite_driver, "SELECT COUNT(*) FROM people") == [(2000,)]    # truncate undone as well
    r = dataimport.import_data(sqlite_driver, opts, p, FakeJob())
    assert r["inserted"] == 2000 and rows(sqlite_driver, "SELECT COUNT(*) FROM people") == [(2000,)]


def test_create_table_sql_rejects_bad_types(sqlite_driver):
    with pytest.raises(DBError):
        dataimport.create_table_sql(sqlite_driver, "main", "t", [{"name": "a", "type": "INT); DROP TABLE x; --"}])
    sql = dataimport.create_table_sql(sqlite_driver, "main", "t", [{"name": "a b", "type": "INTEGER", "pk": True}], drop=True)
    assert sql[0].startswith("DROP TABLE IF EXISTS") and 'PRIMARY KEY ("a b")' in sql[1]
