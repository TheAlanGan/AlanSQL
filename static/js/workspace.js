// A connection workspace: toolbar, navigator, document tabs (SQL editors, editors, admin pages), output panel.
import { api, state } from './api.js';
import { MetaCache } from './completion.js';
import { Navigator } from './navigator.js';
import { OutputPanel } from './output.js';
import { QueryTab } from './querytab.js';
import { reviewAndApply } from './review.js';
import { SnippetsPanel } from './snippets.js';
import { applyLimit, firstWord, needsQuote, quoteIdent, quoteIfNeeded, quoteString, shouldApplyLimit, topLevelWords } from './sqlparse.js';
import {
  TabStrip, alertDialog, checkbox, confirmDialog, contextMenu, copyText, debounce, field, h, icon, modal, promptDialog,
  select, sep, splitter, toast, toolButton,
} from './ui.js';

export class Workspace {
  constructor(app, profile, session) {
    this.app = app;
    this.profile = profile;
    this.sid = session.sid;
    this.info = session.info;
    this.driver = session.info.driver;
    this.dialect = this.driver === 'mysql' ? 'mysql' : 'sqlite';   // statement splitting / keyword rules
    this.features = session.info.features || {};
    this.backslash = this.driver === 'mysql' && !session.info.no_backslash_escapes;
    this.currentSchema = session.info.current_schema;
    this.autocommit = session.info.autocommit !== false;
    this.inTransaction = false;
    this.continueOnError = false;
    this.settings = { limit: app.prefs.limit ?? 1000 };
    this.title = profile.name;
    this.meta = new MetaCache(this);
    this.docList = [];
    this.queryNumber = 0;
    this.connected = true;
    this.persistTabs = debounce(() => this.saveTabs(), 800);
    this.el = h('div', { class: 'workspace' });
    this.build();
  }

  // ------------------------------------------------------------------ layout
  build() {
    const tb = (ic, title, fn) => toolButton(ic, title, fn);
    this.toggles = {
      left: toolButton('sidebarLeft', 'Show/hide the Navigator (sidebar)', () => this.togglePanel('left')),
      bottom: toolButton('sidebarBottom', 'Show/hide the Output area', () => this.togglePanel('bottom')),
      right: toolButton('sidebarRight', 'Show/hide the SQL Snippets panel', () => this.togglePanel('right')),
    };
    const routines = this.features.routines;
    this.toolbar = h('div', { class: 'toolbar ws-toolbar' },
      tb('newSql', 'Create a new SQL tab for executing queries', () => this.openQueryTab()),
      tb('open', 'Open a SQL script file in a new query tab', () => this.openScript()),
      sep(),
      tb('infoOutline', 'Open the inspector for the selected object', () => this.inspectSelected()),
      sep(),
      this.features.create_schema ? tb('schemaAdd', 'Create a new schema in the connected server', () => this.createSchemaDialog()) : null,
      this.features.table_editor === false ? null : tb('tableAdd', 'Create a new table in the active schema', () => this.openTableEditor(this.activeSchema(), null)),
      this.features.object_editor === false ? null : tb('viewAdd', 'Create a new view in the active schema', () => this.openObjectEditor('view', this.activeSchema(), null)),
      routines ? tb('procAdd', 'Create a new stored procedure in the active schema', () => this.openObjectEditor('procedure', this.activeSchema(), null)) : null,
      routines ? tb('funcAdd', 'Create a new function in the active schema', () => this.openObjectEditor('function', this.activeSchema(), null)) : null,
      sep(),
      tb('diagram', 'Reverse engineer the active schema into an ER diagram', () => this.openErd(this.activeSchema())),
      tb('reconnect', 'Reconnect to the database server', () => this.reconnect()),
      h('span', { class: 'flex1' }),
      this.schemaBadge = h('span', { class: 'schema-badge', title: 'Default schema (double-click a schema in the navigator to change it)' }),
      this.txBadge = h('span', { class: 'tx-badge hidden', title: 'A transaction is open. Commit or rollback to end it.' }, 'Transaction open'),
      sep(),
      this.toggles.left, this.toggles.bottom, this.toggles.right);

    this.left = h('div', { class: 'ws-left' });
    this.center = h('div', { class: 'ws-center' });
    this.right = h('div', { class: 'ws-right hidden' });
    const leftSplit = h('div');
    const rightSplit = h('div', { class: 'hidden' });
    this.rightSplit = rightSplit;
    this.leftSplit = leftSplit;
    this.body = h('div', { class: 'ws-body' }, this.left, leftSplit, this.center, rightSplit, this.right);
    this.el.append(this.toolbar, this.body);
    splitter(leftSplit, this.left, { direction: 'v', min: 160, max: 700, key: 'ws-left' });
    splitter(rightSplit, this.right, { direction: 'v', min: 160, max: 600, invert: true, key: 'ws-right' });

    this.docsHost = h('div', { class: 'ws-docs' });
    this.docs = new TabStrip(this.center, {
      className: 'doc-tabs',
      onSelect: (t) => this.showDoc(t?.doc),
      onClose: (t) => this.closeDoc(t.doc),
      onContextMenu: (e, t) => this.docMenu(e, t.doc),
      addButton: { title: 'New SQL tab', onClick: () => this.openQueryTab() },
    });
    this.outputSplit = h('div');
    this.outputHost = h('div', { class: 'ws-output' });
    this.center.append(this.docsHost, this.outputSplit, this.outputHost);
    splitter(this.outputSplit, this.outputHost, { direction: 'h', invert: true, min: 50, max: 700, key: 'ws-output' });

    this.output = new OutputPanel(this.outputHost, this);
    this.navigator = new Navigator(this.left, this);
    this.snippets = new SnippetsPanel(this.right, this);
    const panels = JSON.parse(localStorage.getItem('ws-panels') || '{"left":true,"bottom":true,"right":false}');
    this.panels = panels;
    this.applyPanels();
    this.updateBadges();
  }

  async init() {
    await this.navigator.refresh();
    const saved = await state.get('tabs-' + this.profile.id, null);
    if (saved?.tabs?.length) {
      for (const t of saved.tabs) {
        const tab = this.openQueryTab({ title: t.title, content: t.content, path: t.path, id: t.id, activate: false });
        if (t.path && t.savedContent !== undefined && t.savedContent !== null) { tab.savedContent = t.savedContent; tab.updateDirty(); }
      }
      const active = this.docList.find((d) => d.id === saved.active) || this.docList[0];
      if (active) this.docs.select(active.tab);
      this.queryNumber = Math.max(this.queryNumber, saved.queryNumber || 0);
    } else {
      this.openQueryTab();
    }
    if (this.app.prefs.safeUpdates && this.driver === 'mysql') {
      this.executeStatement('SET SQL_SAFE_UPDATES = 1', { limit: false, quiet: true });
    }
  }

  togglePanel(which) {
    this.panels[which] = !this.panels[which];
    localStorage.setItem('ws-panels', JSON.stringify(this.panels));
    this.applyPanels();
  }

  applyPanels() {
    this.left.classList.toggle('hidden', !this.panels.left);
    this.leftSplit.classList.toggle('hidden', !this.panels.left);
    this.outputHost.classList.toggle('hidden', !this.panels.bottom);
    this.outputSplit.classList.toggle('hidden', !this.panels.bottom);
    this.right.classList.toggle('hidden', !this.panels.right);
    this.rightSplit.classList.toggle('hidden', !this.panels.right);
    for (const k of ['left', 'bottom', 'right']) this.toggles[k].classList.toggle('on', !!this.panels[k]);
  }

  // ------------------------------------------------------------------ documents
  nextQueryNumber() { return ++this.queryNumber; }

  addDoc(doc, { activate = true } = {}) {
    this.docList.push(doc);
    this.docsHost.append(doc.el);
    doc.el.classList.add('hidden');
    doc.tab = this.docs.add({ title: doc.title, icon: doc.icon, doc, tooltip: doc.path || doc.title }, { activate });
    return doc;
  }

  openQueryTab({ title, content = '', path = null, id, activate = true } = {}) {
    const tab = new QueryTab(this, { title, content, path, id });
    this.addDoc(tab, { activate });
    tab.updateDirty();
    this.persistTabs();
    return tab;
  }

  showDoc(doc) {
    for (const d of this.docList) d.el.classList.toggle('hidden', d !== doc);
    if (doc) { doc.onShow?.(); this.lastQueryTab = doc.kind === 'query' ? doc : this.lastQueryTab; }
    this.persistTabs();
    this.app.updateMenus?.();
  }

  activeDoc() { return this.docs.active?.doc || null; }

  activeQueryTab({ create = true } = {}) {
    const a = this.activeDoc();
    if (a?.kind === 'query') return a;
    if (this.lastQueryTab && this.docList.includes(this.lastQueryTab)) return this.lastQueryTab;
    const q = this.docList.find((d) => d.kind === 'query');
    if (q) return q;
    return create ? this.openQueryTab() : null;
  }

  async closeDoc(doc) {
    if (doc.confirmClose && !(await doc.confirmClose())) return false;
    this.docList = this.docList.filter((d) => d !== doc);
    doc.dispose?.();
    doc.el.remove();
    this.docs.remove(doc.tab);
    if (this.lastQueryTab === doc) this.lastQueryTab = null;
    this.persistTabs();
    return true;
  }

  docMenu(e, doc) {
    contextMenu(e, [
      doc.kind === 'query' ? { label: 'Rename Tab...', action: async () => {
        const name = await promptDialog('Rename Tab', 'Tab name:', doc.title);
        if (name) { doc.title = name; this.docs.setTitle(doc.tab, name, doc.path || name); this.persistTabs(); }
      } } : null,
      doc.kind === 'query' ? { label: 'Save Script', icon: 'save', action: () => doc.save() } : null,
      doc.kind === 'query' ? { label: 'Save Script As...', action: () => doc.save(true) } : null,
      doc.path ? { label: 'Copy File Path', icon: 'copy', action: () => copyText(doc.path) } : null,
      '-',
      { label: 'Close Tab', action: () => this.closeDoc(doc) },
      { label: 'Close Other Tabs', action: async () => { for (const d of this.docList.filter((x) => x !== doc)) if (!(await this.closeDoc(d))) break; } },
      { label: 'Close Tabs to the Right', action: async () => { const i = this.docList.indexOf(doc); for (const d of this.docList.slice(i + 1)) if (!(await this.closeDoc(d))) break; } },
      { label: 'Close All Tabs', action: async () => { for (const d of [...this.docList]) if (!(await this.closeDoc(d))) break; } },
      '-',
      { label: 'New SQL Tab', icon: 'newSql', action: () => this.openQueryTab() },
    ]);
  }

  findDoc(pred) { return this.docList.find(pred); }

  saveTabs() {
    const tabs = this.docList.filter((d) => d.kind === 'query').map((d) => d.serialize());
    state.set('tabs-' + this.profile.id, { tabs, active: this.activeDoc()?.id, queryNumber: this.queryNumber }, 0);
  }

  async openScript() {
    const tab = this.activeQueryTab({ create: false });
    if (tab && !tab.content.trim() && !tab.path) return tab.openFile();
    const { pickOpenFile, readFile, addRecent } = await import('./files.js');
    try {
      const path = await pickOpenFile('Open SQL Script');
      if (!path) return;
      const f = await readFile(path);
      addRecent(path);
      this.openQueryTab({ title: f.name, content: f.content, path: f.path });
    } catch (e) { toast(e.message, 'error'); }
  }

  openFileContent(f) {
    const existing = this.docList.find((d) => d.path && d.path.toLowerCase() === f.path.toLowerCase());
    if (existing) { this.docs.select(existing.tab); return existing; }
    return this.openQueryTab({ title: f.name, content: f.content, path: f.path });
  }

  sendToEditor(text, { insert = false } = {}) {
    const tab = this.activeQueryTab();
    this.docs.select(tab.tab);
    if (insert) tab.insertText(text);
    else tab.appendText(text);
  }

  // ------------------------------------------------------------------ execution
  async executeStatement(sql, { limit = true, explainOnly = false, quiet = false } = {}) {
    let toRun = sql;
    const lim = this.settings.limit;
    let applied = false;
    if (!explainOnly && limit && lim && shouldApplyLimit(sql, this.dialect)) {
      // ODBC sources don't share a LIMIT syntax: the server stops reading at max_rows instead
      if (this.driver !== 'odbc') toRun = applyLimit(sql, lim);
      applied = true;
    }
    const entry = quiet ? null : this.output.add({ action: explainOnly ? 'EXPLAIN ' + sql : toRun });
    if (!quiet) this.output.addHistory(sql);
    const t0 = performance.now();
    try {
      if (explainOnly) {
        const plan = await api.post(`/sessions/${this.sid}/explain`, { sql });
        if (entry) this.output.update(entry, { status: 'ok', message: 'OK', ms: performance.now() - t0 });
        return { ok: true, plan, sql, ms: performance.now() - t0 };
      }
      const data = await api.post(`/sessions/${this.sid}/execute`, { sql: toRun, max_rows: applied ? lim : 0 });
      const ms = performance.now() - t0;
      if (data.reconnected) this.output.add({ action: 'Reconnect', status: 'warning', message: 'The connection was lost and has been re-established. Session state (variables, temporary tables, transactions) was reset.' });
      const msgs = [];
      for (const r of data.results) {
        if (r.kind === 'rows') msgs.push(`${r.rows.length.toLocaleString()} row(s) returned${r.truncated ? ' (row limit reached)' : ''}`);
        else if (r.kind === 'status') msgs.push(`${(r.affected ?? 0).toLocaleString()} row(s) affected${r.info ? ' ' + r.info.replace(/^[^A-Za-z]+/, '') : ''}`);
        else if (r.kind === 'error') msgs.push(r.message);
      }
      let status = data.results.some((r) => r.kind === 'error') ? 'error' : 'ok';
      if (data.warnings?.length) {
        status = status === 'ok' ? 'warning' : status;
        msgs.push(`${data.warnings.length} warning(s): ` + data.warnings.map((w) => `${w.code} ${w.message}`).join(' | '));
      }
      if (entry) this.output.update(entry, { status, message: msgs.join(', '), ms: data.exec_ms, fetchMs: data.fetch_ms });
      this.setCurrentSchema(data.current_schema);
      this.setTransactionState(data.in_transaction);
      this.afterStatement(sql);
      return { ok: true, data, sql: toRun, ms };
    } catch (e) {
      const ms = performance.now() - t0;
      if (entry) this.output.update(entry, { status: 'error', message: e.message, ms });
      if (e.code === 'not_found' && /closed/.test(e.message)) this.markDisconnected();
      return { ok: false, error: e.message, sql: toRun, ms };
    }
  }

  afterStatement(sql) {
    const words = topLevelWords(sql, this.dialect);
    const w = words[0];
    if (!['CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE', 'ATTACH', 'DETACH'].includes(w)) return;
    if (words.includes('DATABASE') || words.includes('SCHEMA') || w === 'ATTACH' || w === 'DETACH') { this.refreshSoon(null); return; }
    const m = /(?:TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|INDEX|EVENT)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|([\w$]+))\s*\./i.exec(sql);
    const schema = m ? (m[1] || m[2] || m[3]) : this.currentSchema || (this.driver === 'sqlite' ? 'main' : null);
    this.refreshSoon(schema);
  }

  refreshSoon(schema) {
    clearTimeout(this.refreshTimer);
    this.pendingRefresh = this.pendingRefresh === undefined ? schema : (this.pendingRefresh === schema ? schema : null);
    this.refreshTimer = setTimeout(() => {
      const s = this.pendingRefresh;
      this.pendingRefresh = undefined;
      this.navigator.refreshSchema(s);
    }, 300);
  }

  async cancel() {
    try {
      await api.post(`/sessions/${this.sid}/cancel`);
      this.output.add({ action: 'Stop', status: 'warning', message: 'Query cancellation was requested.' });
    } catch (e) { toast(e.message, 'error'); }
  }

  async runScript(statements, { transaction = false, stopOnError = true } = {}) {
    const r = await api.post(`/sessions/${this.sid}/script`, { statements, transaction, stop_on_error: stopOnError });
    for (const x of r.results) this.logOutput({ action: x.sql, ok: x.ok, message: x.ok ? `${x.affected ?? 0} row(s) affected` : x.error, ms: x.ms });
    this.setCurrentSchema(r.current_schema);
    this.setTransactionState(r.in_transaction);
    return r;
  }

  logOutput({ action, ok, message, ms }) {
    return this.output.add({ action: action || '', status: ok ? 'ok' : 'error', message: message || '', ms });
  }

  // ------------------------------------------------------------------ session state
  stateListeners = new Set();

  notifyState() {
    for (const d of this.docList) d.updateState?.();
    this.updateBadges();
  }

  updateBadges() {
    this.schemaBadge.innerHTML = '';
    this.schemaBadge.append(icon('db'), ' ', this.currentSchema || (this.driver === 'mysql' ? 'no default schema' : 'main'));
    this.txBadge.classList.toggle('hidden', !this.inTransaction);
    if (this.connected === false) this.schemaBadge.classList.add('disconnected');
  }

  setCurrentSchema(schema, { silent = false } = {}) {
    if (schema === undefined || schema === this.currentSchema) return;
    const prev = this.currentSchema;
    this.currentSchema = schema;
    this.updateBadges();
    if (!silent && this.navigator) {
      this.navigator.tree.querySelectorAll('.tree-row[data-kind="schema"]').forEach((r) => {
        r.classList.toggle('bold', r.node?.data?.name === schema);
      });
    }
    if (prev !== schema) this.app.updateTitle?.();
  }

  setTransactionState(inTx) {
    if (inTx === undefined) return;
    this.inTransaction = !!inTx;
    this.notifyState();
  }

  activeSchema() {
    const sel = this.navigator?.infoNode?.data;
    return sel?.schema || (this.navigator?.infoNode?.kind === 'schema' ? sel.name : null) || this.currentSchema || (this.driver === 'sqlite' ? 'main' : null);
  }

  async setDefaultSchema(schema) {
    try {
      const r = await api.post(`/sessions/${this.sid}/use`, { schema });
      this.setCurrentSchema(r.current_schema);
      this.logOutput({ action: `USE ${this.quoteIdent(schema)}`, ok: true, message: `Default schema set to ${schema}` });
    } catch (e) {
      this.logOutput({ action: `USE ${schema}`, ok: false, message: e.message });
    }
  }

  toggleContinueOnError() {
    this.continueOnError = !this.continueOnError;
    this.notifyState();
  }

  setLimit(n) {
    this.settings.limit = n;
    this.app.prefs.limit = n;
    this.app.savePrefs();
    this.notifyState();
  }

  async setAutocommit(enabled) {
    try {
      if (!enabled && this.inTransaction) { /* allowed */ }
      if (enabled && this.inTransaction) {
        const ok = await confirmDialog('Enable Autocommit', 'A transaction is currently open. Enabling autocommit will commit it. Continue?', { okLabel: 'Commit and Enable' });
        if (!ok) return;
      }
      const r = await api.post(`/sessions/${this.sid}/autocommit`, { enabled });
      this.autocommit = r.autocommit;
      this.inTransaction = r.in_transaction;
      this.logOutput({ action: `SET autocommit = ${enabled ? 1 : 0}`, ok: true, message: enabled ? 'Autocommit enabled' : 'Autocommit disabled - use Commit/Rollback to end transactions' });
      this.notifyState();
    } catch (e) { toast(e.message, 'error'); }
  }

  async commit() {
    try {
      const r = await api.post(`/sessions/${this.sid}/commit`);
      this.inTransaction = r.in_transaction;
      this.logOutput({ action: 'COMMIT', ok: true, message: 'Transaction committed' });
      this.notifyState();
    } catch (e) { this.logOutput({ action: 'COMMIT', ok: false, message: e.message }); }
  }

  async rollback() {
    try {
      const r = await api.post(`/sessions/${this.sid}/rollback`);
      this.inTransaction = r.in_transaction;
      this.logOutput({ action: 'ROLLBACK', ok: true, message: 'Transaction rolled back' });
      this.notifyState();
    } catch (e) { this.logOutput({ action: 'ROLLBACK', ok: false, message: e.message }); }
  }

  markDisconnected() {
    this.connected = false;
    this.updateBadges();
    toast('The connection to the server was closed. Use Reconnect (toolbar) to continue.', 'warning', 6000);
  }

  async reconnect() {
    try {
      const r = await this.app.openSessionFor(this.profile);
      if (!r) return;
      api.del(`/sessions/${this.sid}`).catch(() => {});
      this.sid = r.sid;
      this.info = r.info;
      this.connected = true;
      this.autocommit = true;
      this.inTransaction = false;
      this.schemaBadge.classList.remove('disconnected');
      const schema = this.currentSchema;
      this.currentSchema = r.info.current_schema;
      if (schema && schema !== this.currentSchema && this.driver === 'mysql') await this.setDefaultSchema(schema);
      this.meta.invalidate();
      await this.navigator.refresh();
      this.logOutput({ action: 'Reconnect', ok: true, message: 'Reconnected to ' + this.profile.name });
      this.notifyState();
    } catch (e) { toast(e.message, 'error'); }
  }

  async close() {
    for (const d of [...this.docList]) {
      if (d.kind === 'query') {
        if (d.isDirty() && !(await d.confirmClose())) return false;
      } else if (d.confirmClose && !(await d.confirmClose())) return false;
    }
    this.saveTabs();
    state.flush();
    for (const d of this.docList) d.dispose?.();
    api.del(`/sessions/${this.sid}`).catch(() => {});
    return true;
  }

  // ------------------------------------------------------------------ SQL helpers
  quoteIdent(name) {
    if (this.driver === 'odbc') {
      const q = this.info.quote_char || '"';
      return q === '[' ? '[' + String(name).replace(/]/g, ']]') + ']' : q + String(name).split(q).join(q + q) + q;
    }
    return quoteIdent(name, this.driver);
  }
  quoteIfNeeded(name) { return this.driver === 'odbc' ? (needsQuote(name) ? this.quoteIdent(name) : name) : quoteIfNeeded(name, this.driver); }
  qualify(schema, name) {
    if (!schema || (this.driver === 'sqlite' && schema === 'main')) return this.quoteIdent(name);
    if (this.driver === 'odbc' && (!this.info.has_schemas || schema === 'default')) return this.quoteIdent(name);
    return this.quoteIdent(schema) + '.' + this.quoteIdent(name);
  }
  sqlString(v) { return quoteString(v, { backslash: this.backslash }); }
  sqlLiteral(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(Number(v));
    if (typeof v === 'object' && v.$bin !== undefined) return "X'" + v.$bin + "'";
    return this.sqlString(v);
  }

  // ------------------------------------------------------------------ object actions
  selectRows(schema, table) {
    const tab = this.activeQueryTab();
    let cols = '*';
    if (this.driver === 'sqlite') {
      const o = this.navigator.objects.get(schema);
      const columns = o && !(o instanceof Promise) ? o.columns?.[table] : null;
      const isTable = o && !(o instanceof Promise) && o.tables.some((t) => t.name === table);
      if (isTable && columns && !columns.some((c) => c.col_key === 'PRI')) cols = 'rowid, *';
    }
    const sql = `SELECT ${cols} FROM ${this.qualify(schema, table)};`;
    const doc = this.openQueryTab({ title: table, content: sql });
    void tab;
    doc.run('all');
  }

  async copyDDL(kind, schema, name, send = false) {
    try {
      const r = await api.get(`/sessions/${this.sid}/ddl?schema=${encodeURIComponent(schema || '')}&name=${encodeURIComponent(name)}&type=${kind}`);
      let ddl = r.ddl.trim().replace(/;?$/, ';');
      if (['procedure', 'function', 'trigger'].includes(kind) && this.driver === 'mysql') ddl = `DELIMITER $$\n${ddl.replace(/;$/, '')}$$\nDELIMITER ;`;
      if (send) this.sendToEditor(ddl);
      else { await copyText(ddl); toast('Copied to clipboard', 'success', 1500); }
    } catch (e) { toast(e.message, 'error'); }
  }

  async dropObject(kind, schema, name) {
    const label = { schema: 'Schema', table: 'Table', view: 'View', procedure: 'Stored Procedure', function: 'Function', trigger: 'Trigger' }[kind];
    const target = kind === 'schema' ? this.quoteIdent(name) : this.qualify(schema, name);
    const kw = kind === 'schema' ? (this.driver === 'mysql' ? 'DATABASE' : 'SCHEMA') : kind.toUpperCase();
    const stmt = `DROP ${kw} ${target};`;
    const choice = await modal({
      title: `Drop ${label}`, closeValue: 'cancel', width: 480,
      content: h('div', { class: 'msg-dialog' }, icon('warning', 'big'), h('div', { class: 'msg-text' },
        h('p', null, `Please confirm permanent deletion of ${label.toLowerCase()} `, h('b', null, name), kind === 'schema' ? ' and all its objects.' : ' and its data.'),
        h('p', { class: 'muted' }, 'This cannot be undone.'))),
      buttons: [{ label: 'Review SQL', value: 'review' }, '-', { label: 'Cancel', value: 'cancel' }, { label: 'Drop Now', value: 'drop', primary: true, danger: true }],
    });
    if (choice === 'cancel' || !choice) return;
    let ok;
    if (choice === 'review') ok = await reviewAndApply(this, [stmt], { title: `Drop ${label}` });
    else {
      const r = await this.runScript([stmt]);
      ok = r.ok;
      if (!ok) alertDialog('Drop failed', r.results.find((x) => !x.ok)?.error || 'Error', 'error');
    }
    if (ok) {
      if (kind === 'schema') await this.navigator.refresh();
      else await this.navigator.refreshSchema(schema);
      const open = this.findDoc((d) => d.schema === schema && d.objectName === name);
      if (open) this.closeDoc(open);
    }
  }

  async truncateTable(schema, table) {
    const stmt = this.driver === 'mysql' ? `TRUNCATE TABLE ${this.qualify(schema, table)};` : `DELETE FROM ${this.qualify(schema, table)};`;
    const choice = await modal({
      title: 'Truncate Table', closeValue: 'cancel',
      content: h('div', { class: 'msg-dialog' }, icon('warning', 'big'), h('div', { class: 'msg-text' }, 'Delete ALL rows from ', h('b', null, table), '? This cannot be undone.')),
      buttons: [{ label: 'Review SQL', value: 'review' }, '-', { label: 'Cancel', value: 'cancel' }, { label: 'Truncate Now', value: 'go', primary: true, danger: true }],
    });
    if (choice === 'review') await reviewAndApply(this, [stmt], { title: 'Truncate Table' });
    else if (choice === 'go') {
      const r = await this.runScript([stmt]);
      if (r.ok) toast(`Table ${table} truncated.`, 'success');
      else alertDialog('Truncate failed', r.results.find((x) => !x.ok)?.error, 'error');
    }
  }

  async renameTable(schema, table) {
    const name = await promptDialog('Rename Table', `New name for ${table}:`, table);
    if (!name || name === table) return;
    const stmt = this.driver === 'mysql'
      ? `RENAME TABLE ${this.qualify(schema, table)} TO ${this.qualify(schema, name)};`
      : `ALTER TABLE ${this.qualify(schema, table)} RENAME TO ${this.quoteIdent(name)};`;
    if (await reviewAndApply(this, [stmt], { title: 'Rename Table' })) this.navigator.refreshSchema(schema);
  }

  async createTableLike(schema, table) {
    const name = await promptDialog('Create Table Like', `Name of the new table (copy of ${table}'s structure):`, table + '_copy');
    if (!name) return;
    let stmts;
    if (this.driver === 'mysql') stmts = [`CREATE TABLE ${this.qualify(schema, name)} LIKE ${this.qualify(schema, table)};`];
    else {
      const r = await api.get(`/sessions/${this.sid}/ddl?schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(table)}&type=table`);
      const ddl = r.ddl.replace(/^(\s*CREATE\s+TABLE\s+)(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)(\s*\.\s*(?:"[^"]+"|[\w$]+))?/i, `$1${this.quoteIdent(name)}`);
      stmts = [ddl];
    }
    if (await reviewAndApply(this, stmts, { title: 'Create Table Like' })) this.navigator.refreshSchema(schema);
  }

  async maintenance(op, schema, table) {
    let sql;
    if (this.driver === 'mysql') sql = `${op} TABLE ${this.qualify(schema, table)}`;
    else if (op === 'INTEGRITY') sql = 'PRAGMA integrity_check';
    else if (op === 'VACUUM') sql = 'VACUUM';
    else sql = `ANALYZE ${this.qualify(schema, table)}`;
    const tab = this.openQueryTab({ title: `${op.toLowerCase()} ${table}`, content: sql + ';' });
    tab.run('all');
  }

  async callRoutine(kind, schema, name) {
    const { executeRoutineDialog } = await import('./routines.js');
    return executeRoutineDialog(this, kind, schema, name);
  }

  async duplicateRoutine(kind, schema, name) {
    const { duplicateRoutine } = await import('./routines.js');
    return duplicateRoutine(this, kind, schema, name);
  }

  async openRoutines(schema) {
    if (!this.features.routines) { toast('This connection has no stored procedures or functions.', 'info'); return; }
    schema = schema || this.activeSchema() || this.navigator.schemas.find((x) => !x.system)?.name;
    if (!schema) { toast('Select a schema first.', 'warning'); return; }
    const existing = this.findDoc((d) => d.kind === 'routines');
    if (existing) { this.docs.select(existing.tab); existing.setSchema(schema); return; }
    const { RoutinesDoc } = await import('./routines.js');
    const doc = new RoutinesDoc(this, schema);
    this.addDoc(doc);
    doc.load();
  }

  async createSchemaDialog() {
    let meta = { charsets: [], collations: [], defaults: {} };
    try { meta = await this.loadMeta(); } catch { /* ignore */ }
    const name = h('input', { class: 'input', value: 'new_schema', autofocus: true });
    const cs = select([['', 'Default'], ...meta.charsets.map((c) => [c.name, c.name])], '');
    const coll = select([['', 'Default']], '');
    const fillColl = () => {
      coll.innerHTML = '';
      coll.append(h('option', { value: '' }, 'Default'));
      meta.collations.filter((c) => !cs.value || c.charset === cs.value).forEach((c) => coll.append(h('option', { value: c.name }, c.name)));
    };
    cs.addEventListener('change', fillColl);
    fillColl();
    const content = h('div', { class: 'form' }, field('Schema Name:', name), field('Character Set:', cs), field('Collation:', coll),
      h('div', { class: 'muted small' }, `Server default: ${meta.defaults.charset || ''} / ${meta.defaults.collation || ''}`));
    const ok = await modal({ title: 'Create Schema', content, width: 440, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }], closeValue: false });
    if (!ok || !name.value.trim()) return;
    let sql = `CREATE SCHEMA ${this.quoteIdent(name.value.trim())}`;
    if (cs.value) sql += ` DEFAULT CHARACTER SET ${cs.value}`;
    if (coll.value) sql += ` COLLATE ${coll.value}`;
    if (await reviewAndApply(this, [sql + ';'], { title: 'Create Schema' })) await this.navigator.refresh();
  }

  async alterSchemaDialog(s) {
    let meta;
    try { meta = await this.loadMeta(); } catch (e) { toast(e.message, 'error'); return; }
    const cs = select(meta.charsets.map((c) => [c.name, c.name]), s.charset);
    const coll = select([], '');
    const fill = () => {
      coll.innerHTML = '';
      meta.collations.filter((c) => c.charset === cs.value).forEach((c) => coll.append(h('option', { value: c.name }, c.name)));
      coll.value = cs.value === s.charset ? s.collation : meta.charsets.find((c) => c.name === cs.value)?.default_collation;
    };
    cs.addEventListener('change', fill);
    fill();
    const ok = await modal({ title: 'Alter Schema ' + s.name, content: h('div', { class: 'form' }, field('Character Set:', cs), field('Collation:', coll)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }], closeValue: false });
    if (!ok) return;
    const sql = `ALTER SCHEMA ${this.quoteIdent(s.name)} DEFAULT CHARACTER SET ${cs.value} DEFAULT COLLATE ${coll.value};`;
    if (await reviewAndApply(this, [sql], { title: 'Alter Schema' })) this.navigator.refresh();
  }

  loadMeta() {
    if (!this.metaPromise) this.metaPromise = api.get(`/sessions/${this.sid}/meta`).catch((e) => { this.metaPromise = null; throw e; });
    return this.metaPromise;
  }

  inspectSelected() {
    const n = this.navigator.infoNode;
    if (!n) { toast('Select a schema or table in the navigator first.', 'info'); return; }
    if (n.kind === 'table') this.openInspector(n.data.schema, n.data.name);
    else if (n.kind === 'schema') this.openSchemaInspector(n.data.name);
    else if (n.data?.schema && n.data?.table) this.openInspector(n.data.schema, n.data.table);
    else if (n.data?.schema) this.openSchemaInspector(n.data.schema);
  }

  // ------------------------------------------------------------------ editors & admin (lazy-loaded modules)
  // ODBC connections only get the generic tools; engine-specific editors and dumps are off.
  supports(feature) {
    if (this.features[feature] === false) { toast('That isn\'t available for this kind of connection.', 'info'); return false; }
    return true;
  }

  async openTableEditor(schema, table) {
    if (!this.supports('table_editor')) return;
    if (!schema) { toast('Select a schema first (double-click a schema to make it the default).', 'warning'); return; }
    const existing = table && this.findDoc((d) => d.kind === 'table-editor' && d.schema === schema && d.objectName === table);
    if (existing) { this.docs.select(existing.tab); return; }
    const { TableEditor } = await import('./tableeditor.js');
    const doc = new TableEditor(this, schema, table);
    this.addDoc(doc);
    doc.load();
  }

  async openObjectEditor(kind, schema, name, opts = {}) {
    if (!this.supports('object_editor')) return;
    if (!schema) { toast('Select a schema first.', 'warning'); return; }
    const existing = name && this.findDoc((d) => d.kind === 'object-editor' && d.objKind === kind && d.schema === schema && d.objectName === name);
    if (existing) { this.docs.select(existing.tab); return; }
    const { ObjectEditor } = await import('./objecteditor.js');
    const doc = new ObjectEditor(this, kind, schema, name, opts);
    this.addDoc(doc);
    doc.load();
  }

  async openInspector(schema, table) {
    const existing = this.findDoc((d) => d.kind === 'inspector' && d.schema === schema && d.objectName === table);
    if (existing) { this.docs.select(existing.tab); existing.load(); return; }
    const { TableInspector } = await import('./inspector.js');
    const doc = new TableInspector(this, schema, table);
    this.addDoc(doc);
    doc.load();
  }

  async openSchemaInspector(schema) {
    if (!schema) { toast('Select a schema first.', 'warning'); return; }
    const existing = this.findDoc((d) => d.kind === 'schema-inspector' && d.schema === schema);
    if (existing) { this.docs.select(existing.tab); existing.load(); return; }
    const { SchemaInspector } = await import('./inspector.js');
    const doc = new SchemaInspector(this, schema);
    this.addDoc(doc);
    doc.load();
  }

  async openAdmin(kind, opts = {}) {
    if ((kind === 'export' || kind === 'import') && !this.supports('export')) return;
    const existing = this.findDoc((d) => d.kind === 'admin-' + kind);
    if (existing) { this.docs.select(existing.tab); existing.setOptions?.(opts); return; }
    const mod = await import('./admin.js');
    const doc = mod.createAdminDoc(this, kind, opts);
    this.addDoc(doc);
    doc.load?.();
  }

  async openImportWizard(opts = {}) {
    if (!this.supports('import_wizard')) return;
    const { openImportWizard } = await import('./importwizard.js');
    openImportWizard(this, opts);
  }

  async openSchemaCompare(opts = {}) {
    if (this.driver !== 'mysql') { toast('Schema compare is available for MySQL and MariaDB connections.', 'info'); return; }
    const { SchemaCompareDoc } = await import('./schemacompare.js');
    const doc = new SchemaCompareDoc(this, opts);
    this.addDoc(doc);
    doc.load();
  }

  async openErd(schema) {
    if (!schema) { this.openErdPicker(); return; }
    const existing = this.findDoc((d) => d.kind === 'erd' && d.schema === schema);
    if (existing) { this.docs.select(existing.tab); return; }
    const { ErdDoc } = await import('./erd.js');
    const doc = new ErdDoc(this, schema);
    this.addDoc(doc);
    doc.load();
  }

  async openErdPicker() {
    const schemas = this.navigator.schemas.filter((s) => !s.system).map((s) => s.name);
    if (!schemas.length) { toast('No schemas available.', 'warning'); return; }
    const sel = select(schemas, this.currentSchema && schemas.includes(this.currentSchema) ? this.currentSchema : schemas[0]);
    const ok = await modal({ title: 'Reverse Engineer Schema', content: h('div', { class: 'form' }, field('Schema to diagram:', sel)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Create Diagram', value: true, primary: true }], closeValue: false });
    if (ok) this.openErd(sel.value);
  }
}

export { checkbox };
