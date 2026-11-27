// SQL snippets: built-in templates + user snippets (persisted), shown in the right sidebar.
import { state } from './api.js';
import { confirmDialog, contextMenu, copyText, esc, h, icon, modal, promptDialog, select, toast, toolButton } from './ui.js';

const BUILTIN = {
  'DML Statements': [
    ['SELECT', 'SELECT *\nFROM table_name\nWHERE condition\nORDER BY column\nLIMIT 100;'],
    ['SELECT with JOIN', 'SELECT a.*, b.*\nFROM table_a a\nINNER JOIN table_b b ON b.a_id = a.id\nWHERE condition;'],
    ['SELECT with GROUP BY', 'SELECT column, COUNT(*) AS cnt\nFROM table_name\nGROUP BY column\nHAVING cnt > 1\nORDER BY cnt DESC;'],
    ['INSERT', 'INSERT INTO table_name (column1, column2)\nVALUES (value1, value2);'],
    ['INSERT ... SELECT', 'INSERT INTO target_table (column1, column2)\nSELECT column1, column2\nFROM source_table\nWHERE condition;'],
    ['UPDATE', 'UPDATE table_name\nSET column1 = value1\nWHERE condition;'],
    ['DELETE', 'DELETE FROM table_name\nWHERE condition;'],
    ['Common Table Expression', 'WITH cte AS (\n    SELECT column, COUNT(*) AS cnt\n    FROM table_name\n    GROUP BY column\n)\nSELECT *\nFROM cte\nWHERE cnt > 1;'],
    ['Window function', 'SELECT column,\n       ROW_NUMBER() OVER (PARTITION BY group_column ORDER BY sort_column) AS rn\nFROM table_name;'],
  ],
  'DDL Statements': [
    ['CREATE TABLE', 'CREATE TABLE table_name (\n    id INT NOT NULL AUTO_INCREMENT,\n    name VARCHAR(100) NOT NULL,\n    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    PRIMARY KEY (id)\n);'],
    ['ALTER TABLE add column', 'ALTER TABLE table_name\n    ADD COLUMN column_name VARCHAR(45) NULL AFTER other_column;'],
    ['CREATE INDEX', 'CREATE INDEX idx_name ON table_name (column1, column2);'],
    ['Foreign key', 'ALTER TABLE child_table\n    ADD CONSTRAINT fk_child_parent FOREIGN KEY (parent_id)\n    REFERENCES parent_table (id)\n    ON DELETE CASCADE ON UPDATE NO ACTION;'],
    ['CREATE VIEW', 'CREATE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;'],
    ['CREATE PROCEDURE', 'DELIMITER $$\nCREATE PROCEDURE procedure_name(IN p_id INT)\nBEGIN\n    SELECT * FROM table_name WHERE id = p_id;\nEND$$\nDELIMITER ;'],
    ['CREATE FUNCTION', 'DELIMITER $$\nCREATE FUNCTION function_name(p_value INT) RETURNS INT\nDETERMINISTIC\nBEGIN\n    RETURN p_value * 2;\nEND$$\nDELIMITER ;'],
    ['CREATE TRIGGER', 'DELIMITER $$\nCREATE TRIGGER trigger_name BEFORE INSERT ON table_name\nFOR EACH ROW\nBEGIN\n    SET NEW.created_at = NOW();\nEND$$\nDELIMITER ;'],
  ],
  'Management': [
    ['Show processlist', 'SHOW FULL PROCESSLIST;'],
    ['Table sizes', "SELECT table_name, engine, table_rows,\n       ROUND((data_length + index_length) / 1024 / 1024, 2) AS size_mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY size_mb DESC;"],
    ['Create user', "CREATE USER 'username'@'localhost' IDENTIFIED BY 'password';\nGRANT SELECT, INSERT, UPDATE, DELETE ON schema_name.* TO 'username'@'localhost';"],
    ['Show grants', 'SHOW GRANTS FOR CURRENT_USER();'],
    ['Server variables', "SHOW VARIABLES LIKE '%timeout%';"],
    ['InnoDB status', 'SHOW ENGINE INNODB STATUS;'],
    ['SQLite: tables', "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;"],
    ['SQLite: table info', "PRAGMA table_info('table_name');"],
  ],
};


const MINE = 'My Snippets';
const COLLAPSED_KEY = 'snippet-collapsed-folders';
const DRAG_TYPE = 'application/x-dbcentral-snippet';

// User snippets (saved queries), optionally in folders. Folders are one level deep; an empty
// folder is kept in its own list so it survives until it is deleted.
export class SnippetStore {
  constructor() {
    this.items = [];
    this.folders = [];
    this.listeners = new Set();
    this.ready = Promise.all([state.get('snippets', []), state.get('snippet-folders', [])]).then(([items, folders]) => {
      this.items = items || [];
      this.folders = folders || [];
      this.emit();
    });
  }

  emit() { this.listeners.forEach((fn) => fn()); }

  save() {
    state.set('snippets', this.items, 0);
    state.set('snippet-folders', this.folders, 0);
    this.emit();
  }

  folderNames() {
    return [...new Set([...this.folders, ...this.items.map((x) => x.folder).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  }

  async add(name, text, folder = '') {
    await this.ready;
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, text };
    if (folder) { item.folder = folder; if (!this.folders.includes(folder)) this.folders.push(folder); }
    this.items.push(item);
    this.save();
    return item;
  }

  update(id, { name, text, folder }) {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    if (name !== undefined) s.name = name;
    if (text !== undefined) s.text = text;
    if (folder !== undefined) {
      if (folder) { s.folder = folder; if (!this.folders.includes(folder)) this.folders.push(folder); } else delete s.folder;
    }
    this.save();
  }

  remove(id) {
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
  }

  addFolder(name) {
    if (!this.folderNames().includes(name)) { this.folders.push(name); this.save(); }
  }

  renameFolder(from, to) {
    for (const s of this.items) if (s.folder === from) s.folder = to;
    this.folders = [...new Set(this.folders.map((f) => (f === from ? to : f)))];
    this.save();
  }

  // Deletes the folder; its snippets move to the top level (or are deleted when deleteItems is set).
  removeFolder(name, deleteItems = false) {
    if (deleteItems) this.items = this.items.filter((s) => s.folder !== name);
    else for (const s of this.items) if (s.folder === name) delete s.folder;
    this.folders = this.folders.filter((f) => f !== name);
    this.save();
  }

  categories() { return [MINE, ...Object.keys(BUILTIN)]; }

  list(cat) {
    if (cat === MINE) return this.items.map((x) => ({ ...x, user: true }));
    return (BUILTIN[cat] || []).map(([name, text]) => ({ name, text }));
  }
}

// Save / edit dialog with name, folder and SQL. Returns the saved snippet or null.
export async function editSnippetDialog(store, s, { name: defName = '', text: defText = '', folder: defFolder = '' } = {}) {
  await store.ready;
  const listId = 'snippet-folders-' + Date.now();
  const name = h('input', { class: 'input wide', value: s?.name ?? defName });
  const folder = h('input', { class: 'input wide', value: s ? (s.folder || '') : defFolder, placeholder: 'None (top level). Type a new name to create a folder.', list: listId });
  const text = h('textarea', { class: 'input wide mono', rows: 10 });
  text.value = s?.text ?? defText;
  const ok = await modal({
    title: s ? 'Edit Snippet' : 'Save Snippet', width: 560,
    content: h('div', { class: 'form' },
      h('label', { class: 'form-label' }, 'Name'), name,
      h('label', { class: 'form-label' }, 'Folder'), folder, h('datalist', { id: listId }, ...store.folderNames().map((f) => h('option', { value: f }))),
      h('label', { class: 'form-label' }, 'SQL'), text),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }], closeValue: false,
  });
  if (!ok || !name.value.trim()) return null;
  const f = folder.value.trim();
  if (s) { store.update(s.id, { name: name.value.trim(), text: text.value, folder: f }); return s; }
  return store.add(name.value.trim(), text.value, f);
}

export class SnippetsPanel {
  constructor(container, ws) {
    this.ws = ws;
    this.store = ws.app.snippets;
    this.cat = localStorage.getItem('snippet-cat') || 'DML Statements';
    this.catSel = select(this.store.categories(), this.cat, (v) => this.setCat(v), { class: 'input small' });
    this.list = h('div', { class: 'snippet-list' });
    this.newFolderBtn = toolButton('folder', 'New folder for your snippets', () => this.newFolder(), { cls: 'mini' });
    container.append(h('div', { class: 'panel-header' }, h('span', { class: 'panel-title' }, 'SQL Snippets'), h('span', { class: 'flex1' }),
      this.newFolderBtn,
      toolButton('plus', 'Add a new snippet', () => this.edit(null), { cls: 'mini' })),
      h('div', { class: 'snippet-cat' }, this.catSel), this.list,
      h('div', { class: 'muted small pad' }, 'Click to insert at the cursor. Right-click for more options. Drag your snippets onto a folder to move them.'));
    // dropping on empty list space moves a snippet out of its folder
    this.list.addEventListener('dragover', (e) => { if (this.cat === MINE && e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault(); });
    this.list.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (id && this.cat === MINE) { e.preventDefault(); this.store.update(id, { folder: '' }); }
    });
    this.store.listeners.add(() => this.render());
    this.render();
  }

  setCat(v) {
    this.cat = v;
    this.catSel.value = v;
    localStorage.setItem('snippet-cat', v);
    this.render();
  }

  collapsed() { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { return new Set(); } }

  render() {
    this.list.innerHTML = '';
    const mine = this.cat === MINE;
    this.newFolderBtn.classList.toggle('hidden', !mine);
    const items = this.store.list(this.cat);
    if (!mine) {
      for (const s of items) this.list.append(this.row(s));
      if (!items.length) this.list.append(h('div', { class: 'muted pad' }, 'Empty'));
      return;
    }
    const folders = this.store.folderNames();
    if (!items.length && !folders.length) {
      this.list.append(h('div', { class: 'muted pad' }, 'No snippets yet. Use the ★ button in the SQL editor toolbar to save a statement, or + above.'));
      return;
    }
    const collapsed = this.collapsed();
    for (const s of items.filter((x) => !x.folder)) this.list.append(this.row(s));
    for (const f of folders) {
      const inside = items.filter((x) => x.folder === f);
      const open = !collapsed.has(f);
      const head = h('div', { class: 'snippet-folder' + (open ? '' : ' closed'), title: 'Click to open or close. Drop snippets here to move them into this folder.' },
        icon(open ? 'caretDown' : 'caretRight'), icon('folder'), h('span', { class: 'snippet-folder-name' }, f), h('span', { class: 'muted' }, String(inside.length)));
      head.addEventListener('click', () => {
        const set = this.collapsed();
        if (set.has(f)) set.delete(f); else set.add(f);
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
        this.render();
      });
      head.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'New Snippet in Folder...', icon: 'plus', action: () => this.edit(null, { folder: f }) },
        { label: 'Rename Folder...', icon: 'edit', action: () => this.renameFolder(f) },
        '-',
        { label: 'Delete Folder (keep snippets)', action: () => this.store.removeFolder(f) },
        { label: 'Delete Folder and Its Snippets...', icon: 'trash', action: () => this.deleteFolderWithItems(f, inside.length) },
      ]));
      head.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); head.classList.add('drop-over'); } });
      head.addEventListener('dragleave', () => head.classList.remove('drop-over'));
      head.addEventListener('drop', (e) => {
        head.classList.remove('drop-over');
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        this.store.update(id, { folder: f });
      });
      this.list.append(head);
      if (open) {
        for (const s of inside) this.list.append(this.row(s, true));
        if (!inside.length) this.list.append(h('div', { class: 'snippet-empty muted' }, 'Empty folder'));
      }
    }
  }

  row(s, nested = false) {
    const row = h('div', { class: 'snippet' + (nested ? ' nested' : ''), title: s.text }, icon('snippet'), h('div', { class: 'snippet-body' },
      h('div', { class: 'snippet-name' }, s.name), h('div', { class: 'snippet-text', html: esc(s.text.split('\n').slice(0, 2).join(' ')) })));
    row.addEventListener('click', () => this.ws.sendToEditor(s.text, { insert: true }));
    if (s.user) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(DRAG_TYPE, s.id); e.dataTransfer.effectAllowed = 'move'; });
    }
    const folders = this.store.folderNames();
    row.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Insert Snippet at Cursor', action: () => this.ws.sendToEditor(s.text, { insert: true }) },
      { label: 'Replace Current Text', action: () => { const t = this.ws.activeQueryTab(); t.insertText(s.text, { replaceAll: true }); } },
      { label: 'Execute Snippet', icon: 'bolt', action: () => { const t = this.ws.openQueryTab({ title: s.name, content: s.text }); t.run('all'); } },
      { label: 'Copy to Clipboard', icon: 'copy', action: () => copyText(s.text) },
      s.user ? '-' : null,
      s.user ? { label: 'Edit Snippet...', icon: 'edit', action: () => this.edit(s) } : null,
      s.user ? { label: 'Move to Folder', icon: 'folder', submenu: [
        ...folders.map((f) => ({ label: f, checked: s.folder === f, action: () => this.store.update(s.id, { folder: f }) })),
        folders.length ? '-' : null,
        { label: 'New Folder...', icon: 'plus', action: () => this.newFolder(s) },
        s.folder ? { label: 'Move Out of Folder', action: () => this.store.update(s.id, { folder: '' }) } : null,
      ] } : null,
      s.user ? { label: 'Delete Snippet', icon: 'trash', action: () => this.store.remove(s.id) } : null,
      !s.user ? '-' : null,
      !s.user ? { label: 'Save a Copy to My Snippets...', icon: 'star', action: () => this.edit(null, { name: s.name, text: s.text }) } : null,
    ]));
    return row;
  }

  async newFolder(moveSnippet) {
    const name = await promptDialog('New Folder', 'Folder name:', '', { okLabel: 'Create' });
    if (!name || !name.trim()) return;
    const f = name.trim();
    if (moveSnippet) this.store.update(moveSnippet.id, { folder: f });
    else this.store.addFolder(f);
    if (this.cat !== MINE) this.setCat(MINE);
  }

  async renameFolder(f) {
    const name = await promptDialog('Rename Folder', 'New name:', f, { okLabel: 'Rename' });
    if (!name || !name.trim() || name.trim() === f) return;
    if (this.store.folderNames().includes(name.trim())
      && !(await confirmDialog('Merge Folders', `A folder named "${name.trim()}" already exists. Move the snippets of "${f}" into it?`, { okLabel: 'Merge' }))) return;
    this.store.renameFolder(f, name.trim());
  }

  async deleteFolderWithItems(f, n) {
    if (!(await confirmDialog('Delete Folder', `Delete the folder "${f}" and the ${n} snippet${n === 1 ? '' : 's'} in it? This cannot be undone.`, { okLabel: 'Delete', danger: true }))) return;
    this.store.removeFolder(f, true);
  }

  async edit(s, defaults = {}) {
    const saved = await editSnippetDialog(this.store, s, defaults);
    if (!saved) return;
    if (!s && this.cat !== MINE) this.setCat(MINE);
    toast('Snippet saved', 'success', 1500);
  }
}
