// DDL editor for views, stored procedures, functions and triggers (create / alter).
import { api } from './api.js';
import { registerModel } from './completion.js';
import { reviewAndApply } from './review.js';
import { splitStatements } from './sqlparse.js';
import { h, icon, toast, toolButton } from './ui.js';

const LABEL = { view: 'View', procedure: 'Routine', function: 'Function', trigger: 'Trigger' };
const ICON = { view: 'view', procedure: 'procedure', function: 'func', trigger: 'trigger' };
const NAME_RE = /\b(VIEW|PROCEDURE|FUNCTION|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+))?)/i;

function unq(s) { return s.replace(/^[`"[]|[`"\]]$/g, ''); }

export class ObjectEditor {
  constructor(ws, objKind, schema, name, opts = {}) {
    this.ws = ws;
    this.kind = 'object-editor';
    this.objKind = objKind;
    this.schema = schema;
    this.objectName = name;
    this.table = opts.table || null;
    this.isNew = !name;
    this.title = `${name || 'new_' + objKind} - ${LABEL[objKind]}`;
    this.icon = ICON[objKind];
    this.id = 'oe-' + Date.now();
    this.el = h('div', { class: 'doc object-editor' });
  }

  template() {
    const ws = this.ws;
    const q = (n) => ws.qualify(this.schema, n);
    const mysql = ws.driver === 'mysql';
    const table = this.table || 'table_name';
    switch (this.objKind) {
      case 'view': return `CREATE VIEW ${q('new_view')} AS\nSELECT\n    *\nFROM ${q(table)};`;
      case 'procedure': return `CREATE PROCEDURE ${q('new_procedure')} (IN p_id INT)\nBEGIN\n    SELECT p_id;\nEND`;
      case 'function': return `CREATE FUNCTION ${q('new_function')} (p_value INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n    RETURN p_value * 2;\nEND`;
      case 'trigger':
        return mysql
          ? `CREATE TRIGGER ${q(table + '_BEFORE_INSERT')}\nBEFORE INSERT ON ${q(table)}\nFOR EACH ROW\nBEGIN\n    -- SET NEW.column = value;\nEND`
          : `CREATE TRIGGER ${q(table + '_after_insert')}\nAFTER INSERT ON ${ws.quoteIdent(table)}\nFOR EACH ROW\nBEGIN\n    SELECT 1;\nEND;`;
      default: return '';
    }
  }

  async load() {
    let text;
    try {
      if (this.isNew) text = this.template();
      else {
        const r = await api.get(`/sessions/${this.ws.sid}/ddl?schema=${encodeURIComponent(this.schema)}&name=${encodeURIComponent(this.objectName)}&type=${this.objKind}`);
        text = r.ddl.trim();
        this.originalDDL = text;
        if (this.objKind === 'view') text = this.prettyView(text);
        if (this.ws.driver === 'mysql') text = text.replace(/;\s*$/, '');
      }
    } catch (e) {
      this.el.append(h('div', { class: 'pad error-box' }, icon('error'), ' ', e.message));
      return;
    }
    this.build(text);
  }

  prettyView(ddl) {
    const m = /^([\s\S]*?\bVIEW\s+\S+(?:\s*\([^)]*\))?\s+AS\s+)([\s\S]*)$/i.exec(ddl);
    if (!m || !window.sqlFormatter) return ddl;
    try {
      const lang = this.ws.driver === 'mysql' ? (this.ws.info.is_mariadb ? 'mariadb' : 'mysql') : 'sqlite';
      const head = m[1].replace(/\s+AS\s+$/i, ' AS');
      return head + '\n' + window.sqlFormatter.format(m[2].replace(/;\s*$/, ''), { language: lang, keywordCase: 'upper', tabWidth: 4 }) + ';';
    } catch {
      return ddl;
    }
  }

  build(text) {
    this.el.innerHTML = '';
    this.nameLabel = h('span', { class: 'strong' });
    const toolbar = h('div', { class: 'toolbar' },
      toolButton('beautify', 'Beautify', () => this.beautify()),
      toolButton('search', 'Find', () => this.editor.getAction('actions.find').run()),
      h('span', { class: 'tb-sep' }),
      h('span', { class: 'tb-text' }, icon(this.icon), `${LABEL[this.objKind]}:`, this.nameLabel),
      h('span', { class: 'tb-text muted' }, `Schema: ${this.schema}`),
      h('span', { class: 'flex1' }),
      h('span', { class: 'tb-text muted small' }, this.isNew ? 'Edit the DDL and click Apply to create the object.' : 'Apply drops and re-creates the object with the new definition.'));
    this.host = h('div', { class: 'obj-editor-host' });
    const footer = h('div', { class: 'editor-footer' },
      h('button', { class: 'btn', onclick: () => this.editor.setValue(this.initial) }, 'Revert'),
      h('button', { class: 'btn primary', onclick: () => this.apply() }, 'Apply'));
    this.el.append(toolbar, this.host, footer);
    this.initial = text;
    this.model = window.monaco.editor.createModel(text, this.ws.driver === 'mysql' ? 'mysql' : 'sql');
    registerModel(this.model, this.ws);
    this.editor = window.monaco.editor.create(this.host, {
      model: this.model, automaticLayout: true, minimap: { enabled: false }, fontSize: this.ws.app.prefs.fontSize || 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace', scrollBeyondLastLine: false, tabSize: 4,
      theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs',
    });
    this.editor.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS, () => this.apply());
    this.model.onDidChangeContent(() => this.updateName());
    this.updateName();
  }

  updateName() {
    const m = NAME_RE.exec(this.model.getValue());
    this.nameLabel.textContent = m ? unq(m[2].split('.').pop().trim()) : '?';
  }

  beautify() {
    if (this.objKind === 'view') this.editor.setValue(this.prettyView(this.model.getValue()));
    else toast('Beautify is only available for views.', 'info');
  }

  qualifyName(text) {
    if (this.ws.driver !== 'mysql') return text;
    return text.replace(NAME_RE, (all, kw, name) => (name.includes('.') ? all : all.replace(name, `${this.ws.quoteIdent(this.schema)}.${name}`)));
  }

  async apply() {
    const raw = this.model.getValue();
    const parts = splitStatements(raw, { dialect: this.ws.driver, backslash: this.ws.backslash }).map((s) => s.text);
    if (!parts.length) { toast('Nothing to apply.', 'warning'); return; }
    const m = NAME_RE.exec(parts[0]);
    if (!m || !/^\s*CREATE\b/i.test(parts[0])) { toast(`The script must start with CREATE ${this.objKind.toUpperCase()}.`, 'warning'); return; }
    const stmts = [];
    const kw = this.objKind.toUpperCase();
    if (!this.isNew) stmts.push(`DROP ${kw} IF EXISTS ${this.ws.qualify(this.schema, this.objectName)}`);
    stmts.push(this.qualifyName(parts[0]), ...parts.slice(1));
    const ok = await reviewAndApply(this.ws, stmts, { title: `Apply ${LABEL[this.objKind]} Changes`, splitText: true });
    const newName = unq(m[2].split('.').pop().trim());
    if (!ok) {
      if (this.originalDDL) await this.restoreIfMissing();
      return;
    }
    this.isNew = false;
    this.objectName = newName;
    this.initial = raw;
    try {
      const r = await api.get(`/sessions/${this.ws.sid}/ddl?schema=${encodeURIComponent(this.schema)}&name=${encodeURIComponent(newName)}&type=${this.objKind}`);
      this.originalDDL = r.ddl.trim();
    } catch { /* ignore */ }
    this.title = `${newName} - ${LABEL[this.objKind]}`;
    this.ws.docs.setTitle(this.tab, this.title);
    this.ws.navigator.refreshSchema(this.schema);
  }

  async restoreIfMissing() {
    try {
      await api.get(`/sessions/${this.ws.sid}/ddl?schema=${encodeURIComponent(this.schema)}&name=${encodeURIComponent(this.objectName)}&type=${this.objKind}`);
    } catch {
      const r = await this.ws.runScript([this.qualifyName(this.originalDDL.replace(/;\s*$/, ''))]);
      if (r.ok) toast(`The new definition failed, so the original ${this.objKind} was restored.`, 'warning', 6000);
      else toast(`The original ${this.objKind} could not be restored: ${r.results[0]?.error}`, 'error', 8000);
      this.ws.navigator.refreshSchema(this.schema);
    }
  }

  onShow() { this.editor?.layout(); }

  dispose() { this.editor?.dispose(); this.model?.dispose(); }
}
