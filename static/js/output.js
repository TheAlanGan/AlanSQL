// Output panel: Action Output (per statement log) + History Output (executed SQL by date).
import { contextMenu, copyText, esc, h, icon, iconSvg, select, toolButton } from './ui.js';
import { state } from './api.js';

export class OutputPanel {
  constructor(container, ws) {
    this.ws = ws;
    this.entries = [];
    this.counter = 0;
    this.mode = 'action';
    this.el = h('div', { class: 'output-panel' });
    this.modeSel = select([['action', 'Action Output'], ['history', 'History Output']], 'action', (v) => this.setMode(v), { class: 'input small' });
    this.historyFilter = h('input', { class: 'input small hidden', placeholder: 'Filter history', spellcheck: false });
    this.historyFilter.addEventListener('input', () => this.renderHistory());
    const header = h('div', { class: 'panel-header output-header' },
      h('span', { class: 'panel-title' }, 'Output'), this.modeSel, this.historyFilter, h('span', { class: 'flex1' }),
      toolButton('copy', 'Copy all output', () => this.copyAll()),
      toolButton('trash', 'Clear', () => this.clear()));
    this.table = h('div', { class: 'output-table' });
    this.head = h('div', { class: 'out-row out-head' },
      h('span', { class: 'oc-st' }), h('span', { class: 'oc-n' }, '#'), h('span', { class: 'oc-time' }, 'Time'),
      h('span', { class: 'oc-action' }, 'Action'), h('span', { class: 'oc-msg' }, 'Message'), h('span', { class: 'oc-dur' }, 'Duration / Fetch'));
    this.list = h('div', { class: 'out-list' });
    this.table.append(this.head, this.list);
    this.historyEl = h('div', { class: 'history-list hidden' });
    this.el.append(header, this.table, this.historyEl);
    container.append(this.el);
    this.list.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.out-row');
      const entry = row ? this.entries.find((x) => x.n === Number(row.dataset.n)) : null;
      contextMenu(e, [
        { label: 'Copy Action', disabled: !entry, action: () => copyText(entry.action) },
        { label: 'Copy Message', disabled: !entry, action: () => copyText(entry.message) },
        { label: 'Copy Row', disabled: !entry, action: () => copyText(this.rowText(entry)) },
        { label: 'Append Action to SQL Editor', disabled: !entry, action: () => this.ws.sendToEditor(entry.action) },
        '-',
        { label: 'Copy All', action: () => this.copyAll() },
        { label: 'Clear', action: () => this.clear() },
      ]);
    });
    this.list.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.out-row');
      const entry = row ? this.entries.find((x) => x.n === Number(row.dataset.n)) : null;
      if (entry) this.ws.sendToEditor(entry.action);
    });
    this.history = [];
    state.get('history-' + ws.profile.id, []).then((hst) => { this.history = hst || []; });
  }

  setMode(mode) {
    this.mode = mode;
    this.table.classList.toggle('hidden', mode !== 'action');
    this.historyEl.classList.toggle('hidden', mode !== 'history');
    this.historyFilter.classList.toggle('hidden', mode !== 'history');
    if (mode === 'history') this.renderHistory();
  }

  add({ action, status = 'running', message = '', ms, fetchMs }) {
    const entry = { n: ++this.counter, time: new Date(), action: action.replace(/\s+/g, ' ').trim(), status, message, ms, fetchMs };
    entry.el = h('div', { class: 'out-row', dataset: { n: entry.n } });
    this.entries.push(entry);
    if (this.entries.length > 1000) { const old = this.entries.shift(); old.el.remove(); }
    this.list.append(entry.el);
    this.renderEntry(entry);
    this.list.scrollTop = this.list.scrollHeight;
    return entry;
  }

  update(entry, fields) {
    Object.assign(entry, fields);
    this.renderEntry(entry);
    this.list.scrollTop = this.list.scrollHeight;
  }

  renderEntry(e) {
    const st = e.status === 'running' ? 'spinner' : e.status === 'ok' ? 'ok' : e.status === 'warning' ? 'warning' : 'error';
    const dur = e.ms !== undefined && e.ms !== null ? `${(e.ms / 1000).toFixed(4)} sec` + (e.fetchMs !== undefined ? ` / ${(e.fetchMs / 1000).toFixed(6)} sec` : '') : '';
    e.el.className = 'out-row st-' + e.status;
    e.el.innerHTML = `<span class="oc-st">${iconSvg(st)}</span><span class="oc-n">${e.n}</span>` +
      `<span class="oc-time">${e.time.toLocaleTimeString([], { hour12: false })}</span>` +
      `<span class="oc-action" title="${esc(e.action.slice(0, 2000))}">${esc(e.action.slice(0, 500))}</span>` +
      `<span class="oc-msg" title="${esc(e.message)}">${esc(e.message)}</span><span class="oc-dur">${dur}</span>`;
  }

  rowText(e) {
    return [e.n, e.time.toLocaleTimeString([], { hour12: false }), e.action, e.message, e.ms !== undefined ? (e.ms / 1000).toFixed(4) + ' sec' : ''].join('\t');
  }

  copyAll() {
    if (this.mode === 'history') copyText(this.history.map((x) => `-- ${new Date(x.t).toLocaleString()}\n${x.sql};`).join('\n'));
    else copyText(this.entries.map((e) => this.rowText(e)).join('\n'));
  }

  clear() {
    if (this.mode === 'history') {
      this.history = [];
      state.set('history-' + this.ws.profile.id, this.history);
      this.renderHistory();
    } else {
      this.entries.forEach((e) => e.el.remove());
      this.entries = [];
    }
  }

  addHistory(sql) {
    const s = sql.trim();
    if (!s) return;
    this.history.push({ t: Date.now(), sql: s.length > 20000 ? s.slice(0, 20000) : s });
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    state.set('history-' + this.ws.profile.id, this.history, 2000);
    if (this.mode === 'history') this.renderHistory();
  }

  renderHistory() {
    const f = this.historyFilter.value.trim().toLowerCase();
    this.historyEl.innerHTML = '';
    let lastDay = '';
    const items = this.history.filter((x) => !f || x.sql.toLowerCase().includes(f)).slice(-500).reverse();
    if (!items.length) { this.historyEl.append(h('div', { class: 'muted pad' }, 'No history yet.')); return; }
    for (const it of items) {
      const d = new Date(it.t);
      const day = d.toLocaleDateString();
      if (day !== lastDay) { this.historyEl.append(h('div', { class: 'hist-day' }, day)); lastDay = day; }
      const row = h('div', { class: 'hist-row', title: 'Double-click to append to the SQL editor' },
        h('span', { class: 'hist-time' }, d.toLocaleTimeString([], { hour12: false })), h('span', { class: 'hist-sql' }, it.sql.replace(/\s+/g, ' ')));
      row.addEventListener('dblclick', () => this.ws.sendToEditor(it.sql + ';'));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Append to SQL Editor', action: () => this.ws.sendToEditor(it.sql + ';') },
        { label: 'Copy', icon: 'copy', action: () => copyText(it.sql) },
      ]));
      this.historyEl.append(row);
    }
  }
}

export { icon };
