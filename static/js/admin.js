// Administration pages: Server Status/Dashboard, Client Connections, Users and Privileges,
// Status and System Variables, Data Export, Data Import.
import { api } from './api.js';
import { pickOpenFile, pickSaveFile } from './files.js';
import { DataGrid } from './grid.js';
import { PerfReportsPage } from './perfreports.js';
import { reviewAndApply } from './review.js';
import {
  checkbox, confirmDialog, contextMenu, copyText, emptyState, field, formatBytes, formatDuration, formatNumber, h, icon, select, toast, toolButton,
} from './ui.js';

export function createAdminDoc(ws, kind, opts) {
  const map = { status: StatusPage, connections: ConnectionsPage, users: UsersPage, variables: VariablesPage, export: ExportPage, import: ImportPage, perf: PerfReportsPage };
  const Cls = map[kind];
  const doc = new Cls(ws, opts);
  doc.kind = 'admin-' + kind;
  doc.id = 'admin-' + kind + Date.now();
  return doc;
}

class AdminPage {
  constructor(ws, title, ic) {
    this.ws = ws;
    this.title = title;
    this.icon = ic;
    this.el = h('div', { class: 'doc' });
  }

  get visible() { return this.el.isConnected && !this.el.classList.contains('hidden') && !this.ws.el.classList.contains('hidden'); }
  onShow() {}
  dispose() { clearInterval(this.timer); }
}

// ---------------------------------------------------------------------------- server status / dashboard
const CHARTS = [
  ['conn', 'Connections', (s) => Number(s.Threads_connected), (v) => formatNumber(v)],
  ['running', 'Threads Running', (s) => Number(s.Threads_running), (v) => formatNumber(v)],
  ['qps', 'Queries per Second', (s, p, dt) => rate(s, p, dt, 'Questions'), (v) => v.toFixed(1)],
  ['traffic', 'Network Traffic (KB/s)', (s, p, dt) => (rate(s, p, dt, 'Bytes_received') + rate(s, p, dt, 'Bytes_sent')) / 1024, (v) => v.toFixed(1)],
  ['sel', 'SELECT per Second', (s, p, dt) => rate(s, p, dt, 'Com_select'), (v) => v.toFixed(1)],
  ['dml', 'INSERT/UPDATE/DELETE per Second', (s, p, dt) => rate(s, p, dt, 'Com_insert') + rate(s, p, dt, 'Com_update') + rate(s, p, dt, 'Com_delete'), (v) => v.toFixed(1)],
  ['bp', 'InnoDB Buffer Pool Usage (%)', (s) => { const t = Number(s.Innodb_buffer_pool_pages_total); const f = Number(s.Innodb_buffer_pool_pages_free); return t ? (100 * (t - f)) / t : 0; }, (v) => v.toFixed(1) + '%'],
  ['bpr', 'InnoDB Reads per Second', (s, p, dt) => rate(s, p, dt, 'Innodb_buffer_pool_read_requests'), (v) => formatNumber(Math.round(v))],
];

function rate(s, p, dt, key) {
  if (!p || !dt) return 0;
  return Math.max(0, (Number(s[key]) - Number(p[key])) / dt);
}

class StatusPage extends AdminPage {
  constructor(ws) {
    super(ws, 'Server Status', 'server');
    this.series = Object.fromEntries(CHARTS.map(([k]) => [k, []]));
    this.info = h('div');
    this.cards = h('div', { class: 'charts' });
    this.canvases = {};
    for (const [k, label] of CHARTS) {
      const cv = h('canvas', { width: 520, height: 140 });
      const val = h('span');
      this.canvases[k] = { cv, val };
      this.cards.append(h('div', { class: 'chart-card' }, h('div', { class: 't' }, label, val), cv));
    }
    this.el.append(h('div', { class: 'admin-page' },
      h('h2', null, icon('server', 'big'), 'Server Status', h('span', { class: 'flex1' }), toolButton('refresh', 'Refresh', () => this.poll(), { label: 'Refresh' })),
      h('div', { class: 'export-layout' }, this.info, h('div', null, h('h3', null, 'Performance (updates every 2 seconds while visible)'), this.cards))));
  }

  load() {
    this.poll();
    this.timer = setInterval(() => { if (this.visible) this.poll(); }, 2000);
  }

  async poll() {
    let r;
    try { r = await api.get(`/sessions/${this.ws.sid}/admin/status`); } catch (e) { this.info.innerHTML = ''; this.info.append(h('div', { class: 'error-box' }, icon('error'), ' ', e.message)); return; }
    const s = r.status, v = r.variables;
    const dt = this.prev ? r.time - this.prevTime : 0;
    for (const [k, , fn, fmt] of CHARTS) {
      const val = fn(s, this.prev, dt);
      if (this.prev || !['qps', 'traffic', 'sel', 'dml', 'bpr'].includes(k)) {
        this.series[k].push(val);
        if (this.series[k].length > 90) this.series[k].shift();
      }
      this.canvases[k].val.textContent = fmt(val);
      this.draw(this.canvases[k].cv, this.series[k]);
    }
    this.prev = s;
    this.prevTime = r.time;
    const rows = [
      ['Host', v.hostname], ['Port', v.port], ['Version', `${v.version} (${v.version_comment || ''})`], ['Compiled For', `${v.version_compile_os || ''} (${v.version_compile_machine || ''})`],
      ['Data Directory', v.datadir], ['Base Directory', v.basedir], ['Temp Directory', v.tmpdir], ['Uptime', formatDuration(s.Uptime)],
      ['Character Set / Collation', `${v.character_set_server} / ${v.collation_server}`], ['Default Storage Engine', v.default_storage_engine],
      ['Max Connections', v.max_connections], ['Connections (total)', formatNumber(s.Connections)], ['Aborted Connects', formatNumber(s.Aborted_connects)],
      ['Max Used Connections', s.Max_used_connections], ['Slow Queries', formatNumber(s.Slow_queries)], ['Questions (total)', formatNumber(s.Questions)],
      ['InnoDB Buffer Pool', formatBytes(v.innodb_buffer_pool_size)], ['Max Allowed Packet', formatBytes(v.max_allowed_packet)],
      ['Binary Log', v.log_bin], ['General Log', v.general_log], ['Slow Query Log', v.slow_query_log], ['SSL', v.have_ssl || (s.Ssl_cipher ? 'YES' : '')],
      ['Time Zone', `${v.time_zone} (system: ${v.system_time_zone})`], ['SQL Mode', v.sql_mode],
    ].filter(([, x]) => x !== undefined && x !== null && x !== '');
    this.info.innerHTML = '';
    this.info.append(h('h3', null, 'Server Information'), h('table', { class: 'kv-table' }, ...rows.map(([k, x]) => h('tr', null, h('th', null, k), h('td', null, String(x))))));
  }

  draw(cv, data) {
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const dark = document.body.classList.contains('dark');
    ctx.strokeStyle = dark ? '#3a3f47' : '#e3e7ec';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (H * i) / 4); ctx.lineTo(W, (H * i) / 4); ctx.stroke(); }
    if (data.length < 2) return;
    const max = Math.max(...data, 1) * 1.15;
    const step = W / 89;
    const x0 = W - (data.length - 1) * step;
    ctx.beginPath();
    data.forEach((v, i) => { const x = x0 + i * step, y = H - (v / max) * (H - 6) - 2; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = '#2f6db3';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(x0, H); ctx.closePath();
    ctx.fillStyle = 'rgba(47,109,179,.15)';
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------- client connections
class ConnectionsPage extends AdminPage {
  constructor(ws) {
    super(ws, 'Client Connections', 'plug');
    this.hideSleep = checkbox('Hide sleeping connections', false, () => this.render());
    this.auto = checkbox('Refresh every 3 seconds', true);
    this.count = h('span', { class: 'tb-text muted' });
    this.gridHost = h('div', { class: 'grid-host' });
    this.el.append(h('div', { class: 'admin-flex' },
      h('div', { class: 'toolbar' },
        toolButton('refresh', 'Refresh', () => this.load(), { label: 'Refresh' }),
        toolButton('stop', 'Kill the query running in the selected connection', () => this.kill(true), { label: 'Kill Query' }),
        toolButton('close', 'Kill the selected connection', () => this.kill(false), { label: 'Kill Connection' }),
        h('span', { class: 'tb-sep' }), this.hideSleep, h('span', { class: 'tb-sep' }), this.auto, h('span', { class: 'flex1' }), this.count),
      this.gridHost));
    this.grid = new DataGrid(this.gridHost, {
      onActivate: (r, c, row) => row && copyText(String(row.v[c] ?? '')),
      onContextMenu: (e, pos) => {
        const row = pos ? this.grid.rowAt(pos.r) : null;
        contextMenu(e, [
          { label: 'Kill Query', icon: 'stop', disabled: !row, action: () => this.kill(true) },
          { label: 'Kill Connection', icon: 'close', disabled: !row, action: () => this.kill(false) },
          '-',
          { label: 'Copy Info (SQL)', icon: 'copy', disabled: !row, action: () => copyText(String(row.v[7] ?? '')) },
          { label: 'Send Info to SQL Editor', disabled: !row || !row.v[7], action: () => this.ws.sendToEditor(String(row.v[7])) },
          '-',
          { label: 'Refresh', icon: 'refresh', action: () => this.load() },
        ]);
      },
    });
  }

  async load() {
    try {
      const r = await api.get(`/sessions/${this.ws.sid}/admin/processlist`);
      this.rows = r.rows;
      this.render();
    } catch (e) { toast(e.message, 'error'); }
    if (!this.timer) this.timer = setInterval(() => { if (this.visible && this.auto.querySelector('input').checked) this.load(); }, 3000);
  }

  render() {
    const hide = this.hideSleep.querySelector('input').checked;
    const rows = (this.rows || []).filter((x) => !hide || x.command !== 'Sleep');
    const selId = this.grid.rowAt(this.grid.active.r)?.v[0];
    const sort = this.grid.sort;
    this.grid.setData([{ name: 'Id', kind: 'num' }, { name: 'User', kind: 'str' }, { name: 'Host', kind: 'str' }, { name: 'DB', kind: 'str' },
      { name: 'Command', kind: 'str' }, { name: 'Time', kind: 'num' }, { name: 'State', kind: 'str' }, { name: 'Info', kind: 'str', width: 420 }, { name: 'DBCentral', kind: 'str' }],
    rows.map((x) => [x.id, x.user, x.host, x.db, x.command, x.time, x.state, x.info, x.own ? 'this app' : '']));
    if (sort) this.grid.setSort(sort.col, sort.dir);
    const idx = this.grid.view.findIndex((i) => this.grid.rows[i].v[0] === selId);
    if (idx >= 0) { this.grid.active = { r: idx, c: 0 }; this.grid.scheduleRender(); }
    this.count.textContent = `${rows.length} connection(s), ${rows.filter((x) => x.command !== 'Sleep').length} active`;
  }

  async kill(queryOnly) {
    const row = this.grid.rowAt(this.grid.active.r);
    if (!row) { toast('Select a connection first.', 'info'); return; }
    const id = row.v[0];
    if (row.v[8] && !queryOnly && !(await confirmDialog('Kill Connection', 'This is one of DBCentral\'s own connections. Kill it anyway?', { danger: true, okLabel: 'Kill' }))) return;
    try {
      await api.post(`/sessions/${this.ws.sid}/admin/kill`, { id, query_only: queryOnly });
      this.ws.logOutput({ action: `KILL ${queryOnly ? 'QUERY ' : ''}${id}`, ok: true, message: 'OK' });
      this.load();
    } catch (e) { toast(e.message, 'error'); }
  }
}

// ---------------------------------------------------------------------------- variables
class VariablesPage extends AdminPage {
  constructor(ws) {
    super(ws, 'Status and System Variables', 'variables');
    this.kindSel = 'system';
    this.filter = h('input', { class: 'input small', placeholder: 'Search variables', spellcheck: false, style: { width: '240px' } });
    this.filter.addEventListener('input', () => this.grid.setFilter(this.filter.value));
    this.seg = h('div', { class: 'seg' });
    for (const [k, l] of [['system', 'System Variables'], ['status', 'Status Variables']]) {
      this.seg.append(h('button', { class: 'seg-btn' + (k === this.kindSel ? ' active' : ''), dataset: { k }, onclick: () => { this.kindSel = k; this.load(); } }, l));
    }
    this.gridHost = h('div', { class: 'grid-host' });
    this.el.append(h('div', { class: 'admin-flex' },
      h('div', { class: 'toolbar' }, this.seg, h('span', { class: 'tb-sep' }), icon('search'), this.filter, h('span', { class: 'tb-sep' }),
        toolButton('refresh', 'Refresh', () => this.load(), { label: 'Refresh' }),
        toolButton('copy', 'Copy all visible variables', () => copyText(this.grid.visibleRows().map((r) => r.v.join('\t')).join('\n')), { label: 'Copy' }),
        h('span', { class: 'flex1' }), h('span', { class: 'tb-text muted' }, 'Double-click a value to copy it')),
      this.gridHost));
    this.grid = new DataGrid(this.gridHost, { onActivate: (r, c, row) => { copyText(String(row.v[c] ?? '')); toast('Copied', 'success', 1000); } });
  }

  async load() {
    this.seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === this.kindSel));
    try {
      const r = await api.get(`/sessions/${this.ws.sid}/admin/variables?kind=${this.kindSel}`);
      this.grid.setData([{ name: 'Name', kind: 'str', width: 320 }, { name: 'Value', kind: 'str', width: 600 }], r.rows.map((x) => [x.name, x.value]));
      this.grid.setFilter(this.filter.value);
    } catch (e) { toast(e.message, 'error'); }
  }
}

// ---------------------------------------------------------------------------- users and privileges
class UsersPage extends AdminPage {
  constructor(ws) {
    super(ws, 'Users and Privileges', 'users');
    this.list = h('div', { class: 'list' });
    this.detail = h('div', { class: 'users-detail' });
    this.el.append(h('div', { class: 'users-layout' },
      h('div', { class: 'users-list' }, h('div', { class: 'panel-header' }, h('span', { class: 'panel-title' }, 'User Accounts'), h('span', { class: 'flex1' }),
        toolButton('plus', 'Add Account', () => this.addAccount(), { cls: 'mini' }), toolButton('refresh', 'Refresh', () => this.load(), { cls: 'mini' })), this.list),
      this.detail));
    this.section = 'login';
  }

  async load() {
    try {
      const r = await api.get(`/sessions/${this.ws.sid}/admin/users`);
      this.users = r.users;
    } catch (e) {
      this.list.innerHTML = '';
      this.list.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
      return;
    }
    this.renderList();
    if (this.sel && !this.sel.isNew) {
      const still = this.users.find((u) => u.user === this.sel.user && u.host === this.sel.host);
      if (still) this.select(still); else this.showEmpty();
    } else if (!this.sel) this.showEmpty();
  }

  showEmpty() { this.detail.innerHTML = ''; this.detail.append(h('div', { class: 'detail-body' }, emptyState('users', 'Select an account', 'Choose a user account on the left, or add a new one.'))); }

  renderList() {
    this.list.innerHTML = '';
    for (const u of this.users) {
      const it = h('div', { class: 'list-item' + (this.sel && !this.sel.isNew && this.sel.user === u.user && this.sel.host === u.host ? ' selected' : '') }, icon('users'), h('span', null, u.user || '(anonymous)'), h('span', { class: 'muted' }, '@' + u.host));
      it.addEventListener('click', () => this.select(u));
      this.list.append(it);
    }
  }

  async select(u) {
    try {
      const d = await api.get(`/sessions/${this.ws.sid}/admin/user?user=${encodeURIComponent(u.user)}&host=${encodeURIComponent(u.host)}`);
      this.sel = { ...d, isNew: false };
      this.edit = structuredClone({ user: d.user, host: d.host, password: '', confirm: '', limits: d.limits, global: d.global_privileges, schemas: d.schema_privileges });
      this.renderList();
      this.renderDetail();
    } catch (e) { toast(e.message, 'error'); }
  }

  async addAccount() {
    let names = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'RELOAD', 'PROCESS', 'FILE', 'GRANT OPTION', 'REFERENCES', 'INDEX', 'ALTER',
      'SHOW DATABASES', 'SUPER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'REPLICATION SLAVE', 'REPLICATION CLIENT', 'CREATE VIEW', 'SHOW VIEW',
      'CREATE ROUTINE', 'ALTER ROUTINE', 'CREATE USER', 'EVENT', 'TRIGGER'];
    if (this.users?.length) {
      try {
        const any = this.users.find((u) => u.user === 'root') || this.users[0];
        const d = await api.get(`/sessions/${this.ws.sid}/admin/user?user=${encodeURIComponent(any.user)}&host=${encodeURIComponent(any.host)}`);
        names = d.available_privileges;
        this.schemaPrivNames = d.schema_privilege_names;
      } catch { /* use defaults */ }
    }
    this.sel = { isNew: true, available_privileges: names, schema_privilege_names: this.schemaPrivNames || names, grants: [] };
    this.edit = { user: 'newuser', host: '%', password: '', confirm: '', limits: { max_questions: 0, max_updates: 0, max_connections: 0, max_user_connections: 0 }, global: [], schemas: [] };
    this.renderList();
    this.renderDetail();
  }

  renderDetail() {
    const e = this.edit;
    const s = this.sel;
    this.detail.innerHTML = '';
    const tabs = h('div', { class: 'seg' });
    for (const [k, l] of [['login', 'Login'], ['limits', 'Account Limits'], ['roles', 'Administrative Roles'], ['schemas', 'Schema Privileges'], ['grants', 'Grants (SQL)']]) {
      tabs.append(h('button', { class: 'seg-btn' + (k === this.section ? ' active' : ''), onclick: () => { this.section = k; this.renderDetail(); } }, l));
    }
    const body = h('div', { class: 'detail-body' });
    if (this.section === 'login') {
      const inp = (k, type = 'text') => { const x = h('input', { class: 'input', type, value: e[k] || '', autocomplete: 'new-password' }); x.addEventListener('input', () => { e[k] = x.value; }); return x; };
      body.append(h('div', { class: 'form', style: { maxWidth: '460px' } },
        field('Login Name:', inp('user'), 'Use only letters, digits and _ for best compatibility.'),
        field('Limit to Hosts Matching:', inp('host'), '% means any host; localhost only allows local connections.'),
        field(s.isNew ? 'Password:' : 'New Password:', inp('password', 'password'), s.isNew ? 'Leave empty for no password (not recommended).' : 'Leave empty to keep the current password.'),
        field('Confirm Password:', inp('confirm', 'password')),
        s.plugin ? h('div', { class: 'muted small' }, `Authentication plugin: ${s.plugin}`) : null));
    } else if (this.section === 'limits') {
      const lim = (k, label) => { const x = h('input', { class: 'input port', type: 'number', min: 0, value: e.limits[k] }); x.addEventListener('input', () => { e.limits[k] = Number(x.value) || 0; }); return field(label, x); };
      body.append(h('div', { class: 'form', style: { maxWidth: '420px' } }, lim('max_questions', 'Max. Queries per hour:'), lim('max_updates', 'Max. Updates per hour:'),
        lim('max_connections', 'Max. Connections per hour:'), lim('max_user_connections', 'Concurrent Connections:'), h('div', { class: 'muted small' }, '0 means no limit.')));
    } else if (this.section === 'roles') {
      const grid = h('div', { class: 'priv-grid' });
      for (const p of s.available_privileges) grid.append(checkbox(p, e.global.includes(p), (on) => { e.global = on ? [...e.global, p] : e.global.filter((x) => x !== p); }));
      body.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('button', { class: 'btn small', onclick: () => { e.global = [...s.available_privileges]; this.renderDetail(); } }, 'Select All (DBA)'),
        h('button', { class: 'btn small', onclick: () => { e.global = []; this.renderDetail(); } }, 'Revoke All'),
        h('span', { class: 'muted small' }, 'Global privileges apply to all schemas (ON *.*).')), grid);
    } else if (this.section === 'schemas') {
      const names = s.schema_privilege_names || [];
      const list = h('div');
      e.schemas.forEach((sp, i) => {
        const g = h('div', { class: 'priv-grid' });
        for (const p of names) g.append(checkbox(p, sp.privileges.includes(p), (on) => { sp.privileges = on ? [...sp.privileges, p] : sp.privileges.filter((x) => x !== p); }));
        const schemaInput = h('input', { class: 'input', value: sp.schema, style: { width: '220px' } });
        schemaInput.addEventListener('input', () => { sp.schema = schemaInput.value; });
        list.append(h('div', { class: 'chart-card', style: { marginBottom: '10px' } },
          h('div', { class: 'row', style: { marginBottom: '8px' } }, icon('db'), h('b', null, 'Schema:'), schemaInput,
            h('button', { class: 'btn tiny', onclick: () => { sp.privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'SHOW VIEW']; this.renderDetail(); } }, 'Select DML'),
            h('button', { class: 'btn tiny', onclick: () => { sp.privileges = [...names]; this.renderDetail(); } }, 'All'),
            h('span', { class: 'flex1' }),
            h('button', { class: 'btn tiny', onclick: () => { e.schemas.splice(i, 1); this.renderDetail(); } }, 'Remove Entry')), g));
      });
      const schemas = this.ws.navigator.schemas.filter((x) => !x.system).map((x) => x.name);
      const pick = select([['', 'Choose schema...'], ...schemas.map((x) => [x, x]), ['%', '% (all schemas)']], '');
      body.append(h('div', { class: 'row', style: { marginBottom: '10px' } }, pick,
        h('button', { class: 'btn small', onclick: () => { if (!pick.value) return; e.schemas.push({ schema: pick.value, privileges: ['SELECT'] }); this.renderDetail(); } }, 'Add Entry...'),
        h('span', { class: 'muted small' }, 'Schema names may use the % and _ wildcards.')), list);
    } else {
      body.append(h('pre', { class: 'sql-pre' }, (s.grants || []).join(';\n') + (s.grants?.length ? ';' : '-- new account')));
    }
    this.detail.append(
      h('div', { class: 'panel-header' }, h('span', { class: 'panel-title' }, s.isNew ? 'New Account' : `Details for account ${s.user}@${s.host}`)),
      h('div', { class: 'toolbar' }, tabs), body,
      h('div', { class: 'editor-footer' },
        s.isNew ? null : h('button', { class: 'btn danger', onclick: () => this.dropAccount() }, 'Delete Account'),
        h('span', { class: 'flex1' }),
        h('button', { class: 'btn', onclick: () => (s.isNew ? this.showEmpty() : this.select(s)) }, 'Revert'),
        h('button', { class: 'btn primary', onclick: () => this.apply() }, 'Apply')));
  }

  acct(user, host) { return `${this.ws.sqlString(user)}@${this.ws.sqlString(host)}`; }

  async apply() {
    const e = this.edit, s = this.sel;
    if (!e.user.trim() && !confirm('Create an anonymous account?')) return;
    if (e.password !== e.confirm) { toast('The passwords do not match.', 'warning'); return; }
    const stmts = [];
    const acct = this.acct(e.user, e.host);
    if (s.isNew) {
      stmts.push(`CREATE USER ${acct}${e.password ? ` IDENTIFIED BY ${this.ws.sqlString(e.password)}` : ''}`);
    } else {
      if (e.user !== s.user || e.host !== s.host) stmts.push(`RENAME USER ${this.acct(s.user, s.host)} TO ${acct}`);
      if (e.password) stmts.push(`ALTER USER ${acct} IDENTIFIED BY ${this.ws.sqlString(e.password)}`);
    }
    const oldLim = s.isNew ? { max_questions: 0, max_updates: 0, max_connections: 0, max_user_connections: 0 } : s.limits;
    if (JSON.stringify(oldLim) !== JSON.stringify(e.limits)) {
      stmts.push(`ALTER USER ${acct} WITH MAX_QUERIES_PER_HOUR ${e.limits.max_questions} MAX_UPDATES_PER_HOUR ${e.limits.max_updates} MAX_CONNECTIONS_PER_HOUR ${e.limits.max_connections} MAX_USER_CONNECTIONS ${e.limits.max_user_connections}`);
    }
    const diff = (oldP, newP) => ({ add: newP.filter((p) => !oldP.includes(p)), del: oldP.filter((p) => !newP.includes(p)) });
    const privSql = (target, oldP, newP) => {
      const d = diff(oldP, newP);
      const add = d.add.filter((p) => p !== 'GRANT OPTION');
      const del = d.del.filter((p) => p !== 'GRANT OPTION');
      if (add.length) stmts.push(`GRANT ${add.join(', ')} ON ${target} TO ${acct}`);
      if (d.add.includes('GRANT OPTION')) stmts.push(`GRANT USAGE ON ${target} TO ${acct} WITH GRANT OPTION`);
      if (del.length) stmts.push(`REVOKE ${del.join(', ')} ON ${target} FROM ${acct}`);
      if (d.del.includes('GRANT OPTION')) stmts.push(`REVOKE GRANT OPTION ON ${target} FROM ${acct}`);
    };
    privSql('*.*', s.isNew ? [] : s.global_privileges, e.global);
    const oldSchemas = s.isNew ? [] : s.schema_privileges;
    const target = (schema) => `${this.ws.quoteIdent(schema)}.*`;
    for (const sp of e.schemas) {
      if (!sp.schema) continue;
      const old = oldSchemas.find((x) => x.schema === sp.schema);
      privSql(target(sp.schema), old ? old.privileges : [], sp.privileges);
    }
    for (const old of oldSchemas) if (!e.schemas.some((x) => x.schema === old.schema)) privSql(target(old.schema), old.privileges, []);
    if (!stmts.length) { toast('No changes to apply.', 'info'); return; }
    if (await reviewAndApply(this.ws, stmts.map((x) => x + ';'), { title: 'Apply Account Changes' })) {
      this.sel = { user: e.user, host: e.host, isNew: false };
      await this.load();
    }
  }

  async dropAccount() {
    const s = this.sel;
    if (!(await confirmDialog('Delete Account', `Delete the account ${s.user}@${s.host}? This cannot be undone.`, { danger: true, okLabel: 'Delete' }))) return;
    if (await reviewAndApply(this.ws, [`DROP USER ${this.acct(s.user, s.host)};`], { title: 'Delete Account' })) {
      this.sel = null;
      this.load();
    }
  }
}

// ---------------------------------------------------------------------------- data export / import
async function pollJob(job, ui) {
  for (;;) {
    let r;
    try { r = await api.get('/jobs/' + job.id); } catch (e) { ui.status.textContent = e.message; return null; }
    const j = r.job;
    ui.bar.style.width = Math.round(j.progress * 100) + '%';
    ui.status.textContent = j.status === 'error' ? 'Error: ' + j.error : j.message;
    ui.log.textContent = j.log.join('\n');
    ui.log.scrollTop = ui.log.scrollHeight;
    if (j.status !== 'running') return j;
    await new Promise((res) => setTimeout(res, 400));
  }
}

function progressUi() {
  const bar = h('div', { style: { width: '0%' } });
  const status = h('div', { class: 'muted' }, 'Ready.');
  const log = h('div', { class: 'job-log' });
  return { bar, status, log, el: h('div', { class: 'form' }, h('h3', null, 'Progress'), h('div', { class: 'progress' }, bar), status, log) };
}

class ExportPage extends AdminPage {
  constructor(ws, opts) {
    super(ws, 'Data Export', 'dumpOut');
    this.opts = opts || {};
    this.page = h('div', { class: 'admin-page' });
    this.el.append(this.page);
  }

  setOptions(opts) { if (opts?.schema) { this.opts = opts; this.load(); } }

  async load() {
    const ws = this.ws;
    const schemas = ws.navigator.schemas.filter((s) => !s.system).map((s) => s.name);
    let schema = this.opts.schema || ws.currentSchema || schemas[0] || 'main';
    if (!schemas.includes(schema) && schemas.length) schema = schemas[0];
    const schemaSel = select(schemas, schema, (v) => { schema = v; fillTables(); });
    const tableList = h('div', { class: 'check-list' });
    const fillTables = async () => {
      tableList.innerHTML = '';
      tableList.append(h('div', { class: 'muted' }, icon('spinner'), ' Loading...'));
      try {
        const o = await ws.navigator.loadSchema(schema);
        tableList.innerHTML = '';
        for (const t of [...o.tables, ...o.views]) tableList.append(checkbox(`${t.name}${t.type === 'VIEW' ? ' (view)' : ''}`, true, null, { dataset: { name: t.name } }));
        if (!o.tables.length && !o.views.length) tableList.append(h('div', { class: 'muted' }, 'This schema has no tables.'));
      } catch (e) { tableList.innerHTML = ''; tableList.append(h('div', { class: 'error-box' }, e.message)); }
    };
    fillTables();
    const content = select([['both', 'Dump Structure and Data'], ['data', 'Dump Data Only'], ['structure', 'Dump Structure Only']], 'both');
    const mysql = ws.driver === 'mysql';
    const routines = checkbox('Dump Stored Procedures and Functions', true);
    const triggers = checkbox('Dump Triggers', true);
    const createSchema = checkbox('Include Create Schema', true);
    const drop = checkbox('Add DROP statements before CREATE', true);
    const path = h('input', { class: 'input', placeholder: 'Choose an output file...' });
    const ui = progressUi();
    const start = h('button', { class: 'btn primary', onclick: async () => {
      if (!path.value) { toast('Choose the export file first.', 'warning'); return; }
      const tables = [...tableList.querySelectorAll('input:checked')].map((x) => x.dataset.name);
      if (!tables.length) { toast('Select at least one table.', 'warning'); return; }
      start.disabled = true;
      try {
        const r = await api.post(`/sessions/${ws.sid}/export`, {
          path: path.value, schema, tables, content: content.value, include_routines: routines.querySelector('input').checked,
          include_triggers: triggers.querySelector('input').checked, create_schema: mysql && createSchema.querySelector('input').checked,
          drop_objects: drop.querySelector('input').checked,
        });
        const j = await pollJob(r.job, ui);
        if (j?.status === 'done') {
          ui.status.textContent = `Export completed: ${j.result.tables} table(s), ${formatNumber(j.result.rows)} row(s), ${formatBytes(j.result.bytes)} written to ${j.result.path}`;
          ws.logOutput({ action: `Data export of ${schema}`, ok: true, message: ui.status.textContent });
        }
      } catch (e) { toast(e.message, 'error'); }
      start.disabled = false;
    } }, 'Start Export');
    const all = (on) => tableList.querySelectorAll('input').forEach((x) => { x.checked = on; });
    this.page.innerHTML = '';
    this.page.append(
      h('h2', null, icon('dumpOut', 'big'), 'Data Export'),
      h('div', { class: 'export-layout' },
        h('div', { class: 'form' }, h('h3', null, 'Tables to Export'), field(mysql ? 'Schema:' : 'Database:', schemaSel), tableList,
          h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => all(true) }, 'Select All'), h('button', { class: 'btn small', onclick: () => all(false) }, 'Unselect All'))),
        h('div', { class: 'form' }, h('h3', null, 'Export Options'), field('Content:', content),
          mysql ? routines : null, triggers, mysql ? createSchema : null, drop,
          h('h3', null, 'Export to Self-Contained File'),
          h('div', { class: 'row' }, path, h('button', { class: 'btn small', onclick: async () => {
            try {
              const p = await pickSaveFile('Export to File', `${schema}_dump_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.sql`, [['SQL Files', '*.sql'], ['All Files', '*.*']], 'sql');
              if (p) path.value = p;
            } catch (e) { toast(e.message, 'error'); }
          } }, 'Browse...')),
          h('div', { class: 'row' }, start), ui.el)));
  }
}

class ImportPage extends AdminPage {
  constructor(ws) {
    super(ws, 'Data Import', 'dumpIn');
    this.page = h('div', { class: 'admin-page' });
    this.el.append(this.page);
  }

  load() {
    const ws = this.ws;
    const mysql = ws.driver === 'mysql';
    const path = h('input', { class: 'input', placeholder: 'Choose a .sql dump file...' });
    const schemas = ws.navigator.schemas.filter((s) => !s.system).map((s) => s.name);
    const target = select([['', mysql ? '(as defined in the dump file / no default)' : 'main'], ...schemas.map((s) => [s, s])], mysql ? (ws.currentSchema || '') : '');
    const stop = checkbox('Stop on the first error', true);
    const ui = progressUi();
    const start = h('button', { class: 'btn primary', onclick: async () => {
      if (!path.value) { toast('Choose the file to import first.', 'warning'); return; }
      if (!(await confirmDialog('Start Import', `Run all statements in\n${path.value}\nagainst ${ws.profile.name}${target.value ? ' (default schema ' + target.value + ')' : ''}? Existing objects may be overwritten.`, { okLabel: 'Start Import' }))) return;
      start.disabled = true;
      try {
        const r = await api.post(`/sessions/${ws.sid}/import`, { path: path.value, schema: mysql ? target.value : null, stop_on_error: stop.querySelector('input').checked });
        const j = await pollJob(r.job, ui);
        if (j?.status === 'done') {
          const res = j.result;
          ui.status.textContent = `Import finished: ${formatNumber(res.executed)} statement(s) executed in ${res.seconds}s, ${res.errors.length} error(s).`;
          ws.logOutput({ action: `Data import from ${path.value}`, ok: !res.errors.length, message: ui.status.textContent });
          ws.navigator.refresh();
        }
      } catch (e) { toast(e.message, 'error'); }
      start.disabled = false;
    } }, 'Start Import');
    this.page.innerHTML = '';
    this.page.append(h('h2', null, icon('dumpIn', 'big'), 'Data Import / Restore'),
      h('div', { class: 'form', style: { maxWidth: '760px' } },
        h('h3', null, 'Import from Self-Contained File'),
        h('div', { class: 'row' }, path, h('button', { class: 'btn small', onclick: async () => {
          try { const p = await pickOpenFile('Import SQL File', [['SQL Files', '*.sql'], ['All Files', '*.*']]); if (p) path.value = p; } catch (e) { toast(e.message, 'error'); }
        } }, 'Browse...')),
        field(mysql ? 'Default Target Schema:' : 'Database:', target, mysql ? 'Used for statements that do not name a schema. Create a new schema first from the Navigator if needed.' : null),
        stop, h('div', { class: 'row' }, start), ui.el));
  }
}
