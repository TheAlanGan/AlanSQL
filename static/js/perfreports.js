// Performance Reports (MySQL / MariaDB), like Workbench's: reports from the server's sys schema,
// grouped by category, shown in a sortable grid with readable times and sizes.
import { api } from './api.js';
import { saveTextFile } from './files.js';
import { DataGrid } from './grid.js';
import { confirmDialog, copyText, formatBytes, h, icon, select, toast, toolButton } from './ui.js';

const LIMITS = [[100, '100 rows'], [1000, '1,000 rows'], [10000, '10,000 rows']];

function fmtTime(s) {
  if (s === null || s === undefined || s === '') return null;
  const v = Number(s);
  if (!isFinite(v)) return String(s);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 1e-6) return (v * 1e9).toFixed(0) + ' ns';
  if (a < 1e-3) return (v * 1e6).toFixed(2) + ' µs';
  if (a < 1) return (v * 1e3).toFixed(2) + ' ms';
  if (a < 60) return v.toFixed(2) + ' s';
  if (a < 3600) return (v / 60).toFixed(2) + ' min';
  if (a < 86400) return (v / 3600).toFixed(2) + ' h';
  return (v / 86400).toFixed(2) + ' d';
}

function fmtNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (typeof v === 'string' && (v.trim() === '' || isNaN(n))) return v;
  return n.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
}

const DISPLAY = {
  time: fmtTime,
  bytes: (v) => (v === null || v === undefined ? null : (Number(v) < 0 ? '-' : '') + formatBytes(Math.abs(Number(v)))),
  ratio: (v) => (v === null || v === undefined ? null : (Number(v) * 100).toFixed(2) + ' %'),
  pct: (v) => (v === null || v === undefined ? null : Number(v).toFixed(2) + ' %'),
  num: fmtNum,
};
const UNITS = { time: ' (seconds)', bytes: ' (bytes)' };

export class PerfReportsPage {
  constructor(ws) {
    this.ws = ws;
    this.title = 'Performance Reports';
    this.icon = 'gauge';
    this.limit = 1000;
    this.current = null;
    this.result = null;
    this.el = h('div', { class: 'doc' });
    this.nav = h('div', { class: 'perf-nav' });
    this.banner = h('div', { class: 'perf-banner hidden' });
    this.head = h('div', { class: 'perf-head' });
    this.info = h('span', { class: 'tb-text muted' });
    const limitSel = select(LIMITS, this.limit, (v) => { this.limit = Number(v); if (this.current) this.show(this.current); });
    this.gridHost = h('div', { class: 'grid-host perf-grid' });
    this.empty = h('div', { class: 'perf-empty hidden' });
    this.el.append(h('div', { class: 'perf-layout' }, this.nav,
      h('div', { class: 'perf-main' }, this.banner, this.head,
        h('div', { class: 'toolbar' },
          toolButton('refresh', 'Run the report again', () => this.current && this.show(this.current), { label: 'Refresh' }),
          h('span', { class: 'tb-text muted' }, 'Show'), limitSel, h('span', { class: 'tb-sep' }),
          toolButton('copy', 'Copy the SQL this report runs', () => { if (this.result) { copyText(this.result.sql); toast('Query copied', 'success', 1200); } }, { label: 'Copy Query' }),
          toolButton('export', 'Export the report as CSV', () => this.exportCsv(), { label: 'Export...' }),
          h('span', { class: 'tb-sep' }),
          toolButton('trash', 'Reset the collected Performance Schema statistics', () => this.reset(), { label: 'Reset Statistics...' }),
          h('span', { class: 'flex1' }), this.info),
        this.empty, this.gridHost)));
    this.grid = new DataGrid(this.gridHost, {
      onActivate: (r, c, row) => { const v = row.v[c]; copyText(String(v ?? '')); toast('Copied', 'success', 1000); },
    });
  }

  async load() {
    this.nav.innerHTML = '';
    this.nav.append(h('div', { class: 'pad muted' }, icon('spinner'), ' Loading...'));
    try {
      this.status = await api.get(`/sessions/${this.ws.sid}/perf/status`);
    } catch (e) {
      this.nav.innerHTML = '';
      this.nav.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
      return;
    }
    this.renderNav();
    const st = this.status;
    if (!st.sys_version) {
      this.setBanner('error', 'This server has no sys schema, so only the reports that read information_schema work. MySQL 5.7+ and MariaDB 10.6+ include it.');
    }
    const first = st.reports.find((r) => r.id === (st.performance_schema ? 'statement_analysis' : 'largest_tables') && r.available)
      || st.reports.find((r) => r.available);
    if (first) this.show(first);
  }

  renderNav() {
    const st = this.status;
    this.nav.innerHTML = '';
    this.nav.append(h('div', { class: 'perf-nav-status' },
      h('div', null, st.performance_schema ? icon('ok') : icon('warning'), ` Performance Schema: ${st.performance_schema ? 'on' : 'off'}`),
      h('div', { class: 'muted' }, st.sys_version ? `sys schema ${st.sys_version}` : 'no sys schema')));
    let cat = null;
    for (const r of st.reports) {
      if (r.category !== cat) {
        cat = r.category;
        this.nav.append(h('div', { class: 'perf-cat' }, cat));
      }
      const dim = !r.available || (r.needs_ps && !st.performance_schema);
      const item = h('div', {
        class: 'perf-item' + (dim ? ' dim' : '') + (this.current?.id === r.id ? ' selected' : ''),
        title: !r.available ? r.reason : r.needs_ps && !st.performance_schema ? 'Needs the Performance Schema, which is off on this server' : r.description,
      }, r.title);
      if (r.available) item.addEventListener('click', () => this.show(r));
      r.el = item;
      this.nav.append(item);
    }
  }

  setBanner(kind, ...content) {
    this.banner.className = 'perf-banner ' + kind;
    this.banner.innerHTML = '';
    this.banner.append(icon(kind === 'error' ? 'error' : 'warning'), h('div', null, ...content));
  }

  async show(r) {
    this.current = r;
    this.nav.querySelectorAll('.perf-item.selected').forEach((x) => x.classList.remove('selected'));
    r.el?.classList.add('selected');
    this.head.innerHTML = '';
    this.head.append(h('h2', null, r.title), h('div', { class: 'muted' }, r.description));
    if (r.needs_ps && !this.status.performance_schema) {
      this.setBanner('warn',
        h('b', null, 'The Performance Schema is turned off on this server'),
        `, so this report has no data${this.status.is_mariadb ? ' (it is off by default in MariaDB)' : ''}. To turn it on, add `,
        h('code', null, 'performance_schema=ON'), ' to the ', h('code', null, '[mysqld]'),
        ' section of the server\'s my.ini / my.cnf and restart the server. Reports that are not greyed out in the list work without it.');
    } else if (this.status.sys_version) {
      this.banner.className = 'perf-banner hidden';
    }
    this.info.textContent = 'Running...';
    try {
      const res = await api.get(`/sessions/${this.ws.sid}/perf/report?id=${encodeURIComponent(r.id)}&limit=${this.limit}`);
      if (this.current !== r) return;
      this.result = res;
      const cols = res.columns.map((c) => ({
        name: c.name,
        kind: c.format && c.format !== 'sql' ? 'num' : 'str',
        display: DISPLAY[c.format],
        width: c.format === 'sql' ? 460 : undefined,
      }));
      this.grid.setData(cols, res.rows);
      const n = res.rows.length;
      this.info.textContent = `${n.toLocaleString()} row${n === 1 ? '' : 's'}${res.truncated ? ' (limit reached)' : ''} · ${res.ms} ms`;
      this.empty.classList.toggle('hidden', n > 0);
      this.empty.textContent = n ? '' : (r.needs_ps && !this.status.performance_schema)
        ? 'No data: the Performance Schema is off.'
        : 'No data yet. The server collects these statistics while it runs, so try again after some activity.';
    } catch (e) {
      if (this.current !== r) return;
      this.result = null;
      this.grid.setData([], []);
      this.info.textContent = '';
      this.empty.classList.remove('hidden');
      this.empty.textContent = '';
      this.empty.append(h('div', { class: 'error-box' }, icon('error'), ' ', e.message));
    }
  }

  async exportCsv() {
    const res = this.result;
    if (!res) return;
    const q = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = res.columns.map((c) => q(c.name + (UNITS[c.format] || ''))).join(',');
    const rows = this.grid.visibleRows().map((r) => r.v.map(q).join(','));
    const name = this.current.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const p = await saveTextFile([head, ...rows].join('\r\n') + '\r\n', `${name}.csv`, [['CSV Files', '*.csv'], ['All Files', '*.*']]);
    if (p) toast('Exported to ' + p, 'success');
  }

  async reset() {
    if (!this.status?.performance_schema) { toast('The Performance Schema is off on this server; there is nothing to reset.', 'info'); return; }
    const ok = await confirmDialog('Reset Statistics',
      'Clear all statistics the Performance Schema has collected (statement, I/O, wait and index statistics)? '
      + 'This affects every user of this server, not just DBCentral. Use it to measure a workload from a clean start.',
      { okLabel: 'Reset', danger: true });
    if (!ok) return;
    try {
      await api.post(`/sessions/${this.ws.sid}/perf/reset`, {});
      toast('Statistics reset.', 'success');
      if (this.current) this.show(this.current);
    } catch (e) { toast(e.message, 'error'); }
  }

  onShow() {}
  dispose() { this.grid?.destroy(); }
}
