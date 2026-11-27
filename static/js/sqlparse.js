// Client-side SQL helpers: statement splitting (with DELIMITER and compound statements),
// statement-at-cursor, automatic LIMIT, and table-reference extraction for autocomplete.
// Mirrors dbcentral/sqlsplit.py.

const GROUPS = ['ws', 'lc', 'bc', 'sq', 'dq', 'bq', 'br', 'word', 'other'];
const reCache = new Map();

function tokenRe(dialect, backslash, single) {
  const key = dialect + backslash + single;
  if (reCache.has(key)) return reCache.get(key);
  const sq = backslash ? String.raw`'(?:[^'\\]|\\[\s\S]|'')*(?:'|$)` : String.raw`'(?:[^']|'')*(?:'|$)`;
  const dq = backslash ? String.raw`"(?:[^"\\]|\\[\s\S]|"")*(?:"|$)` : String.raw`"(?:[^"]|"")*(?:"|$)`;
  const lc = dialect === 'mysql' ? String.raw`(?:--(?=\s|$)|#)[^\n]*` : String.raw`--[^\n]*`;
  const other = single ? String.raw`[\s\S]` : String.raw`[^\s'"\x60#/\-;A-Za-z_\[]+|[\s\S]`;
  const br = dialect === 'sqlite' ? String.raw`\[[^\]\n]*\]` : '(?!)';
  const src = `(?<ws>\\s+)|(?<lc>${lc})|(?<bc>\\/\\*[\\s\\S]*?(?:\\*\\/|$))|(?<sq>${sq})|(?<dq>${dq})` +
    `|(?<bq>\`(?:[^\`]|\`\`)*(?:\`|$))|(?<br>${br})|(?<word>[A-Za-z_][A-Za-z0-9_$]*)|(?<other>${other})`;
  const re = new RegExp(src, 'y');
  reCache.set(key, re);
  return re;
}

function matchAt(re, text, pos) {
  re.lastIndex = pos;
  const m = re.exec(text);
  if (!m) return null;
  for (const g of GROUPS) if (m.groups[g] !== undefined) return { kind: g, tok: m[0], end: re.lastIndex };
  return null;
}

const COMPOUND = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT']);
const END_PAIRS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'CASE']);

/**
 * Split a script into statements.
 * Returns [{text, start, end, delimEnd, delimiter}] where text = source.slice(start, end).
 */
export function splitStatements(text, { dialect = 'mysql', backslash = true } = {}) {
  const fast = tokenRe(dialect, backslash, false);
  const slow = tokenRe(dialect, backslash, true);
  const out = [];
  let delim = ';';
  let pos = 0;
  const n = text.length;
  let start = -1, lastEnd = -1, words = [], compound = false, depth = 0;
  const emit = (endPos, delimEnd) => {
    if (start >= 0) {
      const e = lastEnd > start ? lastEnd : endPos;
      out.push({ text: text.slice(start, e), start, end: e, delimEnd, delimiter: delim });
    }
    start = -1; lastEnd = -1; words = []; compound = false; depth = 0;
  };
  while (pos < n) {
    if (delim !== ';' && text.startsWith(delim, pos)) {
      emit(pos, pos + delim.length);
      pos += delim.length;
      continue;
    }
    const m = matchAt(delim === ';' ? fast : slow, text, pos);
    if (!m) break;
    const { kind, tok } = m;
    if (delim !== ';' && kind === 'word') {
      const cut = tok.indexOf(delim);
      if (cut > 0) {
        if (start < 0) start = pos;
        lastEnd = pos + cut;
        pos += cut;
        continue;
      }
    }
    if (kind === 'ws' || kind === 'lc' || (kind === 'bc' && !tok.startsWith('/*!'))) {
      pos = m.end;
      continue;
    }
    if (kind === 'word') {
      const up = tok.toUpperCase();
      if (start < 0 && up === 'DELIMITER' && dialect === 'mysql') {
        let eol = text.indexOf('\n', pos);
        if (eol < 0) eol = n;
        const rest = text.slice(m.end, eol).trim();
        delim = rest ? rest.split(/\s+/)[0] : ';';
        pos = eol;
        continue;
      }
      if (start < 0) start = pos;
      if (delim === ';') {
        if (words.length < 12) {
          words.push(up);
          if ((words[0] === 'CREATE' && COMPOUND.has(up)) || (words.length === 3 && words.join(' ') === 'BEGIN NOT ATOMIC')) {
            if (!compound && words[0] === 'BEGIN') depth = Math.max(depth, 1);
            compound = true;
          }
        }
        if (compound) {
          if (up === 'BEGIN' && words.length > 1) depth++;
          else if (up === 'CASE') depth++;
          else if (up === 'END') {
            const nx = /\s*([A-Za-z_]+)/y;
            nx.lastIndex = m.end;
            const nm = nx.exec(text);
            const nw = nm ? nm[1].toUpperCase() : '';
            if (END_PAIRS.has(nw)) {
              if (nw === 'CASE') depth = Math.max(depth - 1, 0);
              lastEnd = nx.lastIndex;
              pos = nx.lastIndex;
              continue;
            }
            depth = Math.max(depth - 1, 0);
          }
        }
      }
      lastEnd = m.end;
      pos = m.end;
      continue;
    }
    if (kind === 'other' && tok === ';' && delim === ';') {
      if (compound && depth > 0) { lastEnd = m.end; pos = m.end; continue; }
      emit(pos, m.end);
      pos = m.end;
      continue;
    }
    if (start < 0) start = pos;
    lastEnd = m.end;
    pos = m.end;
  }
  if (start >= 0) emit(n, n);
  return out;
}

/** Pick the statement the caret is in (or the closest one, Workbench-style). */
export function statementAt(stmts, offset, text) {
  for (const s of stmts) if (offset >= s.start && offset <= s.delimEnd) return s;
  let prev = null;
  for (const s of stmts) if (s.delimEnd <= offset) prev = s;
  const next = stmts.find((s) => s.start >= offset) || null;
  if (prev && text) {
    const between = text.slice(prev.delimEnd, offset);
    if (!between.includes('\n') || !next) return prev;
  }
  return next || prev;
}

/** Upper-cased words at parenthesis depth 0 (strings/comments skipped). */
export function topLevelWords(sql, dialect = 'mysql') {
  const re = tokenRe(dialect, dialect === 'mysql', false);
  const words = [];
  let pos = 0, depth = 0;
  while (pos < sql.length) {
    const m = matchAt(re, sql, pos);
    if (!m) break;
    if (m.kind === 'word' && depth === 0) words.push(m.tok.toUpperCase());
    else if (m.kind === 'other') {
      for (const ch of m.tok) {
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
      }
    }
    pos = m.end;
  }
  return words;
}

export function firstWord(sql, dialect = 'mysql') {
  return topLevelWords(sql, dialect)[0] || '';
}

export function shouldApplyLimit(sql, dialect = 'mysql') {
  const w = topLevelWords(sql, dialect);
  if (!w.length) return false;
  let main = w[0];
  if (main === 'WITH') main = w.find((x) => ['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE'].includes(x));
  if (main !== 'SELECT') return false;
  if (w.includes('LIMIT') || w.includes('INTO') || w.includes('PROCEDURE')) return false;
  for (let i = 0; i < w.length - 1; i++) {
    if (w[i] === 'FOR' && (w[i + 1] === 'UPDATE' || w[i + 1] === 'SHARE')) return false;
    if (w[i] === 'LOCK' && w[i + 1] === 'IN') return false;
  }
  return true;
}

export function applyLimit(sql, limit) {
  return sql.replace(/\s+$/, '') + `\nLIMIT 0, ${limit}`;
}

// ------------------------------------------------------------------ autocomplete helpers
const NOT_ALIAS = new Set(['WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'GROUP', 'ORDER',
  'LIMIT', 'SET', 'VALUES', 'VALUE', 'USING', 'HAVING', 'UNION', 'STRAIGHT_JOIN', 'WINDOW', 'FOR', 'LOCK', 'PARTITION',
  'SELECT', 'INTO', 'AND', 'OR', 'AS', 'USE', 'IGNORE', 'FORCE', 'FULL', 'EXCEPT', 'INTERSECT', 'RETURNING']);

function unquoteIdent(t) {
  if ((t[0] === '`' && t.endsWith('`')) || (t[0] === '"' && t.endsWith('"'))) return t.slice(1, -1);
  if (t[0] === '[' && t.endsWith(']')) return t.slice(1, -1);
  return t;
}

function tokens(sql, dialect) {
  const re = tokenRe(dialect, dialect === 'mysql', true);
  const out = [];
  let pos = 0;
  while (pos < sql.length) {
    const m = matchAt(re, sql, pos);
    if (!m) break;
    if (m.kind === 'word' || m.kind === 'bq' || m.kind === 'br' || (m.kind === 'dq' && dialect === 'sqlite')) {
      out.push({ t: 'id', v: unquoteIdent(m.tok), up: m.kind === 'word' ? m.tok.toUpperCase() : null });
    } else if (m.kind === 'other') {
      out.push({ t: 'p', v: m.tok });
    } else if (m.kind === 'sq' || m.kind === 'dq') {
      out.push({ t: 's', v: m.tok });
    }
    pos = m.end;
  }
  return out;
}

/** Tables referenced in a statement: [{schema, table, alias}] */
export function tableRefs(sql, dialect = 'mysql') {
  const tk = tokens(sql, dialect);
  const refs = [];
  const readRef = (i) => {
    if (!tk[i] || tk[i].t !== 'id' || (tk[i].up && NOT_ALIAS.has(tk[i].up))) return i;
    let schema = null, table = tk[i].v;
    i++;
    if (tk[i]?.v === '.' && tk[i + 1]?.t === 'id') { schema = table; table = tk[i + 1].v; i += 2; }
    let alias = null;
    if (tk[i]?.up === 'AS' && tk[i + 1]?.t === 'id') { alias = tk[i + 1].v; i += 2; }
    else if (tk[i]?.t === 'id' && !(tk[i].up && NOT_ALIAS.has(tk[i].up))) { alias = tk[i].v; i++; }
    refs.push({ schema, table, alias });
    return i;
  };
  for (let i = 0; i < tk.length; i++) {
    const up = tk[i].up;
    if (up === 'FROM' || up === 'JOIN' || up === 'UPDATE' || up === 'INTO' || up === 'STRAIGHT_JOIN') {
      let j = readRef(i + 1);
      if (up === 'FROM' || up === 'UPDATE') {
        while (tk[j]?.v === ',') j = readRef(j + 1);
      }
      i = Math.max(i, j - 1);
    }
  }
  return refs;
}

export function quoteIdent(name, dialect = 'mysql') {
  return dialect === 'mysql' ? '`' + String(name).replace(/`/g, '``') + '`' : '"' + String(name).replace(/"/g, '""') + '"';
}

export function needsQuote(name) {
  return !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) || RESERVED.has(String(name).toUpperCase());
}

export function quoteIfNeeded(name, dialect = 'mysql') {
  return needsQuote(name) ? quoteIdent(name, dialect) : name;
}

export function quoteString(value, { backslash = true } = {}) {
  let s = String(value).replace(/'/g, "''");
  if (backslash) s = s.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z');
  return "'" + s + "'";
}

const RESERVED = new Set(('ADD ALL ALTER ANALYZE AND AS ASC BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY CALL CASCADE CASE CHANGE CHAR ' +
  'CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CURRENT_DATE CURRENT_TIME ' +
  'CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DECIMAL DECLARE DEFAULT DELAYED DELETE DESC DESCRIBE ' +
  'DISTINCT DIV DOUBLE DROP EACH ELSE ELSEIF ENCLOSED EXISTS EXIT EXPLAIN FALSE FETCH FLOAT FOR FORCE FOREIGN FROM ' +
  'FULLTEXT GENERATED GRANT GROUP GROUPS HAVING IF IGNORE IN INDEX INNER INOUT INSERT INT INTEGER INTERVAL INTO IS ' +
  'ITERATE JOIN KEY KEYS KILL LEADING LEAVE LEFT LIKE LIMIT LINES LOAD LOCK LONG LOOP MATCH MOD NATURAL NOT NULL ' +
  'NUMERIC ON OPTION OR ORDER OUT OUTER PRIMARY PROCEDURE RANGE READ REAL REFERENCES REGEXP RENAME REPEAT REPLACE ' +
  'REQUIRE RESTRICT RETURN REVOKE RIGHT RLIKE SCHEMA SELECT SET SHOW SMALLINT SPATIAL SQL TABLE THEN TO TRAILING ' +
  'TRIGGER TRUE UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING VALUES VARCHAR WHEN WHERE WHILE WITH WRITE XOR ' +
  'YEAR_MONTH ZEROFILL ROWS ROW RANK WINDOW OVER').split(' '));

export const SQL_KEYWORDS = ('SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW ' +
  'PROCEDURE FUNCTION TRIGGER DATABASE SCHEMA JOIN LEFT RIGHT INNER OUTER CROSS NATURAL ON USING GROUP BY ORDER ASC DESC ' +
  'HAVING LIMIT OFFSET UNION ALL DISTINCT AS IS NULL LIKE IN BETWEEN EXISTS CASE WHEN THEN ELSE END PRIMARY KEY FOREIGN ' +
  'REFERENCES UNIQUE DEFAULT AUTO_INCREMENT CONSTRAINT CHECK SHOW DESCRIBE EXPLAIN USE BEGIN COMMIT ROLLBACK START ' +
  'TRANSACTION TRUNCATE RENAME COLUMN ADD MODIFY CHANGE AFTER FIRST ENGINE CHARSET COLLATE CHARACTER IF REPLACE IGNORE ' +
  'DUPLICATE CASCADE RESTRICT GRANT REVOKE PRIVILEGES TO IDENTIFIED USER WITH RECURSIVE OVER PARTITION WINDOW ROWS ' +
  'RANGE PRECEDING FOLLOWING UNBOUNDED CURRENT ROW DELIMITER CALL DECLARE CURSOR FOR LOOP WHILE REPEAT UNTIL LEAVE ' +
  'ITERATE RETURN RETURNS DETERMINISTIC READS MODIFIES SQL DATA CONTAINS DEFINER INVOKER SECURITY COMMENT TEMPORARY ' +
  'INT INTEGER TINYINT SMALLINT MEDIUMINT BIGINT DECIMAL NUMERIC FLOAT DOUBLE BIT BOOLEAN BOOL CHAR VARCHAR TEXT ' +
  'TINYTEXT MEDIUMTEXT LONGTEXT BLOB TINYBLOB MEDIUMBLOB LONGBLOB BINARY VARBINARY DATE DATETIME TIMESTAMP TIME YEAR ' +
  'ENUM JSON UNSIGNED ZEROFILL TRUE FALSE PROCESSLIST VARIABLES STATUS TABLES DATABASES COLUMNS INDEXES WARNINGS ' +
  'ERRORS ANALYZE OPTIMIZE REPAIR CHECKSUM LOCK UNLOCK FLUSH KILL QUERY PRAGMA VACUUM ATTACH DETACH WITHOUT ROWID ' +
  'AUTOINCREMENT CONFLICT ABORT FAIL GLOB REGEXP RLIKE XOR DIV MOD STRAIGHT_JOIN SQL_CALC_FOUND_ROWS HIGH_PRIORITY ' +
  'LOW_PRIORITY DELAYED QUICK FULLTEXT SPATIAL VIRTUAL STORED GENERATED ALWAYS INVISIBLE VISIBLE').split(' ');

export const SQL_FUNCTIONS = ('COUNT SUM AVG MIN MAX GROUP_CONCAT CONCAT CONCAT_WS SUBSTRING SUBSTR LEFT RIGHT LENGTH ' +
  'CHAR_LENGTH UPPER LOWER TRIM LTRIM RTRIM REPLACE INSTR LOCATE LPAD RPAD REPEAT REVERSE FORMAT COALESCE IFNULL ' +
  'NULLIF IF ROUND FLOOR CEIL CEILING ABS MOD POW POWER SQRT RAND NOW CURDATE CURTIME CURRENT_DATE CURRENT_TIME ' +
  'CURRENT_TIMESTAMP UTC_TIMESTAMP DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND DAYNAME MONTHNAME DAYOFWEEK DAYOFYEAR ' +
  'WEEK WEEKDAY DATE_ADD DATE_SUB DATEDIFF TIMESTAMPDIFF TIMESTAMPADD DATE_FORMAT STR_TO_DATE FROM_UNIXTIME ' +
  'UNIX_TIMESTAMP LAST_DAY EXTRACT CAST CONVERT JSON_EXTRACT JSON_OBJECT JSON_ARRAY JSON_UNQUOTE JSON_CONTAINS ' +
  'JSON_SET JSON_REMOVE JSON_KEYS JSON_LENGTH JSON_ARRAYAGG JSON_OBJECTAGG UUID MD5 SHA1 SHA2 HEX UNHEX ' +
  'LAST_INSERT_ID ROW_COUNT FOUND_ROWS DATABASE USER VERSION CONNECTION_ID ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD ' +
  'FIRST_VALUE LAST_VALUE NTH_VALUE PERCENT_RANK CUME_DIST GREATEST LEAST FIELD FIND_IN_SET ELT ASCII ORD CHAR ' +
  'BIN OCT CONV SIGN TRUNCATE EXP LOG LOG10 LN PI RADIANS DEGREES SIN COS TAN REGEXP_REPLACE REGEXP_SUBSTR ' +
  'REGEXP_LIKE INET_ATON INET_NTOA BIT_COUNT SLEEP BENCHMARK ANY_VALUE TYPEOF STRFTIME JULIANDAY DATETIME ' +
  'TOTAL PRINTF QUOTE RANDOMBLOB ZEROBLOB SUBSTRING_INDEX').split(' ');
