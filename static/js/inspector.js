// Table Inspector and Schema Inspector.
import { api } from './api.js';
import { DataGrid } from './grid.js';
import { copyText, formatBytes, formatNumber, h, icon, toast, toolButton } from './ui.js';

function statCard(k, v) { return h('div', { class: 'stat-card' }, h('div', { class: 'v' }, v ?? '-'), h('div', { class: 'k' }, k)); }

function gridIn(host, columns, rows, opts) {
  const g = new DataGrid(host, opts || {});
  g.setData(columns.map((c) => (typeof c === 'string' ? { name: c, kind: 'str' } : c)), rows);
  return g;
}

export class TableInspector {
  constructor(ws, schema, table) {
    this.ws = ws;
    this.kind = 'inspector';
    this.schema = schema;
    this.objectName = table;
    this.title = `${table} - Inspector`;
    this.icon = 'infoOutline';
    this.id = 'ti-' + Date.now();
    this.section = 'info';
    this.el = h('div', { class: 'doc' });
    this.toolbar = h('div', { class: 'toolbar' },
      toolButton('refresh', 'Refresh', () => this.load(), { label: 'Refresh' }),
      ws.features.table_editor === false ? null : toolButton('wrench', 'Alter Table', () => ws.openTableEditor(schema, table), { label: 'Alter Table' }),
      toolButton('grid', 'Select Rows', () => ws.selectRows(schema, table), { label: 'Select Rows' }),
      h('span', { class: 'flex1' }), h('span', { class: 'tb-text muted' }, `${schema}.${table}`));
    this.body = h('div', { class: 'editor-body' });
    this.tabs = h('div', { class: 'editor-tabs nav-tabs' });
    for (const [k, label] of [['info', 'Info'], ['columns', 'Columns'], ['indexes', 'Indexes'], ['fks', 'Foreign Keys'], ['triggers', 'Triggers'], ['ddl', 'DDL']]) {
      this.tabs.append(h('button', { class: 'nav-tab' + (k === this.section ? ' active' : ''), dataset: { k }, onclick: () => { this.section = k; this.render(); } }, label));
    }
    this.el.append(this.toolbar, this.body, this.tabs);
  }

  async load() {
    this.body.innerHTML = '';
    this.body.append(h('div', { class: 'pad muted' }, icon('spinner'), ' Loading...'));
    try {
      this.ws.navigator.details.delete(this.schema + '\u0000' + this.objectName);
      this.d = await this.ws.navigator.loadDetails(this.schema, this.objectName);
      this.render();
    } catch (e) {
      this.body.innerHTML = '';
      this.body.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
    }
  }

  render() {
    this.tabs.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.k === this.section));
    this.ddlEditor?.dispose();
    this.ddlEditor = null;
    this.body.innerHTML = '';
    const d = this.d;
    if (!d) return;
    const host = h('div', { class: 'fill' });
    this.body.append(host);
    if (this.section === 'info') {
      const i = d.info;
      const box = h('div', { class: 'inspector-body' });
      box.append(h('h2', { class: 'section-title' }, icon(d.is_view ? 'view' : 'table'), ` ${this.schema}.${this.objectName}`));
      box.append(h('div', { class: 'stat-cards' },
        statCard('Rows' + (this.ws.driver === 'mysql' ? ' (approx.)' : ''), i.row_estimate !== null && i.row_estimate !== undefined ? formatNumber(i.row_estimate) : '-'),
        i.data_length !== undefined ? statCard('Data size', formatBytes(i.data_length)) : null,
        i.index_length !== undefined ? statCard('Index size', formatBytes(i.index_length)) : null,
        statCard('Columns', d.columns.length), statCard('Indexes', d.indexes.length), statCard('Foreign keys', d.foreign_keys.length),
        i.auto_increment ? statCard('Next AUTO_INCREMENT', formatNumber(i.auto_increment)) : null));
      const rows = [['Table type', i.type], ['Engine', i.engine], ['Row format', i.row_format], ['Collation', i.collation], ['Create time', i.created],
        ['Update time', i.updated], ['Avg row length', i.avg_row_length], ['Data free', i.data_free !== undefined ? formatBytes(i.data_free) : null],
        ['Create options', i.create_options], ['Comment', i.comment]].filter(([, v]) => v !== undefined && v !== null && v !== '');
      box.append(h('table', { class: 'kv-table' }, ...rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, String(v))))));
      host.append(box);
    } else if (this.section === 'columns') {
      gridIn(host, ['#', 'Column', 'Type', 'Nullable', 'Default', 'Key', 'Extra', 'Charset', 'Collation', 'Comment'],
        d.columns.map((c) => [c.pos, c.name, c.column_type, c.nullable ? 'YES' : 'NO', c.default, c.col_key, c.extra, c.charset, c.collation, c.comment]));
    } else if (this.section === 'indexes') {
      gridIn(host, ['Index', 'Unique', 'Type', 'Columns', 'Comment'],
        d.indexes.map((x) => [x.name, x.unique ? 'YES' : 'NO', x.type, x.columns.map((c) => c.name + (c.sub_part ? `(${c.sub_part})` : '') + (c.order === 'DESC' ? ' DESC' : '')).join(', '), x.comment]));
    } else if (this.section === 'fks') {
      gridIn(host, ['Name', 'Columns', 'Referenced Table', 'Referenced Columns', 'On Update', 'On Delete'],
        d.foreign_keys.map((f) => [f.name, f.columns.join(', '), `${f.ref_schema}.${f.ref_table}`, f.ref_columns.join(', '), f.on_update, f.on_delete]));
    } else if (this.section === 'triggers') {
      gridIn(host, ['Trigger', 'Timing', 'Event', 'Statement'], d.triggers.map((t) => [t.name, t.timing, t.event, t.body]),
        { onActivate: (r, c, row) => this.ws.openObjectEditor('trigger', this.schema, row.v[0], { table: this.objectName }) });
    } else if (this.section === 'ddl') {
      const bar = h('div', { class: 'toolbar' },
        toolButton('copy', 'Copy DDL', () => { copyText(d.ddl); toast('Copied', 'success', 1200); }, { label: 'Copy' }),
        toolButton('newSql', 'Open in SQL editor', () => this.ws.sendToEditor(d.ddl), { label: 'Send to SQL Editor' }));
      const ed = h('div', { class: 'obj-editor-host' });
      host.append(h('div', { class: 'te-split' }, bar, ed));
      this.ddlEditor = window.monaco.editor.create(ed, {
        value: d.ddl, language: this.ws.driver === 'mysql' ? 'mysql' : 'sql', readOnly: true, minimap: { enabled: false }, automaticLayout: true,
        scrollBeyondLastLine: false, theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs', fontSize: this.ws.app.prefs.fontSize || 13,
      });
    }
  }

  onShow() {}
  dispose() { this.ddlEditor?.dispose(); }
}

export class SchemaInspector {
  constructor(ws, schema) {
    this.ws = ws;
    this.kind = 'schema-inspector';
    this.schema = schema;
    this.title = `${schema} - Schema`;
    this.icon = 'db';
    this.id = 'si-' + Date.now();
    this.el = h('div', { class: 'doc' });
    this.summary = h('div', { class: 'stat-cards pad' });
    this.gridHost = h('div', { class: 'editor-body' });
    this.el.append(h('div', { class: 'toolbar' },
      toolButton('refresh', 'Refresh', () => this.load(), { label: 'Refresh' }),
      toolButton('diagram', 'ER Diagram', () => ws.openErd(schema), { label: 'ER Diagram' }),
      ws.features.export ? toolButton('dumpOut', 'Export', () => ws.openAdmin('export', { schema }), { label: 'Export' }) : null,
      h('span', { class: 'flex1' }), h('span', { class: 'tb-text muted' }, 'Double-click a table to open its inspector')),
    this.summary, this.gridHost);
  }

  async load() {
    try {
      await this.ws.navigator.refreshSchema(this.schema);
      const o = await this.ws.navigator.loadSchema(this.schema);
      const all = [...o.tables, ...o.views];
      const mysql = this.ws.driver === 'mysql';
      const total = (t) => Number(t.data_length || 0) + Number(t.index_length || 0);
      this.summary.innerHTML = '';
      this.summary.append(...[statCard('Tables', o.tables.length), statCard('Views', o.views.length),
        mysql ? statCard('Procedures / functions', `${o.procedures.length} / ${o.functions.length}`) : null,
        mysql ? statCard('Total size', formatBytes(o.tables.reduce((s, t) => s + total(t), 0))) : null,
        mysql ? statCard('Rows (approx.)', formatNumber(o.tables.reduce((s, t) => s + Number(t.row_estimate || 0), 0))) : null].filter(Boolean));
      this.gridHost.innerHTML = '';
      const cols = mysql
        ? ['Name', 'Type', 'Engine', { name: 'Rows', kind: 'num' }, { name: 'Data Size', kind: 'num' }, { name: 'Index Size', kind: 'num' }, { name: 'Total', kind: 'num' }, { name: 'Auto Inc', kind: 'num' }, 'Collation', 'Created', 'Updated', 'Comment']
        : ['Name', 'Type', { name: 'Columns', kind: 'num' }];
      const rows = all.map((t) => (mysql
        ? [t.name, t.type, t.engine, t.row_estimate, formatBytes(t.data_length || 0), formatBytes(t.index_length || 0), formatBytes(total(t)), t.auto_increment, t.collation, t.created, t.updated, t.comment]
        : [t.name, t.type === 'VIEW' ? 'VIEW' : 'TABLE', (o.columns[t.name] || []).length]));
      gridIn(this.gridHost, cols, rows, { onActivate: (r, c, row) => { const t = all.find((x) => x.name === row.v[0]); if (t && t.type !== 'VIEW') this.ws.openInspector(this.schema, t.name); } });
    } catch (e) {
      this.gridHost.innerHTML = '';
      this.gridHost.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
    }
  }

  onShow() {}
}
