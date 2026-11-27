"""The script splitter decides where each statement ends; a mistake here runs the wrong SQL."""
import pytest

from dbcentral.sqlsplit import split_sql


def stmts(text, **kw):
    return [s for s, _ in split_sql(text, **kw)]


def test_simple_statements():
    assert stmts("SELECT 1; SELECT 2") == ["SELECT 1", "SELECT 2"]
    assert stmts("SELECT 1;;  ;\n\nSELECT 2;\n") == ["SELECT 1", "SELECT 2"]


@pytest.mark.parametrize("text", [
    "SELECT ';' AS a; SELECT 2",
    'SELECT ";" AS a; SELECT 2',
    "SELECT `a;b` FROM t; SELECT 2",
    "SELECT 1 /* ; */ AS a; SELECT 2",
    "SELECT 1 -- ;\n AS a; SELECT 2",
    "SELECT 1 # ;\n AS a; SELECT 2",
])
def test_semicolons_in_quotes_and_comments(text):
    assert len(stmts(text)) == 2
    assert stmts(text)[1] == "SELECT 2"


def test_backslash_escapes_follow_the_server_setting():
    text = r"SELECT 'it\'s'; SELECT 2"
    assert stmts(text, backslash=True) == [r"SELECT 'it\'s'", "SELECT 2"]
    # with NO_BACKSLASH_ESCAPES the quote ends at \' and the rest is still inside a string
    assert len(stmts(text, backslash=False)) == 1


def test_delimiter_blocks():
    text = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;"
    assert stmts(text) == ["CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END", "SELECT 3"]


def test_delimiter_with_double_semicolon():
    text = "DELIMITER ;;\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END;;\nDELIMITER ;\nSELECT 1"
    assert stmts(text) == ["CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END", "SELECT 1"]


def test_compound_statement_without_delimiter():
    body = ("CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; "
            "CASE WHEN 1 THEN SELECT 2; END CASE; WHILE 0 DO SELECT 3; END WHILE; END")
    assert stmts(body + "; SELECT 4") == [body, "SELECT 4"]


def test_nested_begin_end():
    body = "CREATE PROCEDURE p() BEGIN BEGIN SELECT 1; END; LOOP LEAVE x; END LOOP; END"
    assert stmts(body + ";SELECT 5") == [body, "SELECT 5"]


def test_case_expression_is_not_a_block():
    text = "SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t; SELECT 2"
    assert stmts(text) == ["SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t", "SELECT 2"]


def test_sqlite_dialect():
    assert stmts('SELECT 1; SELECT "a;b"; /* x; */ SELECT 3', dialect="sqlite") == ["SELECT 1", 'SELECT "a;b"', "SELECT 3"]
    trig = "CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET a = 1; END"
    assert stmts(trig + "; SELECT 1", dialect="sqlite") == [trig, "SELECT 1"]


def test_offsets_point_at_each_statement():
    text = "SELECT 1;\n  SELECT 2;"
    parts = list(split_sql(text))
    for stmt, offset in parts:
        assert text[offset:].lstrip().startswith(stmt.split()[0])
