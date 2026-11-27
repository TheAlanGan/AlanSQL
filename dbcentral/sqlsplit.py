"""SQL script splitter (server side, used for imports). Mirrors static/js/sqlparse.js.

Handles quotes, comments, the client-side DELIMITER command and compound statements
(CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT ... BEGIN ... END) without a custom delimiter.
"""
import re

_COMPOUND_KINDS = {"PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"}


def _token_re(dialect, backslash, single_other):
    sq = r"'(?:[^'\\]|\\.|'')*(?:'|\Z)" if backslash else r"'(?:[^']|'')*(?:'|\Z)"
    dq = r'"(?:[^"\\]|\\.|"")*(?:"|\Z)' if backslash else r'"(?:[^"]|"")*(?:"|\Z)'
    lc = r"(?:--(?=\s|\Z)|\#)[^\n]*" if dialect == "mysql" else r"--[^\n]*"
    other = r"." if single_other else r"[^\s'\"`#/\-;A-Za-z_\[]+|."
    extra = r"|(?P<br>\[[^\]\n]*\])" if dialect == "sqlite" else ""
    return re.compile(
        r"(?P<ws>\s+)|(?P<lc>" + lc + r")|(?P<bc>/\*.*?(?:\*/|\Z))|(?P<sq>" + sq + r")|(?P<dq>" + dq + r")"
        r"|(?P<bq>`(?:[^`]|``)*(?:`|\Z))" + extra + r"|(?P<word>[A-Za-z_][A-Za-z0-9_$]*)|(?P<other>" + other + r")",
        re.S)


_NEXT_WORD = re.compile(r"\s*([A-Za-z_]+)")


def split_sql(text, dialect="mysql", backslash=True):
    """Yield (statement, start_offset) tuples."""
    fast = _token_re(dialect, backslash, False)
    slow = _token_re(dialect, backslash, True)
    delim = ";"
    pos, n = 0, len(text)
    start = None
    words = []
    compound = False
    depth = 0
    while pos < n:
        if delim != ";" and text.startswith(delim, pos):
            if start is not None:
                yield text[start:pos].strip(), start
            start, words, compound, depth = None, [], False, 0
            pos += len(delim)
            continue
        m = (fast if delim == ";" else slow).match(text, pos)
        kind, tok = m.lastgroup, m.group()
        if delim != ";" and kind == "word":
            cut = tok.find(delim)
            if cut > 0:  # e.g. "END$$" with DELIMITER $$
                if start is None:
                    start = pos
                pos += cut
                continue
        if kind in ("ws", "lc") or (kind == "bc" and not tok.startswith("/*!")):
            pos = m.end()
            continue
        if kind == "word":
            up = tok.upper()
            if start is None and up == "DELIMITER" and dialect == "mysql":
                eol = text.find("\n", pos)
                eol = n if eol < 0 else eol
                rest = text[m.end():eol].strip()
                delim = rest.split()[0] if rest else ";"
                pos = eol
                continue
            if start is None:
                start = pos
            if delim == ";":
                if len(words) < 12:
                    words.append(up)
                    if (words[0] == "CREATE" and up in _COMPOUND_KINDS) or words[:3] == ["BEGIN", "NOT", "ATOMIC"]:
                        compound = True
                        if words[:3] == ["BEGIN", "NOT", "ATOMIC"]:
                            depth = max(depth, 1)
                if compound:
                    if up == "BEGIN" and len(words) > 1:
                        depth += 1
                    elif up == "CASE":
                        depth += 1
                    elif up == "END":
                        nxt = _NEXT_WORD.match(text, m.end())
                        nxt_word = nxt.group(1).upper() if nxt else ""
                        if nxt_word in ("IF", "LOOP", "WHILE", "REPEAT", "CASE"):
                            if nxt_word == "CASE":
                                depth = max(depth - 1, 0)
                            pos = nxt.end()  # consume "END IF" / "END CASE" ... as one unit
                            continue
                        depth = max(depth - 1, 0)
            pos = m.end()
            continue
        if kind == "other" and tok == ";" and delim == ";":
            if compound and depth > 0:
                pos = m.end()
                continue
            if start is not None:
                yield text[start:pos].strip(), start
            start, words, compound, depth = None, [], False, 0
            pos = m.end()
            continue
        if start is None:
            start = pos
        pos = m.end()
    if start is not None:
        stmt = text[start:].strip()
        if stmt:
            yield stmt, start
