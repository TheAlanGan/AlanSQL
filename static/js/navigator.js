// Left sidebar: Schemas tree, Administration list and Information panel.
import { api } from './api.js';
import { contextMenu, copyText, debounce, esc, formatBytes, formatNumber, h, icon, iconSvg, splitter, toolButton } from './ui.js';

export class Navigator {
  constructor(container, ws) {
    this.ws = ws;
    this.expanded = new Set(JSON.parse(localStorage.getItem('nav-exp:' + ws.profile.id) || '[]'));
    this.objects = new Map();    // schema -> objects payload
    this.details = new Map();    // schema.table -> details payload
    this.schemas = [];
    this.selected = null;
    this.el = h('div', { class: 'navigator' });
    container.append(this.el);
    this.build();
  }

  build() {
    const ws = this.ws;
    this.filterInput = h('input', { class: 'input small nav-filter', placeholder: 'Filter objects', spellcheck: false });
    this.filterInput.addEventListener('input', debounce(() => this.applyFilter(), 150));
    this.tree = h('div', { class: 'tree', tabindex: '0' });
    this.schemaPane = h('div', { class: 'nav-pane' },
      h('div', { class: 'nav-section-head' }, h('span', null, ws.driver === 'mysql' || (ws.driver === 'odbc' && ws.info.has_schemas) ? 'SCHEMAS' : 'DATABASE'),
        h('span', { class: 'flex1' }),
        ws.features.create_schema ? toolButton('schemaAdd', 'Create a new schema', () => ws.createSchemaDialog(), { cls: 'mini' }) : null,
        toolButton('refresh', 'Refresh all', () => this.refresh(), { cls: 'mini' })),
      h('div', { class: 'nav-filter-row' }, icon('search'), this.filterInput),
      this.tree);
    this.adminPane = h('div', { class: 'nav-pane hidden' }, this.buildAdmin());
    this.tabSchemas = h('button', { class: 'nav-tab active', onclick: () => this.showPane('schemas') }, 'Schemas');
    this.tabAdmin = h('button', { class: 'nav-tab', onclick: () => this.showPane('admin') }, 'Administration');
    this.info = h('div', { class: 'info-panel' });
    this.infoBody = h('div', { class: 'info-body' });
    this.infoTabs = { object: h('button', { class: 'nav-tab active', onclick: () => this.showInfo('object') }, 'Object Info'),
      session: h('button', { class: 'nav-tab', onclick: () => this.showInfo('session') }, 'Session') };
    this.infoMode = 'object';
    this.info.append(h('div', { class: 'panel-header' }, h('span', { class: 'panel-title' }, 'Information')), this.infoBody,
      h('div', { class: 'nav-tabs bottom' }, this.infoTabs.object, this.infoTabs.session));
    const infoSplit = h('div');
    this.el.append(
      h('div', { class: 'panel-header' }, h('span', { class: 'panel-title' }, 'Navigator')),
      h('div', { class: 'nav-main' }, this.schemaPane, this.adminPane),
      h('div', { class: 'nav-tabs bottom' }, this.tabAdmin, this.tabSchemas),
      infoSplit, this.info);
    splitter(infoSplit, this.info, { direction: 'h', invert: true, min: 40, max: 600, key: 'nav-info' });
    this.tree.addEventListener('keydown', (e) => this.onKey(e));
    this.showInfo('object');
  }

  showPane(which) {
    this.schemaPane.classList.toggle('hidden', which !== 'schemas');
    this.adminPane.classList.toggle('hidden', which !== 'admin');
    this.tabSchemas.classList.toggle('active', which === 'schemas');
    this.tabAdmin.classList.toggle('active', which === 'admin');
  }

  buildAdmin() {
    const ws = this.ws;
    const mysql = ws.driver === 'mysql';
    const item = (ic, label, action, enabled = true) => {
      const el = h('div', { class: 'admin-item' + (enabled ? '' : ' disabled'), title: enabled ? label : 'Not available for SQLite connections' }, icon(ic), h('span', null, label));
      if (enabled) el.addEventListener('click', action);
      return el;
    };
    return h('div', { class: 'admin-list' },
      h('div', { class: 'nav-section-head' }, 'MANAGEMENT'),
      item('server', 'Server Status', () => ws.openAdmin('status'), mysql),
      item('plug', 'Client Connections', () => ws.openAdmin('connections'), mysql),
      item('users', 'Users and Privileges', () => ws.openAdmin('users'), mysql),
      item('variables', 'Status and System Variables', () => ws.openAdmin('variables'), mysql),
      item('dumpOut', 'Data Export', () => ws.openAdmin('export')),
      item('dumpIn', 'Data Import/Restore', () => ws.openAdmin('import')),
      h('div', { class: 'nav-section-head' }, 'PERFORMANCE'),
      item('gauge', 'Dashboard', () => ws.openAdmin('status'), mysql),
      item('plan', 'Performance Reports', () => ws.openAdmin('perf'), mysql),
      item('plan', 'Schema Inspector', () => ws.openSchemaInspector(ws.currentSchema || this.schemas[0]?.name)),
      h('div', { class: 'nav-section-head' }, 'MODELING'),
      item('diagram', 'ER Diagram (Reverse Engineer)', () => ws.openErdPicker()));
  }

  // ------------------------------------------------------------------- data
  async refresh() {
    this.objects.clear();
    this.details.clear();
    this.ws.meta.invalidate();
    try {
      const r = await api.get(`/sessions/${this.ws.sid}/schemas`);
      this.schemas = r.schemas;
      if (r.current_schema !== undefined) this.ws.setCurrentSchema(r.current_schema, { silent: true });
    } catch (e) {
      this.tree.innerHTML = '';
      this.tree.append(h('div', { class: 'error-box small' }, icon('error'), ' ', e.message));
      return;
    }
    this.render();
    if (this.ws.driver === 'sqlite' && !this.expanded.size) this.expanded.add('s:main').add('g:main:tables');
    if (this.ws.driver === 'odbc' && !this.ws.info.has_schemas && !this.expanded.size) this.expanded.add('s:default').add('g:default:tables');
    for (const s of this.schemas) if (this.expanded.has('s:' + s.name)) await this.loadSchema(s.name);
    this.render();
  }

  async refreshSchema(schema) {
    if (!schema) return this.refresh();
    this.objects.delete(schema);
    [...this.details.keys()].filter((k) => k.startsWith(schema + '\u0000')).forEach((k) => this.details.delete(k));
    this.ws.meta.invalidate(schema);
    if (!this.schemas.some((s) => s.name === schema)) return this.refresh();
    await this.loadSchema(schema);
    this.render();
  }

  async loadSchema(schema) {
    if (this.objects.has(schema)) return this.objects.get(schema);
    const p = api.get(`/sessions/${this.ws.sid}/objects?schema=${encodeURIComponent(schema)}`);
    this.objects.set(schema, p);
    try {
      const o = await p;
      this.objects.set(schema, o);
      return o;
    } catch (e) {
      this.objects.delete(schema);
      throw e;
    }
  }

  async loadDetails(schema, table) {
    const key = schema + '\u0000' + table;
    if (this.details.has(key)) return this.details.get(key);
    const d = await api.get(`/sessions/${this.ws.sid}/table?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`);
    this.details.set(key, d);
    return d;
  }

  saveExpanded() {
    localStorage.setItem('nav-exp:' + this.ws.profile.id, JSON.stringify([...this.expanded].slice(-300)));
  }

  // ------------------------------------------------------------------- rendering
  render() {
    const scroll = this.tree.scrollTop;
    this.tree.innerHTML = '';
    if (!this.schemas.length) {
      this.tree.append(h('div', { class: 'muted pad' }, 'No schemas.'));
      return;
    }
    for (const s of this.schemas) this.tree.append(this.schemaNode(s));
    this.applyFilter();
    this.tree.scrollTop = scroll;
  }

  row(id, depth, { label, ic, expandable, kind, data, bold, extra, title, actions }) {
    const expanded = this.expanded.has(id);
    const r = h('div', { class: 'tree-row' + (bold ? ' bold' : '') + (this.selected === id ? ' selected' : ''), style: { paddingLeft: (4 + depth * 14) + 'px' }, dataset: { id, kind }, title: title || '' });
    r.append(h('span', { class: 'tree-caret' + (expandable ? '' : ' none') }, expandable ? icon(expanded ? 'caretDown' : 'caretRight') : ''));
    r.append(icon(ic));
    r.append(h('span', { class: 'tree-label' }, label));
    if (extra) r.append(h('span', { class: 'tree-extra' }, extra));
    if (actions) {
      const acts = h('span', { class: 'tree-actions' });
      for (const [ai, at, fn] of actions) acts.append(h('button', { class: 'tree-act', title: at, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ai)));
      r.append(acts);
    }
    r.node = { id, kind, data, label };
    r.addEventListener('click', (e) => {
      this.select(id, r);
      if (e.target.closest('.tree-caret') && expandable) this.toggle(id, r);
    });
    r.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tree-caret') || e.target.closest('.tree-act')) return;
      this.onDouble(r.node, r, expandable);
    });
    r.addEventListener('contextmenu', (e) => { this.select(id, r); this.menu(e, r.node); });
    return r;
  }

  select(id, rowEl) {
    this.selected = id;
    this.tree.querySelectorAll('.tree-row.selected').forEach((x) => x.classList.remove('selected'));
    rowEl?.classList.add('selected');
    this.showInfo(this.infoMode, rowEl?.node);
  }

  async toggle(id) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else {
      this.expanded.add(id);
      const [kind, ...rest] = id.split(':');
      try {
        if (kind === 's') await this.loadSchema(rest.join(':'));
        if (kind === 't' || kind === 'v') {
          const { schema, table } = this.decode(id);
          await this.loadSchema(schema);
          if (kind === 't') await this.loadDetails(schema, table);
        }
      } catch (e) {
        this.ws.logOutput({ action: 'Load schema objects', ok: false, message: e.message });
      }
    }
    this.saveExpanded();
    this.render();
  }

  decode(id) {
    const parts = id.split(':');
    const payload = parts.slice(1).join(':').split('\u0001');
    return { schema: payload[0], table: payload[1], extra: payload[2] };
  }

  enc(...parts) { return parts.join('\u0001'); }

  schemaNode(s) {
    const ws = this.ws;
    const id = 's:' + s.name;
    const wrap = h('div', { class: 'tree-node', dataset: { schema: s.name } });
    const isDefault = ws.currentSchema === s.name;
    wrap.append(this.row(id, 0, { label: s.name, ic: 'dbColor', expandable: true, kind: 'schema', data: s, bold: isDefault, title: s.file || '' }));
    if (!this.expanded.has(id)) return wrap;
    const o = this.objects.get(s.name);
    const kids = h('div', { class: 'tree-children' });
    wrap.append(kids);
    if (!o || o instanceof Promise) { kids.append(h('div', { class: 'tree-loading', style: { paddingLeft: '30px' } }, icon('spinner'), ' Loading...')); return wrap; }
    const groups = [['tables', 'Tables', o.tables, 'table'], ['views', 'Views', o.views, 'view']];
    if (ws.features.routines) groups.push(['procedures', 'Stored Procedures', o.procedures, 'procedure'], ['functions', 'Functions', o.functions, 'function']);
    for (const [g, label, items, kind] of groups) {
      const gid = 'g:' + this.enc(s.name, g);
      const gw = h('div', { class: 'tree-node group', dataset: { group: g } });
      gw.append(this.row(gid, 1, { label, ic: 'folder', expandable: true, kind: 'group', data: { schema: s.name, group: g }, extra: items.length ? String(items.length) : '' }));
      if (this.expanded.has(gid)) {
        const gk = h('div', { class: 'tree-children' });
        if (!items.length) gk.append(h('div', { class: 'tree-empty', style: { paddingLeft: '48px' } }, 'n/a'));
        for (const it of items) gk.append(this.objectNode(s.name, kind, it, o));
        gw.append(gk);
      }
      kids.append(gw);
    }
    return wrap;
  }

  objectNode(schema, kind, it, o) {
    const ws = this.ws;
    const prefix = kind === 'table' ? 't' : kind === 'view' ? 'v' : kind === 'procedure' ? 'p' : 'f';
    const id = prefix + ':' + this.enc(schema, it.name);
    const expandable = kind === 'table' || kind === 'view';
    const actions = [];
    if (kind === 'table') {
      actions.push(['infoOutline', 'Table Inspector', () => ws.openInspector(schema, it.name)],
        ['wrench', 'Alter Table', () => ws.openTableEditor(schema, it.name)],
        ['grid', 'Select Rows', () => ws.selectRows(schema, it.name)]);
    } else if (kind === 'view') {
      actions.push(['wrench', 'Alter View', () => ws.openObjectEditor('view', schema, it.name)], ['grid', 'Select Rows', () => ws.selectRows(schema, it.name)]);
    } else {
      actions.push(['wrench', 'Alter ' + (kind === 'procedure' ? 'Stored Procedure' : 'Function'), () => ws.openObjectEditor(kind, schema, it.name)]);
    }
    const wrap = h('div', { class: 'tree-node obj', dataset: { name: it.name.toLowerCase() } });
    wrap.append(this.row(id, 2, { label: it.name, ic: kind === 'procedure' ? 'procedure' : kind === 'function' ? 'func' : kind, expandable, kind, data: { schema, name: it.name, item: it }, title: it.comment || '', actions }));
    if (expandable && this.expanded.has(id)) {
      const kids = h('div', { class: 'tree-children' });
      const cols = o.columns?.[it.name] || [];
      const det = this.details.get(schema + '\u0000' + it.name);
      const sub = [['columns', 'Columns', cols]];
      if (kind === 'table') {
        sub.push(['indexes', 'Indexes', det?.indexes], ['fks', 'Foreign Keys', det?.foreign_keys], ['triggers', 'Triggers', det?.triggers]);
      }
      for (const [g, label, items] of sub) {
        const gid = 'c:' + this.enc(schema, it.name, g);
        const gw = h('div', { class: 'tree-node' });
        gw.append(this.row(gid, 3, { label, ic: 'folder', expandable: true, kind: 'subgroup', data: { schema, table: it.name, group: g } }));
        if (this.expanded.has(gid)) {
          const gk = h('div', { class: 'tree-children' });
          if (!items) gk.append(h('div', { class: 'tree-loading', style: { paddingLeft: '62px' } }, icon('spinner'), ' Loading...'));
          else if (!items.length) gk.append(h('div', { class: 'tree-empty', style: { paddingLeft: '62px' } }, 'n/a'));
          else {
            for (const x of items) gk.append(this.leafNode(schema, it.name, g, x));
          }
          gw.append(gk);
        }
        kids.append(gw);
      }
      wrap.append(kids);
      if (kind === 'table' && !det) this.loadDetails(schema, it.name).then(() => this.render()).catch(() => {});
    }
    return wrap;
  }

  leafNode(schema, table, group, x) {
    let ic = 'column', label = x.name, extra = '', kind = 'column';
    if (group === 'columns') {
      ic = x.col_key === 'PRI' ? 'key' : 'column';
      extra = x.column_type || '';
    } else if (group === 'indexes') {
      ic = x.primary ? 'key' : 'index'; kind = 'index';
      extra = x.columns.map((c) => c.name).join(', ');
    } else if (group === 'fks') {
      ic = 'fk'; kind = 'fk';
      extra = '→ ' + x.ref_table;
    } else if (group === 'triggers') {
      ic = 'trigger'; kind = 'trigger';
      extra = `${x.timing} ${x.event}`;
    }
    const id = 'l:' + this.enc(schema, table, group + '/' + x.name);
    return this.row(id, 4, { label, ic, expandable: false, kind, data: { schema, table, item: x, group }, extra });
  }

  // ------------------------------------------------------------------- filtering
  applyFilter() {
    const f = this.filterInput.value.trim().toLowerCase();
    this.tree.querySelectorAll('.tree-node').forEach((n) => n.classList.remove('filtered-out'));
    if (!f) return;
    for (const sNode of this.tree.querySelectorAll(':scope > .tree-node')) {
      const schemaMatch = sNode.dataset.schema.toLowerCase().includes(f);
      let anyChild = false;
      sNode.querySelectorAll('.tree-node.obj').forEach((o) => {
        const m = o.dataset.name.includes(f);
        if (!m && !schemaMatch) o.classList.add('filtered-out');
        anyChild = anyChild || m;
      });
      if (!schemaMatch && !anyChild) {
        const o = this.objects.get(sNode.dataset.schema);
        const loadedMatch = o && !(o instanceof Promise) && [...o.tables, ...o.views, ...o.procedures, ...o.functions].some((t) => t.name.toLowerCase().includes(f));
        if (!loadedMatch) sNode.classList.add('filtered-out');
      }
    }
  }

  // ------------------------------------------------------------------- interaction
  onDouble(node, rowEl, expandable) {
    const ws = this.ws;
    const d = node.data;
    if (node.kind === 'schema') { ws.setDefaultSchema(d.name); return; }
    if (node.kind === 'table' || node.kind === 'view' || node.kind === 'procedure' || node.kind === 'function') {
      ws.sendToEditor(ws.quoteIfNeeded(d.name), { insert: true });
      return;
    }
    if (node.kind === 'column') { ws.sendToEditor(ws.quoteIfNeeded(d.item.name), { insert: true }); return; }
    if (expandable) this.toggle(node.id, rowEl);
  }

  onKey(e) {
    const rows = [...this.tree.querySelectorAll('.tree-row')].filter((r) => r.offsetParent !== null);
    const i = rows.findIndex((r) => r.dataset.id === this.selected);
    if (e.key === 'ArrowDown' && i < rows.length - 1) { this.select(rows[i + 1].dataset.id, rows[i + 1]); rows[i + 1].scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && i > 0) { this.select(rows[i - 1].dataset.id, rows[i - 1]); rows[i - 1].scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && i >= 0) {
      const id = rows[i].dataset.id;
      const open = this.expanded.has(id);
      if ((e.key === 'ArrowRight') !== open && rows[i].querySelector('.tree-caret:not(.none)')) this.toggle(id);
      e.preventDefault();
    } else if (e.key === 'Enter' && i >= 0) this.onDouble(rows[i].node, rows[i], true);
  }

  menu(e, node) {
    const ws = this.ws;
    const d = node.data;
    const q = (s, n) => ws.qualify(s, n);
    const refresh = { label: 'Refresh All', icon: 'refresh', action: () => this.refresh() };
    if (node.kind === 'schema') {
      const s = d.name;
      contextMenu(e, [
        { label: 'Set as Default Schema', action: () => ws.setDefaultSchema(s) },
        { label: 'Filter to This Schema', action: () => { this.filterInput.value = s; this.applyFilter(); } },
        '-',
        { label: 'Schema Inspector', icon: 'infoOutline', action: () => ws.openSchemaInspector(s) },
        { label: 'ER Diagram', icon: 'diagram', action: () => ws.openErd(s) },
        ws.features.routines ? { label: 'Procedures & Functions', icon: 'procedure', action: () => ws.openRoutines(s) } : null,
        ws.driver === 'mysql' ? { label: 'Compare with Another Schema...', icon: 'compare', action: () => ws.openSchemaCompare({ source: s }) } : null,
        '-',
        { label: 'Copy to Clipboard', submenu: [
          { label: 'Name', action: () => copyText(s) },
          ws.driver === 'mysql' ? { label: 'Create Statement', action: () => ws.copyDDL('schema', null, s) } : null,
        ] },
        { label: 'Send to SQL Editor', submenu: [
          { label: 'Name', action: () => ws.sendToEditor(ws.quoteIfNeeded(s), { insert: true }) },
          ws.driver === 'mysql' ? { label: 'Create Statement', action: () => ws.copyDDL('schema', null, s, true) } : null,
        ] },
        '-',
        { label: 'Create Table...', icon: 'tableAdd', action: () => ws.openTableEditor(s, null) },
        { label: 'Create View...', icon: 'viewAdd', action: () => ws.openObjectEditor('view', s, null) },
        ws.features.routines ? { label: 'Create Stored Procedure...', icon: 'procAdd', action: () => ws.openObjectEditor('procedure', s, null) } : null,
        ws.features.routines ? { label: 'Create Function...', icon: 'funcAdd', action: () => ws.openObjectEditor('function', s, null) } : null,
        '-',
        ws.features.create_schema ? { label: 'Create Schema...', icon: 'schemaAdd', action: () => ws.createSchemaDialog() } : null,
        ws.features.create_schema ? { label: 'Alter Schema...', action: () => ws.alterSchemaDialog(d) } : null,
        ws.features.create_schema ? { label: 'Drop Schema...', icon: 'trash', action: () => ws.dropObject('schema', null, s) } : null,
        { label: 'Table Data Import Wizard...', icon: 'import', action: () => ws.openImportWizard({ schema: s }) },
        { label: 'Data Export...', icon: 'dumpOut', action: () => ws.openAdmin('export', { schema: s }) },
        '-',
        { label: 'Refresh', icon: 'refresh', action: () => this.refreshSchema(s) },
        refresh,
      ]);
    } else if (node.kind === 'group') {
      const { schema, group } = d;
      const create = { tables: ['Create Table...', () => ws.openTableEditor(schema, null)], views: ['Create View...', () => ws.openObjectEditor('view', schema, null)],
        procedures: ['Create Stored Procedure...', () => ws.openObjectEditor('procedure', schema, null)], functions: ['Create Function...', () => ws.openObjectEditor('function', schema, null)] }[group];
      contextMenu(e, [{ label: create[0], icon: 'plus', action: create[1] },
        group === 'procedures' || group === 'functions' ? { label: 'Manage Procedures & Functions', icon: 'procedure', action: () => ws.openRoutines(schema) } : null,
        group === 'tables' ? { label: 'Table Data Import Wizard...', icon: 'import', action: () => ws.openImportWizard({ schema }) } : null,
        '-', { label: 'Refresh', icon: 'refresh', action: () => this.refreshSchema(schema) }, refresh]);
    } else if (node.kind === 'table' || node.kind === 'view') {
      const { schema, name } = d;
      const isTable = node.kind === 'table';
      const stmtMenu = (send) => [
        { label: 'Name (short)', action: () => this.emit(ws.quoteIfNeeded(name), send) },
        { label: 'Name (long)', action: () => this.emit(q(schema, name), send) },
        '-',
        { label: 'Select All Statement', action: () => this.genStatement('select', schema, name, send) },
        isTable ? { label: 'Insert Statement', action: () => this.genStatement('insert', schema, name, send) } : null,
        isTable ? { label: 'Update Statement', action: () => this.genStatement('update', schema, name, send) } : null,
        isTable ? { label: 'Delete Statement', action: () => this.genStatement('delete', schema, name, send) } : null,
        { label: 'Create Statement', action: () => ws.copyDDL(node.kind, schema, name, send) },
      ];
      contextMenu(e, [
        { label: `Select Rows - Limit ${ws.settings.limit || 'All'}`, icon: 'grid', action: () => ws.selectRows(schema, name) },
        isTable ? { label: 'Table Inspector', icon: 'infoOutline', action: () => ws.openInspector(schema, name) } : null,
        '-',
        { label: 'Copy to Clipboard', icon: 'copy', submenu: () => stmtMenu(false) },
        { label: 'Send to SQL Editor', submenu: () => stmtMenu(true) },
        '-',
        isTable ? { label: 'Create Table...', icon: 'tableAdd', action: () => ws.openTableEditor(schema, null) } : { label: 'Create View...', icon: 'viewAdd', action: () => ws.openObjectEditor('view', schema, null) },
        isTable ? { label: 'Create Table Like...', action: () => ws.createTableLike(schema, name) } : null,
        isTable ? { label: 'Alter Table...', icon: 'wrench', action: () => ws.openTableEditor(schema, name) } : { label: 'Alter View...', icon: 'wrench', action: () => ws.openObjectEditor('view', schema, name) },
        isTable ? { label: 'Table Maintenance', submenu: ws.driver === 'mysql' ? [
          { label: 'Analyze Table', action: () => ws.maintenance('ANALYZE', schema, name) },
          { label: 'Optimize Table', action: () => ws.maintenance('OPTIMIZE', schema, name) },
          { label: 'Check Table', action: () => ws.maintenance('CHECK', schema, name) },
          { label: 'Repair Table', action: () => ws.maintenance('REPAIR', schema, name) },
          { label: 'Checksum Table', action: () => ws.maintenance('CHECKSUM', schema, name) },
        ] : [
          { label: 'Analyze', action: () => ws.maintenance('ANALYZE', schema, name) },
          { label: 'Integrity Check', action: () => ws.maintenance('INTEGRITY', schema, name) },
          { label: 'Vacuum Database', action: () => ws.maintenance('VACUUM', schema, name) },
        ] } : null,
        isTable ? { label: 'Table Data Import Wizard...', icon: 'import', action: () => ws.openImportWizard({ schema, table: name }) } : null,
        '-',
        { label: isTable ? 'Drop Table...' : 'Drop View...', icon: 'trash', action: () => ws.dropObject(node.kind, schema, name) },
        isTable ? { label: 'Truncate Table...', action: () => ws.truncateTable(schema, name) } : null,
        isTable ? { label: 'Rename Table...', action: () => ws.renameTable(schema, name) } : null,
        '-',
        { label: 'Refresh', icon: 'refresh', action: () => this.refreshSchema(schema) },
        refresh,
      ]);
    } else if (node.kind === 'procedure' || node.kind === 'function') {
      const { schema, name } = d;
      contextMenu(e, [
        { label: node.kind === 'procedure' ? 'Execute Stored Procedure...' : 'Call Function...', icon: 'bolt', action: () => ws.callRoutine(node.kind, schema, name, d.item) },
        { label: 'Alter ' + (node.kind === 'procedure' ? 'Stored Procedure...' : 'Function...'), icon: 'wrench', action: () => ws.openObjectEditor(node.kind, schema, name) },
        { label: 'Duplicate...', icon: 'copy', action: () => ws.duplicateRoutine(node.kind, schema, name) },
        { label: 'Show in Procedures & Functions', icon: 'procedure', action: () => ws.openRoutines(schema) },
        '-',
        { label: 'Copy to Clipboard', submenu: [{ label: 'Name', action: () => copyText(name) }, { label: 'Create Statement', action: () => ws.copyDDL(node.kind, schema, name) }] },
        { label: 'Send to SQL Editor', submenu: [{ label: 'Name', action: () => ws.sendToEditor(ws.quoteIfNeeded(name), { insert: true }) }, { label: 'Create Statement', action: () => ws.copyDDL(node.kind, schema, name, true) }] },
        '-',
        { label: 'Drop ' + (node.kind === 'procedure' ? 'Stored Procedure...' : 'Function...'), icon: 'trash', action: () => ws.dropObject(node.kind, schema, name) },
        '-',
        refresh,
      ]);
    } else if (node.kind === 'column') {
      contextMenu(e, [
        { label: 'Copy Name', icon: 'copy', action: () => copyText(d.item.name) },
        { label: 'Send Name to SQL Editor', action: () => ws.sendToEditor(ws.quoteIfNeeded(d.item.name), { insert: true }) },
        '-',
        { label: 'Alter Table...', icon: 'wrench', action: () => ws.openTableEditor(d.schema, d.table) },
      ]);
    } else if (node.kind === 'trigger') {
      contextMenu(e, [
        { label: 'Alter Trigger...', icon: 'wrench', action: () => ws.openObjectEditor('trigger', d.schema, d.item.name, { table: d.table }) },
        { label: 'Copy Create Statement', icon: 'copy', action: () => ws.copyDDL('trigger', d.schema, d.item.name) },
        { label: 'Drop Trigger...', icon: 'trash', action: () => ws.dropObject('trigger', d.schema, d.item.name) },
      ]);
    } else if (node.kind === 'index' || node.kind === 'fk' || node.kind === 'subgroup') {
      contextMenu(e, [
        { label: 'Alter Table...', icon: 'wrench', action: () => ws.openTableEditor(d.schema, d.table) },
        { label: 'Table Inspector', icon: 'infoOutline', action: () => ws.openInspector(d.schema, d.table) },
        '-', refresh,
      ]);
    }
  }

  emit(text, send) {
    if (send) this.ws.sendToEditor(text);
    else copyText(text);
  }

  async genStatement(kind, schema, table, send) {
    const ws = this.ws;
    const o = await this.loadSchema(schema);
    const cols = (o.columns?.[table] || []).map((c) => c.name);
    const t = ws.qualify(schema, table);
    const qi = (c) => ws.quoteIdent(c);
    let sql = '';
    if (kind === 'select') sql = `SELECT ${cols.length ? cols.map(qi).join(',\n    ') : '*'}\nFROM ${t};`;
    else if (kind === 'insert') sql = `INSERT INTO ${t}\n(${cols.map(qi).join(',\n')})\nVALUES\n(${cols.map((c) => `<{${c}: }>`).join(',\n')});`;
    else if (kind === 'update') sql = `UPDATE ${t}\nSET\n${cols.map((c) => `${qi(c)} = <{${c}: }>`).join(',\n')}\nWHERE <{where_expression}>;`;
    else if (kind === 'delete') sql = `DELETE FROM ${t}\nWHERE <{where_expression}>;`;
    this.emit(sql, send);
  }

  // ------------------------------------------------------------------- information panel
  showInfo(mode, node) {
    this.infoMode = mode;
    if (node !== undefined) this.infoNode = node;
    Object.entries(this.infoTabs).forEach(([k, b]) => b.classList.toggle('active', k === mode));
    const body = this.infoBody;
    body.innerHTML = '';
    if (mode === 'session') {
      const i = this.ws.info;
      const rows = this.ws.driver === 'mysql' ? [
        ['Connection', this.ws.profile.name], ['Host', i.host], ['Port', i.port], ['Server', i.version_comment || (i.is_mariadb ? 'MariaDB' : 'MySQL')],
        ['Version', i.server_version], ['Login User', this.ws.profile.user], ['Current User', i.user], ['SSL', i.ssl ? 'Enabled' : 'Disabled'],
        ['Default Schema', this.ws.currentSchema || '(none)'], ['Autocommit', this.ws.autocommit ? 'On' : 'Off'],
      ] : this.ws.driver === 'odbc' ? [
        ['Connection', this.ws.profile.name], ['Data source', i.host], ['Database', i.server_version], ['User', i.user || '(Windows / none)'],
        ['Default Schema', this.ws.info.has_schemas ? (this.ws.currentSchema || '(none)') : '(no schemas)'], ['Autocommit', this.ws.autocommit ? 'On' : 'Off'],
      ] : [['Connection', this.ws.profile.name], ['File', i.file], ['Engine', i.server_version], ['Autocommit', this.ws.autocommit ? 'On' : 'Off']];
      body.innerHTML = '<table class="info-table">' + rows.map(([k, v]) => `<tr><th>${esc(k)}:</th><td>${esc(v ?? '')}</td></tr>`).join('') + '</table>';
      return;
    }
    const n = this.infoNode;
    if (!n) { body.append(h('div', { class: 'muted' }, 'No object selected')); return; }
    const d = n.data || {};
    const line = (k, v) => `<div><span class="muted">${esc(k)}:</span> <b>${esc(v)}</b></div>`;
    if (n.kind === 'schema') {
      body.innerHTML = line('Schema', d.name) + (d.charset ? line('Charset', d.charset) + line('Collation', d.collation) : '') + (d.file ? line('File', d.file) : '');
    } else if (n.kind === 'table' || n.kind === 'view') {
      const o = this.objects.get(d.schema);
      const cols = o && !(o instanceof Promise) ? o.columns?.[d.name] || [] : [];
      const it = d.item || {};
      let html = line(n.kind === 'table' ? 'Table' : 'View', d.name);
      if (it.engine) html += line('Engine', it.engine);
      if (it.row_estimate !== null && it.row_estimate !== undefined) html += line('Rows (approx.)', formatNumber(it.row_estimate));
      if (it.data_length !== undefined && it.data_length !== null) html += line('Data size', formatBytes(Number(it.data_length) + Number(it.index_length || 0)));
      if (it.comment) html += line('Comment', it.comment);
      html += '<div class="muted info-sub">Columns:</div><table class="info-cols">' + cols.map((c) =>
        `<tr><td>${iconSvg(c.col_key === 'PRI' ? 'key' : 'column')} ${esc(c.name)}</td><td class="muted">${esc(c.column_type)}${c.col_key === 'PRI' ? ' PK' : ''}${/auto_increment/i.test(c.extra) ? ' AI' : ''}${c.nullable ? '' : ' NN'}</td></tr>`).join('') + '</table>';
      body.innerHTML = html;
    } else if (n.kind === 'column') {
      const c = d.item;
      body.innerHTML = line('Column', c.name) + line('Type', c.column_type) + line('Nullable', c.nullable ? 'YES' : 'NO') +
        line('Default', c.default ?? '(none)') + (c.extra ? line('Extra', c.extra) : '') + (c.comment ? line('Comment', c.comment) : '');
    } else if (n.kind === 'procedure' || n.kind === 'function') {
      body.innerHTML = line(n.kind === 'procedure' ? 'Procedure' : 'Function', d.name) + (d.item?.returns ? line('Returns', d.item.returns) : '') + (d.item?.comment ? line('Comment', d.item.comment) : '');
      import('./routines.js').then(async ({ loadRoutines, routineInfoHtml }) => {
        const r = (await loadRoutines(this.ws, d.schema, d.name)).find((x) => x.type === n.kind);
        if (r && this.infoNode === n) body.innerHTML = routineInfoHtml(r);
      }).catch(() => { /* keep the short version */ });
    } else if (n.kind === 'index') {
      const x = d.item;
      body.innerHTML = line('Index', x.name) + line('Type', x.primary ? 'PRIMARY' : x.unique ? 'UNIQUE' : 'INDEX') + line('Columns', x.columns.map((c) => c.name).join(', '));
    } else if (n.kind === 'fk') {
      const x = d.item;
      body.innerHTML = line('Foreign Key', x.name) + line('Columns', x.columns.join(', ')) + line('References', `${x.ref_table} (${x.ref_columns.join(', ')})`) +
        line('On Update', x.on_update) + line('On Delete', x.on_delete);
    } else if (n.kind === 'trigger') {
      const x = d.item;
      body.innerHTML = line('Trigger', x.name) + line('Timing', `${x.timing} ${x.event}`) + `<pre class="sql-pre small">${esc(x.body)}</pre>`;
    } else {
      body.innerHTML = line('Object', n.label);
    }
  }
}
