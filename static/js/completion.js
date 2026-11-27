// Metadata cache + Monaco autocomplete for schemas, tables, columns, keywords and functions.
import { api } from './api.js';
import { SQL_FUNCTIONS, SQL_KEYWORDS, quoteIfNeeded, splitStatements, statementAt, tableRefs } from './sqlparse.js';

const owners = new WeakMap();
let registered = false;

export class MetaCache {
  constructor(ws) {
    this.ws = ws;
    this.schemaList = null;
    this.tableMap = new Map();   // schema -> Promise<{table: [[col,type]]}>
  }

  invalidate(schema) {
    if (schema) this.tableMap.delete(schema);
    else { this.tableMap.clear(); this.schemaList = null; }
  }

  async schemas() {
    if (!this.schemaList) {
      this.schemaList = api.get(`/sessions/${this.ws.sid}/schemas`).then((r) => r.schemas.map((s) => s.name)).catch(() => []);
    }
    return this.schemaList;
  }

  tables(schema) {
    if (!schema) return Promise.resolve({});
    if (!this.tableMap.has(schema)) {
      this.tableMap.set(schema, api.get(`/sessions/${this.ws.sid}/completion?schema=${encodeURIComponent(schema)}`)
        .then((r) => r.tables).catch(() => ({})));
    }
    return this.tableMap.get(schema);
  }

  async columns(schema, table) {
    const t = await this.tables(schema);
    const key = Object.keys(t).find((k) => k.toLowerCase() === String(table).toLowerCase());
    return key ? t[key] : [];
  }
}

export function registerModel(model, ws) {
  owners.set(model, ws);
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function setupCompletion() {
  if (registered) return;
  registered = true;
  for (const lang of ['mysql', 'sql']) {
    window.monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.'],
      provideCompletionItems: (model, position) => provide(model, position),
    });
  }
}

async function provide(model, position) {
  const ws = owners.get(model);
  if (!ws) return { suggestions: [] };
  const K = window.monaco.languages.CompletionItemKind;
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  const stmts = splitStatements(text, { dialect: ws.dialect, backslash: ws.backslash });
  const stmt = statementAt(stmts, offset, text);
  const stmtText = stmt ? text.slice(stmt.start, Math.max(stmt.end, offset)) : '';
  const word = model.getWordUntilPosition(position);
  const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
  const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
  const dot = /(?:`([^`]+)`|"([^"]+)"|([\w$]+))\s*\.\s*$/.exec(before);
  const suggestions = [];
  const dialect = ws.dialect;
  const defSchema = ws.currentSchema || (ws.driver === 'sqlite' ? 'main' : null);
  const refs = tableRefs(stmtText, dialect);
  const push = (label, kind, detail, sort, insert) => suggestions.push({
    label, kind, detail, sortText: sort + label.toLowerCase(), insertText: insert ?? ws.quoteIfNeeded(label), range,
  });

  if (dot) {
    const q = dot[1] || dot[2] || dot[3];
    const ref = refs.find((r) => (r.alias && eq(r.alias, q)) || eq(r.table, q));
    if (ref) {
      for (const [c, t] of await ws.meta.columns(ref.schema || defSchema, ref.table)) push(c, K.Field, t, '0');
    }
    const schemas = await ws.meta.schemas();
    const sch = schemas.find((s) => eq(s, q));
    if (sch) {
      for (const t of Object.keys(await ws.meta.tables(sch))) push(t, K.Struct, 'table in ' + sch, '1');
    }
    if (!ref && !sch && defSchema) {
      // maybe a table name that isn't in the FROM clause yet
      const cols = await ws.meta.columns(defSchema, q);
      for (const [c, t] of cols) push(c, K.Field, t, '0');
    }
    return { suggestions };
  }

  const seen = new Set();
  for (const ref of refs) {
    const cols = await ws.meta.columns(ref.schema || defSchema, ref.table);
    for (const [c, t] of cols) {
      if (seen.has(c)) continue;
      seen.add(c);
      push(c, K.Field, `${t} · ${ref.alias || ref.table}`, '0');
    }
  }
  if (defSchema) {
    for (const t of Object.keys(await ws.meta.tables(defSchema))) push(t, K.Struct, 'table', '1');
  }
  if (ws.driver === 'mysql') {
    for (const s of await ws.meta.schemas()) push(s, K.Module, 'schema', '2');
  }
  for (const kw of SQL_KEYWORDS) push(kw, K.Keyword, 'keyword', '3', kw);
  for (const fn of SQL_FUNCTIONS) {
    suggestions.push({
      label: fn + '()', kind: K.Function, detail: 'function', sortText: '4' + fn.toLowerCase(), range,
      insertText: fn + '($0)', insertTextRules: window.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: fn,
    });
  }
  return { suggestions };
}
