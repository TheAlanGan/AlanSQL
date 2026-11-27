// Schema Compare & Synchronize (MySQL / MariaDB): compare a source schema (the model) with a target schema,
// review the differences object by object, and generate / apply a script that makes the target match.
import { api } from './api.js';
import { saveTextFile } from './files.js';
import { checkbox, dropdownMenu, h, icon, splitter, toast, toolButton } from './ui.js';
import { reviewAndApply } from './review.js';

const STATUS = {
  create: { label: 'Create', cls: 'new', hint: 'Only in the source: will be created in the target' },
  alter: { label: 'Alter', cls: 'mod', hint: 'Different: the target will be changed to match the source' },
  drop: { label: 'Drop', cls: 'del', hint: 'Only in the target: will be dropped' },
  same: { label: 'Identical', cls: '', hint: 'No differences' },
};
const TYPE_ICON = { table: 'table', view: 'view', procedure: 'procedure', function: 'func', trigger: 'trigger' };
const OPTION_LABELS = [
  ['ignore_definer', 'Ignore DEFINER differences', true],
  ['ignore_int_width', 'Ignore integer display width, e.g. INT(11) vs INT', true],
  ['ignore_column_order', 'Ignore column order', false],
  ['keep_definer', 'Keep DEFINER clauses in the generated script', false],
];

export class SchemaCompareDoc {
  constructor(ws, { source, target } = {}) {
    this.ws = ws;
    this.app = ws.app;
    this.kind = 'schema-compare';
    this.title = 'Schema Compare';
    this.icon = 'compare';
    this.id = 'cmp-' + Date.now();
    this.opts = Object.fromEntries(OPTION_LABELS.map(([k, , v]) => [k, v]));
    this.result = null;
    this.selected = new Set();
    this.showSame = false;
    this.current = null;
    this.diffEditor = null;
    this.side = {
      source: { ws, schema: source || ws.activeSchema?.() || null },
      target: { ws, schema: target || null },
    };

    this.el = h('div', { class: 'doc cmp-doc' });
    this.sideUi = { source: this.sidePicker('source'), target: this.sidePicker('target') };
    this.compareBtn = h('button', { class: 'btn primary', onclick: () => this.compare() }, icon('refresh'), ' Compare');
    const head = h('div', { class: 'cmp-head' },
      this.sideUi.source.el,
      h('button', { class: 'btn cmp-swap', title: 'Swap source and target', onclick: () => this.swap() }, '⇄'),
      this.sideUi.target.el,
      h('div', { class: 'cmp-actions' }, this.compareBtn,
        h('button', { class: 'btn', onclick: (e) => this.optionsMenu(e.currentTarget) }, icon('gear'), ' Options')));
    this.summary = h('div', { class: 'cmp-summary muted' }, 'Choose the source (the schema to copy from) and the target (the schema to change), then click Compare.');
    this.list = h('div', { class: 'cmp-list' });
    this.selectAll = checkbox('Select all differences', false, (v) => {
      for (const i of this.result?.items || []) if (i.status !== 'same') { if (v) this.selected.add(i.id); else this.selected.delete(i.id); }
      this.renderList(); this.updateFoot();
    });
    this.listWrap = h('div', { class: 'cmp-left' },
      h('div', { class: 'cmp-list-head' }, this.selectAll,
        checkbox('Show identical objects', false, (v) => { this.showSame = v; this.renderList(); })),
      this.list);
    this.detailTitle = h('div', { class: 'cmp-detail-title muted' }, 'Select an object to see its differences.');
    this.diffHost = h('div', { class: 'cmp-diff' });
    this.sqlPre = h('pre', { class: 'sql-pre cmp-sql' });
    this.detail = h('div', { class: 'cmp-right' }, this.detailTitle,
      h('div', { class: 'cmp-diff-labels' }, h('span', null, 'Target (current)'), h('span', null, 'Source (desired)')),
      this.diffHost, h('div', { class: 'section-title' }, 'SQL for this object'), this.sqlPre);
    const split = h('div', { class: 'splitter splitter-v' });
    this.foot = h('div', { class: 'cmp-foot' },
      h('span', { class: 'cmp-count muted' }),
      h('span', { class: 'flex1' }),
      toolButton('save', 'Save the synchronization script to a file', () => this.saveScript(), { label: 'Save Script...' }),
      toolButton('newSql', 'Open the script in a SQL editor tab of the target connection', () => this.openInEditor(), { label: 'Open in SQL Editor' }),
      h('button', { class: 'btn primary', onclick: () => this.apply() }, 'Apply to Target...'));
    this.el.append(head, this.summary, h('div', { class: 'cmp-body' }, this.listWrap, split, this.detail), this.foot);
    splitter(split, this.listWrap, { direction: 'v', min: 220, max: 800, key: 'cmp-list' });
    this.updateFoot();
  }

  // ------------------------------------------------------------------ source / target pickers
  mysqlWorkspaces() { return this.app.workspaces.filter((w) => w.driver === 'mysql'); }

  sidePicker(which) {
    const conn = h('select', { class: 'input' });
    const schema = h('select', { class: 'input' });
    conn.addEventListener('change', () => {
      this.side[which].ws = this.mysqlWorkspaces().find((w) => w.sid === conn.value) || null;
      this.side[which].schema = null;
      this.fillSchemas(which);
    });
    schema.addEventListener('change', () => { this.side[which].schema = schema.value; });
    const el = h('div', { class: 'cmp-side' },
      h('div', { class: 'cmp-side-label' }, which === 'source' ? 'Source (copy from)' : 'Target (change this)'),
      h('div', { class: 'row' }, conn, schema));
    return { el, conn, schema };
  }

  fillPickers() {
    for (const which of ['source', 'target']) {
      const ui = this.sideUi[which];
      const list = this.mysqlWorkspaces();
      if (!list.includes(this.side[which].ws)) this.side[which].ws = list[0] || null;
      ui.conn.innerHTML = '';
      for (const w of list) ui.conn.append(h('option', { value: w.sid }, w.profile.name + (list.filter((x) => x.profile.id === w.profile.id).length > 1 ? ` (${w.sid.slice(0, 4)})` : '')));
      ui.conn.value = this.side[which].ws?.sid || '';
      this.fillSchemas(which);
    }
  }

  fillSchemas(which) {
    const ui = this.sideUi[which];
    const s = this.side[which];
    const names = (s.ws?.navigator.schemas || []).filter((x) => !x.system).map((x) => x.name);
    if (!names.includes(s.schema)) {
      const other = this.side[which === 'source' ? 'target' : 'source'];
      s.schema = names.find((n) => !(other.ws === s.ws && other.schema === n)) || names[0] || null;
    }
    ui.schema.innerHTML = '';
    for (const n of names) ui.schema.append(h('option', { value: n }, n));
    ui.schema.value = s.schema || '';
  }

  swap() {
    [this.side.source, this.side.target] = [this.side.target, this.side.source];
    this.fillPickers();
    if (this.result) this.compare();
  }

  optionsMenu(anchor) {
    dropdownMenu(anchor, OPTION_LABELS.map(([k, label]) => ({
      label, checked: !!this.opts[k],
      action: () => { this.opts[k] = !this.opts[k]; if (this.result) this.compare(); },
    })));
  }

  onShow() { this.fillPickers(); this.diffEditor?.layout(); }

  load() { this.fillPickers(); }

  // ------------------------------------------------------------------ compare
  label(which) {
    const s = this.side[which];
    return `${s.ws?.profile.name || '?'} / ${s.schema}`;
  }

  async compare() {
    const { source, target } = this.side;
    if (!source.ws || !target.ws || !source.schema || !target.schema) { toast('Open a MySQL/MariaDB connection and choose both schemas.', 'warning'); return; }
    if (source.ws === target.ws && source.schema === target.schema) { toast('Choose two different schemas.', 'warning'); return; }
    this.compareBtn.disabled = true;
    this.summary.className = 'cmp-summary muted';
    this.summary.innerHTML = '';
    this.summary.append(icon('spinner'), ' Comparing schemas...');
    try {
      const r = await api.post('/schema-diff', {
        source: { sid: source.ws.sid, schema: source.schema },
        target: { sid: target.ws.sid, schema: target.schema },
        options: this.opts,
      });
      this.result = r;
      this.targetWs = target.ws;
      this.targetSchema = target.schema;
      this.title = `Compare ${source.schema} → ${target.schema}`;
      this.ws.docs.setTitle(this.tab, this.title, `${this.label('source')} → ${this.label('target')}`);
      this.selected = new Set(r.items.filter((i) => i.status === 'create' || i.status === 'alter').map((i) => i.id));
      const c = r.counts;
      const diffs = (c.create || 0) + (c.alter || 0) + (c.drop || 0);
      this.summary.className = 'cmp-summary';
      this.summary.innerHTML = '';
      this.summary.append(...[
        diffs ? h('span', null, h('b', null, `${diffs} difference${diffs === 1 ? '' : 's'}`), ` between ${this.label('source')} and ${this.label('target')}: `) : h('span', null, icon('ok'), h('b', null, ' The schemas are identical'), ` (${c.same || 0} objects).`),
        ...['create', 'alter', 'drop'].filter((k) => c[k]).map((k) => h('span', { class: 'badge ' + STATUS[k].cls }, `${c[k]} ${STATUS[k].label.toLowerCase()}`)),
        diffs ? h('span', { class: 'muted' }, ` · ${c.same || 0} identical`) : null,
        c.drop ? h('span', { class: 'muted' }, ' · Objects to drop are not selected; tick them to include them.') : null,
        ...r.warnings.map((w) => h('div', { class: 'cmp-warn' }, icon('warning'), ' ', w))].filter(Boolean));
      this.renderList();
      const first = r.items.find((i) => i.status !== 'same');
      this.showItem(first || null);
    } catch (e) {
      this.summary.className = 'cmp-summary';
      this.summary.innerHTML = '';
      this.summary.append(h('div', { class: 'error-box' }, icon('error'), ' ', e.message));
    }
    this.compareBtn.disabled = false;
    this.updateFoot();
  }

  renderList() {
    this.list.innerHTML = '';
    if (!this.result) return;
    const items = this.result.items.filter((i) => this.showSame || i.status !== 'same');
    if (!items.length) { this.list.append(h('div', { class: 'pad muted' }, 'No differences.')); return; }
    const groups = [['table', 'Tables'], ['view', 'Views'], ['procedure', 'Stored Procedures'], ['function', 'Functions'], ['trigger', 'Triggers']];
    for (const [type, label] of groups) {
      const g = items.filter((i) => i.type === type);
      if (!g.length) continue;
      const actionable = g.filter((i) => i.status !== 'same');
      const all = h('input', { type: 'checkbox', checked: actionable.length > 0 && actionable.every((i) => this.selected.has(i.id)), disabled: !actionable.length });
      all.addEventListener('change', () => { for (const i of actionable) { if (all.checked) this.selected.add(i.id); else this.selected.delete(i.id); } this.renderList(); this.updateFoot(); });
      this.list.append(h('div', { class: 'cmp-group' }, all, h('span', null, label), h('span', { class: 'muted' }, ` (${g.length})`)));
      for (const it of g) {
        const cb = h('input', { type: 'checkbox', checked: this.selected.has(it.id), disabled: it.status === 'same' });
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => { if (cb.checked) this.selected.add(it.id); else this.selected.delete(it.id); this.updateFoot(); });
        const st = STATUS[it.status];
        const row = h('div', { class: 'cmp-row' + (this.current === it ? ' selected' : ''), title: st.hint },
          cb, icon(TYPE_ICON[it.type] || 'table'), h('span', { class: 'cmp-name' }, it.name),
          it.warnings.length ? icon('warning') : null,
          h('span', { class: 'badge ' + st.cls }, st.label + (it.destructive && it.status === 'alter' ? ' *' : '')));
        if (it.destructive && it.status === 'alter') row.title = 'Alter: includes dropping columns (data in them is lost)';
        row.addEventListener('click', () => this.showItem(it));
        it.row = row;
        this.list.append(row);
      }
    }
  }

  showItem(it) {
    this.current = it;
    this.list.querySelectorAll('.cmp-row.selected').forEach((r) => r.classList.remove('selected'));
    it?.row?.classList.add('selected');
    if (!it) {
      this.detailTitle.textContent = 'No differences.';
      this.sqlPre.textContent = '';
      this.setDiff('', '');
      return;
    }
    this.detailTitle.innerHTML = '';
    this.detailTitle.className = 'cmp-detail-title';
    this.detailTitle.append(...[icon(TYPE_ICON[it.type] || 'table'), h('b', null, ' ' + it.name), ' ',
      h('span', { class: 'badge ' + STATUS[it.status].cls }, STATUS[it.status].label), ' ',
      h('span', { class: 'muted' }, STATUS[it.status].hint),
      ...it.warnings.map((w) => h('div', { class: 'cmp-warn' }, icon('warning'), ' ', w)),
      it.destructive ? h('div', { class: 'cmp-warn' }, icon('warning'), it.status === 'alter'
        ? ' Columns are dropped. A renamed column also shows up as drop + add, which loses the data in it.'
        : ' Dropping this object cannot be undone.') : null].filter(Boolean));
    this.setDiff(it.target_ddl, it.source_ddl);
    this.sqlPre.textContent = it.statements.length ? it.statements.map((s) => terminate(s.sql)).join('\n\n') : '-- nothing to do';
  }

  setDiff(original, modified) {
    const monaco = window.monaco;
    if (!monaco) return;
    if (!this.diffEditor) {
      this.diffEditor = monaco.editor.createDiffEditor(this.diffHost, {
        readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false,
        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12, wordWrap: 'on', renderOverviewRuler: false,
        theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs',
      });
    }
    const old = this.diffEditor.getModel();
    this.diffEditor.setModel({ original: monaco.editor.createModel(original || '', 'mysql'), modified: monaco.editor.createModel(modified || '', 'mysql') });
    old?.original.dispose();
    old?.modified.dispose();
  }

  // ------------------------------------------------------------------ script
  chosen() { return this.result ? this.result.items.filter((i) => this.selected.has(i.id) && i.statements.length) : []; }

  updateFoot() {
    const n = this.chosen().length;
    const diffs = (this.result?.items || []).filter((i) => i.status !== 'same');
    const cb = this.selectAll.querySelector('input');
    cb.checked = diffs.length > 0 && diffs.every((i) => this.selected.has(i.id));
    cb.indeterminate = !cb.checked && diffs.some((i) => this.selected.has(i.id));
    cb.disabled = !diffs.length;
    this.foot.querySelector('.cmp-count').textContent = this.result ? `${n} object${n === 1 ? '' : 's'} selected for synchronization` : '';
    this.foot.querySelectorAll('button').forEach((b) => { b.disabled = !n; });
  }

  script() {
    const items = this.chosen();
    if (!items.length) return null;
    const order = new Map(this.result.items.map((it, i) => [it.id, i]));
    const stmts = items.flatMap((it) => it.statements.map((s) => ({ ...s, idx: order.get(it.id) })))
      .sort((a, b) => a.phase - b.phase || a.order - b.order || a.idx - b.idx);
    const head = [
      `-- Synchronize ${this.label('target')} with ${this.label('source')}`,
      `-- Generated by DBCentral on ${new Date().toLocaleString()}`,
      '',
      'SET FOREIGN_KEY_CHECKS = 0;',
    ];
    return head.join('\n') + '\n\n' + stmts.map((s) => terminate(s.sql)).join('\n\n') + '\n\nSET FOREIGN_KEY_CHECKS = 1;\n';
  }

  async apply() {
    const text = this.script();
    if (!text) return;
    const drops = this.chosen().filter((i) => i.destructive).length;
    const ok = await reviewAndApply(this.targetWs, [text], {
      title: `Synchronize ${this.targetSchema}`,
      endpoint: `/sessions/${this.targetWs.sid}/apply-script`,
      intro: `Review the script that changes ${this.label('target')}. It runs on a separate connection; DDL statements cannot be rolled back.`
        + (drops ? ` ${drops} selected object(s) drop tables, columns or other objects.` : ''),
    });
    if (ok) {
      toast('Synchronization applied.', 'success');
      this.targetWs.navigator.refreshSchema(this.targetSchema);
      this.compare();
    }
  }

  openInEditor() {
    const text = this.script();
    if (!text) return;
    this.targetWs.openQueryTab({ title: `sync ${this.targetSchema}`, content: text });
    this.app.tabs.select(this.targetWs.appTab);
  }

  async saveScript() {
    const text = this.script();
    if (!text) return;
    const p = await saveTextFile(text, `sync_${this.targetSchema}.sql`, [['SQL Files', '*.sql'], ['All Files', '*.*']]);
    if (p) toast('Script saved: ' + p, 'success');
  }

  dispose() {
    const m = this.diffEditor?.getModel();
    this.diffEditor?.dispose();
    m?.original.dispose();
    m?.modified.dispose();
  }
}

function terminate(sql) {
  return sql.startsWith('DELIMITER') ? sql : sql.replace(/;?\s*$/, ';');
}

