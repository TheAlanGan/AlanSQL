// Create / Alter Table editor (Workbench style): columns, indexes, foreign keys, triggers, options.
import { api } from './api.js';
import { reviewAndApply } from './review.js';
import { checkbox, contextMenu, emptyState, field, h, icon, select, toast, toolButton } from './ui.js';

const MYSQL_TYPES = ['INT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'BIGINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'BIT(1)', 'BOOLEAN',
  'VARCHAR(45)', 'VARCHAR(255)', 'CHAR(1)', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB',
  'BINARY(16)', 'VARBINARY(255)', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', "ENUM('a','b')", "SET('a','b')", 'JSON',
  'GEOMETRY', 'POINT'];
const SQLITE_TYPES = ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'VARCHAR(255)', 'BOOLEAN', 'DATE', 'DATETIME', 'DECIMAL(10,2)'];
const FK_RULES = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];
const STRINGY = /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set|date|datetime|timestamp|time|year|json|binary|varbinary|blob)/i;
let keySeq = 0;
const nextKey = () => 'k' + (++keySeq);

export class TableEditor {
  constructor(ws, schema, table) {
    this.ws = ws;
    this.kind = 'table-editor';
    this.schema = schema;
    this.objectName = table;
    this.isNew = !table;
    this.title = (table || 'new_table') + ' - Table';
    this.icon = 'table';
    this.id = 'te-' + Date.now();
    this.mysql = ws.driver === 'mysql';
    this.tab = null;
    this.section = 'columns';
    this.selCol = 0;
    this.selIdx = 0;
    this.selFk = 0;
    this.el = h('div', { class: 'doc table-editor' }, h('div', { class: 'pad muted' }, icon('spinner'), ' Loading...'));
  }

  async load() {
    try {
      this.meta = this.mysql ? await this.ws.loadMeta() : { engines: [], charsets: [], collations: [], defaults: {} };
      this.details = this.isNew ? null : await api.get(`/sessions/${this.ws.sid}/table?schema=${encodeURIComponent(this.schema)}&table=${encodeURIComponent(this.objectName)}`);
      this.schemaObjects = await this.ws.navigator.loadSchema(this.schema).catch(() => ({ tables: [], columns: {} }));
    } catch (e) {
      this.el.innerHTML = '';
      this.el.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
      return;
    }
    this.reset();
    this.build();
  }

  // ------------------------------------------------------------------ model
  reset() {
    const d = this.details;
    const defCharset = this.meta.defaults?.charset || '';
    if (!d) {
      this.model = {
        table: { name: 'new_table', engine: this.meta.defaults?.engine || '', charset: '', collation: '', comment: '', auto_increment: '', row_format: '' },
        columns: [this.newColumn(this.mysql ? 'id' : 'id', this.mysql ? 'INT' : 'INTEGER', { pk: true, nn: true, ai: true })],
        indexes: [], fks: [],
      };
      this.original = null;
      return;
    }
    const tcoll = d.info.collation || '';
    const tcharset = tcoll ? (this.meta.collations.find((c) => c.name === tcoll)?.charset || tcoll.split('_')[0]) : '';
    const pkIdx = d.indexes.find((i) => i.primary);
    const pkCols = new Set(pkIdx ? pkIdx.columns.map((c) => c.name) : []);
    const columns = d.columns.map((c) => {
      let type = c.column_type || c.data_type || '';
      const un = /\bunsigned\b/i.test(type);
      const zf = /\bzerofill\b/i.test(type);
      type = type.replace(/\s+unsigned\b/i, '').replace(/\s+zerofill\b/i, '').trim();
      type = type.replace(/^[a-z ]+/i, (m) => m.toUpperCase());
      const extra = c.extra || '';
      const g = !!c.gen_expr || (/\bGENERATED\b/i.test(extra) && !/DEFAULT_GENERATED/i.test(extra) && this.mysql);
      const onUpd = /on update ([\w()]+)/i.exec(extra);
      return {
        key: nextKey(), origName: c.name, name: c.name, type, pk: pkCols.has(c.name), nn: !c.nullable, un, zf,
        ai: /auto_increment/i.test(extra), g, storage: /STORED/i.test(extra) ? 'STORED' : 'VIRTUAL',
        default: g ? (c.gen_expr || '') : (c.default ?? ''), onUpdate: onUpd ? onUpd[1] : '',
        charset: c.charset && c.collation !== tcoll ? c.charset : '', collation: c.collation && c.collation !== tcoll ? c.collation : '',
        comment: c.comment || '',
      };
    });
    const indexes = d.indexes.filter((i) => !i.primary && i.origin !== 'pk').map((i) => ({
      key: nextKey(), origName: i.name, name: i.name,
      kind: i.unique ? 'UNIQUE' : /FULLTEXT/i.test(i.type) ? 'FULLTEXT' : /SPATIAL/i.test(i.type) ? 'SPATIAL' : 'INDEX',
      columns: i.columns.map((c) => ({ name: c.name, order: c.order || 'ASC', length: c.sub_part || '' })),
      comment: i.comment || '', auto: i.origin === 'u',
    }));
    const fks = d.foreign_keys.map((f) => ({
      key: nextKey(), origName: f.name, name: f.name, refSchema: f.ref_schema || this.schema, refTable: f.ref_table,
      columns: [...f.columns], refColumns: [...f.ref_columns], onUpdate: f.on_update || 'NO ACTION', onDelete: f.on_delete || 'NO ACTION',
    }));
    this.model = {
      table: { name: d.info.name, engine: d.info.engine || '', charset: tcharset === defCharset && !tcoll ? '' : tcharset, collation: tcoll, comment: d.info.comment || '',
        auto_increment: d.info.auto_increment ?? '', row_format: d.info.row_format || '' },
      columns, indexes, fks,
    };
    for (const c of columns) c.uq = this.hasUniqueOn(c.name);
    this.original = structuredClone(this.model);
  }

  newColumn(name, type, flags = {}) {
    return { key: nextKey(), origName: null, name, type, pk: false, nn: false, uq: false, un: false, zf: false, ai: false, g: false,
      storage: 'VIRTUAL', default: '', onUpdate: '', charset: '', collation: '', comment: '', ...flags };
  }

  hasUniqueOn(col) {
    return this.model.indexes.some((i) => i.kind === 'UNIQUE' && i.columns.length === 1 && i.columns[0].name === col);
  }

  setUnique(col, on) {
    if (on && !this.hasUniqueOn(col.name)) {
      this.model.indexes.push({ key: nextKey(), origName: null, name: `${col.name}_UNIQUE`, kind: 'UNIQUE', columns: [{ name: col.name, order: 'ASC', length: '' }], comment: '' });
    } else if (!on) {
      this.model.indexes = this.model.indexes.filter((i) => !(i.kind === 'UNIQUE' && i.columns.length === 1 && i.columns[0].name === col.name));
    }
    col.uq = on;
  }

  renameColumnRefs(oldName, newName) {
    for (const i of this.model.indexes) for (const c of i.columns) if (c.name === oldName) c.name = newName;
    for (const f of this.model.fks) f.columns = f.columns.map((c) => (c === oldName ? newName : c));
  }

  // ------------------------------------------------------------------ UI
  build() {
    const t = this.model.table;
    const ws = this.ws;
    this.el.innerHTML = '';
    this.nameInput = h('input', { class: 'input', value: t.name });
    this.nameInput.addEventListener('input', () => { t.name = this.nameInput.value; });
    const head = h('div', { class: 'editor-head' }, icon('table', 'big'));
    const form = h('div', { class: 'form grid2' });
    form.append(field('Table Name:', this.nameInput), field('Schema:', h('input', { class: 'input', value: this.schema, readOnly: true })));
    if (this.mysql) {
      const cs = select([['', 'Schema Default'], ...this.meta.charsets.map((c) => [c.name, c.name])], t.charset);
      const coll = select([], t.collation);
      const fillColl = () => {
        const cur = t.collation;
        coll.innerHTML = '';
        coll.append(h('option', { value: '' }, 'Default Collation'));
        this.meta.collations.filter((c) => !cs.value || c.charset === cs.value).forEach((c) => coll.append(h('option', { value: c.name }, c.name)));
        coll.value = this.meta.collations.some((c) => c.name === cur && (!cs.value || c.charset === cs.value)) ? cur : '';
        t.collation = coll.value;
      };
      cs.addEventListener('change', () => { t.charset = cs.value; fillColl(); });
      coll.addEventListener('change', () => { t.collation = coll.value; });
      fillColl();
      const eng = select([['', 'Default'], ...this.meta.engines.map((e) => [e, e])], t.engine, (v) => { t.engine = v; });
      form.append(field('Charset/Collation:', h('div', { class: 'row' }, cs, coll)), field('Engine:', eng));
      const comment = h('textarea', { class: 'input', rows: 2 });
      comment.value = t.comment;
      comment.addEventListener('input', () => { t.comment = comment.value; });
      form.append(h('div', { class: 'span2' }, field('Comments:', comment)));
    }
    head.append(form);
    this.body = h('div', { class: 'editor-body' });
    const tabs = h('div', { class: 'editor-tabs nav-tabs' });
    const sections = [['columns', 'Columns'], ['indexes', 'Indexes'], ['fks', 'Foreign Keys'], ['triggers', 'Triggers']];
    if (this.mysql) sections.push(['options', 'Options']);
    for (const [k, label] of sections) {
      tabs.append(h('button', { class: 'nav-tab' + (k === this.section ? ' active' : ''), onclick: (e) => {
        this.section = k;
        tabs.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
        this.renderSection();
      } }, label));
    }
    const footer = h('div', { class: 'editor-footer' },
      h('span', { class: 'muted flex1' }, this.isNew ? 'New table - click Apply to create it.' : 'Changes are applied with ALTER TABLE after you review them.'),
      h('button', { class: 'btn', onclick: () => { this.reset(); this.build(); } }, 'Revert'),
      h('button', { class: 'btn primary', onclick: () => this.apply() }, 'Apply'));
    this.el.append(head, this.body, tabs, footer);
    this.renderSection();
  }

  renderSection() {
    this.body.innerHTML = '';
    if (this.section === 'columns') this.renderColumns();
    else if (this.section === 'indexes') this.renderIndexes();
    else if (this.section === 'fks') this.renderFks();
    else if (this.section === 'triggers') this.renderTriggers();
    else this.renderOptions();
  }

  typeList() {
    let dl = document.getElementById('dl-types-' + this.ws.driver);
    if (!dl) {
      dl = h('datalist', { id: 'dl-types-' + this.ws.driver }, ...(this.mysql ? MYSQL_TYPES : SQLITE_TYPES).map((t) => h('option', { value: t })));
      document.body.append(dl);
    }
    return dl.id;
  }

  renderColumns() {
    const cols = this.model.columns;
    const flags = this.mysql ? [['pk', 'PK', 'Primary Key'], ['nn', 'NN', 'Not Null'], ['uq', 'UQ', 'Unique Index'], ['un', 'UN', 'Unsigned'],
      ['zf', 'ZF', 'Zero Fill'], ['ai', 'AI', 'Auto Increment'], ['g', 'G', 'Generated Column']]
      : [['pk', 'PK', 'Primary Key'], ['nn', 'NN', 'Not Null'], ['uq', 'UQ', 'Unique Index'], ['ai', 'AI', 'Autoincrement (INTEGER PRIMARY KEY only)'], ['g', 'G', 'Generated Column']];
    const table = h('table', { class: 'grid-table' });
    table.append(h('tr', null, h('th', { style: { width: '24px' } }), h('th', null, 'Column Name'), h('th', null, 'Datatype'),
      ...flags.map(([, l, t]) => h('th', { title: t, class: 'c', style: { width: '30px' } }, l)), h('th', null, 'Default/Expression')));
    cols.forEach((c, i) => {
      const tr = h('tr', { class: (i === this.selCol ? 'selected' : '') + (c.origName ? '' : ' st-new') });
      const name = h('input', { class: 'cell', value: c.name, spellcheck: false });
      name.addEventListener('change', () => { const old = c.name; c.name = name.value.trim(); this.renameColumnRefs(old, c.name); this.renderDetail(); });
      const type = h('input', { class: 'cell', value: c.type, list: this.typeList(), spellcheck: false });
      type.addEventListener('change', () => { c.type = type.value.trim(); });
      const dflt = h('input', { class: 'cell', value: c.default ?? '', spellcheck: false, placeholder: c.g ? 'expression' : '' });
      dflt.addEventListener('change', () => { c.default = dflt.value; });
      const cbs = flags.map(([k]) => {
        const cb = h('input', { type: 'checkbox', checked: !!c[k] });
        cb.addEventListener('change', () => {
          if (k === 'uq') this.setUnique(c, cb.checked);
          else c[k] = cb.checked;
          if (k === 'pk' && cb.checked) c.nn = true;
          if (k === 'ai' && cb.checked && !this.mysql) { c.pk = true; c.type = 'INTEGER'; }
          this.renderColumns();
        });
        return h('td', { class: 'c' }, cb);
      });
      tr.append(h('td', { class: 'c' }, icon(c.pk ? 'key' : c.nn ? 'columnNN' : 'column')), h('td', null, name), h('td', null, type), ...cbs, h('td', null, dflt));
      tr.addEventListener('mousedown', () => { if (this.selCol !== i) { this.selCol = i; table.querySelectorAll('tr').forEach((r, ri) => r.classList.toggle('selected', ri === i + 1)); this.renderDetail(); } });
      tr.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Move Up', disabled: i === 0, action: () => { cols.splice(i - 1, 0, cols.splice(i, 1)[0]); this.selCol = i - 1; this.renderColumns(); } },
        { label: 'Move Down', disabled: i === cols.length - 1, action: () => { cols.splice(i + 1, 0, cols.splice(i, 1)[0]); this.selCol = i + 1; this.renderColumns(); } },
        { label: 'Insert Column Above', action: () => { cols.splice(i, 0, this.newColumn(this.uniqueColName(), this.mysql ? 'VARCHAR(45)' : 'TEXT')); this.renderColumns(); } },
        '-',
        { label: 'Delete Selected Column', icon: 'trash', action: () => this.deleteColumn(i) },
      ]));
      table.append(tr);
    });
    const add = h('tr', { class: 'placeholder' }, h('td'), h('td', { colspan: flags.length + 3 }, '+ click here to add a column'));
    add.addEventListener('click', () => {
      cols.push(this.newColumn(this.uniqueColName(), this.mysql ? 'VARCHAR(45)' : 'TEXT'));
      this.selCol = cols.length - 1;
      this.renderColumns();
      setTimeout(() => { const rows = table.querySelectorAll('tr'); rows[rows.length - 2]?.querySelector('input.cell')?.select(); }, 0);
    });
    table.append(add);
    const top = h('div', { class: 'te-top' }, table);
    this.detail = h('div', { class: 'te-detail' });
    const wrap = h('div', { class: 'te-split' },
      h('div', { class: 'toolbar' }, toolButton('plus', 'Add column', () => add.click()), toolButton('trash', 'Delete selected column', () => this.deleteColumn(this.selCol)),
        toolButton('chevronDown', 'Move column down', () => { const i = this.selCol; if (i < cols.length - 1) { cols.splice(i + 1, 0, cols.splice(i, 1)[0]); this.selCol++; this.renderColumns(); } }),
        h('span', { class: 'muted small' }, 'Right-click a column for more options. Default values are SQL expressions (quote strings or they are quoted automatically).')),
      top, this.detail);
    this.body.innerHTML = '';
    this.body.append(wrap);
    this.renderDetail();
  }

  uniqueColName() {
    let n = 1;
    while (this.model.columns.some((c) => c.name === (this.mysql ? `new_column${n > 1 ? n : ''}` : `column${n}`))) n++;
    return this.mysql ? `new_column${n > 1 ? n : ''}` : `column${n}`;
  }

  deleteColumn(i) {
    const c = this.model.columns[i];
    if (!c) return;
    this.model.columns.splice(i, 1);
    this.model.indexes = this.model.indexes.map((ix) => ({ ...ix, columns: ix.columns.filter((x) => x.name !== c.name) })).filter((ix) => ix.columns.length);
    this.model.fks = this.model.fks.filter((f) => !f.columns.includes(c.name));
    this.selCol = Math.max(0, Math.min(i, this.model.columns.length - 1));
    this.renderColumns();
  }

  renderDetail() {
    const c = this.model.columns[this.selCol];
    this.detail.innerHTML = '';
    if (!c) return;
    const inp = (k, ph = '') => {
      const x = h('input', { class: 'input', value: c[k] ?? '', placeholder: ph, spellcheck: false });
      x.addEventListener('change', () => { c[k] = x.value; if (k === 'name' || k === 'type' || k === 'default') this.renderColumns(); });
      return x;
    };
    const grid = h('div', { class: 'form grid4' }, field('Column Name:', inp('name')), field('Data Type:', inp('type')),
      field(c.g ? 'Expression:' : 'Default:', inp('default', c.g ? 'e.g. price * qty' : "e.g. 0, 'text', CURRENT_TIMESTAMP")));
    if (this.mysql) {
      const cs = select([['', 'Table Default'], ...this.meta.charsets.map((x) => [x.name, x.name])], c.charset, (v) => { c.charset = v; c.collation = ''; this.renderDetail(); });
      const coll = select([['', 'Default'], ...this.meta.collations.filter((x) => !c.charset || x.charset === c.charset).map((x) => [x.name, x.name])], c.collation, (v) => { c.collation = v; });
      grid.append(field('Charset/Collation:', h('div', { class: 'row' }, cs, coll)), field('Comments:', inp('comment')),
        field('On Update:', inp('onUpdate', 'e.g. CURRENT_TIMESTAMP')));
    }
    if (c.g) grid.append(field('Storage:', select([['VIRTUAL', 'Virtual'], ['STORED', 'Stored']], c.storage, (v) => { c.storage = v; })));
    this.detail.append(grid);
  }

  renderIndexes() {
    const m = this.model;
    const list = h('table', { class: 'grid-table' }, h('tr', null, h('th', null, 'Index Name'), h('th', null, 'Type')));
    m.indexes.forEach((ix, i) => {
      const name = h('input', { class: 'cell', value: ix.name });
      name.addEventListener('change', () => { ix.name = name.value.trim(); });
      const kinds = this.mysql ? ['INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL'] : ['INDEX', 'UNIQUE'];
      const kind = select(kinds, ix.kind, (v) => { ix.kind = v; this.syncUq(); }, { class: 'cell' });
      const tr = h('tr', { class: (i === this.selIdx ? 'selected' : '') + (ix.origName ? '' : ' st-new') }, h('td', null, name), h('td', null, kind));
      tr.addEventListener('mousedown', () => { this.selIdx = i; this.renderIndexes(); });
      tr.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Delete Index', icon: 'trash', action: () => { m.indexes.splice(i, 1); this.syncUq(); this.renderIndexes(); } }]));
      list.append(tr);
    });
    const add = h('tr', { class: 'placeholder' }, h('td', { colspan: 2 }, '+ click to add an index'));
    add.addEventListener('click', () => {
      let n = 1;
      while (m.indexes.some((x) => x.name === `idx_${m.table.name}${n > 1 ? '_' + n : ''}`)) n++;
      m.indexes.push({ key: nextKey(), origName: null, name: `idx_${m.table.name}${n > 1 ? '_' + n : ''}`, kind: 'INDEX', columns: [], comment: '' });
      this.selIdx = m.indexes.length - 1;
      this.renderIndexes();
    });
    list.append(add);
    const pk = m.columns.filter((c) => c.pk).map((c) => c.name);
    const left = h('div', { class: 'te-pane' }, h('div', { class: 'te-pane-head' }, 'Indexes', h('span', { class: 'muted small' }, pk.length ? `(PRIMARY: ${pk.join(', ')} - set in Columns)` : '')), list);
    const right = h('div', { class: 'te-pane' });
    const ix = m.indexes[this.selIdx];
    if (!ix) right.append(emptyState('index', 'No index selected', 'Add an index on the left.'));
    else {
      const t = h('table', { class: 'grid-table' }, h('tr', null, h('th', { class: 'c' }), h('th', null, 'Index Column'), h('th', null, '#'), h('th', null, 'Order'), h('th', null, 'Length')));
      m.columns.forEach((c) => {
        const pos = ix.columns.findIndex((x) => x.name === c.name);
        const entry = ix.columns[pos];
        const cb = h('input', { type: 'checkbox', checked: pos >= 0 });
        cb.addEventListener('change', () => {
          if (cb.checked) ix.columns.push({ name: c.name, order: 'ASC', length: '' });
          else ix.columns.splice(ix.columns.findIndex((x) => x.name === c.name), 1);
          this.syncUq();
          this.renderIndexes();
        });
        const order = select(['ASC', 'DESC'], entry?.order || 'ASC', (v) => { if (entry) entry.order = v; }, { class: 'cell', disabled: !entry });
        const len = h('input', { class: 'cell', value: entry?.length || '', disabled: !entry, style: { width: '60px' } });
        len.addEventListener('change', () => { if (entry) entry.length = len.value.trim(); });
        t.append(h('tr', null, h('td', { class: 'c' }, cb), h('td', null, c.name), h('td', { class: 'num' }, pos >= 0 ? String(pos + 1) : ''), h('td', null, order), h('td', null, len)));
      });
      const comment = h('input', { class: 'input', value: ix.comment || '' });
      comment.addEventListener('change', () => { ix.comment = comment.value; });
      right.append(h('div', { class: 'te-pane-head' }, `Index Columns - ${ix.name}`), t, this.mysql ? h('div', { class: 'pad form' }, field('Index Comment:', comment)) : null);
    }
    this.body.innerHTML = '';
    this.body.append(h('div', { class: 'te-two' }, left, right));
  }

  syncUq() { for (const c of this.model.columns) c.uq = this.hasUniqueOn(c.name); }

  renderFks() {
    const m = this.model;
    const tables = (this.schemaObjects?.tables || []).map((t) => t.name);
    const list = h('table', { class: 'grid-table' }, h('tr', null, h('th', null, 'Foreign Key Name'), h('th', null, 'Referenced Table')));
    m.fks.forEach((fk, i) => {
      const name = h('input', { class: 'cell', value: fk.name });
      name.addEventListener('change', () => { fk.name = name.value.trim(); });
      const opts = [...new Set([...(fk.refSchema === this.schema ? [] : []), ...tables, fk.refTable].filter(Boolean))];
      const ref = select([['', '(select table)'], ...opts.map((t) => [t, (fk.refSchema && fk.refSchema !== this.schema ? fk.refSchema + '.' : '') + t])], fk.refTable, (v) => {
        fk.refTable = v; fk.refSchema = this.schema; fk.refColumns = fk.columns.map(() => ''); this.renderFks();
      }, { class: 'cell' });
      const tr = h('tr', { class: (i === this.selFk ? 'selected' : '') + (fk.origName ? '' : ' st-new') }, h('td', null, name), h('td', null, ref));
      tr.addEventListener('mousedown', (e) => { if (e.target.tagName === 'SELECT') return; this.selFk = i; this.renderFks(); });
      tr.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Delete Foreign Key', icon: 'trash', action: () => { m.fks.splice(i, 1); this.renderFks(); } }]));
      list.append(tr);
    });
    const add = h('tr', { class: 'placeholder' }, h('td', { colspan: 2 }, '+ click to add a foreign key'));
    add.addEventListener('click', () => {
      m.fks.push({ key: nextKey(), origName: null, name: `fk_${m.table.name}_${m.fks.length + 1}`, refSchema: this.schema, refTable: '', columns: [], refColumns: [], onUpdate: 'NO ACTION', onDelete: 'NO ACTION' });
      this.selFk = m.fks.length - 1;
      this.renderFks();
    });
    list.append(add);
    const left = h('div', { class: 'te-pane' }, h('div', { class: 'te-pane-head' }, 'Foreign Keys'), list);
    const right = h('div', { class: 'te-pane' });
    const fk = m.fks[this.selFk];
    if (!fk) right.append(emptyState('fk', 'No foreign key selected', 'Add a foreign key on the left.'));
    else {
      const refCols = this.refColumns(fk);
      const t = h('table', { class: 'grid-table' }, h('tr', null, h('th', { class: 'c' }), h('th', null, 'Column'), h('th', null, 'Referenced Column')));
      m.columns.forEach((c) => {
        const pos = fk.columns.indexOf(c.name);
        const cb = h('input', { type: 'checkbox', checked: pos >= 0 });
        cb.addEventListener('change', () => {
          if (cb.checked) { fk.columns.push(c.name); fk.refColumns.push(refCols.includes(c.name) ? c.name : (refCols.find((x) => x === 'id') || '')); }
          else { const p = fk.columns.indexOf(c.name); fk.columns.splice(p, 1); fk.refColumns.splice(p, 1); }
          this.renderFks();
        });
        const refSel = select([['', ''], ...refCols.map((x) => [x, x])], pos >= 0 ? fk.refColumns[pos] : '', (v) => { fk.refColumns[fk.columns.indexOf(c.name)] = v; }, { class: 'cell', disabled: pos < 0 });
        t.append(h('tr', null, h('td', { class: 'c' }, cb), h('td', null, c.name), h('td', null, refSel)));
      });
      const opts = h('div', { class: 'pad form grid2' },
        field('On Update:', select(FK_RULES, fk.onUpdate, (v) => { fk.onUpdate = v; })),
        field('On Delete:', select(FK_RULES, fk.onDelete, (v) => { fk.onDelete = v; })));
      right.append(h('div', { class: 'te-pane-head' }, `Columns - ${fk.name}`), t, h('div', { class: 'te-pane-head' }, 'Foreign Key Options'), opts);
    }
    this.body.innerHTML = '';
    this.body.append(h('div', { class: 'te-two' }, left, right));
  }

  refColumns(fk) {
    if (!fk.refTable) return [];
    if (fk.refTable === this.model.table.name || fk.refTable === this.objectName) return this.model.columns.map((c) => c.name);
    return (this.schemaObjects?.columns?.[fk.refTable] || []).map((c) => c.name);
  }

  renderTriggers() {
    const trg = this.details?.triggers || [];
    const box = h('div', { class: 'inspector-body' });
    if (this.isNew) box.append(h('div', { class: 'muted' }, 'Create the table first, then add triggers.'));
    else {
      box.append(h('div', { class: 'toolbar' }, h('button', { class: 'btn small', onclick: () => this.ws.openObjectEditor('trigger', this.schema, null, { table: this.objectName }) }, icon('plus'), ' Add Trigger')));
      if (!trg.length) box.append(h('p', { class: 'muted' }, 'This table has no triggers.'));
      const t = h('table', { class: 'grid-table' }, h('tr', null, h('th', null, 'Trigger'), h('th', null, 'Timing'), h('th', null, 'Event'), h('th', null, '')));
      for (const x of trg) {
        t.append(h('tr', null, h('td', null, icon('trigger'), ' ', x.name), h('td', null, x.timing), h('td', null, x.event),
          h('td', null, h('button', { class: 'btn tiny', onclick: () => this.ws.openObjectEditor('trigger', this.schema, x.name, { table: this.objectName }) }, 'Edit'), ' ',
            h('button', { class: 'btn tiny', onclick: () => this.ws.dropObject('trigger', this.schema, x.name).then(() => this.load()) }, 'Drop'))));
      }
      if (trg.length) box.append(t);
    }
    this.body.innerHTML = '';
    this.body.append(box);
  }

  renderOptions() {
    const t = this.model.table;
    const ai = h('input', { class: 'input port', value: t.auto_increment ?? '' });
    ai.addEventListener('change', () => { t.auto_increment = ai.value.trim(); });
    const rf = select(['', 'DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT'], t.row_format.toUpperCase(), (v) => { t.row_format = v; });
    this.body.innerHTML = '';
    this.body.append(h('div', { class: 'inspector-body' }, h('div', { class: 'form', style: { maxWidth: '420px' } },
      field('Auto Increment (next value):', ai), field('Row Format:', rf))));
  }

  // ------------------------------------------------------------------ SQL generation
  q(n) { return this.ws.quoteIdent(n); }

  fmtDefault(c) {
    let d = (c.default ?? '').trim();
    if (!d) return null;
    if (/^null$/i.test(d)) return 'NULL';
    const literalish = /^-?\d+(\.\d+)?$/.test(d) || /^'.*'$/s.test(d) || /^".*"$/s.test(d) || /^\(.*\)$/s.test(d) || /^[bx]'.*'$/i.test(d) || /^0x[0-9a-f]+$/i.test(d)
      || /^(current_timestamp|current_date|current_time|now|localtime|localtimestamp|true|false)\b/i.test(d) || /^[a-z_]+\(.*\)$/is.test(d);
    if (!literalish && (STRINGY.test(c.type) || !/^[A-Za-z_]+$/.test(d))) d = this.ws.sqlString(d);
    return d;
  }

  colDef(c, { inlinePk = false } = {}) {
    let s = `${this.q(c.name)} ${c.type || (this.mysql ? 'VARCHAR(45)' : '')}`.trimEnd();
    if (this.mysql) {
      if (c.un) s += ' UNSIGNED';
      if (c.zf) s += ' ZEROFILL';
      if (c.charset) s += ` CHARACTER SET ${c.charset}`;
      if (c.collation) s += ` COLLATE ${c.collation}`;
    }
    if (inlinePk) s += ' PRIMARY KEY' + (c.ai ? ' AUTOINCREMENT' : '');
    if (c.g) {
      s += ` GENERATED ALWAYS AS (${c.default || 'NULL'}) ${c.storage || 'VIRTUAL'}`;
      if (c.nn) s += ' NOT NULL';
    } else {
      if (this.mysql) s += c.nn ? ' NOT NULL' : ' NULL';
      else if (c.nn) s += ' NOT NULL';
      const d = this.fmtDefault(c);
      if (d !== null && !(d === 'NULL' && c.nn) && !(this.mysql && c.ai)) s += ` DEFAULT ${d}`;
      if (this.mysql && c.onUpdate) s += ` ON UPDATE ${c.onUpdate}`;
      if (this.mysql && c.ai) s += ' AUTO_INCREMENT';
    }
    if (this.mysql && c.comment) s += ` COMMENT ${this.ws.sqlString(c.comment)}`;
    return s;
  }

  indexCols(ix) {
    return ix.columns.map((c) => `${this.q(c.name)}${c.length && this.mysql ? `(${c.length})` : ''}${c.order === 'DESC' ? ' DESC' : this.mysql ? ' ASC' : ''}`).join(', ');
  }

  indexDef(ix) {
    const kw = ix.kind === 'INDEX' ? 'INDEX' : `${ix.kind} INDEX`;
    return `${kw} ${this.q(ix.name)} (${this.indexCols(ix)})${this.mysql && ix.comment ? ` COMMENT ${this.ws.sqlString(ix.comment)}` : ''}`;
  }

  fkDef(fk, { constraintName = true } = {}) {
    const ref = this.mysql ? this.ws.qualify(fk.refSchema || this.schema, fk.refTable) : this.q(fk.refTable);
    return `${constraintName ? `CONSTRAINT ${this.q(fk.name)} ` : ''}FOREIGN KEY (${fk.columns.map((c) => this.q(c)).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map((c) => this.q(c)).join(', ')}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
  }

  validate() {
    const m = this.model;
    if (!m.table.name.trim()) throw new Error('The table needs a name.');
    if (!m.columns.length) throw new Error('The table needs at least one column.');
    const names = new Set();
    for (const c of m.columns) {
      if (!c.name) throw new Error('Every column needs a name.');
      if (names.has(c.name.toLowerCase())) throw new Error(`Duplicate column name: ${c.name}`);
      names.add(c.name.toLowerCase());
      if (!c.type && this.mysql) throw new Error(`Column ${c.name} needs a data type.`);
    }
    for (const ix of m.indexes) if (!ix.columns.length) throw new Error(`Index ${ix.name} has no columns.`);
    for (const fk of m.fks) {
      if (!fk.refTable || !fk.columns.length || fk.refColumns.some((c) => !c)) throw new Error(`Foreign key ${fk.name} is incomplete (choose the referenced table and columns).`);
    }
  }

  createStatements(model = this.model, tableName = model.table.name) {
    const m = model;
    const lines = [];
    const pk = m.columns.filter((c) => c.pk);
    const sqliteInlinePk = !this.mysql && pk.length === 1 && /^integer$/i.test(pk[0].type) && pk[0].ai;
    for (const c of m.columns) lines.push('  ' + this.colDef(c, { inlinePk: sqliteInlinePk && c === pk[0] }));
    if (pk.length && !sqliteInlinePk) lines.push(`  PRIMARY KEY (${pk.map((c) => this.q(c.name)).join(', ')})`);
    if (this.mysql) for (const ix of m.indexes) lines.push('  ' + this.indexDef(ix));
    for (const fk of m.fks) lines.push('  ' + this.fkDef(fk, { constraintName: this.mysql }));
    let sql = `CREATE TABLE ${this.ws.qualify(this.schema, tableName)} (\n${lines.join(',\n')})`;
    if (this.mysql) {
      const t = m.table;
      if (t.engine) sql += `\nENGINE = ${t.engine}`;
      if (t.charset) sql += `\nDEFAULT CHARACTER SET = ${t.charset}`;
      if (t.collation) sql += `\nCOLLATE = ${t.collation}`;
      if (t.comment) sql += `\nCOMMENT = ${this.ws.sqlString(t.comment)}`;
      if (t.auto_increment && /^\d+$/.test(String(t.auto_increment))) sql += `\nAUTO_INCREMENT = ${t.auto_increment}`;
      if (t.row_format) sql += `\nROW_FORMAT = ${t.row_format}`;
    }
    const stmts = [sql + ';'];
    if (!this.mysql) {
      for (const ix of m.indexes) {
        stmts.push(`CREATE ${ix.kind === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${this.ws.qualify(this.schema, ix.name)} ON ${this.q(tableName)} (${this.indexCols(ix)});`);
      }
    }
    return stmts;
  }

  alterStatementsMysql() {
    const o = this.original;
    const m = this.model;
    const tq = this.ws.qualify(this.schema, o.table.name);
    const parts = [];
    const pre = [];
    // foreign keys removed / changed -> dropped first (separate statement, like Workbench)
    const fkSig = (f) => this.fkDef(f);
    const newFkByOrig = new Map(m.fks.filter((f) => f.origName).map((f) => [f.origName, f]));
    for (const of of o.fks) {
      const nf = newFkByOrig.get(of.name);
      if (!nf || fkSig(nf) !== fkSig(of)) pre.push(`DROP FOREIGN KEY ${this.q(of.name)}`);
    }
    // columns
    const keptNames = new Set(m.columns.filter((c) => c.origName).map((c) => c.origName));
    for (const oc of o.columns) if (!keptNames.has(oc.name)) parts.push(`DROP COLUMN ${this.q(oc.name)}`);
    const origOrder = o.columns.map((c) => c.name).filter((n) => keptNames.has(n));
    const origPrev = new Map(origOrder.map((n, i) => [n, i ? origOrder[i - 1] : null]));
    const newKept = m.columns.filter((c) => c.origName);
    const oByName = new Map(o.columns.map((c) => [c.name, c]));
    m.columns.forEach((c, i) => {
      const pos = i === 0 ? ' FIRST' : ` AFTER ${this.q(m.columns[i - 1].name)}`;
      if (!c.origName) { parts.push(`ADD COLUMN ${this.colDef(c)}${pos}`); return; }
      const oc = oByName.get(c.origName);
      const ki = newKept.indexOf(c);
      const prevKept = ki > 0 ? newKept[ki - 1].origName : null;
      const prevIsNew = i > 0 && !m.columns[i - 1].origName;
      const moved = prevKept !== origPrev.get(c.origName) && !prevIsNew;
      const changed = this.colDef({ ...c, name: c.origName }) !== this.colDef(oc);
      if (c.name !== c.origName || changed || moved) parts.push(`CHANGE COLUMN ${this.q(c.origName)} ${this.colDef(c)}${moved ? pos : ''}`);
    });
    // primary key
    const oPk = o.columns.filter((c) => c.pk).map((c) => c.name);
    const nPkCols = m.columns.filter((c) => c.pk);
    const nPk = nPkCols.map((c) => c.origName || c.name);
    if (oPk.join('\u0000') !== nPk.join('\u0000') || nPkCols.some((c) => c.origName && c.name !== c.origName && false)) {
      if (oPk.length) parts.push('DROP PRIMARY KEY');
      if (nPkCols.length) parts.push(`ADD PRIMARY KEY (${nPkCols.map((c) => this.q(c.name)).join(', ')})`);
    }
    // indexes
    const ixSig = (ix) => this.indexDef(ix);
    const newIxByOrig = new Map(m.indexes.filter((x) => x.origName).map((x) => [x.origName, x]));
    for (const oi of o.indexes) {
      const ni = newIxByOrig.get(oi.name);
      if (!ni || ixSig(ni) !== ixSig(oi)) parts.push(`DROP INDEX ${this.q(oi.name)}`);
    }
    for (const ni of m.indexes) {
      const oi = ni.origName ? o.indexes.find((x) => x.name === ni.origName) : null;
      if (!oi || ixSig(ni) !== ixSig(oi)) parts.push(`ADD ${this.indexDef(ni)}`);
    }
    // foreign keys added / changed
    const oFkByName = new Map(o.fks.map((f) => [f.name, f]));
    for (const nf of m.fks) {
      const of = nf.origName ? oFkByName.get(nf.origName) : null;
      if (!of || fkSig(nf) !== fkSig(of)) parts.push(`ADD ${this.fkDef(nf)}`);
    }
    // table options
    const t = m.table, ot = o.table;
    if (t.engine && t.engine !== ot.engine) parts.push(`ENGINE = ${t.engine}`);
    if ((t.charset && t.charset !== ot.charset) || (t.collation && t.collation !== ot.collation)) {
      if (t.charset) parts.push(`DEFAULT CHARACTER SET = ${t.charset}`);
      if (t.collation) parts.push(`COLLATE = ${t.collation}`);
    }
    if (t.comment !== ot.comment) parts.push(`COMMENT = ${this.ws.sqlString(t.comment)}`);
    if (String(t.auto_increment) !== String(ot.auto_increment) && /^\d+$/.test(String(t.auto_increment))) parts.push(`AUTO_INCREMENT = ${t.auto_increment}`);
    if (t.row_format && t.row_format.toUpperCase() !== (ot.row_format || '').toUpperCase()) parts.push(`ROW_FORMAT = ${t.row_format}`);
    if (t.name !== ot.name) parts.push(`RENAME TO ${this.ws.qualify(this.schema, t.name)}`);
    const stmts = [];
    if (pre.length) stmts.push(`ALTER TABLE ${tq}\n  ${pre.join(',\n  ')};`);
    if (parts.length) stmts.push(`ALTER TABLE ${tq}\n  ${parts.join(',\n  ')};`);
    return stmts;
  }

  alterStatementsSqlite() {
    const o = this.original;
    const m = this.model;
    const tq = (n) => this.ws.qualify(this.schema, n);
    const oByName = new Map(o.columns.map((c) => [c.name, c]));
    const kept = m.columns.filter((c) => c.origName);
    const sameDef = (c) => this.colDef({ ...c, name: c.origName }) === this.colDef(oByName.get(c.origName));
    const keptOrderSame = kept.map((c) => c.origName).join('\u0000') === o.columns.filter((c) => kept.some((k) => k.origName === c.name)).map((c) => c.name).join('\u0000');
    const firstNew = m.columns.findIndex((c) => !c.origName);
    const newAtEnd = firstNew < 0 || m.columns.slice(firstNew).every((c) => !c.origName);
    const pkSame = o.columns.filter((c) => c.pk).map((c) => c.name).join() === m.columns.filter((c) => c.pk).map((c) => c.origName || '#').join();
    const fkSame = JSON.stringify(o.fks.map((f) => this.fkDef(f))) === JSON.stringify(m.fks.map((f) => this.fkDef(f)));
    const newOk = m.columns.filter((c) => !c.origName).every((c) => !c.pk && !(c.nn && !this.fmtDefault(c)) && !(c.g && c.storage === 'STORED'));
    const simple = kept.every(sameDef) && keptOrderSame && newAtEnd && pkSame && fkSame && newOk;
    const stmts = [];
    const ixSig = (ix) => `${ix.kind}|${ix.name}|${this.indexCols(ix)}`;
    const oIx = new Map(o.indexes.map((x) => [x.name, x]));
    if (simple) {
      if (m.table.name !== o.table.name) stmts.push(`ALTER TABLE ${tq(o.table.name)} RENAME TO ${this.q(m.table.name)};`);
      const t = m.table.name;
      for (const oc of o.columns) if (!kept.some((c) => c.origName === oc.name)) stmts.push(`ALTER TABLE ${tq(t)} DROP COLUMN ${this.q(oc.name)};`);
      for (const c of kept) if (c.name !== c.origName) stmts.push(`ALTER TABLE ${tq(t)} RENAME COLUMN ${this.q(c.origName)} TO ${this.q(c.name)};`);
      for (const c of m.columns.filter((x) => !x.origName)) stmts.push(`ALTER TABLE ${tq(t)} ADD COLUMN ${this.colDef(c)};`);
      for (const oi of o.indexes) {
        const ni = m.indexes.find((x) => x.origName === oi.name);
        if (!ni || ixSig(ni) !== ixSig(oi)) stmts.push(`DROP INDEX ${tq(oi.name)};`);
      }
      for (const ni of m.indexes) {
        const oi = ni.origName ? oIx.get(ni.origName) : null;
        if (!oi || ixSig(ni) !== ixSig(oi)) stmts.push(`CREATE ${ni.kind === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${tq(ni.name)} ON ${this.q(t)} (${this.indexCols(ni)});`);
      }
      return { stmts, rebuild: false };
    }
    // Full rebuild (SQLite cannot alter column definitions in place).
    const tmp = `_dbcentral_new_${m.table.name}`;
    const create = this.createStatements({ ...m, indexes: [] }, tmp)[0];
    const from = kept.map((c) => this.q(c.origName)).join(', ');
    const to = kept.map((c) => this.q(c.name)).join(', ');
    stmts.push('PRAGMA foreign_keys = OFF;', 'BEGIN;', create);
    if (kept.length) stmts.push(`INSERT INTO ${tq(tmp)} (${to}) SELECT ${from} FROM ${tq(o.table.name)};`);
    stmts.push(`DROP TABLE ${tq(o.table.name)};`, `ALTER TABLE ${tq(tmp)} RENAME TO ${this.q(m.table.name)};`);
    for (const ix of m.indexes) stmts.push(`CREATE ${ix.kind === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${tq(ix.name)} ON ${this.q(m.table.name)} (${this.indexCols(ix)});`);
    for (const trg of this.details?.triggers || []) if (trg.body) stmts.push(trg.body.trim().replace(/;?$/, ';'));
    stmts.push('PRAGMA foreign_key_check;', 'COMMIT;', `PRAGMA foreign_keys = ${this.ws.profile.foreign_keys === false ? 'OFF' : 'ON'};`);
    return { stmts, rebuild: true };
  }

  async apply() {
    document.activeElement?.blur?.();
    try { this.validate(); } catch (e) { toast(e.message, 'warning'); return; }
    let stmts, intro;
    if (this.isNew) stmts = this.createStatements();
    else if (this.mysql) stmts = this.alterStatementsMysql();
    else {
      const r = this.alterStatementsSqlite();
      stmts = r.stmts;
      if (r.rebuild) {
        intro = 'SQLite cannot change existing column definitions in place, so the table will be rebuilt (new table, copy data, drop old, rename). Review the script before applying.';
        const renamed = this.model.columns.some((c) => c.origName && c.origName !== c.name);
        if (renamed && this.details?.triggers?.length) intro += ' Note: triggers are re-created unchanged - edit them in the script if they reference renamed columns.';
      }
    }
    if (!stmts.length) { toast('No changes to apply.', 'info'); return; }
    const ok = await reviewAndApply(this.ws, stmts, { title: 'Apply SQL Script to Database', intro });
    if (!ok) return;
    const name = this.model.table.name;
    this.isNew = false;
    this.objectName = name;
    this.title = name + ' - Table';
    this.ws.docs.setTitle(this.tab, this.title);
    await this.ws.navigator.refreshSchema(this.schema);
    this.ws.meta.invalidate(this.schema);
    await this.load();
  }

  onShow() {}
  confirmClose() { return Promise.resolve(true); }
}

export { checkbox };
