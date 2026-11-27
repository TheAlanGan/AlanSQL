// ER diagram (reverse engineered from a schema): draggable tables, FK relationships, zoom, SVG/PNG export.
import { api } from './api.js';
import { saveTextFile } from './files.js';
import { contextMenu, esc, h, icon, toast, toolButton } from './ui.js';

const HEAD = 24, ROW = 18, PAD = 8;

export class ErdDoc {
  constructor(ws, schema) {
    this.ws = ws;
    this.kind = 'erd';
    this.schema = schema;
    this.title = `${schema} - ER Diagram`;
    this.icon = 'diagram';
    this.id = 'erd-' + Date.now();
    this.zoom = 1;
    this.keysOnly = false;
    this.storeKey = `erd:${ws.profile.id}:${schema}`;
    this.pos = JSON.parse(localStorage.getItem(this.storeKey) || '{}');
    this.el = h('div', { class: 'doc' });
    this.keysBtn = toolButton('key2', 'Show only key columns', () => { this.keysOnly = !this.keysOnly; this.keysBtn.classList.toggle('on', this.keysOnly); this.draw(); }, { label: 'Keys only' });
    this.zoomLabel = h('span', { class: 'tb-text muted' }, '100%');
    this.wrap = h('div', { class: 'erd-wrap' });
    this.el.append(h('div', { class: 'toolbar' },
      toolButton('refresh', 'Reload from database', () => this.load(), { label: 'Refresh' }),
      toolButton('diagram', 'Arrange tables automatically', () => { this.pos = {}; this.layout(true); this.draw(); this.save(); }, { label: 'Auto Layout' }),
      this.keysBtn, h('span', { class: 'tb-sep' }),
      toolButton('minus', 'Zoom out', () => this.setZoom(this.zoom / 1.2)), this.zoomLabel, toolButton('plus', 'Zoom in', () => this.setZoom(this.zoom * 1.2)),
      toolButton('search', 'Fit to window', () => this.fit()), h('span', { class: 'tb-sep' }),
      toolButton('export', 'Export the diagram as SVG', () => this.exportSvg(), { label: 'Export SVG' }),
      toolButton('save', 'Export the diagram as PNG', () => this.exportPng(), { label: 'Export PNG' }),
      h('span', { class: 'flex1' }), h('span', { class: 'tb-text muted' }, 'Drag tables to arrange them. Double-click a table to alter it.')),
    h('div', { class: 'editor-body' }, this.wrap));
    this.wrap.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
  }

  async load() {
    this.wrap.innerHTML = '';
    this.wrap.append(h('div', { class: 'pad muted' }, icon('spinner'), ' Reverse engineering schema...'));
    try {
      await this.ws.navigator.refreshSchema(this.schema);
      const o = await this.ws.navigator.loadSchema(this.schema);
      const fks = (await api.get(`/sessions/${this.ws.sid}/fks?schema=${encodeURIComponent(this.schema)}`)).fks;
      this.tables = [...o.tables.map((t) => ({ name: t.name, view: false })), ...o.views.map((t) => ({ name: t.name, view: true }))]
        .map((t) => ({ ...t, columns: o.columns[t.name] || [] }));
      this.fks = fks.filter((f) => (!f.ref_schema || f.ref_schema === this.schema) && this.tables.some((t) => t.name === f.ref_table));
      for (const t of this.tables) {
        const fkCols = new Set(this.fks.filter((f) => f.table === t.name).flatMap((f) => f.columns));
        t.fkCols = fkCols;
      }
      this.layout(false);
      this.draw();
    } catch (e) {
      this.wrap.innerHTML = '';
      this.wrap.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
    }
  }

  visibleCols(t) {
    return this.keysOnly ? t.columns.filter((c) => c.col_key === 'PRI' || t.fkCols.has(c.name)) : t.columns;
  }

  size(t) {
    const ctx = ErdDoc.ctx || (ErdDoc.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = '11.5px "Segoe UI", sans-serif';
    let w = ctx.measureText(t.name).width + 40;
    for (const c of this.visibleCols(t)) w = Math.max(w, ctx.measureText(c.name).width + ctx.measureText(c.column_type || '').width + 54);
    return { w: Math.min(Math.ceil(w), 340), h: HEAD + Math.max(1, this.visibleCols(t).length) * ROW + PAD };
  }

  layout(force) {
    const degree = new Map(this.tables.map((t) => [t.name, 0]));
    for (const f of this.fks) { degree.set(f.table, degree.get(f.table) + 1); degree.set(f.ref_table, (degree.get(f.ref_table) || 0) + 1); }
    const order = [...this.tables].sort((a, b) => degree.get(b.name) - degree.get(a.name) || a.name.localeCompare(b.name));
    const cols = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.4)));
    const colX = [];
    let x = 30;
    const sizes = new Map(order.map((t) => [t.name, this.size(t)]));
    for (let c = 0; c < cols; c++) {
      colX.push(x);
      let maxW = 0;
      for (let i = c; i < order.length; i += cols) maxW = Math.max(maxW, sizes.get(order[i].name).w);
      x += maxW + 70;
    }
    const colY = new Array(cols).fill(30);
    order.forEach((t, i) => {
      const c = i % cols;
      if (force || !this.pos[t.name]) this.pos[t.name] = { x: colX[c], y: colY[c] };
      colY[c] += sizes.get(t.name).h + 40;
    });
  }

  save() { localStorage.setItem(this.storeKey, JSON.stringify(this.pos)); }

  setZoom(z) {
    this.zoom = Math.max(0.2, Math.min(3, z));
    this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
    this.applyZoom();
  }

  applyZoom() {
    if (!this.svg) return;
    this.svg.setAttribute('width', Math.ceil(this.W * this.zoom));
    this.svg.setAttribute('height', Math.ceil(this.H * this.zoom));
  }

  fit() {
    if (!this.W) return;
    this.setZoom(Math.min(this.wrap.clientWidth / this.W, this.wrap.clientHeight / this.H, 1.5));
  }

  draw() {
    const NS = 'http://www.w3.org/2000/svg';
    const boxes = new Map();
    let W = 400, H = 300;
    for (const t of this.tables) {
      const p = this.pos[t.name] || { x: 30, y: 30 };
      const s = this.size(t);
      boxes.set(t.name, { ...p, ...s, t });
      W = Math.max(W, p.x + s.w + 60);
      H = Math.max(H, p.y + s.h + 60);
    }
    this.W = W; this.H = H; this.boxes = boxes;
    const parts = [`<svg xmlns="${NS}" class="erd-svg" viewBox="0 0 ${W} ${H}" width="${W * this.zoom}" height="${H * this.zoom}">`,
      '<defs><marker id="erd-one" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M6 0V10M9 0V10" stroke="#7b5ea7" stroke-width="1.4" fill="none"/></marker>',
      '<marker id="erd-many" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M0 6L11 0M0 6L11 6M0 6L11 12" stroke="#7b5ea7" stroke-width="1.3" fill="none"/></marker></defs>',
      '<g class="rels">'];
    for (const [i, f] of this.fks.entries()) parts.push(this.relPath(f, i));
    parts.push('</g>');
    for (const b of boxes.values()) {
      const t = b.t;
      const cols = this.visibleCols(t);
      parts.push(`<g class="erd-table" data-t="${esc(t.name)}" transform="translate(${b.x},${b.y})">`,
        `<rect class="body" width="${b.w}" height="${b.h}" rx="4"/>`,
        `<rect class="head" width="${b.w}" height="${HEAD}" rx="4" style="fill:${t.view ? '#9bb36b' : '#7fa6d3'}"/><rect class="head" y="${HEAD - 4}" width="${b.w}" height="4" style="fill:${t.view ? '#9bb36b' : '#7fa6d3'}"/>`,
        `<text class="title" x="8" y="16">${esc(t.name)}${t.view ? ' (view)' : ''}</text>`);
      cols.forEach((c, i) => {
        const y = HEAD + i * ROW + 14;
        const pk = c.col_key === 'PRI', fk = t.fkCols.has(c.name);
        const mark = pk ? '<circle cx="12" cy="-4" r="4" fill="#f5d36b" stroke="#b8860b"/>' : fk ? '<path d="M8 -4l4 -4 4 4 -4 4z" fill="#c9b6e4" stroke="#7b5ea7"/>' : `<path d="M8 -4l4 -4 4 4 -4 4z" fill="${c.nullable ? 'none' : '#6b9bd2'}" stroke="#3f6fa5"/>`;
        parts.push(`<g transform="translate(0,${y})">${mark}<text x="22" y="0" style="${pk ? 'font-weight:700' : ''}">${esc(c.name)}</text><text class="type" x="${b.w - 8}" y="0" text-anchor="end">${esc((c.column_type || '').toLowerCase().slice(0, 22))}</text></g>`);
      });
      if (!cols.length) parts.push(`<text class="type" x="8" y="${HEAD + 13}">${this.keysOnly ? '(no key columns)' : '(no columns)'}</text>`);
      parts.push('</g>');
    }
    parts.push('</svg>');
    this.wrap.innerHTML = parts.join('');
    this.svg = this.wrap.querySelector('svg');
    this.bind();
  }

  anchor(b, colName, side) {
    const cols = this.visibleCols(b.t);
    const i = cols.findIndex((c) => c.name === colName);
    const y = b.y + (i >= 0 ? HEAD + i * ROW + 10 : HEAD / 2);
    return { x: side === 'left' ? b.x : b.x + b.w, y };
  }

  relPath(f, i) {
    const a = this.boxes.get(f.table), b = this.boxes.get(f.ref_table);
    if (!a || !b) return '';
    let d;
    if (a === b) {
      const p = this.anchor(a, f.columns[0], 'right');
      const q = this.anchor(b, f.ref_columns[0], 'right');
      d = `M${p.x} ${p.y} C${p.x + 50} ${p.y} ${q.x + 50} ${q.y} ${q.x} ${q.y}`;
    } else {
      const aRight = a.x + a.w / 2 < b.x + b.w / 2;
      const p = this.anchor(a, f.columns[0], aRight ? 'right' : 'left');
      const q = this.anchor(b, f.ref_columns[0], aRight ? 'left' : 'right');
      const dx = Math.max(40, Math.abs(q.x - p.x) / 2) * (aRight ? 1 : -1);
      d = `M${p.x} ${p.y} C${p.x + dx} ${p.y} ${q.x - dx} ${q.y} ${q.x} ${q.y}`;
    }
    return `<path class="erd-rel" data-i="${i}" d="${d}" marker-start="url(#erd-many)" marker-end="url(#erd-one)"><title>${esc(`${f.table}.${f.columns.join(', ')} → ${f.ref_table}.${f.ref_columns.join(', ')} (${f.name})`)}</title></path>`;
  }

  bind() {
    this.svg.querySelectorAll('.erd-table').forEach((g) => {
      const name = g.dataset.t;
      g.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.svg.querySelectorAll('.erd-table.selected').forEach((x) => x.classList.remove('selected'));
        g.classList.add('selected');
        this.svg.querySelectorAll('.erd-rel').forEach((r) => {
          const f = this.fks[Number(r.dataset.i)];
          r.classList.toggle('hl', f.table === name || f.ref_table === name);
        });
        const start = { x: e.clientX, y: e.clientY };
        const p0 = { ...this.pos[name] };
        const move = (ev) => {
          this.pos[name] = { x: Math.max(0, p0.x + (ev.clientX - start.x) / this.zoom), y: Math.max(0, p0.y + (ev.clientY - start.y) / this.zoom) };
          g.setAttribute('transform', `translate(${this.pos[name].x},${this.pos[name].y})`);
          const b = this.boxes.get(name);
          b.x = this.pos[name].x; b.y = this.pos[name].y;
          this.svg.querySelectorAll('.erd-rel').forEach((r) => {
            const f = this.fks[Number(r.dataset.i)];
            if (f.table === name || f.ref_table === name) {
              const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
              tmp.innerHTML = this.relPath(f, Number(r.dataset.i));
              r.setAttribute('d', tmp.firstChild.getAttribute('d'));
            }
          });
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          this.save();
          const b = this.boxes.get(name);
          if (b.x + b.w + 60 > this.W || b.y + b.h + 60 > this.H) this.draw();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      g.addEventListener('dblclick', () => {
        const t = this.tables.find((x) => x.name === name);
        if (t.view) this.ws.openObjectEditor('view', this.schema, name);
        else this.ws.openTableEditor(this.schema, name);
      });
      g.addEventListener('contextmenu', (e) => {
        const t = this.tables.find((x) => x.name === name);
        contextMenu(e, [
          { label: 'Select Rows', icon: 'grid', action: () => this.ws.selectRows(this.schema, name) },
          t.view ? { label: 'Alter View...', icon: 'wrench', action: () => this.ws.openObjectEditor('view', this.schema, name) }
            : { label: 'Alter Table...', icon: 'wrench', action: () => this.ws.openTableEditor(this.schema, name) },
          t.view ? null : { label: 'Table Inspector', icon: 'infoOutline', action: () => this.ws.openInspector(this.schema, name) },
        ]);
      });
    });
  }

  svgText() {
    const style = `<style>.erd-table rect.body{fill:#fff;stroke:#5b7fa8;stroke-width:1.2}.erd-table text{font:11.5px "Segoe UI",Arial,sans-serif;fill:#1e2329}.erd-table text.title{font-weight:700;fill:#fff}.erd-table text.type{fill:#6b7380;font-size:10.5px}.erd-rel{fill:none;stroke:#7b5ea7;stroke-width:1.4}</style>`;
    return this.svg.outerHTML.replace(/width="[\d.]+" height="[\d.]+"/, `width="${this.W}" height="${this.H}"`).replace(/(<svg[^>]*>)/, `$1${style}<rect width="100%" height="100%" fill="#fff"/>`);
  }

  async exportSvg() {
    const p = await saveTextFile(this.svgText(), `${this.schema}_erd.svg`, [['SVG Image', '*.svg']]);
    if (p) toast('Diagram saved to ' + p, 'success');
  }

  async exportPng() {
    const svg = this.svgText();
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = this.W * scale; c.height = this.H * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${this.schema}_erd.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast('PNG downloaded to your Downloads folder.', 'success');
      });
    };
    img.src = url;
  }

  onShow() {}
}
