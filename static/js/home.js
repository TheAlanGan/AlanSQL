// Home screen: connection tiles + the "Setup New Connection" dialog.
import { api } from './api.js';
import { pickOpenFile, pickSaveFile } from './files.js';
import { checkbox, confirmDialog, contextMenu, esc, field, h, icon, modal, promptDialog, select, toast } from './ui.js';

// Connection-string starters for common ODBC drivers (DRIVER={...}; is added in front).
function odbcTemplate(driver) {
  const d = driver.toLowerCase();
  if (d.includes('access') && d.includes('text')) return 'DBQ=C:\\path\\to\\folder;';
  if (d.includes('access') || d.includes('dbase')) return 'DBQ=C:\\path\\to\\database.accdb;';
  if (d.includes('excel')) return 'DBQ=C:\\path\\to\\workbook.xlsx;';
  if (d.includes('sql server')) return 'SERVER=localhost;DATABASE=master;Trusted_Connection=yes;';
  if (d.includes('postgres')) return 'SERVER=localhost;PORT=5432;DATABASE=postgres;';
  if (d.includes('mysql') || d.includes('mariadb')) return 'SERVER=localhost;PORT=3306;DATABASE=test;';
  if (d.includes('oracle')) return 'DBQ=localhost:1521/XEPDB1;';
  return '';
}

function odbcDriverName(connstr) {
  const m = /DRIVER\s*=\s*\{([^}]*)\}/i.exec(connstr || '');
  return m ? m[1] : '';
}

const COLORS = ['', '#4a7bbf', '#3d8b5a', '#b9771e', '#a94442', '#7b5ea7', '#2a8a8a', '#666'];
let knownGroups = [];
const COLLAPSED_KEY = 'home-collapsed-groups';

function collapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { return new Set(); }
}

export class HomePage {
  constructor(app) {
    this.app = app;
    this.el = h('div', { class: 'home' });
    this.filter = '';
  }

  async refresh() {
    try {
      const r = await api.get('/connections');
      this.connections = r.connections;
      knownGroups = [...new Set(this.connections.map((c) => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      this.connections = [];
      toast(e.message, 'error');
    }
    this.render();
  }

  render() {
    const el = this.el;
    el.innerHTML = '';
    const filterInput = h('input', { class: 'input home-filter', placeholder: 'Filter connections', value: this.filter, spellcheck: false });
    filterInput.addEventListener('input', () => { this.filter = filterInput.value; this.renderTiles(); });
    this.tilesMysql = h('div', { class: 'tiles' });
    this.tilesSqlite = h('div', { class: 'tiles' });
    this.tilesOdbc = h('div', { class: 'tiles' });
    el.append(
      h('div', { class: 'home-hero' },
        h('div', { class: 'home-logo' }, icon('dbColor', 'huge')),
        h('div', null, h('h1', null, 'Welcome to DBCentral'),
          h('p', { class: 'muted' }, 'A personal SQL development and administration tool for MySQL, MariaDB and SQLite, plus other databases through ODBC. ',
            'Design tables, write and run queries, browse and edit data, manage users and export or import databases.'))),
      h('div', { class: 'home-section-head' },
        h('h2', null, 'MySQL Connections'),
        h('button', { class: 'round-btn', title: 'Add a new MySQL/MariaDB connection', onclick: () => this.editConnection(null, 'mysql') }, icon('plus')),
        h('span', { class: 'flex1' }), filterInput),
      this.tilesMysql,
      h('div', { class: 'home-section-head' },
        h('h2', null, 'SQLite Databases'),
        h('button', { class: 'round-btn', title: 'Add a SQLite database file', onclick: () => this.editConnection(null, 'sqlite') }, icon('plus'))),
      this.tilesSqlite,
      h('div', { class: 'home-section-head' },
        h('h2', null, 'Other Databases (ODBC)'),
        h('button', { class: 'round-btn', title: 'Add a connection through an ODBC driver (SQL Server, Access, PostgreSQL, Oracle, ...)', onclick: () => this.editConnection(null, 'odbc') }, icon('plus'))),
      this.tilesOdbc,
      this.recentHost = h('div', { class: 'home-recent' }));
    this.renderTiles();
    this.renderRecent();
  }

  async renderRecent() {
    const { listRecent } = await import('./files.js');
    const recent = await listRecent();
    this.recentHost.innerHTML = '';
    if (!recent.length) return;
    this.recentHost.append(h('div', { class: 'home-section-head' }, h('h2', null, 'Recent SQL Scripts')));
    const list = h('div', { class: 'recent-list' });
    for (const p of recent.slice(0, 8)) {
      list.append(h('div', { class: 'recent-item', title: 'Open in the active connection', onclick: () => this.app.openRecentFile(p) }, icon('snippet'), h('span', null, p)));
    }
    this.recentHost.append(list);
  }

  renderTiles() {
    if (!this.tilesMysql) return;
    const f = this.filter.trim().toLowerCase();
    const match = (c) => !f || [c.name, c.host, c.user, c.file, c.group, c.odbc_dsn, c.odbc_connstr].some((x) => (x || '').toLowerCase().includes(f));
    const collapsed = collapsedGroups();
    for (const [host, driver] of [[this.tilesMysql, 'mysql'], [this.tilesSqlite, 'sqlite'], [this.tilesOdbc, 'odbc']]) {
      host.innerHTML = '';
      host.classList.add('tile-section');
      const list = (this.connections || []).filter((c) => c.driver === driver && match(c));
      const loose = list.filter((c) => !c.group);
      const groups = [...new Set(list.map((c) => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const looseTiles = h('div', { class: 'tiles' }, ...loose.map((c) => this.tile(c)));
      if (!list.length) {
        looseTiles.append(h('div', { class: 'tile tile-add', onclick: () => this.editConnection(null, driver) },
          icon('plusCircle', 'big'), h('div', null, f ? 'No matching connections' : driver === 'mysql' ? 'Add a MySQL / MariaDB connection' : driver === 'odbc' ? 'Connect to another database through ODBC' : 'Open or create a SQLite database')));
      }
      if (groups.length && loose.length) this.dropTarget(looseTiles, '');
      host.append(looseTiles);
      for (const g of groups) {
        const members = list.filter((c) => c.group === g);
        const open = f || !collapsed.has(driver + ':' + g);
        const head = h('div', { class: 'group-head' + (open ? '' : ' closed'), title: 'Click to collapse or expand. Drag connections here to move them into this group.' },
          icon(open ? 'caretDown' : 'caretRight'), icon('folder'), h('span', { class: 'group-name' }, g), h('span', { class: 'muted' }, `${members.length}`),
          h('button', { class: 'round-btn small', title: `Add a connection to ${g}`, onclick: (e) => { e.stopPropagation(); this.editConnection(null, driver, g); } }, icon('plus')));
        head.addEventListener('click', () => this.toggleGroup(driver + ':' + g));
        head.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: `New Connection in "${g}"...`, icon: 'plus', action: () => this.editConnection(null, driver, g) },
          { label: 'Rename Group...', icon: 'edit', action: () => this.renameGroup(g) },
          { label: 'Ungroup (keep connections)', action: () => this.renameGroup(g, '') },
          '-',
          { label: 'Expand All Groups', action: () => { localStorage.setItem(COLLAPSED_KEY, '[]'); this.renderTiles(); } },
          { label: 'Collapse All Groups', action: () => { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(knownGroups.flatMap((x) => ['mysql:' + x, 'sqlite:' + x]))); this.renderTiles(); } },
        ]));
        this.dropTarget(head, g);
        host.append(head);
        if (open) host.append(h('div', { class: 'tiles group-tiles' }, ...members.map((c) => this.tile(c))));
      }
    }
  }

  toggleGroup(key) {
    const set = collapsedGroups();
    if (set.has(key)) set.delete(key); else set.add(key);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
    this.renderTiles();
  }

  dropTarget(el, group) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-dbcentral-conn')) { e.preventDefault(); el.classList.add('drop-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-over');
      const id = e.dataTransfer.getData('application/x-dbcentral-conn');
      if (!id) return;
      e.preventDefault();
      const c = this.connections.find((x) => x.id === id);
      if (c && (c.group || '') !== group) this.setGroup(c, group);
    });
  }

  async setGroup(c, group) {
    try {
      await api.post('/connections/set-group', { ids: [c.id], group });
      if (group) { const set = collapsedGroups(); set.delete(c.driver + ':' + group); localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); }
      toast(group ? `Moved "${c.name}" to ${group}` : `Removed "${c.name}" from its group`, 'success', 1500);
      this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async newGroupFor(c) {
    const name = await promptDialog('New Group', 'Group name:', '', { okLabel: 'Create' });
    if (name && name.trim()) this.setGroup(c, name.trim());
  }

  async renameGroup(g, to) {
    if (to === undefined) {
      to = await promptDialog('Rename Group', 'New name:', g, { okLabel: 'Rename' });
      if (to === null || !to.trim() || to.trim() === g) return;
      to = to.trim();
    } else if (!(await confirmDialog('Ungroup', `Remove the group "${g}"? Its connections stay, they are just no longer grouped.`, { okLabel: 'Ungroup' }))) return;
    try {
      await api.post('/connections/rename-group', { from: g, to });
      this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  tile(c) {
    const isOpen = this.app.workspaces.some((w) => w.profile.id === c.id);
    const t = h('div', { class: 'tile' + (isOpen ? ' open' : ''), tabindex: '0', title: 'Click to connect' },
      c.color ? h('div', { class: 'tile-color', style: { background: c.color } }) : null,
      h('div', { class: 'tile-name' }, c.name),
      c.driver === 'mysql'
        ? [h('div', { class: 'tile-line' }, icon('users'), esc(c.user || 'root')), h('div', { class: 'tile-line' }, icon('server'), `${c.host || '127.0.0.1'}:${c.port || 3306}`),
          c.ssh ? h('div', { class: 'tile-line' }, icon('key'), `SSH ${c.ssh_user || ''}@${c.ssh_host || ''}${c.ssh_port && c.ssh_port !== 22 ? ':' + c.ssh_port : ''}`) : null]
        : c.driver === 'odbc'
          ? [h('div', { class: 'tile-line' }, icon('plug'), c.odbc_mode === 'string' ? (odbcDriverName(c.odbc_connstr) || 'Connection string') : `DSN ${c.odbc_dsn || ''}`),
            c.user ? h('div', { class: 'tile-line' }, icon('users'), esc(c.user)) : null]
          : [h('div', { class: 'tile-line path' }, icon('sqlite'), c.file || '')],
      h('button', { class: 'tile-gear', title: 'Edit connection', onclick: (e) => { e.stopPropagation(); this.editConnection(c); } }, icon('wrench')));
    t.addEventListener('click', () => this.app.connect(c));
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.app.connect(c); });
    t.draggable = true;
    t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-dbcentral-conn', c.id); e.dataTransfer.effectAllowed = 'move'; t.classList.add('dragging'); });
    t.addEventListener('dragend', () => t.classList.remove('dragging'));
    const groupMenu = () => [
      ...knownGroups.map((g) => ({ label: g, checked: c.group === g, action: () => this.setGroup(c, g) })),
      knownGroups.length ? '-' : null,
      { label: 'New Group...', icon: 'plus', action: () => this.newGroupFor(c) },
      c.group ? { label: 'Remove from Group', action: () => this.setGroup(c, '') } : null,
    ];
    t.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Open Connection', icon: 'plug', action: () => this.app.connect(c) },
      { label: 'Edit Connection...', icon: 'wrench', action: () => this.editConnection(c) },
      { label: 'Duplicate Connection', icon: 'copy', action: async () => { await api.post(`/connections/${c.id}/duplicate`); this.refresh(); } },
      { label: 'Move to Group', icon: 'folder', submenu: groupMenu },
      '-',
      { label: 'Move to Top', action: () => this.move(c, -1e9) },
      { label: 'Move Left', action: () => this.move(c, -1) },
      { label: 'Move Right', action: () => this.move(c, 1) },
      '-',
      c.has_password ? { label: 'Clear Saved Password', icon: 'key2', action: async () => { await api.put(`/connections/${c.id}`, { profile: c, clear_password: true }); toast('Password removed from vault', 'success'); this.refresh(); } } : null,
      { label: 'Delete Connection...', icon: 'trash', action: async () => {
        if (await confirmDialog('Delete Connection', `Delete the connection "${c.name}"? (The database itself is not affected.)`, { okLabel: 'Delete', danger: true })) {
          await api.del('/connections/' + c.id);
          this.refresh();
        }
      } },
    ]));
    return t;
  }

  async move(c, delta) {
    const ids = this.connections.map((x) => x.id);
    const i = ids.indexOf(c.id);
    ids.splice(i, 1);
    const j = Math.max(0, Math.min(ids.length, i + delta));
    ids.splice(j, 0, c.id);
    await api.post('/connections/reorder', { ids });
    this.refresh();
  }

  async editConnection(conn, driver, group) {
    const r = await connectionDialog(conn, driver || conn?.driver || 'mysql', group);
    if (r) this.refresh();
    return r;
  }
}

export async function connectionDialog(conn, driver, group) {
  const p = { name: '', driver, host: '127.0.0.1', port: 3306, user: 'root', schema: '', ssl_mode: 'preferred', connect_timeout: 10, file: '', create_if_missing: true, foreign_keys: true, color: '',
    ssh: false, ssh_host: '', ssh_port: 22, ssh_user: '', ssh_auth: 'password', ssh_key_file: '', ...(conn || {}) };
  const groupList = 'conn-groups-' + Date.now();
  const inputs = {
    name: h('input', { class: 'input', value: p.name || (driver === 'sqlite' || driver === 'odbc' ? '' : 'Local instance'), autofocus: true }),
    odbc_mode: select([['dsn', 'Data source name (DSN)'], ['string', 'Connection string']], p.odbc_mode || 'dsn'),
    odbc_dsn: select([[p.odbc_dsn || '', p.odbc_dsn || '(loading data sources...)']], p.odbc_dsn || ''),
    odbc_driver: select([['', 'Insert a template for a driver...']], ''),
    odbc_connstr: h('textarea', { class: 'input mono', rows: 3, spellcheck: false, placeholder: 'DRIVER={SQL Server};SERVER=localhost;DATABASE=master;Trusted_Connection=yes;' }),
    odbc_user: h('input', { class: 'input', value: conn?.driver === 'odbc' ? (conn.user || '') : '', placeholder: 'Optional' }),
    odbc_password: h('input', { class: 'input', type: 'password', autocomplete: 'new-password',
      placeholder: conn?.has_password && conn.driver === 'odbc' ? '•••••• (stored in vault)' : 'Optional' }),
    odbc_schema: h('input', { class: 'input', value: conn?.driver === 'odbc' ? (conn.schema || '') : '', placeholder: 'Optional' }),
    odbc_timeout: h('input', { class: 'input port', type: 'number', value: conn?.driver === 'odbc' ? (conn.connect_timeout || 15) : 15 }),
    group: h('input', { class: 'input', value: conn ? (conn.group || '') : (group || ''), placeholder: 'None', list: groupList }),
    driver: select([['mysql', 'MySQL / MariaDB (Standard TCP/IP)'], ['mysql-ssh', 'MySQL / MariaDB (Standard TCP/IP over SSH)'], ['sqlite', 'SQLite database file'],
      ['odbc', 'Other database (ODBC)']],
      p.driver === 'mysql' && p.ssh ? 'mysql-ssh' : p.driver),
    ssh_host: h('input', { class: 'input', value: p.ssh_host || '', placeholder: 'ssh.example.com' }),
    ssh_port: h('input', { class: 'input port', type: 'number', value: p.ssh_port || 22 }),
    ssh_user: h('input', { class: 'input', value: p.ssh_user || '' }),
    ssh_auth: select([['password', 'Password'], ['key', 'Private key file'], ['agent', 'SSH agent (Pageant or Windows OpenSSH agent)']], p.ssh_auth || 'password'),
    ssh_password: h('input', { class: 'input', type: 'password', autocomplete: 'new-password' }),
    ssh_key_file: h('input', { class: 'input', value: p.ssh_key_file || '', placeholder: 'e.g. C:\\Users\\you\\.ssh\\id_ed25519' }),
    host: h('input', { class: 'input', value: p.host || '' }),
    port: h('input', { class: 'input port', type: 'number', value: p.port || 3306 }),
    user: h('input', { class: 'input', value: p.user || '' }),
    password: h('input', { class: 'input', type: 'password', placeholder: conn?.has_password ? '•••••• (stored in vault)' : 'Not stored - you will be asked when connecting', autocomplete: 'new-password' }),
    schema: h('input', { class: 'input', value: p.schema || '', placeholder: 'Leave blank to select it later' }),
    ssl_mode: select([['disabled', 'No'], ['preferred', 'If available'], ['required', 'Require'], ['verify_ca', 'Require and Verify CA'], ['verify_identity', 'Require and Verify Identity']], p.ssl_mode || 'preferred'),
    ssl_ca: h('input', { class: 'input', value: p.ssl_ca || '' }),
    ssl_cert: h('input', { class: 'input', value: p.ssl_cert || '' }),
    ssl_key: h('input', { class: 'input', value: p.ssl_key || '' }),
    connect_timeout: h('input', { class: 'input port', type: 'number', value: p.connect_timeout || 10 }),
    init_command: h('input', { class: 'input', value: p.init_command || '', placeholder: "e.g. SET time_zone = '+00:00'" }),
    file: h('input', { class: 'input', value: p.file || '', placeholder: 'C:\\path\\to\\database.db' }),
  };
  let color = p.color || '';
  const savePw = checkbox('Store password in the Windows Credential Manager (vault)', !conn || conn.has_password);
  const clearPw = conn?.has_password ? h('button', { class: 'btn small', type: 'button', onclick: () => { clearPw.dataset.clear = '1'; inputs.password.placeholder = 'Password will be removed from the vault'; clearPw.disabled = true; } }, 'Clear') : null;
  const saveSsh = checkbox('Store in vault', !conn || conn.has_ssh_password);
  const clearSsh = conn?.has_ssh_password ? h('button', { class: 'btn small', type: 'button', onclick: () => { clearSsh.dataset.clear = '1'; inputs.ssh_password.placeholder = 'Will be removed from the vault'; clearSsh.disabled = true; } }, 'Clear') : null;
  const createMissing = checkbox('Create the database file if it does not exist', p.create_if_missing !== false);
  const fks = checkbox('Enforce foreign keys (PRAGMA foreign_keys = ON)', p.foreign_keys !== false);
  const browse = (input, title, filters, save) => h('button', { class: 'btn small', type: 'button', onclick: async () => {
    try {
      const path = save ? await pickSaveFile(title, 'database.db', filters, 'db') : await pickOpenFile(title, filters);
      if (path) {
        input.value = path;
        if (input === inputs.file && !inputs.name.value.trim()) inputs.name.value = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      }
    } catch (e) { toast(e.message, 'error'); }
  } }, save ? 'New...' : 'Browse...');
  const dbFilters = [['SQLite databases', '*.db;*.sqlite;*.sqlite3;*.db3'], ['All Files', '*.*']];
  const certFilters = [['Certificates', '*.pem;*.crt;*.key'], ['All Files', '*.*']];
  const keyFilters = [['All Files', '*.*'], ['Key files', '*.pem;*.key;id_*']];
  const swatches = h('div', { class: 'swatches' }, ...COLORS.map((c) => {
    const s = h('button', { type: 'button', class: 'swatch' + (c === color ? ' active' : ''), style: { background: c || 'transparent' }, title: c ? c : 'No color' }, c ? '' : '∅');
    s.addEventListener('click', () => { color = c; swatches.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === s)); });
    return s;
  }));

  const sshSecretLabel = h('span', { class: 'field-label' });
  const sshSecretRow = h('label', { class: 'field' }, sshSecretLabel, h('div', { class: 'row' }, inputs.ssh_password, clearSsh));
  const sshKeyRow = field('SSH Key File:', h('div', { class: 'row' }, inputs.ssh_key_file, browse(inputs.ssh_key_file, 'SSH Private Key File', keyFilters)));
  const sshSaveRow = h('div', { class: 'span2' }, saveSsh);
  const syncAuth = () => {
    const a = inputs.ssh_auth.value;
    sshSecretLabel.textContent = a === 'key' ? 'Key passphrase (if any):' : 'SSH Password:';
    const stored = conn?.has_ssh_password && !clearSsh?.dataset.clear;
    inputs.ssh_password.placeholder = stored ? '•••••• (stored in vault)' : a === 'key' ? 'Leave blank if the key has none' : 'Not stored - you will be asked when connecting';
    sshSecretRow.classList.toggle('hidden', a === 'agent');
    sshSaveRow.classList.toggle('hidden', a === 'agent');
    sshKeyRow.classList.toggle('hidden', a !== 'key');
  };
  inputs.ssh_auth.addEventListener('change', syncAuth);
  syncAuth();
  const sshParams = h('div', { class: 'form grid2 ssh-params span2' },
    field('SSH Hostname:', inputs.ssh_host), field('SSH Port:', inputs.ssh_port),
    field('SSH Username:', inputs.ssh_user), field('SSH Authentication:', inputs.ssh_auth),
    sshSecretRow, sshKeyRow, sshSaveRow,
    h('div', { class: 'span2 muted small' }, 'The MySQL hostname and port below are as seen from the SSH server (usually 127.0.0.1).'));
  const hostLabel = h('span', { class: 'field-label' }, 'Hostname:');
  const mysqlParams = h('div', { class: 'form grid2' },
    sshParams,
    h('label', { class: 'field' }, hostLabel, inputs.host), field('Port:', inputs.port),
    field('Username:', inputs.user),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password:'), h('div', { class: 'row' }, inputs.password, clearPw)),
    h('div', { class: 'span2' }, savePw),
    field('Default Schema:', inputs.schema));
  const sslParams = h('div', { class: 'form grid2' },
    field('Use SSL:', inputs.ssl_mode),
    h('div', { class: 'span2 muted small' }, '"If available" encrypts the connection when the server supports it, without verifying certificates.'),
    field('SSL CA File:', h('div', { class: 'row' }, inputs.ssl_ca, browse(inputs.ssl_ca, 'SSL CA File', certFilters))),
    field('SSL CERT File:', h('div', { class: 'row' }, inputs.ssl_cert, browse(inputs.ssl_cert, 'SSL Client Certificate', certFilters))),
    field('SSL Key File:', h('div', { class: 'row' }, inputs.ssl_key, browse(inputs.ssl_key, 'SSL Client Key', certFilters))));
  const advParams = h('div', { class: 'form grid2' },
    field('Connect timeout (s):', inputs.connect_timeout),
    field('Init command:', inputs.init_command));
  const sqliteParams = h('div', { class: 'form' },
    field('Database file:', h('div', { class: 'row' }, inputs.file, browse(inputs.file, 'Open SQLite Database', dbFilters), browse(inputs.file, 'Create SQLite Database', dbFilters, true))),
    createMissing, fks);

  const tabsBar = h('div', { class: 'seg' });
  const tabBodies = { params: mysqlParams, ssl: sslParams, advanced: advParams };
  const showTab = (k) => {
    tabsBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    Object.entries(tabBodies).forEach(([kk, el]) => el.classList.toggle('hidden', kk !== k));
  };
  [['params', 'Parameters'], ['ssl', 'SSL'], ['advanced', 'Advanced']].forEach(([k, l]) => tabsBar.append(h('button', { type: 'button', class: 'seg-btn', dataset: { k }, onclick: () => showTab(k) }, l)));
  const mysqlBox = h('div', { class: 'conn-mysql' }, tabsBar, mysqlParams, sslParams, advParams);
  inputs.odbc_connstr.value = p.odbc_connstr || '';
  const saveOdbcPw = checkbox('Store password in the Windows Credential Manager (vault)', !conn || (conn.driver === 'odbc' && conn.has_password));
  const dsnRow = field('Data source:', inputs.odbc_dsn, 'Data sources are set up in Windows: search the Start menu for "ODBC Data Sources (64-bit)".');
  const strRow = h('div', { class: 'form' },
    field('Connection string:', inputs.odbc_connstr, 'Put the password in the Password field below, not here: the connection string is saved as plain text.'),
    inputs.odbc_driver);
  const odbcBox = h('div', { class: 'conn-odbc form' },
    field('Connect using:', inputs.odbc_mode), dsnRow, strRow,
    h('div', { class: 'form grid2' }, field('Username:', inputs.odbc_user), field('Password:', inputs.odbc_password),
      h('div', { class: 'span2' }, saveOdbcPw),
      field('Default schema:', inputs.odbc_schema), field('Connect timeout (s):', inputs.odbc_timeout)),
    h('div', { class: 'muted small' }, 'Leave the username empty for Windows authentication or data sources without a login. ',
      'Through ODBC you can browse tables and run queries; the table designer, admin pages and result editing are for MySQL/MariaDB and SQLite.'));
  const syncOdbc = () => {
    dsnRow.classList.toggle('hidden', inputs.odbc_mode.value !== 'dsn');
    strRow.classList.toggle('hidden', inputs.odbc_mode.value !== 'string');
  };
  inputs.odbc_mode.addEventListener('change', syncOdbc);
  syncOdbc();
  inputs.odbc_driver.addEventListener('change', () => {
    const d = inputs.odbc_driver.value;
    if (!d) return;
    inputs.odbc_connstr.value = `DRIVER={${d}};${odbcTemplate(d)}`;
    inputs.odbc_driver.value = '';
    inputs.odbc_connstr.focus();
  });
  api.get('/odbc/sources').then((src) => {
    const dsn = inputs.odbc_dsn;
    const cur = dsn.value;
    dsn.innerHTML = '';
    const list = src.dsns.map((x) => [x.name, `${x.name}  (${x.driver})`]);
    if (cur && !src.dsns.some((x) => x.name === cur)) list.unshift([cur, `${cur}  (not found on this PC)`]);
    if (!list.length) list.push(['', '(no data sources set up)']);
    for (const [v, l] of list) dsn.append(h('option', { value: v }, l));
    dsn.value = cur || list[0][0];
    for (const d of src.drivers) inputs.odbc_driver.append(h('option', { value: d }, d));
  }).catch((e) => {
    inputs.odbc_dsn.innerHTML = '';
    inputs.odbc_dsn.append(h('option', { value: '' }, 'ODBC is not available: ' + e.message));
  });
  const sqliteBox = h('div', { class: 'conn-sqlite' }, sqliteParams);
  const status = h('div', { class: 'conn-status' });
  const syncDriver = () => {
    const d = inputs.driver.value;
    mysqlBox.classList.toggle('hidden', !d.startsWith('mysql'));
    sqliteBox.classList.toggle('hidden', d !== 'sqlite');
    odbcBox.classList.toggle('hidden', d !== 'odbc');
    sshParams.classList.toggle('hidden', d !== 'mysql-ssh');
    hostLabel.textContent = d === 'mysql-ssh' ? 'MySQL Hostname:' : 'Hostname:';
  };
  inputs.driver.addEventListener('change', syncDriver);
  showTab('params');
  syncDriver();

  const collect = () => {
    const sel = inputs.driver.value;
    const d = sel === 'mysql-ssh' ? 'mysql' : sel;
    const defaultName = d === 'sqlite' ? inputs.file.value.split(/[\\/]/).pop()
      : d === 'odbc' ? (inputs.odbc_mode.value === 'dsn' ? inputs.odbc_dsn.value : odbcDriverName(inputs.odbc_connstr.value)) || 'ODBC connection'
        : `${inputs.host.value}:${inputs.port.value}`;
    const prof = { name: inputs.name.value.trim() || defaultName, driver: d, color };
    if (inputs.group.value.trim()) prof.group = inputs.group.value.trim();
    if (sel === 'mysql-ssh') {
      Object.assign(prof, { ssh: true, ssh_host: inputs.ssh_host.value.trim(), ssh_port: Number(inputs.ssh_port.value) || 22, ssh_user: inputs.ssh_user.value.trim(),
        ssh_auth: inputs.ssh_auth.value, ssh_key_file: inputs.ssh_key_file.value.trim() });
    }
    if (d === 'mysql') {
      Object.assign(prof, { host: inputs.host.value.trim(), port: Number(inputs.port.value) || 3306, user: inputs.user.value.trim(), schema: inputs.schema.value.trim(),
        ssl_mode: inputs.ssl_mode.value, ssl_ca: inputs.ssl_ca.value.trim(), ssl_cert: inputs.ssl_cert.value.trim(), ssl_key: inputs.ssl_key.value.trim(),
        connect_timeout: Number(inputs.connect_timeout.value) || 10, init_command: inputs.init_command.value.trim() });
    } else if (d === 'odbc') {
      Object.assign(prof, { odbc_mode: inputs.odbc_mode.value, odbc_dsn: inputs.odbc_dsn.value, odbc_connstr: inputs.odbc_connstr.value.trim(),
        user: inputs.odbc_user.value.trim(), schema: inputs.odbc_schema.value.trim(), connect_timeout: Number(inputs.odbc_timeout.value) || 15 });
    } else {
      Object.assign(prof, { file: inputs.file.value.trim(), create_if_missing: createMissing.querySelector('input').checked, foreign_keys: fks.querySelector('input').checked });
    }
    return prof;
  };

  const test = async () => {
    const prof = collect();
    status.className = 'conn-status';
    status.innerHTML = '';
    status.append(icon('spinner'), ' Connecting...');
    try {
      const body = { profile: prof, id: conn?.id };
      if (prof.driver === 'odbc') {
        if (inputs.odbc_password.value) body.password = inputs.odbc_password.value;
        else if (!conn?.has_password) body.password = '';
      } else if (inputs.password.value) body.password = inputs.password.value;
      else if (prof.driver === 'mysql' && !conn?.has_password) body.password = '';
      if (prof.ssh && inputs.ssh_password.value) body.ssh_password = inputs.ssh_password.value;
      let r = null;
      for (let i = 0; i < 6 && !r; i++) {
        try {
          r = await api.post('/connections/test', body);
        } catch (e) {
          const again = await handleSshError(e, prof, body);
          if (again === null) { status.innerHTML = ''; return false; }
          if (!again) throw e;
        }
      }
      if (!r) throw new Error('Could not connect.');
      if (body.ssh_password !== undefined) inputs.ssh_password.value = body.ssh_password;  // the one that worked
      status.className = 'conn-status ok';
      status.innerHTML = '';
      status.append(icon('ok'), ` Successfully connected. ${r.info.server_version}${r.info.ssl ? ' (SSL)' : ''}${r.info.ssh ? ' via SSH ' + r.info.ssh : ''} - ${r.ms} ms`);
    } catch (e) {
      status.className = 'conn-status err';
      status.innerHTML = '';
      status.append(icon('error'), ' ' + e.message);
    }
    return false;
  };

  const content = h('div', { class: 'conn-dialog' },
    h('div', { class: 'form grid2' }, field('Connection Name:', inputs.name), field('Connection Type:', inputs.driver),
      field('Group:', inputs.group), field('Color tag:', swatches), h('datalist', { id: groupList }, ...knownGroups.map((g) => h('option', { value: g })))),
    mysqlBox, sqliteBox, odbcBox, status);

  return modal({
    title: conn ? 'Edit Connection - ' + conn.name : 'Setup New Connection', width: 640, content, closeValue: null,
    buttons: [
      { label: 'Test Connection', onClick: test },
      '-',
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, onClick: async () => {
        const prof = collect();
        if (prof.driver === 'sqlite' && !prof.file) { toast('Choose a database file.', 'warning'); return false; }
        if (prof.driver === 'odbc') {
          if (prof.odbc_mode === 'dsn' ? !prof.odbc_dsn : !prof.odbc_connstr) { toast(prof.odbc_mode === 'dsn' ? 'Choose a data source.' : 'Enter a connection string.', 'warning'); return false; }
          if (prof.odbc_mode === 'string' && /(^|;)\s*(PWD|PASSWORD)\s*=/i.test(prof.odbc_connstr)
            && !(await confirmDialog('Password in Connection String', 'The connection string contains a password, and connection strings are saved as plain text. Move it to the Password field instead, so it is kept in the vault?', { okLabel: 'Save Anyway', cancelLabel: 'Go Back' }))) return false;
        }
        const body = { profile: prof };
        const pw = inputs.password.value;
        const wantSave = savePw.querySelector('input').checked;
        if (prof.driver === 'mysql') {
          if (pw && wantSave) { body.password = pw; body.save_password = true; }
          if ((clearPw?.dataset.clear) || (conn?.has_password && !wantSave)) body.clear_password = true;
        } else if (prof.driver === 'odbc') {
          const opw = inputs.odbc_password.value;
          const keep = saveOdbcPw.querySelector('input').checked;
          if (opw && keep) { body.password = opw; body.save_password = true; }
          if (conn?.has_password && !keep) body.clear_password = true;
        }
        if (prof.ssh) {
          if (!prof.ssh_host || !prof.ssh_user) { toast('Enter the SSH hostname and username.', 'warning'); return false; }
          if (prof.ssh_auth === 'key' && !prof.ssh_key_file) { toast('Choose the SSH key file.', 'warning'); return false; }
          const sshPw = inputs.ssh_password.value;
          const keepSsh = saveSsh.querySelector('input').checked && prof.ssh_auth !== 'agent';
          if (sshPw && keepSsh) { body.ssh_password = sshPw; body.save_ssh_password = true; }
          if (clearSsh?.dataset.clear || (conn?.has_ssh_password && !keepSsh)) body.clear_ssh_password = true;
        }
        try {
          const r = conn ? await api.put('/connections/' + conn.id, body) : await api.post('/connections', body);
          return r.connection;
        } catch (e) {
          toast(e.message, 'error');
          return false;
        }
      } },
    ],
  });
}

// need: any of 'password' (MySQL) and 'ssh_password' (SSH password or key passphrase).
// Resolves to { password, save_password, ssh_password, save_ssh_password } (only the asked fields) or null.
export async function passwordPrompt(profile, message, need = ['password']) {
  const parts = [];
  const result = {};
  const sshKey = profile.ssh_auth === 'key';
  for (const kind of need) {
    const input = h('input', { class: 'input wide', type: 'password', autocomplete: 'current-password' });
    const save = checkbox(kind === 'password' ? 'Save password in vault' : sshKey ? 'Save passphrase in vault' : 'Save SSH password in vault', false);
    const rows = kind === 'password' && profile.driver === 'odbc'
      ? [['Data source:', profile.odbc_mode === 'string' ? (odbcDriverName(profile.odbc_connstr) || 'connection string') : profile.odbc_dsn], ['User:', profile.user || '']]
      : kind === 'password'
      ? [['Service:', `Mysql@${profile.host || '127.0.0.1'}:${profile.port || 3306}`], ['User:', profile.user || 'root']]
      : sshKey ? [['Key file:', profile.ssh_key_file || '']]
        : [['Service:', `SSH ${profile.ssh_host || ''}:${profile.ssh_port || 22}`], ['User:', profile.ssh_user || '']];
    const label = kind === 'password' ? (profile.driver === 'odbc' ? 'Password:' : 'MySQL password:') : sshKey ? 'Key passphrase:' : 'SSH password:';
    parts.push(h('div', { class: 'pw-part' },
      h('table', { class: 'info-table' }, ...rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))),
      h('div', { class: 'form' }, field(label, input), save)));
    result[kind] = () => ({ [kind]: input.value, ['save_' + kind]: save.querySelector('input').checked });
  }
  const title = need.includes('password') ? (profile.driver === 'odbc' ? 'Connect to Database' : 'Connect to MySQL Server') : sshKey ? 'SSH Key Passphrase' : 'SSH Login';
  const content = h('div', { class: 'pw-dialog' },
    h('div', { class: 'msg-dialog' }, icon('key', 'big'), h('div', null, h('p', null, need.length > 1 ? 'Please enter the passwords for the following services:' : sshKey && need[0] === 'ssh_password' ? 'Please enter the passphrase of the SSH key:' : 'Please enter password for the following service:'))),
    message ? h('div', { class: 'conn-status err' }, icon('error'), ' ', message) : null,
    ...parts);
  return modal({
    title, width: 460, content, closeValue: null,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, onClick: () => Object.assign({}, ...Object.values(result).map((f) => f())) }],
  });
}

// Shared handling of SSH errors when connecting. Updates `body` and returns true to retry,
// null when the user cancelled, false when the error is not one we can resolve here.
export async function handleSshError(e, profile, body) {
  const code = e.data?.code || e.code;
  if (!profile.ssh || !code || !String(code).startsWith('ssh_')) {
    if (e.status === 401 && e.data?.need_password) {
      const r = await passwordPrompt(profile, null, e.data.need || ['password']);
      if (!r) return null;
      Object.assign(body, r);
      return true;
    }
    return false;
  }
  if (code === 'ssh_unknown_host') {
    const d = e.data.details || {};
    const ok = await modal({
      title: 'Unknown SSH Host', width: 520, closeValue: false,
      content: h('div', { class: 'msg-dialog' }, icon('warning', 'big'), h('div', { class: 'msg-text' },
        h('p', null, `The authenticity of the SSH server ${d.host} can't be established. This is normal the first time you connect.`),
        h('table', { class: 'info-table' }, h('tr', null, h('th', null, 'Key type:'), h('td', null, d.key_type || '')),
          h('tr', null, h('th', null, 'Fingerprint:'), h('td', { class: 'mono' }, d.fingerprint || ''))),
        h('p', null, 'If you can, compare the fingerprint with the server\'s (ssh-keygen -lf on the server\'s host key). DBCentral remembers the key and warns you if it ever changes.'))),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Trust and Continue', value: true, primary: true }],
    });
    if (!ok) return null;
    body.accept_host_key = d.fingerprint;
    return true;
  }
  if (code === 'ssh_need_password' || code === 'ssh_need_passphrase' || (code === 'ssh_auth_failed' && profile.ssh_auth !== 'agent')) {
    const r = await passwordPrompt(profile, code === 'ssh_need_password' ? null : e.message, ['ssh_password']);
    if (!r) return null;
    Object.assign(body, r);
    return true;
  }
  return false;
}
