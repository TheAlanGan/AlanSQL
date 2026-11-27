// Stored procedures and functions (MySQL / MariaDB): the execute dialog, a per-schema
// "Procedures & Functions" page, and duplicate / export helpers.
import { api } from './api.js';
import { reviewAndApply } from './review.js';
import { esc, h, icon, modal, promptDialog, select, splitter, toast, toolButton } from './ui.js';

const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric',
  'float', 'double', 'real', 'bit', 'year', 'bool', 'boolean']);
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const HEADER_RE = /^(CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION)\s+)(`(?:[^`]|``)+`(?:\s*\.\s*`(?:[^`]|``)+`)?|[\w$]+)/i;

export async function loadRoutines(ws, schema, name) {
  const qs = `schema=${encodeURIComponent(schema)}` + (name ? `&name=${encodeURIComponent(name)}` : '');
  return (await api.get(`/sessions/${ws.sid}/routines?${qs}`)).routines;
}

export function signature(r) {
  return (r.params || []).map((p) => (r.type === 'procedure' ? `${p.mode} ` : '') + `${p.name} ${p.type}`).join(', ');
}

function userVar(n) { return /^\w+$/.test(n) ? '@' + n : '@`' + n.replace(/`/g, '``') + '`'; }

function argValue(ws, p, raw, isNull) {
  if (isNull) return 'NULL';
  const v = raw.trim();
  if (raw.startsWith('=')) return raw.slice(1).trim() || 'NULL';       // SQL expression, e.g. =NOW()
  if (NUMERIC.has(p.data_type)) {
    if (NUMBER_RE.test(v)) return v;
    if (/^(true|false)$/i.test(v)) return v.toUpperCase();
  }
  return ws.sqlString(raw);
}

// Builds the CALL / SELECT script for a routine from the dialog's values.
export function buildCall(ws, r, schema, values) {
  const target = ws.qualify(schema, r.name);
  const lines = [];
  const args = [];
  for (const p of r.params) {
    const val = values[p.name] || { v: '', n: false };
    if (r.type === 'procedure' && (p.mode === 'OUT' || p.mode === 'INOUT')) {
      if (p.mode === 'INOUT') lines.push(`SET ${userVar(p.name)} = ${argValue(ws, p, val.v, val.n)};`);
      args.push(userVar(p.name));
    } else {
      args.push(argValue(ws, p, val.v, val.n));
    }
  }
  if (r.type === 'function') {
    lines.push(`SELECT ${target}(${args.join(', ')}) AS ${ws.quoteIfNeeded(r.name)};`);
  } else {
    lines.push(`CALL ${target}(${args.join(', ')});`);
    const outs = r.params.filter((p) => p.mode === 'OUT' || p.mode === 'INOUT');
    if (outs.length) lines.push(`SELECT ${outs.map((p) => `${userVar(p.name)} AS ${ws.quoteIfNeeded(p.name)}`).join(', ')};`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ execute dialog
export async function executeRoutineDialog(ws, kind, schema, name) {
  let r;
  try {
    r = (await loadRoutines(ws, schema, name)).find((x) => x.type === kind);
  } catch (e) { toast(e.message, 'error'); return; }
  if (!r) { toast(`${kind === 'procedure' ? 'Procedure' : 'Function'} ${name} was not found. Refresh the Navigator.`, 'warning'); return; }
  const key = `routine-args:${ws.profile.id}:${schema}.${kind}.${name}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { saved = {}; }
  const values = {};
  const preview = h('pre', { class: 'sql-pre small routine-preview' });
  const update = () => { preview.textContent = buildCall(ws, r, schema, values); };
  const rows = r.params.map((p, i) => {
    const out = r.type === 'procedure' && p.mode === 'OUT';
    values[p.name] = { v: saved[p.name]?.v ?? '', n: saved[p.name]?.n ?? false };
    const inp = h('input', { class: 'input', value: values[p.name].v, placeholder: p.type, autofocus: i === 0 && !out, disabled: values[p.name].n });
    const nul = h('input', { type: 'checkbox', checked: values[p.name].n, title: 'Pass NULL' });
    inp.addEventListener('input', () => { values[p.name].v = inp.value; update(); });
    nul.addEventListener('change', () => { values[p.name].n = nul.checked; inp.disabled = nul.checked; update(); });
    return h('tr', null,
      h('td', null, r.type === 'procedure' ? h('span', { class: 'badge mode-' + p.mode.toLowerCase() }, p.mode) : null),
      h('td', { class: 'strong' }, p.name), h('td', { class: 'muted' }, p.type),
      out ? h('td', { class: 'muted', colspan: 2 }, `returned in ${userVar(p.name)}`) : h('td', null, inp),
      out ? null : h('td', { class: 'center' }, nul));
  });
  update();
  const content = h('div', { class: 'form routine-dialog' },
    h('div', null, icon(kind === 'procedure' ? 'procedure' : 'func'), ' ', h('b', null, `${schema}.${name}`), h('span', { class: 'muted' }, `(${signature(r)})`),
      r.returns ? h('span', { class: 'muted' }, ` returns ${r.returns}`) : null),
    r.comment ? h('div', { class: 'muted' }, r.comment) : null,
    r.params.length
      ? h('table', { class: 'routine-params' }, h('thead', null, h('tr', null, ...['', 'Parameter', 'Type', 'Value', 'NULL'].map((x) => h('th', null, x)))), h('tbody', null, ...rows))
      : h('div', { class: 'muted' }, 'This routine has no parameters.'),
    r.params.some((p) => !(r.type === 'procedure' && p.mode === 'OUT'))
      ? h('div', { class: 'muted small' }, 'Numbers are passed as they are and everything else as quoted text. Start a value with = to pass an SQL expression, such as =NOW() or =@my_variable.')
      : null,
    h('div', { class: 'section-title' }, 'SQL to run'), preview);
  const choice = await modal({
    title: kind === 'procedure' ? 'Execute Stored Procedure' : 'Call Function', content, width: 640, closeValue: null,
    buttons: [{ label: 'Open in SQL Editor', value: 'open' }, '-', { label: 'Cancel', value: null }, { label: 'Execute', value: 'run', primary: true }],
  });
  if (!choice) return;
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* ignore */ }
  const tab = ws.openQueryTab({ title: `${kind === 'procedure' ? 'call' : 'select'} ${name}`, content: buildCall(ws, r, schema, values) });
  if (choice === 'run') tab.run('all');
}

// ------------------------------------------------------------------ duplicate / export
export async function duplicateRoutine(ws, kind, schema, name) {
  const newName = await promptDialog(`Duplicate ${kind === 'procedure' ? 'Procedure' : 'Function'}`, 'Name of the copy:', `${name}_copy`, { okLabel: 'Continue' });
  if (!newName || !newName.trim()) return false;
  let ddl;
  try {
    ddl = (await api.get(`/sessions/${ws.sid}/ddl?schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}&type=${kind}`)).ddl.trim().replace(/;\s*$/, '');
  } catch (e) { toast(e.message, 'error'); return false; }
  if (!HEADER_RE.test(ddl)) { toast('Could not find the routine name in its definition.', 'error'); return false; }
  ddl = ddl.replace(HEADER_RE, (_m, head) => head + ws.qualify(schema, newName.trim()));
  const ok = await reviewAndApply(ws, [`DELIMITER $$\n${ddl}$$\nDELIMITER ;`], {
    title: `Duplicate ${name}`, intro: `This creates ${newName.trim()} as a copy of ${name}. You can change the definition before applying it.`,
  });
  if (ok) ws.navigator.refreshSchema(schema);
  return ok;
}

export async function exportRoutines(ws, schema, list) {
  if (!list.length) { toast('No procedures or functions to export.', 'info'); return; }
  const parts = [`-- Procedures and functions of ${ws.quoteIdent(schema)}`, `-- Exported by DBCentral on ${new Date().toLocaleString()}`, '', 'DELIMITER $$', ''];
  for (const r of list) {
    try {
      const ddl = (await api.get(`/sessions/${ws.sid}/ddl?schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(r.name)}&type=${r.type}`)).ddl.trim().replace(/;\s*$/, '');
      parts.push(`DROP ${r.type.toUpperCase()} IF EXISTS ${ws.qualify(schema, r.name)}$$`, ddl.replace(HEADER_RE, (_m, head) => head + ws.qualify(schema, r.name)) + '$$', '');
    } catch (e) {
      parts.push(`-- ${r.type} ${r.name}: ${e.message}`, '');
    }
  }
  parts.push('DELIMITER ;', '');
  ws.openQueryTab({ title: `${schema} routines`, content: parts.join('\n') });
}

// ------------------------------------------------------------------ Procedures & Functions page
export class RoutinesDoc {
  constructor(ws, schema) {
    this.ws = ws;
    this.kind = 'routines';
    this.schema = schema;
    this.icon = 'procedure';
    this.id = 'routines-' + Date.now();
    this.title = `${schema} - Procedures & Functions`;
    this.list = [];
    this.typeFilter = 'all';
    this.sortKey = 'name';
    this.sortDir = 1;
    this.selected = null;

    this.el = h('div', { class: 'doc routines-doc' });
    this.schemaSel = select([], schema, (v) => this.setSchema(v), { class: 'input small' });
    this.filter = h('input', { class: 'input small', placeholder: 'Filter by name, parameter or comment', spellcheck: false, style: { width: '240px' } });
    this.filter.addEventListener('input', () => this.renderTable());
    this.seg = h('div', { class: 'seg' });
    for (const [k, l] of [['all', 'All'], ['procedure', 'Procedures'], ['function', 'Functions']]) {
      this.seg.append(h('button', { class: 'seg-btn' + (k === 'all' ? ' active' : ''), dataset: { k }, onclick: () => { this.typeFilter = k; this.seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === k)); this.renderTable(); } }, l));
    }
    this.count = h('span', { class: 'tb-text muted' });
    this.tableHost = h('div', { class: 'routines-table scroll' });
    this.details = h('div', { class: 'routines-details' });
    const split = h('div', { class: 'splitter splitter-h' });
    this.el.append(
      h('div', { class: 'toolbar' },
        h('span', { class: 'tb-text muted' }, 'Schema'), this.schemaSel, h('span', { class: 'tb-sep' }), this.seg, icon('search'), this.filter,
        h('span', { class: 'tb-sep' }),
        toolButton('procAdd', 'Create a new stored procedure', () => ws.openObjectEditor('procedure', this.schema, null), { label: 'New Procedure' }),
        toolButton('funcAdd', 'Create a new function', () => ws.openObjectEditor('function', this.schema, null), { label: 'New Function' }),
        toolButton('refresh', 'Reload the list', () => this.load(), { label: 'Refresh' }),
        toolButton('export', 'Open the CREATE statements of the listed routines in a SQL editor', () => exportRoutines(ws, this.schema, this.visible()), { label: 'Export...' }),
        h('span', { class: 'flex1' }), this.count),
      this.tableHost, split, this.details);
    splitter(split, this.details, { direction: 'h', invert: true, min: 120, max: 700, key: 'routines-details' });
  }

  fillSchemas() {
    const names = this.ws.navigator.schemas.filter((s) => !s.system).map((s) => s.name);
    this.schemaSel.innerHTML = '';
    for (const n of names) this.schemaSel.append(h('option', { value: n }, n));
    this.schemaSel.value = this.schema;
  }

  setSchema(schema) {
    if (!schema || schema === this.schema) return;
    this.schema = schema;
    this.selected = null;
    this.title = `${schema} - Procedures & Functions`;
    this.ws.docs.setTitle(this.tab, this.title);
    this.load();
  }

  async load() {
    this.fillSchemas();
    try {
      this.list = await loadRoutines(this.ws, this.schema);
    } catch (e) {
      this.tableHost.innerHTML = '';
      this.tableHost.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
      return;
    }
    if (this.selected) this.selected = this.list.find((r) => r.type === this.selected.type && r.name === this.selected.name) || null;
    this.renderTable();
    this.renderDetails();
  }

  onShow() { if (this.list.length || this.tableHost.childElementCount) this.load(); }

  visible() {
    const f = this.filter.value.trim().toLowerCase();
    let rows = this.list.filter((r) => this.typeFilter === 'all' || r.type === this.typeFilter);
    if (f) rows = rows.filter((r) => [r.name, r.comment, signature(r), r.returns].some((x) => (x || '').toLowerCase().includes(f)));
    const k = this.sortKey;
    return rows.slice().sort((a, b) => String(a[k] ?? '').localeCompare(String(b[k] ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * this.sortDir || a.name.localeCompare(b.name));
  }

  renderTable() {
    const rows = this.visible();
    const p = this.list.filter((r) => r.type === 'procedure').length;
    this.count.textContent = `${p} procedure${p === 1 ? '' : 's'}, ${this.list.length - p} function${this.list.length - p === 1 ? '' : 's'}`;
    this.tableHost.innerHTML = '';
    if (!this.list.length) {
      this.tableHost.append(h('div', { class: 'pad muted' }, `There are no stored procedures or functions in ${this.schema}. Use New Procedure or New Function to create one.`));
      return;
    }
    const cols = [['name', 'Name'], ['type', 'Type'], [null, 'Parameters'], ['returns', 'Returns'], ['deterministic', 'Deterministic'],
      ['data_access', 'SQL Data Access'], ['security', 'Security'], ['definer', 'Definer'], ['modified', 'Modified'], ['comment', 'Comment']];
    const head = h('tr', null, ...cols.map(([k, l]) => {
      const th = h('th', { class: k ? 'sortable' : '' }, l + (k && k === this.sortKey ? (this.sortDir > 0 ? ' ▲' : ' ▼') : ''));
      if (k) th.addEventListener('click', () => { if (this.sortKey === k) this.sortDir = -this.sortDir; else { this.sortKey = k; this.sortDir = 1; } this.renderTable(); });
      return th;
    }));
    const body = h('tbody');
    for (const r of rows) {
      const tr = h('tr', { class: this.selected === r ? 'selected' : '' },
        h('td', null, icon(r.type === 'procedure' ? 'procedure' : 'func'), ' ', h('b', null, r.name)),
        h('td', null, r.type === 'procedure' ? 'Procedure' : 'Function'),
        h('td', { class: 'mono small', title: signature(r) }, signature(r) || h('span', { class: 'muted' }, '(none)')),
        h('td', { class: 'mono small' }, r.returns || ''), h('td', null, r.deterministic === 'YES' ? 'Yes' : 'No'),
        h('td', null, r.data_access || ''), h('td', null, r.security || ''), h('td', { class: 'muted' }, r.definer || ''),
        h('td', { class: 'muted' }, r.modified || ''), h('td', { title: r.comment || '' }, r.comment || ''));
      tr.addEventListener('click', () => { this.selected = r; this.renderTable(); this.renderDetails(); });
      tr.addEventListener('dblclick', () => this.ws.openObjectEditor(r.type, this.schema, r.name));
      body.append(tr);
    }
    if (!rows.length) body.append(h('tr', null, h('td', { colspan: cols.length, class: 'muted' }, 'No routines match the filter.')));
    this.tableHost.append(h('table', { class: 'grid-table routines-grid' }, h('thead', null, head), body));
  }

  async renderDetails() {
    const r = this.selected;
    const ws = this.ws;
    this.details.innerHTML = '';
    if (!r) { this.details.append(h('div', { class: 'pad muted' }, 'Select a procedure or function to see its definition. Double-click to edit it.')); return; }
    const label = r.type === 'procedure' ? 'Procedure' : 'Function';
    const actions = h('div', { class: 'row routines-actions' },
      h('button', { class: 'btn primary', onclick: () => executeRoutineDialog(ws, r.type, this.schema, r.name) }, icon('bolt'), r.type === 'procedure' ? ' Execute...' : ' Call...'),
      h('button', { class: 'btn', onclick: () => ws.openObjectEditor(r.type, this.schema, r.name) }, icon('wrench'), ' Edit'),
      h('button', { class: 'btn', onclick: async () => { if (await duplicateRoutine(ws, r.type, this.schema, r.name)) this.load(); } }, icon('copy'), ' Duplicate...'),
      h('button', { class: 'btn', onclick: () => ws.copyDDL(r.type, this.schema, r.name) }, 'Copy CREATE Statement'),
      h('span', { class: 'flex1' }),
      h('button', { class: 'btn danger', onclick: async () => { await ws.dropObject(r.type, this.schema, r.name); this.selected = null; this.load(); } }, icon('trash'), ' Drop...'));
    const pre = h('pre', { class: 'sql-pre routines-ddl' }, 'Loading definition...');
    this.details.append(h('div', { class: 'routines-details-head' }, icon(r.type === 'procedure' ? 'procedure' : 'func'), h('b', null, ` ${label} ${r.name}`),
      r.comment ? h('span', { class: 'muted' }, ` - ${r.comment}`) : null), actions, pre);
    try {
      const d = await api.get(`/sessions/${ws.sid}/ddl?schema=${encodeURIComponent(this.schema)}&name=${encodeURIComponent(r.name)}&type=${r.type}`);
      if (this.selected === r) pre.textContent = d.ddl.trim();
    } catch (e) { pre.textContent = e.message; }
  }
}

// Info-panel HTML for a routine (used by the Navigator).
export function routineInfoHtml(r) {
  const line = (k, v) => `<div><span class="muted">${esc(k)}:</span> <b>${esc(v)}</b></div>`;
  let html = line(r.type === 'procedure' ? 'Procedure' : 'Function', r.name);
  if (r.returns) html += line('Returns', r.returns);
  html += line('Deterministic', r.deterministic === 'YES' ? 'Yes' : 'No') + line('SQL data access', r.data_access || '')
    + line('Security', r.security || '') + line('Definer', r.definer || '');
  if (r.modified) html += line('Modified', r.modified);
  if (r.comment) html += line('Comment', r.comment);
  html += '<div class="muted info-sub">Parameters:</div>';
  html += r.params.length
    ? '<table class="info-cols">' + r.params.map((p) => `<tr><td>${r.type === 'procedure' ? `<span class="muted">${esc(p.mode)}</span> ` : ''}${esc(p.name)}</td><td class="muted">${esc(p.type)}</td></tr>`).join('') + '</table>'
    : '<div class="muted">(none)</div>';
  return html;
}

