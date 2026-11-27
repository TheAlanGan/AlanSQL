// Shared UI helpers: element builder, modals, context menus, toasts, splitters, tab strips.
import { icon, iconSvg } from './icons.js';

export { icon, iconSvg };

const PROP_ATTRS = new Set(['value', 'checked', 'selected', 'disabled', 'readOnly', 'indeterminate', 'multiple']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (PROP_ATTRS.has(k)) el[k] = v;
      else if (v === false) continue;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  n = Number(n);
  if (!isFinite(n)) return '';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
}

export function formatNumber(n) {
  const x = Number(n);
  return isFinite(x) ? x.toLocaleString() : String(n ?? '');
}

export function formatDuration(sec) {
  sec = Math.floor(Number(sec) || 0);
  const d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (d || hh) parts.push(hh + 'h');
  if (d || hh || mm) parts.push(mm + 'm');
  parts.push(ss + 's');
  return parts.join(' ');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text);
  return Promise.resolve();
}

function fallbackCopy(text) {
  const ta = h('textarea', { style: { position: 'fixed', left: '-9999px' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

// ------------------------------------------------------------------ toasts
export function toast(message, kind = 'info', ms = 3500) {
  let host = document.getElementById('toast-host');
  if (!host) { host = h('div', { id: 'toast-host' }); document.body.append(host); }
  const t = h('div', { class: 'toast toast-' + kind }, icon(kind === 'error' ? 'error' : kind === 'success' ? 'ok' : kind === 'warning' ? 'warning' : 'info'), h('span', null, message));
  host.append(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 300); }, ms);
}

// ------------------------------------------------------------------ modals
let modalDepth = 0;

export function modal({ title, content, buttons, width = 460, className = '', onOpen, closeValue = null, resizable = false }) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay' });
    const body = h('div', { class: 'modal-body' });
    if (content) body.append(content);
    const footer = h('div', { class: 'modal-footer' });
    const box = h('div', { class: 'modal ' + className + (resizable ? ' resizable' : ''), style: { width: typeof width === 'number' ? width + 'px' : width }, role: 'dialog' });
    const header = h('div', { class: 'modal-header' }, h('span', { class: 'modal-title' }, title || ''),
      h('button', { class: 'modal-x', title: 'Close', onclick: () => close(closeValue) }, icon('close')));
    box.append(header, body, footer);
    overlay.append(box);
    modalDepth++;
    let closed = false;
    const ctrl = {
      box, body, footer,
      close,
      setBusy(b) { footer.querySelectorAll('button').forEach((x) => { x.disabled = b; }); box.classList.toggle('busy', b); },
      buttons: {},
    };
    function close(v) {
      if (closed) return;
      closed = true;
      modalDepth--;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    }
    (buttons || [{ label: 'OK', value: true, primary: true }]).forEach((b) => {
      if (b === '-') { footer.append(h('span', { class: 'flex1' })); return; }
      const btn = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') }, b.label);
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          let r;
          try { r = await b.onClick(ctrl); } catch (e) { toast(e.message || String(e), 'error'); return; }
          if (r === false) return;
          if (r !== undefined && r !== true) { close(r); return; }
        }
        close(b.value);
      });
      ctrl.buttons[b.key || b.label] = btn;
      footer.append(btn);
    });
    function onKey(e) {
      if (overlay !== document.querySelector('#overlay-root > .modal-overlay:last-child')) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(closeValue); }
      if (e.key === 'Enter' && !e.shiftKey) {
        const t = e.target;
        if (t.tagName === 'TEXTAREA' || t.closest?.('.monaco-editor') || t.tagName === 'BUTTON' || t.tagName === 'SELECT') return;
        const primary = footer.querySelector('.btn.primary');
        if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    // drag by header
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = box.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      box.style.position = 'fixed';
      box.style.margin = '0';
      const move = (ev) => {
        box.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - ox)) + 'px';
        box.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - oy)) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    document.getElementById('overlay-root').append(overlay);
    onOpen?.(ctrl);
    setTimeout(() => {
      const f = body.querySelector('[autofocus]') || body.querySelector('input:not([type=checkbox]):not([disabled]), select, textarea');
      if (f) { f.focus(); f.select?.(); } else footer.querySelector('.btn.primary')?.focus();
    }, 30);
  });
}

export function isModalOpen() { return modalDepth > 0; }

export function alertDialog(title, message, kind = 'info') {
  const content = h('div', { class: 'msg-dialog' }, icon(kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info', 'big'),
    h('div', { class: 'msg-text' }, message));
  return modal({ title, content, buttons: [{ label: 'OK', value: true, primary: true }] });
}

export function confirmDialog(title, message, { okLabel = 'OK', danger = false, cancelLabel = 'Cancel', extra } = {}) {
  const content = h('div', { class: 'msg-dialog' }, icon(danger ? 'warning' : 'info', 'big'),
    h('div', { class: 'msg-text' }, message));
  const buttons = [];
  if (extra) buttons.push(...extra);
  buttons.push({ label: cancelLabel, value: false }, { label: okLabel, value: true, primary: true, danger });
  return modal({ title, content, buttons, closeValue: false });
}

export function promptDialog(title, label, value = '', { okLabel = 'OK', placeholder = '', password = false } = {}) {
  const input = h('input', { type: password ? 'password' : 'text', value, placeholder, class: 'input wide' });
  const content = h('div', { class: 'form' }, h('label', { class: 'form-label' }, label), input);
  return modal({
    title, content, closeValue: null,
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, onClick: () => input.value }],
  });
}

// ------------------------------------------------------------------ context menus
let openMenus = [];

export function closeMenus() {
  openMenus.forEach((m) => m.remove());
  openMenus = [];
  document.querySelectorAll('.menubar-item.open').forEach((x) => x.classList.remove('open'));
}

function buildMenu(items, level) {
  const menu = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(h('div', { class: 'ctx-sep' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'ctx-header' }, it.header)); continue; }
    const row = h('div', { class: 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.checked ? ' checked' : '') },
      h('span', { class: 'ctx-icon' }, it.checked !== undefined ? h('span', { class: 'ctx-check' }, it.checked ? '✓' : '') : it.icon ? icon(it.icon) : ''),
      h('span', { class: 'ctx-label' }, it.label),
      h('span', { class: 'ctx-shortcut' }, it.shortcut || ''),
      it.submenu ? h('span', { class: 'ctx-arrow' }, icon('caretRight')) : null);
    if (it.submenu) {
      let sub = null;
      row.addEventListener('mouseenter', () => {
        openMenus.filter((m) => Number(m.dataset.level) > level).forEach((m) => m.remove());
        openMenus = openMenus.filter((m) => Number(m.dataset.level) <= level);
        const items2 = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
        sub = buildMenu(items2, level + 1);
        const r = row.getBoundingClientRect();
        placeMenu(sub, r.right - 2, r.top - 3, r.left);
      });
    } else {
      row.addEventListener('mouseenter', () => {
        openMenus.filter((m) => Number(m.dataset.level) > level).forEach((m) => m.remove());
        openMenus = openMenus.filter((m) => Number(m.dataset.level) <= level);
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        closeMenus();
        it.action?.();
      });
    }
    menu.append(row);
  }
  menu.dataset.level = level;
  return menu;
}

function placeMenu(menu, x, y, altX) {
  document.body.append(menu);
  openMenus.push(menu);
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width > window.innerWidth - 4) left = altX !== undefined ? altX - r.width + 2 : window.innerWidth - r.width - 4;
  if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
  menu.style.left = Math.max(2, left) + 'px';
  menu.style.top = top + 'px';
}

// Optional filter applied to every menu (used to hide actions the active connection can't do).
let menuFilter = null;
export function setMenuFilter(fn) { menuFilter = fn; }
function filterItems(items) {
  if (!menuFilter || !Array.isArray(items)) return items;
  const out = menuFilter(items).map((it) => (it && Array.isArray(it.submenu) ? { ...it, submenu: filterItems(it.submenu) } : it));
  // tidy separators left at the start/end or doubled
  return out.filter((it, i, a) => it !== '-' || (i > 0 && i < a.length - 1 && a[i - 1] !== '-'));
}

export function contextMenu(ev, items) {
  items = filterItems(items);
  ev.preventDefault?.();
  ev.stopPropagation?.();
  closeMenus();
  const menu = buildMenu(items, 0);
  placeMenu(menu, ev.clientX, ev.clientY);
}

export function dropdownMenu(anchor, items) {
  items = filterItems(items);
  closeMenus();
  const r = anchor.getBoundingClientRect();
  const menu = buildMenu(items, 0);
  placeMenu(menu, r.left, r.bottom);
  return menu;
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest?.('.ctx-menu') && !e.target.closest?.('.menubar-item')) closeMenus();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenus.length) closeMenus(); }, true);
window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());

// ------------------------------------------------------------------ splitters
// direction 'v' resizes width (vertical bar), 'h' resizes height (horizontal bar).
// `invert` when the resized element is after the handle (right/bottom panels).
export function splitter(handle, target, { direction = 'v', min = 80, max = 2000, invert = false, onResize, key } = {}) {
  handle.classList.add('splitter', direction === 'v' ? 'splitter-v' : 'splitter-h');
  if (key) {
    const saved = Number(localStorage.getItem('split:' + key));
    if (saved) target.style[direction === 'v' ? 'width' : 'height'] = saved + 'px';
  }
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = direction === 'v' ? e.clientX : e.clientY;
    const r = target.getBoundingClientRect();
    const size0 = direction === 'v' ? r.width : r.height;
    document.body.classList.add(direction === 'v' ? 'resizing-v' : 'resizing-h');
    const move = (ev) => {
      const pos = direction === 'v' ? ev.clientX : ev.clientY;
      let size = size0 + (pos - start) * (invert ? -1 : 1);
      const mx = typeof max === 'function' ? max() : max;
      size = Math.max(min, Math.min(mx, size));
      target.style[direction === 'v' ? 'width' : 'height'] = size + 'px';
      target.style.flex = 'none';
      onResize?.(size);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-v', 'resizing-h');
      if (key) {
        const rr = target.getBoundingClientRect();
        localStorage.setItem('split:' + key, Math.round(direction === 'v' ? rr.width : rr.height));
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ------------------------------------------------------------------ tab strip
export class TabStrip {
  constructor(container, { onSelect, onClose, onContextMenu, className = '', closable = true, addButton } = {}) {
    this.el = h('div', { class: 'tabstrip ' + className });
    this.list = h('div', { class: 'tabstrip-list' });
    this.el.append(this.list);
    if (addButton) {
      this.el.append(h('button', { class: 'tabstrip-add', title: addButton.title, onclick: addButton.onClick }, icon('plus')));
    }
    container.append(this.el);
    this.tabs = [];
    this.active = null;
    this.onSelect = onSelect;
    this.onClose = onClose;
    this.onContextMenu = onContextMenu;
    this.closable = closable;
    this.list.addEventListener('wheel', (e) => { if (e.deltaY) { this.list.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  }

  add(tab, { activate = true, after } = {}) {
    const el = h('div', { class: 'tab', title: tab.tooltip || tab.title });
    el.append(tab.icon ? icon(tab.icon) : '', h('span', { class: 'tab-title' }, tab.title));
    if (this.closable && tab.closable !== false) {
      el.append(h('button', { class: 'tab-close', title: 'Close', onclick: (e) => { e.stopPropagation(); this.onClose?.(tab); } }, icon('close')));
    }
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); if (this.closable && tab.closable !== false) this.onClose?.(tab); }
    });
    el.addEventListener('click', () => this.select(tab));
    el.addEventListener('contextmenu', (e) => this.onContextMenu?.(e, tab));
    tab.tabEl = el;
    const idx = after ? this.tabs.indexOf(after) + 1 : this.tabs.length;
    if (idx > 0 && idx < this.tabs.length) {
      this.tabs[idx - 1].tabEl.after(el);
      this.tabs.splice(idx, 0, tab);
    } else {
      this.list.append(el);
      this.tabs.push(tab);
    }
    if (activate) this.select(tab);
    return tab;
  }

  select(tab) {
    if (!tab) return;
    this.tabs.forEach((t) => t.tabEl.classList.toggle('active', t === tab));
    const prev = this.active;
    this.active = tab;
    tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (prev !== tab) this.onSelect?.(tab, prev);
  }

  remove(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.tabEl.remove();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.select(next);
      else this.onSelect?.(null, tab);
    }
  }

  setTitle(tab, title, tooltip) {
    tab.title = title;
    const t = tab.tabEl?.querySelector('.tab-title');
    if (t) t.textContent = title;
    if (tab.tabEl) tab.tabEl.title = tooltip || title;
  }

  setDirty(tab, dirty) {
    tab.tabEl?.classList.toggle('dirty', !!dirty);
  }
}

// ------------------------------------------------------------------ small widgets
export function toolButton(iconName, title, onClick, { label, cls = '', toggle = false } = {}) {
  const b = h('button', { class: 'tb-btn ' + cls + (label ? ' with-label' : ''), title, onclick: onClick, type: 'button' }, icon(iconName));
  if (label) b.append(h('span', { class: 'tb-label' }, label));
  if (toggle) b.classList.add('toggle');
  return b;
}

export function sep() { return h('span', { class: 'tb-sep' }); }

export function select(options, value, onChange, attrs = {}) {
  const s = h('select', { class: 'input', ...attrs });
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o];
    s.append(h('option', { value: v }, label));
  }
  if (value !== undefined) s.value = value;
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function checkbox(label, checked, onChange, attrs = {}) {
  const cb = h('input', { type: 'checkbox', checked: !!checked, ...attrs });
  if (onChange) cb.addEventListener('change', () => onChange(cb.checked));
  return h('label', { class: 'check' }, cb, h('span', null, label));
}

export function emptyState(iconName, title, text) {
  return h('div', { class: 'empty-state' }, icon(iconName, 'huge'), h('div', { class: 'empty-title' }, title), text ? h('div', { class: 'empty-text' }, text) : null);
}
