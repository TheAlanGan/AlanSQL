// Application shell: menu bar, Home + connection tabs, global shortcuts, preferences.
import { api, clientId, startHeartbeat, state } from './api.js';
import { setupCompletion } from './completion.js';
import { openRecent, listRecent } from './files.js';
import { HomePage, passwordPrompt, handleSshError } from './home.js';
import { SnippetStore } from './snippets.js';
import { LIMITS } from './querytab.js';
import { Workspace } from './workspace.js';
import {
  TabStrip, alertDialog, checkbox, closeMenus, confirmDialog, dropdownMenu, field, h, icon, isModalOpen, modal, select, setMenuFilter, toast,
} from './ui.js';

// Menu entries that generate MySQL/SQLite-specific SQL, hidden while an ODBC connection is active.
const NOT_FOR_ODBC = /^(Create Table|Alter Table|Create View|Alter View|Table Maintenance|Rename Table|Table Data Import Wizard|Data Export|Data Import|Create Stored Procedure|Create Function|Create Trigger|Explain)/;

class App {
  constructor() {
    this.workspaces = [];
    this.prefs = { limit: 1000, fontSize: 13, theme: 'light', safeUpdates: false };
    this.snippets = new SnippetStore();
    setMenuFilter((items) => (this.activeWorkspace()?.driver === 'odbc'
      ? items.filter((it) => !(it && typeof it === 'object' && NOT_FOR_ODBC.test(it.label || ''))) : items));
  }

  async start() {
    const root = document.getElementById('app');
    root.innerHTML = '';
    if (!api.hasToken()) {
      root.append(h('div', { class: 'fatal' }, h('h2', null, 'DBCentral'), h('p', null, 'This window is missing its session token. Start DBCentral with the launcher (DBCentral.bat or "python launch.py").')));
      return;
    }
    this.prefs = { ...this.prefs, ...(await state.get('prefs', {})) };
    this.applyTheme();
    setupCompletion();
    startHeartbeat();
    this.menubar = h('div', { class: 'menubar' });
    this.tabbarHost = h('div', { class: 'app-tabbar' });
    this.pages = h('div', { class: 'pages' });
    root.append(this.menubar, this.tabbarHost, this.pages);
    this.buildMenus();
    this.tabs = new TabStrip(this.tabbarHost, {
      className: 'conn-tabs',
      onSelect: (t) => this.showPage(t),
      onClose: (t) => this.closeWorkspace(t.ws),
    });
    this.home = new HomePage(this);
    this.pages.append(this.home.el);
    this.homeTab = this.tabs.add({ title: 'Home', icon: 'home', closable: false, page: this.home.el });
    this.homeTab.tabEl.classList.add('home-tab');
    await this.home.refresh();
    this.installShortcuts();
    window.addEventListener('beforeunload', (e) => {
      state.flush();
      for (const ws of this.workspaces) ws.saveTabs();
      if (this.workspaces.length) { e.preventDefault(); e.returnValue = ''; }
    });
    this.updateTitle();
  }

  // ------------------------------------------------------------------ pages / tabs
  showPage(tab) {
    if (!tab) return;
    for (const el of this.pages.children) el.classList.toggle('hidden', el !== tab.page);
    this.activeWs = tab.ws || null;
    if (tab.ws) tab.ws.activeDoc()?.onShow?.();
    else this.home.renderTiles();
    this.updateTitle();
  }

  updateTitle() {
    const ws = this.activeWs;
    document.title = ws ? `${ws.profile.name}${ws.currentSchema && ws.driver === 'mysql' ? ' - ' + ws.currentSchema : ''} - DBCentral` : 'DBCentral';
  }

  async openSessionFor(profile, { message } = {}) {
    const body = { connection_id: profile.id, client_id: clientId };
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await api.post('/sessions', body);
      } catch (e) {
        if (e.status === 401 && e.data?.need_password) {
          const r = await passwordPrompt(profile, message, e.data.need || ['password']);
          if (!r) return null;
          Object.assign(body, r);
          message = null;
          continue;
        }
        if (profile.driver === 'mysql' && /\b1045\b|Access denied/i.test(e.message) && body.password !== undefined) {
          const r = await passwordPrompt(profile, e.message);
          if (!r) return null;
          Object.assign(body, r);
          continue;
        }
        const again = await handleSshError(e, profile, body);
        if (again === null) return null;
        if (again) continue;
        throw e;
      }
    }
    return null;
  }

  async connect(profile) {
    const open = this.workspaces.find((w) => w.profile.id === profile.id);
    if (open) {
      const again = await modal({
        title: 'Connection Already Open', content: h('div', { class: 'msg-text' }, `"${profile.name}" is already open. Switch to it or open another connection tab?`),
        buttons: [{ label: 'Cancel', value: null }, { label: 'Open Another', value: 'new' }, { label: 'Switch', value: 'switch', primary: true }], closeValue: null,
      });
      if (again === 'switch') { this.tabs.select(open.appTab); return open; }
      if (again !== 'new') return null;
    }
    const busy = toastBusy(`Connecting to ${profile.name}...`);
    let session;
    try {
      session = await this.openSessionFor(profile);
    } catch (e) {
      busy.remove();
      await alertDialog('Cannot Connect to Database Server', h('div', null, h('p', null, `Your connection attempt failed for "${profile.name}".`), h('pre', { class: 'error-pre' }, e.message),
        h('p', { class: 'muted small' }, profile.driver === 'mysql' ? 'Check that the server is running, the host/port are correct and the user has access.'
          : profile.driver === 'odbc' ? 'Check the data source or connection string, that the ODBC driver is installed (64-bit), and the login details.'
            : 'Check the database file path.')), 'error');
      return null;
    }
    busy.remove();
    if (!session) return null;
    const ws = new Workspace(this, session.profile || profile, session);
    this.workspaces.push(ws);
    this.pages.append(ws.el);
    ws.appTab = this.tabs.add({ title: ws.title, icon: profile.driver === 'sqlite' ? 'sqlite' : profile.driver === 'odbc' ? 'plug' : 'dbColor', ws, page: ws.el, tooltip: `${profile.name} - ${session.info.server_version}` });
    if (profile.color) ws.appTab.tabEl.style.borderTopColor = profile.color;
    await ws.init();
    this.home.refresh();
    return ws;
  }

  async closeWorkspace(ws) {
    if (!(await ws.close())) return;
    this.workspaces = this.workspaces.filter((w) => w !== ws);
    ws.el.remove();
    this.tabs.remove(ws.appTab);
    this.home.renderTiles();
  }

  activeWorkspace() { return this.activeWs || null; }

  async openRecentFile(path) {
    const ws = this.activeWorkspace() || this.workspaces[0];
    if (!ws) { toast('Open a connection first, then open the script.', 'info'); return; }
    try {
      const f = await openRecent(path);
      this.tabs.select(ws.appTab);
      ws.openFileContent(f);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ------------------------------------------------------------------ menus
  buildMenus() {
    const menus = [
      ['File', () => this.fileMenu()],
      ['Edit', () => this.editMenu()],
      ['View', () => this.viewMenu()],
      ['Query', () => this.queryMenu()],
      ['Database', () => this.databaseMenu()],
      ['Server', () => this.serverMenu()],
      ['Tools', () => this.toolsMenu()],
      ['Help', () => this.helpMenu()],
    ];
    for (const [label, items] of menus) {
      const el = h('div', { class: 'menubar-item' }, label);
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (el.classList.contains('open')) { closeMenus(); return; }
        closeMenus();
        el.classList.add('open');
        dropdownMenu(el, items());
      });
      el.addEventListener('mouseenter', () => {
        if (document.querySelector('.menubar-item.open') && !el.classList.contains('open')) {
          closeMenus();
          el.classList.add('open');
          dropdownMenu(el, items());
        }
      });
      this.menubar.append(el);
    }
    this.menubar.append(h('span', { class: 'flex1' }), h('span', { class: 'menubar-brand' }, icon('dbColor'), ' DBCentral'));
  }

  wsRequired(fn) {
    return () => {
      const ws = this.activeWorkspace();
      if (!ws) { toast('Open a database connection first.', 'info'); return; }
      fn(ws);
    };
  }

  qtRequired(fn) {
    return this.wsRequired((ws) => fn(ws.activeQueryTab(), ws));
  }

  fileMenu() {
    const ws = this.activeWorkspace();
    return [
      { label: 'New Model / Connection...', icon: 'plus', action: () => this.home.editConnection(null, 'mysql') },
      { label: 'Open SQLite Database...', icon: 'sqlite', action: () => this.home.editConnection(null, 'sqlite') },
      '-',
      { label: 'New Query Tab', icon: 'newSql', shortcut: 'Ctrl+Alt+T', disabled: !ws, action: this.wsRequired((w) => w.openQueryTab()) },
      { label: 'Open SQL Script...', icon: 'open', shortcut: 'Ctrl+O', disabled: !ws, action: this.wsRequired((w) => w.openScript()) },
      { label: 'Open Recent', disabled: !ws, submenu: () => this.recentSubmenu || [{ label: '(no recent scripts)', disabled: true }] },
      { label: 'Save Script', icon: 'save', shortcut: 'Ctrl+S', disabled: !ws, action: this.qtRequired((t) => t.save()) },
      { label: 'Save Script As...', shortcut: 'Ctrl+Shift+S', disabled: !ws, action: this.qtRequired((t) => t.save(true)) },
      '-',
      { label: 'Close Tab', disabled: !ws?.activeDoc(), action: this.wsRequired((w) => w.activeDoc() && w.closeDoc(w.activeDoc())) },
      { label: 'Close Connection', disabled: !ws, action: this.wsRequired((w) => this.closeWorkspace(w)) },
      '-',
      { label: 'Exit', action: () => this.exit() },
    ];
  }

  editMenu() {
    const run = (id) => this.qtRequired((t) => { t.editor.focus(); t.editor.trigger('menu', id, null); });
    const ws = this.activeWorkspace();
    return [
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !ws, action: run('undo') },
      { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !ws, action: run('redo') },
      '-',
      { label: 'Cut', shortcut: 'Ctrl+X', action: () => document.execCommand('cut') },
      { label: 'Copy', shortcut: 'Ctrl+C', action: () => document.execCommand('copy') },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !ws, action: run('editor.action.clipboardPasteAction') },
      { label: 'Select All', shortcut: 'Ctrl+A', disabled: !ws, action: run('editor.action.selectAll') },
      '-',
      { label: 'Find...', icon: 'search', shortcut: 'Ctrl+F', disabled: !ws, action: run('actions.find') },
      { label: 'Find and Replace...', shortcut: 'Ctrl+H', disabled: !ws, action: run('editor.action.startFindReplaceAction') },
      { label: 'Go to Line...', shortcut: 'Ctrl+G', disabled: !ws, action: run('editor.action.gotoLine') },
      '-',
      { label: 'Format', submenu: [
        { label: 'Beautify Query', icon: 'beautify', shortcut: 'Ctrl+B', action: this.qtRequired((t) => t.beautify()) },
        { label: 'UPCASE Selection', shortcut: 'Ctrl+Shift+U', action: this.qtRequired((t) => t.changeCase(true)) },
        { label: 'lowercase Selection', shortcut: 'Ctrl+Shift+L', action: this.qtRequired((t) => t.changeCase(false)) },
        { label: 'Toggle Comment', shortcut: 'Ctrl+/', action: run('editor.action.commentLine') },
        { label: 'Indent Lines', shortcut: 'Tab', action: run('editor.action.indentLines') },
        { label: 'Unindent Lines', shortcut: 'Shift+Tab', action: run('editor.action.outdentLines') },
      ] },
      { label: 'Trigger Autocomplete', shortcut: 'Ctrl+Space', disabled: !ws, action: run('editor.action.triggerSuggest') },
      '-',
      { label: 'Preferences...', icon: 'gear', action: () => this.preferences() },
    ];
  }

  viewMenu() {
    const ws = this.activeWorkspace();
    return [
      { label: 'Home', icon: 'home', action: () => this.tabs.select(this.homeTab) },
      '-',
      { label: 'Navigator Panel', checked: !!ws?.panels.left, disabled: !ws, action: this.wsRequired((w) => w.togglePanel('left')) },
      { label: 'Output Panel', checked: !!ws?.panels.bottom, disabled: !ws, action: this.wsRequired((w) => w.togglePanel('bottom')) },
      { label: 'Snippets Panel', checked: !!ws?.panels.right, disabled: !ws, action: this.wsRequired((w) => w.togglePanel('right')) },
      { label: 'Output: Action Output', disabled: !ws, action: this.wsRequired((w) => { w.output.modeSel.value = 'action'; w.output.setMode('action'); }) },
      { label: 'Output: History Output', icon: 'history', disabled: !ws, action: this.wsRequired((w) => { w.output.modeSel.value = 'history'; w.output.setMode('history'); }) },
      '-',
      { label: 'Dark Theme', checked: this.prefs.theme === 'dark', action: () => { this.prefs.theme = this.prefs.theme === 'dark' ? 'light' : 'dark'; this.applyTheme(); this.savePrefs(); } },
      { label: 'Increase Editor Font', shortcut: 'Ctrl+=', action: () => this.setFontSize(this.prefs.fontSize + 1) },
      { label: 'Decrease Editor Font', shortcut: 'Ctrl+-', action: () => this.setFontSize(this.prefs.fontSize - 1) },
    ];
  }

  queryMenu() {
    const ws = this.activeWorkspace();
    const d = !ws;
    return [
      { label: 'Execute (All or Selection)', icon: 'bolt', shortcut: 'Ctrl+Shift+Enter', disabled: d, action: this.qtRequired((t) => t.run('all')) },
      { label: 'Execute Current Statement', icon: 'boltCursor', shortcut: 'Ctrl+Enter', disabled: d, action: this.qtRequired((t) => t.run('current')) },
      { label: 'Explain Current Statement', icon: 'explain', shortcut: 'Ctrl+Alt+X', disabled: d, action: this.qtRequired((t) => t.explain()) },
      { label: 'Stop', icon: 'stop', disabled: d, action: this.qtRequired((t) => t.stop()) },
      '-',
      { label: 'Continue on SQL Error', checked: !!ws?.continueOnError, disabled: d, action: this.wsRequired((w) => w.toggleContinueOnError()) },
      { label: 'Limit Rows', disabled: d, submenu: () => LIMITS.map(([v, l]) => ({ label: l, checked: ws.settings.limit === v, action: () => ws.setLimit(v) })) },
      '-',
      { label: 'Auto-Commit Transactions', checked: !!ws?.autocommit, disabled: d, action: this.wsRequired((w) => w.setAutocommit(!w.autocommit)) },
      { label: 'Commit Transaction', icon: 'commit', disabled: d, action: this.wsRequired((w) => w.commit()) },
      { label: 'Rollback Transaction', icon: 'rollback', disabled: d, action: this.wsRequired((w) => w.rollback()) },
      '-',
      { label: 'New Tab', icon: 'newSql', shortcut: 'Ctrl+Alt+T', disabled: d, action: this.wsRequired((w) => w.openQueryTab()) },
      { label: 'Reconnect to Server', icon: 'reconnect', disabled: d, action: this.wsRequired((w) => w.reconnect()) },
    ];
  }

  databaseMenu() {
    const ws = this.activeWorkspace();
    const d = !ws;
    return [
      { label: 'Connect to Database...', icon: 'plug', action: () => this.connectPicker() },
      { label: 'Manage Connections...', action: () => this.tabs.select(this.homeTab) },
      '-',
      { label: 'Reverse Engineer (ER Diagram)...', icon: 'diagram', disabled: d, action: this.wsRequired((w) => w.openErdPicker()) },
      { label: 'Schema Inspector', icon: 'infoOutline', disabled: d, action: this.wsRequired((w) => w.openSchemaInspector(w.activeSchema())) },
      { label: 'Procedures & Functions', icon: 'procedure', disabled: d || !ws.features.routines, action: this.wsRequired((w) => w.openRoutines(w.activeSchema())) },
      { label: 'Compare / Synchronize Schemas...', icon: 'compare', disabled: d || ws.driver !== 'mysql', action: this.wsRequired((w) => w.openSchemaCompare()) },
      '-',
      { label: 'Create Schema...', icon: 'schemaAdd', disabled: d || !ws.features.create_schema, action: this.wsRequired((w) => w.createSchemaDialog()) },
      { label: 'Create Table...', icon: 'tableAdd', disabled: d, action: this.wsRequired((w) => w.openTableEditor(w.activeSchema(), null)) },
      { label: 'Create View...', icon: 'viewAdd', disabled: d, action: this.wsRequired((w) => w.openObjectEditor('view', w.activeSchema(), null)) },
      { label: 'Create Stored Procedure...', icon: 'procAdd', disabled: d || !ws.features.routines, action: this.wsRequired((w) => w.openObjectEditor('procedure', w.activeSchema(), null)) },
      { label: 'Create Function...', icon: 'funcAdd', disabled: d || !ws.features.routines, action: this.wsRequired((w) => w.openObjectEditor('function', w.activeSchema(), null)) },
      { label: 'Create Trigger...', icon: 'trigger', disabled: d, action: this.wsRequired((w) => w.openObjectEditor('trigger', w.activeSchema(), null)) },
      '-',
      { label: 'Refresh Navigator', icon: 'refresh', shortcut: 'F5', disabled: d, action: this.wsRequired((w) => w.navigator.refresh()) },
    ];
  }

  serverMenu() {
    const ws = this.activeWorkspace();
    const notMysql = !ws || ws.driver !== 'mysql';
    return [
      { label: 'Server Status', icon: 'server', disabled: notMysql, action: this.wsRequired((w) => w.openAdmin('status')) },
      { label: 'Client Connections', icon: 'plug', disabled: notMysql, action: this.wsRequired((w) => w.openAdmin('connections')) },
      { label: 'Users and Privileges', icon: 'users', disabled: notMysql, action: this.wsRequired((w) => w.openAdmin('users')) },
      { label: 'Status and System Variables', icon: 'variables', disabled: notMysql, action: this.wsRequired((w) => w.openAdmin('variables')) },
      '-',
      { label: 'Data Export', icon: 'dumpOut', disabled: !ws, action: this.wsRequired((w) => w.openAdmin('export')) },
      { label: 'Data Import', icon: 'dumpIn', disabled: !ws, action: this.wsRequired((w) => w.openAdmin('import')) },
      { label: 'Table Data Import Wizard...', icon: 'import', disabled: !ws, action: this.wsRequired((w) => w.openImportWizard({ schema: w.currentSchema })) },
      '-',
      { label: 'Performance Dashboard', icon: 'gauge', disabled: notMysql, action: this.wsRequired((w) => w.openAdmin('status')) },
      { label: 'Performance Reports', icon: 'plan', disabled: notMysql, action: this.wsRequired((w) => w.openAdmin('perf')) },
    ];
  }

  toolsMenu() {
    return [
      { label: 'SQL Snippets Panel', icon: 'snippet', disabled: !this.activeWorkspace(), action: this.wsRequired((w) => { if (!w.panels.right) w.togglePanel('right'); }) },
      { label: 'Query History', icon: 'history', disabled: !this.activeWorkspace(), action: this.wsRequired((w) => { if (!w.panels.bottom) w.togglePanel('bottom'); w.output.modeSel.value = 'history'; w.output.setMode('history'); }) },
      '-',
      { label: 'Preferences...', icon: 'gear', action: () => this.preferences() },
    ];
  }

  helpMenu() {
    return [
      { label: 'Keyboard Shortcuts', action: () => this.shortcutsHelp() },
      { label: 'About DBCentral', icon: 'info', action: () => this.about() },
    ];
  }

  async refreshRecentSubmenu() {
    const recent = await listRecent();
    this.recentSubmenu = recent.length ? recent.slice(0, 12).map((p) => ({ label: p, action: () => this.openRecentFile(p) })) : [{ label: '(no recent scripts)', disabled: true }];
  }

  async connectPicker() {
    const r = await api.get('/connections');
    if (!r.connections.length) { this.home.editConnection(null, 'mysql'); return; }
    const where = (c) => (c.driver === 'mysql' ? `${c.user}@${c.host}:${c.port}` : c.driver === 'odbc' ? `ODBC ${c.odbc_mode === 'string' ? 'connection string' : c.odbc_dsn || ''}` : c.file);
    const sel = select(r.connections.map((c) => [c.id, `${c.name}  (${where(c)})`]), r.connections[0].id);
    const ok = await modal({ title: 'Connect to Database', content: h('div', { class: 'form' }, field('Stored Connection:', sel)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }], closeValue: false });
    if (ok) this.connect(r.connections.find((c) => c.id === sel.value));
  }

  // ------------------------------------------------------------------ shortcuts
  installShortcuts() {
    this.refreshRecentSubmenu();
    setInterval(() => this.refreshRecentSubmenu(), 15000);
    document.addEventListener('keydown', (e) => {
      if (isModalOpen()) return;
      const ws = this.activeWorkspace();
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === 'F5' || (ctrl && k === 'r' && !e.shiftKey)) {
        e.preventDefault();
        ws?.navigator.refresh();
      } else if (ctrl && e.altKey && k === 't') {
        e.preventDefault();
        ws?.openQueryTab();
      } else if (ctrl && k === 'o' && !e.shiftKey) {
        e.preventDefault();
        ws?.openScript();
      } else if (ctrl && k === 's') {
        e.preventDefault();
        const doc = ws?.activeDoc();
        if (doc?.kind === 'query') doc.save(e.shiftKey);
        else doc?.apply?.();
      } else if (ctrl && (k === '=' || k === '+')) {
        e.preventDefault(); this.setFontSize(this.prefs.fontSize + 1);
      } else if (ctrl && k === '-') {
        e.preventDefault(); this.setFontSize(this.prefs.fontSize - 1);
      } else if (ctrl && k === 'p') {
        e.preventDefault();
      }
    });
  }

  // ------------------------------------------------------------------ prefs / theme
  savePrefs() { state.set('prefs', this.prefs); }

  applyTheme() {
    const dark = this.prefs.theme === 'dark';
    document.body.classList.toggle('dark', dark);
    window.monaco?.editor.setTheme(dark ? 'vs-dark' : 'vs');
  }

  setFontSize(n) {
    this.prefs.fontSize = Math.max(9, Math.min(28, n));
    this.savePrefs();
    for (const w of this.workspaces) for (const d of w.docList) d.editor?.updateOptions({ fontSize: this.prefs.fontSize });
  }

  async preferences() {
    const limit = select(LIMITS, this.prefs.limit);
    const font = h('input', { class: 'input port', type: 'number', min: 9, max: 28, value: this.prefs.fontSize });
    const theme = select([['light', 'Light'], ['dark', 'Dark']], this.prefs.theme);
    const safe = checkbox('"Safe Updates": reject UPDATE/DELETE statements without a key in the WHERE clause (MySQL, applies to new connections)', this.prefs.safeUpdates);
    const content = h('div', { class: 'form' }, field('Default row limit for SELECT queries:', limit), field('SQL editor font size:', font), field('Theme:', theme), safe);
    const ok = await modal({ title: 'Preferences', width: 520, content, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }], closeValue: false });
    if (!ok) return;
    this.prefs.limit = Number(limit.value);
    this.prefs.theme = theme.value;
    this.prefs.safeUpdates = safe.querySelector('input').checked;
    this.setFontSize(Number(font.value) || 13);
    for (const w of this.workspaces) w.setLimit(this.prefs.limit);
    this.applyTheme();
    this.savePrefs();
  }

  shortcutsHelp() {
    const rows = [
      ['Ctrl+Enter', 'Execute the statement under the cursor'], ['Ctrl+Shift+Enter', 'Execute all statements (or the selection)'],
      ['Ctrl+Alt+X', 'Explain the current statement'], ['Ctrl+Space', 'Autocomplete'], ['Ctrl+B', 'Beautify SQL'],
      ['Ctrl+/', 'Toggle comment'], ['Ctrl+F / Ctrl+H', 'Find / replace'], ['Ctrl+S / Ctrl+Shift+S', 'Save script / save as'],
      ['Ctrl+O', 'Open SQL script'], ['Ctrl+Alt+T', 'New query tab'], ['F5', 'Refresh navigator'],
      ['Ctrl+Shift+U / L', 'Upper / lower case selection'], ['Ctrl+= / Ctrl+-', 'Editor font size'],
      ['Result grid: Enter / F2', 'Edit cell'], ['Result grid: Delete', 'Delete selected rows'], ['Result grid: Ctrl+C', 'Copy cell / selected rows'],
    ];
    alertDialog('Keyboard Shortcuts', h('table', { class: 'kv-table' }, ...rows.map(([k, v]) => h('tr', null, h('th', null, h('kbd', null, k)), h('td', null, v)))));
  }

  about() {
    alertDialog('About DBCentral', h('div', null, h('p', null, h('b', null, 'DBCentral 1.0'), ' - a personal, Workbench-style SQL client.'),
      h('p', { class: 'muted' }, 'Supports MySQL, MariaDB and SQLite. Built with Python (Flask, PyMySQL), the Monaco editor and sql-formatter.'),
      h('p', { class: 'muted small' }, 'Settings, connections and history are stored in %APPDATA%\\DBCentral. Passwords are kept in the Windows Credential Manager.')));
  }

  async exit() {
    for (const ws of [...this.workspaces]) {
      if (!(await ws.close())) return;
      this.workspaces = this.workspaces.filter((w) => w !== ws);
    }
    state.flush();
    window.close();
    setTimeout(() => toast('You can now close this window.', 'info'), 300);
  }
}

function toastBusy(text) {
  let host = document.getElementById('toast-host');
  if (!host) { host = h('div', { id: 'toast-host' }); document.body.append(host); }
  const t = h('div', { class: 'toast toast-info' }, icon('spinner'), h('span', null, text));
  host.append(t);
  return t;
}

window.monacoReady.then(() => {
  const app = new App();
  window.dbcentral = app;
  app.start().catch((e) => {
    console.error(e);
    document.getElementById('app').append(h('pre', { class: 'error-pre' }, 'Startup failed: ' + (e.stack || e.message)));
  });
});

export { confirmDialog };
