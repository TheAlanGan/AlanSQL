// Result panel: result tabs with grid / form editor / field types / query stats / execution plan views.
import { api } from './api.js';
import { DataGrid, displayValue, plainValue } from './grid.js';
import {
  TabStrip, contextMenu, copyText, dropdownMenu, emptyState, esc, formatNumber, h, icon, modal, sep, toast, toolButton,
} from './ui.js';
import { saveTextFile } from './files.js';
import { reviewAndApply } from './review.js';

const VIEWS = [
  ['grid', 'grid', 'Result Grid'],
  ['form', 'form', 'Form Editor'],
  ['types', 'fieldTypes', 'Field Types'],
  ['stats', 'stats', 'Query Stats'],
  ['plan', 'plan', 'Execution Plan'],
];

export class ResultPanel {
  constructor(container, owner) {
    this.owner = owner;          // QueryTab (has .ws, .rerunFor(view))
    this.el = h('div', { class: 'result-panel' });
    this.body = h('div', { class: 'rp-body' });
    this.empty = emptyState('grid', 'No results', 'Execute a query (Ctrl+Enter) to see results here.');
    this.body.append(this.empty);
    this.el.append(this.body);
    container.append(this.el);
    this.tabs = new TabStrip(this.el, {
      className: 'bottom result-tabs',
      onSelect: (t) => this.show(t?.view),
      onClose: (t) => this.close(t.view),
      onContextMenu: (e, t) => contextMenu(e, [
        { label: t.view.pinned ? 'Unpin Tab' : 'Pin Tab', icon: 'pin', action: () => this.togglePin(t.view) },
        '-',
        { label: 'Close Tab', action: () => this.close(t.view) },
        { label: 'Close Other Tabs', action: () => this.views.filter((v) => v !== t.view).forEach((v) => this.close(v)) },
        { label: 'Close All Tabs', action: () => [...this.views].forEach((v) => this.close(v)) },
      ]),
    });
    this.views = [];
    this.counter = 0;
  }

  get ws() { return this.owner.ws; }

  hasUnsavedEdits() { return this.views.some((v) => v.grid?.hasChanges()); }

  clearUnpinned() {
    for (const v of [...this.views]) if (!v.pinned && !v.grid?.hasChanges()) this.close(v);
  }

  add(result, meta) {
    this.counter++;
    const base = result.editable?.table || singleTable(result.columns) || 'Result';
    const title = `${base} ${this.counter}`;
    const view = new ResultView(this, result, { ...meta, title });
    this.views.push(view);
    this.body.append(view.el);
    view.tab = this.tabs.add({ title, icon: 'grid', view, tooltip: meta.sql });
    this.empty.remove();
    return view;
  }

  show(view) {
    for (const v of this.views) v.el.classList.toggle('hidden', v !== view);
    if (view) { view.onShow(); this.empty.remove(); } else if (!this.views.length) this.body.append(this.empty);
  }

  togglePin(view) {
    view.pinned = !view.pinned;
    view.tab.tabEl.classList.toggle('pinned', view.pinned);
  }

  close(view) {
    if (view.grid?.hasChanges() && !confirm('Discard pending changes in this result?')) return;
    this.views = this.views.filter((v) => v !== view);
    view.destroy();
    this.tabs.remove(view.tab);
    if (!this.views.length) this.body.append(this.empty);
  }

  activeView() { return this.tabs.active?.view || null; }
}

function singleTable(columns) {
  const t = new Set(columns.map((c) => c.org_table || c.table).filter(Boolean));
  return t.size === 1 ? [...t][0] : null;
}

class ResultView {
  constructor(panel, result, meta) {
    this.panel = panel;
    this.result = result;
    this.meta = meta;
    this.pinned = false;
    this.mode = 'grid';
    this.wrap = false;
    this.el = h('div', { class: 'rv' });
    this.build();
    this.load(result, meta);
  }

  get ws() { return this.panel.ws; }
  get editable() { return !!this.result.editable; }

  build() {
    this.filterInput = h('input', { class: 'input small', placeholder: 'Filter rows', spellcheck: false });
    this.filterInput.addEventListener('input', () => { this.grid.setFilter(this.filterInput.value); this.updateFooter(); });
    this.editBtns = [
      toolButton('rowEdit', 'Edit current row (open in Form Editor)', () => this.setMode('form')),
      toolButton('rowAdd', 'Insert new row', () => this.addRow()),
      toolButton('rowDel', 'Delete selected rows', () => this.grid.deleteSelectedRows()),
    ];
    this.wrapBtn = toolButton('wrap', 'Wrap cell content', () => {
      this.wrap = !this.wrap;
      this.wrapBtn.classList.toggle('on', this.wrap);
      this.grid.opts.wrap = this.wrap;
      this.grid.scheduleRender(true);
    });
    this.toolbar = h('div', { class: 'rv-toolbar toolbar' },
      h('span', { class: 'tb-text strong' }, icon('grid'), ' Result Grid'), sep(),
      h('span', { class: 'tb-text' }, 'Filter Rows:'), this.filterInput, sep(),
      h('span', { class: 'tb-text edit-label' }, 'Edit:'), ...this.editBtns, sep(),
      h('span', { class: 'tb-text' }, 'Export:'), toolButton('export', 'Export recordset to an external file', (e) => this.exportMenu(e.currentTarget)), sep(),
      h('span', { class: 'tb-text' }, 'Wrap Cell Content:'), this.wrapBtn,
      h('span', { class: 'flex1' }),
      this.countLabel = h('span', { class: 'tb-text muted' }));
    this.content = h('div', { class: 'rv-content' });
    this.gridHost = h('div', { class: 'rv-grid' });
    this.altHost = h('div', { class: 'rv-alt hidden' });
    this.content.append(this.gridHost, this.altHost);
    this.side = h('div', { class: 'rv-side' });
    this.sideBtns = {};
    for (const [key, ic, label] of VIEWS) {
      const b = h('button', { class: 'rv-side-btn', title: label, onclick: () => this.setMode(key) }, icon(ic), h('span', null, label));
      this.sideBtns[key] = b;
      this.side.append(b);
    }
    this.applyBtn = h('button', { class: 'btn small primary', onclick: () => this.apply() }, 'Apply');
    this.revertBtn = h('button', { class: 'btn small', onclick: () => this.grid.revert() }, 'Revert');
    this.roLabel = h('span', { class: 'ro-label' });
    this.footer = h('div', { class: 'rv-footer' }, this.roLabel, h('span', { class: 'flex1' }), this.revertBtn, this.applyBtn);
    this.el.append(this.toolbar, h('div', { class: 'rv-main' }, this.content, this.side), this.footer);

    this.grid = new DataGrid(this.gridHost, {
      editable: () => this.editable,
      showNewRow: () => this.editable,
      onEdit: () => this.updateFooter(),
      onContextMenu: (e, pos) => this.cellMenu(e, pos),
      onActivate: (r, c) => this.openValue(r, c),
      onCopy: () => this.copySelection(),
      onSelectionChange: () => { if (this.mode === 'form') this.renderForm(); },
    });
  }

  load(result, meta) {
    this.result = result;
    if (meta) this.meta = { ...this.meta, ...meta };
    const ed = result.editable;
    const cols = result.columns.map((c, i) => ({ ...c, editable: !!(ed && ed.columns[i]) }));
    this.grid.setData(cols, result.rows);
    this.editBtns.forEach((b) => { b.disabled = !this.editable; });
    this.toolbar.querySelector('.edit-label').classList.toggle('muted', !this.editable);
    this.plan = null;
    this.updateFooter();
    if (this.mode !== 'grid') this.setMode(this.mode);
  }

  onShow() { this.grid.scheduleRender(true); }

  destroy() { this.grid.destroy(); this.el.remove(); }

  updateFooter() {
    const changed = this.grid.hasChanges();
    this.applyBtn.disabled = !changed;
    this.revertBtn.disabled = !changed;
    this.applyBtn.classList.toggle('hidden', !this.editable);
    this.revertBtn.classList.toggle('hidden', !this.editable);
    this.roLabel.innerHTML = '';
    if (!this.editable) {
      this.roLabel.append(icon('infoOutline'), h('span', null, 'Read Only'));
      this.roLabel.title = this.result.read_only_reason || 'This result cannot be edited.';
    } else {
      this.roLabel.title = `Editable: ${this.result.editable.schema}.${this.result.editable.table}`;
      if (changed) this.roLabel.append(icon('edit'), h('span', null, 'Pending changes - click Apply to save them'));
    }
    const shown = this.grid.rowCount;
    const total = this.result.rows.length;
    let txt = `${formatNumber(total)} row${total === 1 ? '' : 's'}`;
    if (shown !== total) txt = `${formatNumber(shown)} of ` + txt;
    if (this.result.truncated) txt += ' (more available - limit reached)';
    this.countLabel.textContent = txt;
    this.tab?.tabEl.classList.toggle('dirty', changed);
  }

  addRow() {
    this.setMode('grid');
    const vi = this.grid.addRow();
    const c = this.grid.firstEditableCol();
    if (c >= 0) setTimeout(() => this.grid.startEdit(vi, c), 0);
  }

  // ------------------------------------------------------------- side views
  setMode(mode) {
    this.mode = mode;
    Object.entries(this.sideBtns).forEach(([k, b]) => b.classList.toggle('active', k === mode));
    const isGrid = mode === 'grid';
    this.gridHost.classList.toggle('hidden', !isGrid);
    this.altHost.classList.toggle('hidden', isGrid);
    this.toolbar.classList.toggle('dim', !isGrid);
    if (isGrid) { this.grid.scheduleRender(true); return; }
    this.altHost.innerHTML = '';
    if (mode === 'form') this.renderForm();
    else if (mode === 'types') this.renderTypes();
    else if (mode === 'stats') this.renderStats();
    else if (mode === 'plan') this.renderPlan();
  }

  renderForm() {
    if (this.mode !== 'form') return;
    const g = this.grid;
    this.altHost.innerHTML = '';
    if (!g.rowCount) { this.altHost.append(emptyState('form', 'No rows', '')); return; }
    if (g.active.r < 0 || g.active.r >= g.rowCount) g.active = { r: 0, c: 0 };
    const r = g.active.r;
    const row = g.rowAt(r);
    const nav = h('div', { class: 'form-nav toolbar' },
      h('button', { class: 'btn small', onclick: () => { g.active.r = 0; this.renderForm(); } }, '⏮'),
      h('button', { class: 'btn small', onclick: () => { g.active.r = Math.max(0, r - 1); this.renderForm(); } }, '◀'),
      h('span', { class: 'tb-text' }, `Record ${r + 1} of ${g.rowCount}`),
      h('button', { class: 'btn small', onclick: () => { g.active.r = Math.min(g.rowCount - 1, r + 1); this.renderForm(); } }, '▶'),
      h('button', { class: 'btn small', onclick: () => { g.active.r = g.rowCount - 1; this.renderForm(); } }, '⏭'),
      row.st ? h('span', { class: 'badge ' + row.st }, { new: 'new row', mod: 'modified', del: 'deleted' }[row.st]) : null);
    const form = h('div', { class: 'record-form' });
    g.columns.forEach((c) => {
      const v = row.v[c.idx];
      const canEdit = g.canEdit(r, c.idx);
      const long = typeof v === 'string' && (v.length > 80 || v.includes('\n'));
      const input = h(long ? 'textarea' : 'input', { class: 'input' + (v === null ? ' is-null' : ''), readOnly: !canEdit, rows: long ? 4 : undefined, placeholder: v === null ? 'NULL' : '' });
      input.value = v === null ? '' : plainValue(v);
      input.addEventListener('change', () => g.setCell(r, c.idx, input.value));
      const nullBtn = canEdit ? h('button', { class: 'btn tiny', title: 'Set to NULL', onclick: () => { g.setCell(r, c.idx, null); this.renderForm(); } }, 'NULL') : null;
      form.append(h('label', { class: 'rf-label' + (row.ch?.has(c.idx) ? ' changed' : '') }, c.pk ? '🔑 ' : '', c.name, h('span', { class: 'muted small' }, ' ' + (c.type || ''))),
        h('div', { class: 'rf-value' }, input, nullBtn));
    });
    this.altHost.append(nav, form);
  }

  renderTypes() {
    const rows = this.result.columns.map((c, i) => [i + 1, c.name, c.schema || '', c.org_table || c.table || '', c.org_name || '',
      c.type, c.length ?? '', c.decimals ?? '', c.nullable === false ? 'NO' : 'YES', c.pk ? 'YES' : '', c.auto_increment ? 'YES' : '']);
    const cols = ['#', 'Field', 'Schema', 'Table', 'Original Name', 'Type', 'Display Size', 'Decimals', 'Nullable', 'Primary Key', 'Auto Inc']
      .map((n, i) => ({ name: n, kind: i === 0 || i === 6 || i === 7 ? 'num' : 'str' }));
    const host = h('div', { class: 'fill' });
    this.altHost.append(host);
    new DataGrid(host, {}).setData(cols, rows);
  }

  renderStats() {
    const m = this.meta;
    const r = this.result;
    const rows = [
      ['Statement', m.sql],
      ['Executed at', m.time ? new Date(m.time).toLocaleString() : ''],
      ['Server execution time', `${(m.exec_ms ?? 0).toFixed(3)} ms`],
      ['Fetch / conversion time', `${(m.fetch_ms ?? 0).toFixed(3)} ms`],
      ['Client round trip', m.round_trip_ms !== undefined ? `${m.round_trip_ms.toFixed(1)} ms` : ''],
      ['Rows returned', formatNumber(r.rows.length) + (r.truncated ? ' (truncated by row limit)' : '')],
      ['Columns', r.columns.length],
      ['Editable', r.editable ? `Yes - ${r.editable.schema}.${r.editable.table} (key: ${r.editable.pk.join(', ')})` : `No - ${r.read_only_reason || ''}`],
      ['Connection', this.ws.title],
    ];
    const t = h('table', { class: 'kv-table' });
    for (const [k, v] of rows) t.append(h('tr', null, h('th', null, k), h('td', null, k === 'Statement' ? h('pre', { class: 'sql-pre' }, v) : String(v))));
    this.altHost.append(h('div', { class: 'pad scroll' }, h('h3', { class: 'section-title' }, 'Query Statistics'), t));
  }

  async renderPlan() {
    const host = h('div', { class: 'plan-host pad scroll' }, h('div', { class: 'muted' }, icon('spinner'), ' Running EXPLAIN...'));
    this.altHost.append(host);
    try {
      if (!this.plan) this.plan = await api.post(`/sessions/${this.ws.sid}/explain`, { sql: this.meta.originalSql || this.meta.sql });
      host.innerHTML = '';
      renderExplain(host, this.plan, this.ws.driver);
    } catch (e) {
      host.innerHTML = '';
      host.append(h('div', { class: 'error-box' }, icon('error'), ' ', e.message));
    }
  }

  // ------------------------------------------------------------- menus
  cellMenu(e, pos) {
    const g = this.grid;
    const r = pos?.r ?? -1, c = pos?.c ?? -1;
    const row = r >= 0 ? g.rowAt(r) : null;
    const canEdit = row && c >= 0 && g.canEdit(r, c);
    const ed = this.editable;
    contextMenu(e, [
      { label: canEdit ? 'Open Value in Editor' : 'Open Value in Viewer', icon: 'edit', disabled: !row || c < 0, action: () => this.openValue(r, c) },
      { label: 'Set Field to NULL', disabled: !canEdit, action: () => g.setCell(r, c, null) },
      { label: 'Set Field to Empty String', disabled: !canEdit, action: () => g.setCell(r, c, '') },
      '-',
      { label: 'Copy Field', icon: 'copy', disabled: !row || c < 0, shortcut: 'Ctrl+C', action: () => copyText(fieldText(row.v[c], true)) },
      { label: 'Copy Field (unquoted)', disabled: !row || c < 0, action: () => copyText(fieldText(row.v[c], false)) },
      { label: 'Copy Row', disabled: !row, action: () => copyText(this.rowsAs('csv', [row], false)) },
      { label: 'Copy Row (with names)', disabled: !row, action: () => copyText(this.rowsAs('csv', [row], true)) },
      { label: 'Copy Row (tab separated)', disabled: !row, action: () => copyText(this.rowsAs('tsv', [row], false)) },
      { label: 'Copy Selected Rows as INSERT', disabled: !row, action: () => copyText(this.rowsAs('sql', g.selectedRowObjects(), true)) },
      { label: 'Copy All Rows (tab separated, with names)', action: () => copyText(this.rowsAs('tsv', g.visibleRows(), true)) },
      '-',
      { label: 'Filter Rows by This Value', disabled: !row || c < 0, action: () => { this.filterInput.value = plainValue(row.v[c]) ?? ''; this.grid.setFilter(this.filterInput.value); this.updateFooter(); } },
      { label: 'Sort Ascending', disabled: c < 0, action: () => g.setSort(c, 1) },
      { label: 'Sort Descending', disabled: c < 0, action: () => g.setSort(c, -1) },
      { label: 'Clear Sorting', disabled: !g.sort, action: () => g.setSort(c, 0) },
      '-',
      { label: 'Add Row', icon: 'rowAdd', disabled: !ed, action: () => this.addRow() },
      { label: 'Delete Row(s)', icon: 'rowDel', disabled: !ed || !row, action: () => g.deleteSelectedRows() },
      '-',
      { label: 'Refresh', icon: 'refresh', action: () => this.panel.owner.rerunFor(this) },
    ]);
  }

  copySelection() {
    const g = this.grid;
    if (g.selRows.size > 1) copyText(this.rowsAs('tsv', g.selectedRowObjects(), false));
    else {
      const row = g.rowAt(g.active.r);
      if (row && g.active.c >= 0) copyText(fieldText(row.v[g.active.c], false));
    }
  }

  openValue(r, c) {
    const g = this.grid;
    const row = g.rowAt(r);
    if (!row || c < 0) return;
    const col = g.columns[c];
    const v = row.v[c];
    const canEdit = g.canEdit(r, c);
    const isBin = v && typeof v === 'object' && v.$bin !== undefined;
    const ta = h('textarea', { class: 'input mono value-editor', readOnly: !canEdit, spellcheck: false });
    ta.value = v === null ? '' : isBin ? hexToText(v.$bin) : String(v);
    const views = h('div', { class: 'seg' });
    const body = h('div', { class: 'value-body' }, ta);
    const setView = (kind) => {
      views.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === kind));
      body.innerHTML = '';
      if (kind === 'text') body.append(ta);
      else if (kind === 'hex') body.append(h('pre', { class: 'hexdump' }, hexDump(isBin ? v.$bin : textToHex(ta.value))));
      else if (kind === 'json') {
        let txt;
        try { txt = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (err) { txt = 'Not valid JSON: ' + err.message; }
        body.append(h('pre', { class: 'json-view' }, txt));
      }
    };
    for (const [k, label] of [['text', 'Text'], ['hex', 'Binary'], ['json', 'JSON']]) {
      views.append(h('button', { class: 'seg-btn', dataset: { k }, onclick: () => setView(k) }, label));
    }
    setView('text');
    const info = h('div', { class: 'muted small' }, `${col.name} : ${col.type || ''}` +
      (isBin ? ` - ${v.size.toLocaleString()} bytes${v.size > v.$bin.length / 2 ? ' (preview)' : ''}` : v === null ? ' - NULL' : ` - ${String(v).length.toLocaleString()} characters`));
    modal({
      title: 'Edit Data for ' + col.name, width: 720, className: 'value-dialog',
      content: h('div', { class: 'value-dialog-body' }, h('div', { class: 'row-between' }, views, info), body),
      buttons: canEdit ? [
        { label: 'Save to File...', onClick: async () => { await saveTextFile(ta.value, col.name + '.txt', [['Text', '*.txt'], ['All Files', '*.*']]); return false; } },
        { label: 'Set NULL', onClick: () => { g.setCell(r, c, null); } },
        '-',
        { label: 'Cancel', value: null },
        { label: 'Apply', primary: true, onClick: () => { g.setCell(r, c, ta.value); } },
      ] : [
        { label: 'Save to File...', onClick: async () => { await saveTextFile(ta.value, col.name + '.txt', [['Text', '*.txt'], ['All Files', '*.*']]); return false; } },
        '-',
        { label: 'Close', value: null, primary: true },
      ],
    });
  }

  exportMenu(anchor) {
    const doExport = async (fmt, ext, label) => {
      const text = this.rowsAs(fmt, this.grid.visibleRows(), true);
      const name = (this.result.editable?.table || 'result') + '.' + ext;
      const saved = await saveTextFile(text, name, [[label, '*.' + ext], ['All Files', '*.*']]);
      if (saved) toast(`Exported ${this.grid.rowCount} rows to ${saved}`, 'success');
    };
    dropdownMenu(anchor, [
      { label: 'CSV (comma separated)', action: () => doExport('csv', 'csv', 'CSV') },
      { label: 'CSV (semicolon separated)', action: () => doExport('csv;', 'csv', 'CSV') },
      { label: 'Tab separated', action: () => doExport('tsv', 'tsv', 'Tab separated') },
      { label: 'JSON', action: () => doExport('json', 'json', 'JSON') },
      { label: 'SQL INSERT statements', action: () => doExport('sql', 'sql', 'SQL') },
      { label: 'HTML table', action: () => doExport('html', 'html', 'HTML') },
      { label: 'Markdown table', action: () => doExport('md', 'md', 'Markdown') },
      { label: 'XML', action: () => doExport('xml', 'xml', 'XML') },
    ]);
  }

  rowsAs(fmt, rows, withHeader) {
    const cols = this.grid.columns;
    const names = cols.map((c) => c.name);
    const vals = rows.map((r) => r.v);
    const csvCell = (v, d) => {
      if (v === null) return '';
      const s = plainValue(v);
      return /["\n\r]/.test(s) || s.includes(d) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    if (fmt === 'csv' || fmt === 'csv;' || fmt === 'tsv') {
      const d = fmt === 'tsv' ? '\t' : fmt === 'csv;' ? ';' : ',';
      const lines = vals.map((v) => v.map((x) => fmt === 'tsv' ? (x === null ? 'NULL' : plainValue(x).replace(/[\t\n\r]/g, ' ')) : csvCell(x, d)).join(d));
      if (withHeader) lines.unshift(names.map((n) => fmt === 'tsv' ? n : csvCell(n, d)).join(d));
      return lines.join('\r\n') + '\r\n';
    }
    if (fmt === 'json') {
      return JSON.stringify(vals.map((v) => Object.fromEntries(names.map((n, i) => [n, v[i] && typeof v[i] === 'object' ? plainValue(v[i]) : v[i]]))), null, 2);
    }
    if (fmt === 'sql') {
      const ws = this.ws;
      const table = this.result.editable ? ws.qualify(this.result.editable.schema, this.result.editable.table) : ws.quoteIdent(singleTable(this.result.columns) || 'table_name');
      const colList = names.map((n) => ws.quoteIdent(n)).join(', ');
      return vals.map((v) => `INSERT INTO ${table} (${colList}) VALUES (${v.map((x) => ws.sqlLiteral(x)).join(', ')});`).join('\n') + '\n';
    }
    if (fmt === 'html') {
      const th = names.map((n) => `<th>${esc(n)}</th>`).join('');
      const trs = vals.map((v) => '<tr>' + v.map((x) => `<td>${x === null ? '<i>NULL</i>' : esc(plainValue(x))}</td>`).join('') + '</tr>').join('\n');
      return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Export</title><style>table{border-collapse:collapse;font:13px sans-serif}td,th{border:1px solid #ccc;padding:3px 6px}th{background:#eee}</style></head>\n<body><table>\n<tr>${th}</tr>\n${trs}\n</table></body></html>\n`;
    }
    if (fmt === 'md') {
      const cell = (x) => (x === null ? 'NULL' : plainValue(x)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return [`| ${names.join(' | ')} |`, `| ${names.map(() => '---').join(' | ')} |`, ...vals.map((v) => `| ${v.map(cell).join(' | ')} |`)].join('\n') + '\n';
    }
    if (fmt === 'xml') {
      const tag = (n) => n.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^([^A-Za-z_])/, '_$1');
      return '<?xml version="1.0" encoding="UTF-8"?>\n<resultset>\n' + vals.map((v) => '  <row>\n' + v.map((x, i) =>
        x === null ? `    <${tag(names[i])} xsi:nil="true"/>` : `    <${tag(names[i])}>${esc(plainValue(x))}</${tag(names[i])}>`).join('\n') + '\n  </row>').join('\n') + '\n</resultset>\n';
    }
    return '';
  }

  // ------------------------------------------------------------- apply edits
  buildChanges() {
    const ed = this.result.editable;
    const pkIdx = ed.pk.map((name) => ed.columns.indexOf(name));
    const changes = { updates: [], inserts: [], deletes: [] };
    for (const row of this.grid.rows) {
      if (!row.st) continue;
      const base = row.o || row.v;
      const pk = Object.fromEntries(pkIdx.map((i) => [ed.pk[pkIdx.indexOf(i)], base[i]]));
      if (row.st === 'del') changes.deletes.push({ pk });
      else if (row.st === 'mod') changes.updates.push({ pk, set: Object.fromEntries([...row.ch].map((i) => [ed.columns[i], row.v[i]])) });
      else if (row.st === 'new') changes.inserts.push(Object.fromEntries([...(row.ch || [])].filter((i) => ed.columns[i]).map((i) => [ed.columns[i], row.v[i]])));
    }
    return changes;
  }

  async apply() {
    if (this.grid.editor) this.grid.commitEditor();
    const ed = this.result.editable;
    try {
      const { statements } = await api.post(`/sessions/${this.ws.sid}/build_edits`, { schema: ed.schema, table: ed.table, changes: this.buildChanges() });
      if (!statements.length) return;
      const ok = await reviewAndApply(this.ws, statements, { title: 'Apply SQL Script to Database', transaction: true });
      if (ok) {
        this.grid.commitChanges();
        this.updateFooter();
        this.panel.owner.rerunFor(this);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }
}

function fieldText(v, quoted) {
  if (v === null) return 'NULL';
  const s = plainValue(v);
  if (!quoted || typeof v === 'number') return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

function hexToText(hex) {
  const bytes = new Uint8Array(hex.match(/../g)?.map((x) => parseInt(x, 16)) || []);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function textToHex(text) {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexDump(hex) {
  const bytes = hex.match(/../g) || [];
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const ascii = chunk.map((b) => { const n = parseInt(b, 16); return n >= 32 && n < 127 ? String.fromCharCode(n) : '.'; }).join('');
    lines.push(i.toString(16).padStart(8, '0') + '  ' + chunk.join(' ').padEnd(48, ' ') + '  ' + ascii);
    if (lines.length > 4000) { lines.push('...'); break; }
  }
  return lines.join('\n') || '(empty)';
}

// ------------------------------------------------------------------ visual explain
const ACCESS = {
  ALL: ['Full Table Scan', 'bad'], index: ['Full Index Scan', 'warn'], range: ['Index Range Scan', 'ok'],
  index_merge: ['Index Merge', 'ok'], ref: ['Non-Unique Key Lookup', 'good'], eq_ref: ['Unique Key Lookup', 'good'],
  ref_or_null: ['Key Lookup (or NULL)', 'good'], const: ['Single Row (constant)', 'best'], system: ['Single Row (system)', 'best'],
  fulltext: ['Fulltext Index Search', 'ok'], unique_subquery: ['Unique Subquery', 'good'], index_subquery: ['Index Subquery', 'good'],
  hash_ALL: ['Hash Join (full scan)', 'warn'], hash_index: ['Hash Join (index)', 'ok'],
};

export function renderExplain(host, plan, driver) {
  const seg = h('div', { class: 'seg' });
  const body = h('div', { class: 'plan-body' });
  const modes = [];
  if (plan.json) modes.push(['visual', 'Visual Explain']);
  if (driver === 'sqlite' && plan.table) modes.push(['tree', 'Query Plan']);
  if (plan.table) modes.push(['table', 'Tabular Explain']);
  if (plan.json) modes.push(['json', 'Raw JSON']);
  const show = (k) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    body.innerHTML = '';
    if (k === 'visual') body.append(visualExplain(plan.json));
    else if (k === 'tree') body.append(sqliteTree(plan.table));
    else if (k === 'json') {
      let t = plan.json;
      try { t = JSON.stringify(JSON.parse(plan.json), null, 2); } catch { /* keep raw */ }
      body.append(h('pre', { class: 'json-view' }, t));
    } else {
      const g = h('div', { class: 'plan-grid' });
      body.append(g);
      new DataGrid(g, {}).setData(plan.table.columns, plan.table.rows);
    }
  };
  modes.forEach(([k, label]) => seg.append(h('button', { class: 'seg-btn', dataset: { k }, onclick: () => show(k) }, label)));
  host.append(h('div', { class: 'row-between' }, seg, h('span', { class: 'muted small' }, 'Execution plan for the statement of this result')), body);
  if (modes.length) show(modes[0][0]);
  else body.append(emptyState('plan', 'No plan available', ''));
}

function sqliteTree(table) {
  const rows = table.rows.map((r) => ({ id: r[0], parent: r[1], detail: r[3] }));
  const root = h('div', { class: 'qp-tree' });
  const byParent = new Map();
  rows.forEach((r) => { if (!byParent.has(r.parent)) byParent.set(r.parent, []); byParent.get(r.parent).push(r); });
  const add = (parentId, container) => {
    for (const r of byParent.get(parentId) || []) {
      const cls = /^SCAN/.test(r.detail) ? 'bad' : /^SEARCH/.test(r.detail) ? 'good' : /TEMP B-TREE/.test(r.detail) ? 'warn' : 'neutral';
      const node = h('div', { class: 'qp-node' }, h('span', { class: 'qp-badge ' + cls }, r.detail.split(' ')[0]), ' ', r.detail);
      const kids = h('div', { class: 'qp-children' });
      container.append(node, kids);
      add(r.id, kids);
    }
  };
  add(0, root);
  return root;
}

function visualExplain(jsonText) {
  let plan;
  try { plan = JSON.parse(jsonText); } catch { return h('pre', null, jsonText); }
  const wrap = h('div', { class: 've' });
  const qb = plan.query_block || plan;
  const header = h('div', { class: 've-head' }, icon('plan'), ' Query block #', String(qb.select_id ?? 1),
    qb.cost_info?.query_cost ? h('span', { class: 've-cost' }, `query cost: ${qb.cost_info.query_cost}`) : null);
  wrap.append(header);
  const tables = [];
  const ops = [];
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth)); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'table' && v && typeof v === 'object' && v.table_name !== undefined) {
        tables.push(v);
        walk(v, depth + 1);
      } else if (['ordering_operation', 'grouping_operation', 'duplicates_removal', 'filesort', 'temporary_table', 'window_functions_computation'].includes(k)) {
        ops.push(k.replace(/_/g, ' ') + (v?.using_filesort ? ' (filesort)' : '') + (v?.using_temporary_table ? ' (temporary table)' : ''));
        walk(v, depth + 1);
      } else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(qb);
  if (ops.length) wrap.append(h('div', { class: 've-ops' }, ...ops.map((o) => h('span', { class: 've-op' }, o))));
  const flow = h('div', { class: 've-flow' });
  tables.forEach((t, i) => {
    if (i > 0) flow.append(h('div', { class: 've-join' }, h('div', { class: 've-diamond' }), h('span', null, 'nested loop')));
    const [label, cls] = ACCESS[t.access_type] || [t.access_type || 'access', 'neutral'];
    const rows = t.rows_examined_per_scan ?? t.rows ?? t.r_rows;
    const box = h('div', { class: 've-table ' + cls },
      h('div', { class: 've-type' }, label),
      h('div', { class: 've-name' }, icon('table'), ' ', t.table_name),
      t.key ? h('div', { class: 've-key' }, icon('key'), ' ', t.key) : null,
      h('div', { class: 've-meta' }, rows !== undefined ? `${formatNumber(rows)} row(s)` : '', t.filtered !== undefined ? ` · filtered ${t.filtered}%` : ''),
      t.cost_info?.prefix_cost ? h('div', { class: 've-meta' }, `cost ${t.cost_info.prefix_cost}`) : null,
      t.attached_condition ? h('div', { class: 've-cond', title: t.attached_condition }, 'where: ', t.attached_condition) : null);
    flow.append(box);
  });
  if (!tables.length) flow.append(h('div', { class: 'muted' }, qb.table?.message || qb.message || 'No table access in this plan.'));
  wrap.append(flow);
  const legend = h('div', { class: 've-legend' }, ...[['best', 'Constant'], ['good', 'Key lookup'], ['ok', 'Range / index merge'], ['warn', 'Full index scan'], ['bad', 'Full table scan']]
    .map(([c, l]) => h('span', null, h('i', { class: 've-swatch ' + c }), l)));
  wrap.append(legend);
  return wrap;
}

export { displayValue };
