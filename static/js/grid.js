// Virtualized, editable data grid (result grid, variables, process list...).
import { esc, h } from './ui.js';

const ROW_H = 22;
const RN_W = 46;   // row-number column width

export function displayValue(v, maxLen = 400) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.$bin !== undefined) {
    if (v.size <= 16) return '0x' + v.$bin.toUpperCase();
    return `BLOB (${v.size.toLocaleString()} bytes)`;
  }
  let s = typeof v === 'string' ? v : String(v);
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

export function plainValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.$bin !== undefined) return '0x' + v.$bin.toUpperCase();
  return String(v);
}

// Sorting: each value's sort key is worked out once per sort (not on every comparison), and text is
// compared with one shared collator. Order: NULLs first, numbers by value, text in natural order.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortKey(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(v) ? Number(v) : NaN);
  return { v, n, s: String(plainValue(v)) };
}

function compareKeys(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a.v === b.v) return 0;
  if (!isNaN(a.n) && !isNaN(b.n)) return a.n - b.n;
  return collator.compare(a.s, b.s);
}

export class DataGrid {
  /**
   * opts: { editable, onEdit(row,col,value), onContextMenu(e, cell), onActivate(r,c), onSelectionChange,
   *         showNewRow, onNewRow(), wrap, rowNumbers }
   */
  constructor(container, opts = {}) {
    this.opts = opts;
    this.columns = [];
    this.rows = [];
    this.view = [];
    this.sort = null;          // {col, dir}
    this.filterText = '';
    this.active = { r: -1, c: -1 };  // r = view index (or view.length for "new row")
    this.selRows = new Set();  // view-index-independent: row objects
    this.editor = null;

    this.el = h('div', { class: 'dg', tabindex: '0' });
    this.scroll = h('div', { class: 'dg-scroll' });
    this.header = h('div', { class: 'dg-header' });
    this.canvas = h('div', { class: 'dg-canvas' });
    this.rowsEl = h('div', { class: 'dg-rows' });
    this.canvas.append(this.rowsEl);
    this.scroll.append(this.header, this.canvas);
    this.el.append(this.scroll);
    container.append(this.el);

    this.scroll.addEventListener('scroll', () => this.scheduleRender());
    this.ro = new ResizeObserver(() => this.scheduleRender());
    this.ro.observe(this.scroll);
    this.rowsEl.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.rowsEl.addEventListener('contextmenu', (e) => this.onContext(e));
    this.header.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  destroy() { this.ro.disconnect(); this.el.remove(); }

  // ---------------------------------------------------------------- data
  setData(columns, rows, { keepState = false } = {}) {
    this.columns = columns.map((c, i) => ({
      ...c,
      idx: i,
      width: c.width || this.measure(c, rows, i),
      align: c.align || (c.kind === 'num' || c.kind === 'bit' ? 'right' : 'left'),
    }));
    this.rows = rows.map((v) => ({ v: v.slice(), o: null, st: '', ch: null }));
    if (!keepState) { this.sort = null; this.active = { r: -1, c: -1 }; this.selRows.clear(); }
    this.rebuildView();
    this.renderHeader();
    this.scheduleRender(true);
  }

  measure(col, rows, i) {
    const ctx = DataGrid.ctx || (DataGrid.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    let w = ctx.measureText(col.name).width + 34;
    const n = Math.min(rows.length, 150);
    for (let r = 0; r < n; r++) {
      const s = col.display ? col.display(rows[r][i]) : displayValue(rows[r][i], 60);
      const tw = s === null ? 30 : ctx.measureText(s).width + 16;
      if (tw > w) w = tw;
    }
    return Math.max(56, Math.min(Math.ceil(w), 320));
  }

  rebuildView() {
    let idx = this.rows.map((_, i) => i);
    const f = this.filterText.trim().toLowerCase();
    if (f) {
      idx = idx.filter((i) => this.rows[i].st === 'new' || this.rows[i].v.some((v) => {
        const s = plainValue(v);
        return s !== null && s.toLowerCase().includes(f);
      }));
    }
    if (this.sort) {
      const { col, dir } = this.sort;
      const keys = new Array(this.rows.length);
      for (const i of idx) keys[i] = sortKey(this.rows[i].v[col]);
      idx.sort((a, b) => {
        const ra = this.rows[a], rb = this.rows[b];
        if (ra.st === 'new' && rb.st !== 'new') return 1;
        if (rb.st === 'new' && ra.st !== 'new') return -1;
        return compareKeys(keys[a], keys[b]) * dir || a - b;
      });
    }
    this.view = idx;
  }

  setFilter(text) {
    this.filterText = text || '';
    this.rebuildView();
    this.scheduleRender(true);
  }

  setSort(col, dir) {
    if (dir !== undefined) this.sort = dir ? { col, dir } : null;
    else if (!this.sort || this.sort.col !== col) this.sort = { col, dir: 1 };
    else if (this.sort.dir === 1) this.sort.dir = -1;
    else this.sort = null;
    this.rebuildView();
    this.renderHeader();
    this.scheduleRender(true);
  }

  get rowCount() { return this.view.length; }
  rowAt(viewIndex) { return this.rows[this.view[viewIndex]]; }

  // ---------------------------------------------------------------- editing model
  setCell(viewIndex, col, value) {
    const row = this.rowAt(viewIndex);
    if (!row) return;
    const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && plainValue(a) === plainValue(b));
    if (row.st === 'new') {
      row.v[col] = value;
      row.ch = row.ch || new Set();
      row.ch.add(col);
    } else {
      if (!row.o) row.o = row.v.slice();
      row.v[col] = value;
      row.ch = row.ch || new Set();
      if (same(row.o[col], value)) row.ch.delete(col); else row.ch.add(col);
      if (row.st !== 'del') row.st = row.ch.size ? 'mod' : '';
    }
    this.opts.onEdit?.(row, col, value);
    this.scheduleRender();
  }

  addRow(values) {
    const row = { v: values || this.columns.map(() => null), o: null, st: 'new', ch: new Set() };
    this.rows.push(row);
    this.rebuildView();
    const vi = this.view.indexOf(this.rows.length - 1);
    this.active = { r: vi, c: Math.max(0, this.firstEditableCol()) };
    this.scheduleRender(true);
    this.ensureVisible(vi, this.active.c);
    this.opts.onEdit?.(row, -1, null);
    return vi;
  }

  firstEditableCol() {
    const i = this.columns.findIndex((c) => c.editable && !c.auto_increment);
    return i >= 0 ? i : this.columns.findIndex((c) => c.editable);
  }

  deleteSelectedRows() {
    const targets = this.selRows.size ? [...this.selRows] : (this.rowAt(this.active.r) ? [this.rowAt(this.active.r)] : []);
    for (const row of targets) {
      if (row.st === 'new') {
        this.rows.splice(this.rows.indexOf(row), 1);
      } else {
        row.st = row.st === 'del' ? (row.ch?.size ? 'mod' : '') : 'del';
      }
    }
    this.selRows.clear();
    this.rebuildView();
    this.scheduleRender(true);
    this.opts.onEdit?.(null, -1, null);
  }

  revert() {
    this.rows = this.rows.filter((r) => r.st !== 'new');
    for (const r of this.rows) {
      if (r.o) r.v = r.o;
      r.o = null; r.st = ''; r.ch = null;
    }
    this.rebuildView();
    this.scheduleRender(true);
    this.opts.onEdit?.(null, -1, null);
  }

  /** Accept the current values as the new baseline (after Apply). */
  commitChanges() {
    this.rows = this.rows.filter((r) => r.st !== 'del');
    for (const r of this.rows) { r.o = null; r.st = ''; r.ch = null; }
    this.rebuildView();
    this.scheduleRender(true);
  }

  hasChanges() { return this.rows.some((r) => r.st); }

  // ---------------------------------------------------------------- rendering
  renderHeader() {
    const parts = [`<div class="dg-hcell dg-rn" style="width:${RN_W}px"></div>`];
    let x = RN_W;
    this.colLeft = [];
    for (const c of this.columns) {
      this.colLeft.push(x);
      x += c.width;
      const sortMark = this.sort && this.sort.col === c.idx ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '';
      const keyMark = c.pk ? '<span class="dg-pk" title="Primary key">🔑</span>' : '';
      parts.push(`<div class="dg-hcell" data-c="${c.idx}" style="width:${c.width}px" title="${esc(c.name)}${c.type ? ' : ' + esc(c.type) : ''}">` +
        `${keyMark}<span class="dg-hname">${esc(c.name)}</span><span class="dg-sort">${sortMark}</span><span class="dg-resize" data-c="${c.idx}"></span></div>`);
    }
    this.totalWidth = x;
    this.header.innerHTML = parts.join('');
    this.header.style.width = x + 'px';
    this.canvas.style.width = x + 'px';
    this.header.querySelectorAll('.dg-hcell[data-c]').forEach((cell) => {
      cell.addEventListener('click', (e) => {
        if (e.target.classList.contains('dg-resize')) return;
        this.setSort(Number(cell.dataset.c));
      });
    });
    this.header.querySelectorAll('.dg-resize').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const ci = Number(handle.dataset.c);
        const startX = e.clientX, w0 = this.columns[ci].width;
        const move = (ev) => {
          this.columns[ci].width = Math.max(30, w0 + ev.clientX - startX);
          this.renderHeader();
          this.scheduleRender(true);
        };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      handle.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const ci = Number(handle.dataset.c);
        this.columns[ci].width = this.measure(this.columns[ci], this.view.map((i) => this.rows[i].v), ci);
        this.renderHeader();
        this.scheduleRender(true);
      });
    });
  }

  scheduleRender(force) {
    if (force) this.lastRange = null;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); });
  }

  totalRows() { return this.view.length + (this.opts.showNewRow?.() ? 1 : 0); }

  render() {
    const total = this.totalRows();
    const rh = this.opts.wrap ? ROW_H * 3 : ROW_H;
    this.rowH = rh;
    this.canvas.style.height = total * rh + 'px';
    const top = this.scroll.scrollTop;
    const height = this.scroll.clientHeight;
    const first = Math.max(0, Math.floor(top / rh) - 8);
    const last = Math.min(total, Math.ceil((top + height) / rh) + 8);
    const parts = [];
    const showNew = this.opts.showNewRow?.();
    for (let r = first; r < last; r++) {
      const isNewPlaceholder = showNew && r === this.view.length;
      const row = isNewPlaceholder ? null : this.rowAt(r);
      let cls = 'dg-row';
      if (r % 2) cls += ' odd';
      if (row?.st === 'new') cls += ' st-new';
      else if (row?.st === 'del') cls += ' st-del';
      if (isNewPlaceholder) cls += ' placeholder';
      if (row && this.selRows.has(row)) cls += ' selected';
      if (r === this.active.r) cls += ' active-row';
      const cells = [`<div class="dg-cell dg-rn" style="width:${RN_W}px">${isNewPlaceholder ? '*' : r + 1}</div>`];
      for (const c of this.columns) {
        let ccls = 'dg-cell';
        if (c.align === 'right') ccls += ' right';
        if (r === this.active.r && c.idx === this.active.c) ccls += ' active';
        if (row?.ch?.has(c.idx)) ccls += ' changed';
        let content;
        if (isNewPlaceholder) content = '<span class="nullv">NULL</span>';
        else {
          const v = row.v[c.idx];
          const d = c.display ? c.display(v) : displayValue(v, this.opts.wrap ? 2000 : 400);
          if (d === null) content = '<span class="nullv">NULL</span>';
          else if (typeof v === 'object' && v.$bin !== undefined && v.size > 16) content = `<span class="blobv">${esc(d)}</span>`;
          else content = esc(this.opts.wrap ? d : d.replace(/\r?\n/g, ' ↵ '));
        }
        cells.push(`<div class="${ccls}" data-c="${c.idx}" style="width:${c.width}px">${content}</div>`);
      }
      parts.push(`<div class="${cls}" data-r="${r}" style="top:${r * rh}px;height:${rh}px;width:${this.totalWidth}px">${cells.join('')}</div>`);
    }
    this.rowsEl.innerHTML = parts.join('');
    this.el.classList.toggle('wrap', !!this.opts.wrap);
  }

  // ---------------------------------------------------------------- interaction
  cellFromEvent(e) {
    const cell = e.target.closest('.dg-cell');
    const rowEl = e.target.closest('.dg-row');
    if (!rowEl) return null;
    const r = Number(rowEl.dataset.r);
    const c = cell && cell.dataset.c !== undefined ? Number(cell.dataset.c) : -1;
    return { r, c, rowNum: cell?.classList.contains('dg-rn') };
  }

  onMouseDown(e) {
    if (this.editor && !e.target.closest('.dg-editor')) this.commitEditor();
    const pos = this.cellFromEvent(e);
    if (!pos) return;
    this.el.focus({ preventScroll: true });
    // Rows are re-rendered on every click, so native dblclick never fires: detect it here.
    if (e.button === 0 && e.detail === 2 && pos.c >= 0 && !pos.rowNum) {
      e.preventDefault();
      this.onDblClick(e, pos);
      return;
    }
    if (e.button === 2) {
      if (pos.c >= 0) this.active = { r: pos.r, c: pos.c };
      const row = this.rowAt(pos.r);
      if (row && !this.selRows.has(row)) { this.selRows.clear(); }
      this.scheduleRender();
      return;
    }
    if (pos.rowNum) {
      const row = this.rowAt(pos.r);
      if (!row) return;
      if (e.shiftKey && this.anchorRow !== undefined) {
        const [a, b] = [Math.min(this.anchorRow, pos.r), Math.max(this.anchorRow, pos.r)];
        if (!e.ctrlKey) this.selRows.clear();
        for (let i = a; i <= b; i++) { const rr = this.rowAt(i); if (rr) this.selRows.add(rr); }
      } else if (e.ctrlKey) {
        if (this.selRows.has(row)) this.selRows.delete(row); else this.selRows.add(row);
        this.anchorRow = pos.r;
      } else {
        this.selRows.clear();
        this.selRows.add(row);
        this.anchorRow = pos.r;
      }
      this.active = { r: pos.r, c: Math.max(0, this.active.c) };
    } else {
      this.selRows.clear();
      this.active = { r: pos.r, c: pos.c };
      this.anchorRow = pos.r;
      if (this.opts.showNewRow?.() && pos.r === this.view.length) {
        this.addRow();
        return;
      }
    }
    this.opts.onSelectionChange?.(this.active);
    this.scheduleRender();
  }

  onDblClick(e, pos) {
    if (!pos || pos.c < 0) return;
    if (this.opts.showNewRow?.() && pos.r === this.view.length) return;
    if (this.canEdit(pos.r, pos.c)) this.startEdit(pos.r, pos.c);
    else this.opts.onActivate?.(pos.r, pos.c, this.rowAt(pos.r));
  }

  onContext(e) {
    const pos = this.cellFromEvent(e);
    this.opts.onContextMenu?.(e, pos);
  }

  canEdit(r, c) {
    if (!this.opts.editable?.()) return false;
    const col = this.columns[c];
    const row = this.rowAt(r);
    if (!col || !col.editable || !row || row.st === 'del') return false;
    const v = row.v[c];
    if (v && typeof v === 'object' && v.$bin !== undefined) return false;
    return true;
  }

  ensureVisible(r, c) {
    const rh = this.rowH || ROW_H;
    const top = r * rh;
    const headerH = this.header.offsetHeight;
    if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
    else if (top + rh > this.scroll.scrollTop + this.scroll.clientHeight - headerH) {
      this.scroll.scrollTop = top + rh - this.scroll.clientHeight + headerH;
    }
    if (c >= 0 && this.colLeft) {
      const left = this.colLeft[c] - RN_W;
      const right = this.colLeft[c] + this.columns[c].width;
      if (left < this.scroll.scrollLeft) this.scroll.scrollLeft = left;
      else if (right > this.scroll.scrollLeft + this.scroll.clientWidth) this.scroll.scrollLeft = right - this.scroll.clientWidth;
    }
  }

  move(dr, dc, { extend = false } = {}) {
    const total = this.view.length;
    if (!total || !this.columns.length) return;
    let { r, c } = this.active;
    if (r < 0) { r = 0; c = 0; } else {
      r = Math.max(0, Math.min(total - 1, r + dr));
      c = Math.max(0, Math.min(this.columns.length - 1, c + dc));
    }
    if (extend) {
      const row = this.rowAt(r);
      if (row) this.selRows.add(row);
    } else this.selRows.clear();
    this.active = { r, c };
    this.ensureVisible(r, c);
    this.opts.onSelectionChange?.(this.active);
    this.scheduleRender();
  }

  onKey(e) {
    if (this.editor) return;
    const page = Math.max(1, Math.floor(this.scroll.clientHeight / (this.rowH || ROW_H)) - 1);
    const k = e.key;
    if (k === 'ArrowDown') { this.move(1, 0, { extend: e.shiftKey }); e.preventDefault(); }
    else if (k === 'ArrowUp') { this.move(-1, 0, { extend: e.shiftKey }); e.preventDefault(); }
    else if (k === 'ArrowLeft') { this.move(0, -1); e.preventDefault(); }
    else if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) { this.move(0, 1); e.preventDefault(); }
    else if (k === 'Tab' && e.shiftKey) { this.move(0, -1); e.preventDefault(); }
    else if (k === 'PageDown') { this.move(page, 0); e.preventDefault(); }
    else if (k === 'PageUp') { this.move(-page, 0); e.preventDefault(); }
    else if (k === 'Home') { this.move(e.ctrlKey ? -1e9 : 0, -1e9); e.preventDefault(); }
    else if (k === 'End') { this.move(e.ctrlKey ? 1e9 : 0, 1e9); e.preventDefault(); }
    else if ((k === 'Enter' || k === 'F2') && this.active.r >= 0) {
      e.preventDefault();
      if (this.canEdit(this.active.r, this.active.c)) this.startEdit(this.active.r, this.active.c);
      else this.opts.onActivate?.(this.active.r, this.active.c, this.rowAt(this.active.r));
    } else if (k === 'c' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.opts.onCopy?.();
    } else if (k === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.view.forEach((i) => this.selRows.add(this.rows[i]));
      this.scheduleRender();
    } else if (k === 'Delete' && this.opts.editable?.() && this.selRows.size) {
      e.preventDefault();
      this.deleteSelectedRows();
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && this.active.r >= 0 && this.canEdit(this.active.r, this.active.c)) {
      this.startEdit(this.active.r, this.active.c, k);
      e.preventDefault();
    }
  }

  startEdit(r, c, initial) {
    this.ensureVisible(r, c);
    const row = this.rowAt(r);
    const col = this.columns[c];
    const v = row.v[c];
    const input = h('input', { class: 'dg-editor', spellcheck: false });
    input.value = initial !== undefined ? initial : (v === null ? '' : plainValue(v));
    input.style.top = r * (this.rowH || ROW_H) + 'px';
    input.style.left = this.colLeft[c] + 'px';
    input.style.width = Math.max(col.width, 80) + 'px';
    input.style.height = (this.rowH || ROW_H) + 'px';
    if (col.align === 'right') input.style.textAlign = 'right';
    this.canvas.append(input);
    this.editor = { input, r, c, wasNull: v === null && initial === undefined };
    input.focus();
    if (initial === undefined) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.commitEditor(); this.move(1, 0); this.el.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEditor(); this.el.focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); this.commitEditor(); this.move(0, e.shiftKey ? -1 : 1); this.el.focus(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => setTimeout(() => this.commitEditor(), 0));
  }

  commitEditor() {
    if (!this.editor) return;
    const { input, r, c, wasNull } = this.editor;
    this.editor = null;
    const text = input.value;
    input.remove();
    const row = this.rowAt(r);
    if (!row) return;
    const old = row.v[c];
    if (wasNull && text === '') return;      // left an untouched NULL alone
    const col = this.columns[c];
    let value = text;
    if ((col.kind === 'num' || col.kind === 'bit') && text.trim() !== '' && !isNaN(text) && /^-?\d{1,15}$/.test(text.trim())) value = Number(text);
    if (old !== null && plainValue(old) === text) return;
    this.setCell(r, c, value);
  }

  cancelEditor() {
    if (!this.editor) return;
    this.editor.input.remove();
    this.editor = null;
  }

  // ---------------------------------------------------------------- export helpers
  selectedRowObjects() {
    if (this.selRows.size) return this.view.map((i) => this.rows[i]).filter((r) => this.selRows.has(r));
    const r = this.rowAt(this.active.r);
    return r ? [r] : [];
  }

  visibleRows() { return this.view.map((i) => this.rows[i]); }
}
