// SQL editor tab: Monaco editor + Workbench-like toolbar + result panel.
import { registerModel } from './completion.js';
import { SQL_FILTERS, addRecent, pickOpenFile, pickSaveFile, readFile, writeFile } from './files.js';
import { ResultPanel } from './results.js';
import { splitStatements, statementAt } from './sqlparse.js';
import { h, modal, select, sep, splitter, toast, toolButton } from './ui.js';

export const LIMITS = [[0, "Don't Limit"], [10, 'Limit to 10 rows'], [50, 'Limit to 50 rows'], [100, 'Limit to 100 rows'],
  [200, 'Limit to 200 rows'], [300, 'Limit to 300 rows'], [500, 'Limit to 500 rows'], [1000, 'Limit to 1000 rows'],
  [2000, 'Limit to 2000 rows'], [5000, 'Limit to 5000 rows'], [10000, 'Limit to 10000 rows'], [50000, 'Limit to 50000 rows']];

let tabCounter = 0;

export class QueryTab {
  constructor(ws, { title, content = '', path = null, id } = {}) {
    this.ws = ws;
    this.kind = 'query';
    this.id = id || 'q' + Date.now().toString(36) + (++tabCounter);
    this.title = title || 'Query ' + ws.nextQueryNumber();
    this.path = path;
    this.savedContent = path ? content : null;
    this.running = false;
    this.cancelRequested = false;
    this.icon = 'newSql';
    this.el = h('div', { class: 'doc query-tab' });
    this.buildToolbar();
    this.editorHost = h('div', { class: 'qt-editor' });
    this.split = h('div');
    this.resultsHost = h('div', { class: 'qt-results' });
    this.el.append(this.toolbar, this.editorHost, this.split, this.resultsHost);
    splitter(this.split, this.resultsHost, { direction: 'h', invert: true, min: 60, max: () => this.el.clientHeight - 80, key: 'qt-results' });
    this.results = new ResultPanel(this.resultsHost, this);
    this.createEditor(content);
    this.updateState();
  }

  // ----------------------------------------------------------------- setup
  buildToolbar() {
    const ws = this.ws;
    this.btn = {
      open: toolButton('open', 'Open a script file in this editor (Ctrl+O)', () => this.openFile()),
      save: toolButton('save', 'Save the script to a file (Ctrl+S)', () => this.save()),
      exec: toolButton('bolt', 'Execute the selected portion of the script or everything if there is no selection (Ctrl+Shift+Enter)', () => this.run('all')),
      execCur: toolButton('boltCursor', 'Execute the statement under the keyboard cursor (Ctrl+Enter)', () => this.run('current')),
      explain: toolButton('explain', 'Execute the EXPLAIN command on the statement under the cursor (Ctrl+Alt+X)', () => this.explain()),
      stop: toolButton('stop', 'Stop the query being executed', () => this.stop()),
      onError: toolButton('stopOnError', 'Toggle whether execution of the SQL script should continue after failed statements', () => ws.toggleContinueOnError()),
      commit: toolButton('commit', 'Commit the current transaction', () => ws.commit()),
      rollback: toolButton('rollback', 'Rollback the current transaction', () => ws.rollback()),
      autocommit: toolButton('autocommit', 'Toggle autocommit mode. When enabled, each statement will be committed immediately.', () => ws.setAutocommit(!ws.autocommit)),
      beautify: toolButton('beautify', 'Beautify/reformat the SQL script (Ctrl+B)', () => this.beautify()),
      find: toolButton('search', 'Show the Find panel for the editor (Ctrl+F)', () => this.editor.getAction('actions.find').run()),
      invisibles: toolButton('invisibles', 'Toggle display of invisible characters', () => this.toggleOption('invisibles')),
      wrap: toolButton('wrap', 'Toggle wrapping of long lines', () => this.toggleOption('wrap')),
      snippet: toolButton('star', 'Save the current statement or selection to the snippet list', () => this.saveSnippet()),
    };
    this.limitSel = select(LIMITS, ws.settings.limit, (v) => ws.setLimit(Number(v)), { title: 'Toggle limiting of number of rows returned by queries', class: 'input small limit-select' });
    const b = this.btn;
    this.toolbar = h('div', { class: 'toolbar qt-toolbar' },
      b.open, b.save, sep(), b.exec, b.execCur, b.explain, b.stop, sep(), b.onError, sep(), b.commit, b.rollback, b.autocommit, sep(),
      this.limitSel, sep(), b.snippet, b.beautify, b.find, b.invisibles, b.wrap);
  }

  createEditor(content) {
    const ws = this.ws;
    const prefs = ws.app.prefs;
    this.model = window.monaco.editor.createModel(content, ws.driver === 'mysql' ? 'mysql' : 'sql');
    registerModel(this.model, ws);
    this.editor = window.monaco.editor.create(this.editorHost, {
      model: this.model,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: prefs.fontSize || 13,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      lineNumbers: 'on',
      renderLineHighlight: 'all',
      scrollBeyondLastLine: false,
      tabSize: 4,
      wordWrap: this.wrapOn ? 'on' : 'off',
      renderWhitespace: 'none',
      quickSuggestions: { other: true, comments: false, strings: false },
      quickSuggestionsDelay: 250,
      suggestOnTriggerCharacters: true,
      fixedOverflowWidgets: true,
      glyphMargin: true,
      theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs',
    });
    const M = window.monaco;
    const KM = M.KeyMod, KC = M.KeyCode;
    this.editor.addCommand(KM.CtrlCmd | KC.Enter, () => this.run('current'));
    this.editor.addCommand(KM.CtrlCmd | KM.Shift | KC.Enter, () => this.run('all'));
    this.editor.addCommand(KM.CtrlCmd | KM.Alt | KC.KeyX, () => this.explain());
    this.editor.addCommand(KM.CtrlCmd | KC.KeyB, () => this.beautify());
    this.editor.addCommand(KM.CtrlCmd | KC.KeyS, () => this.save());
    this.editor.addCommand(KM.CtrlCmd | KM.Shift | KC.KeyS, () => this.save(true));
    this.editor.addCommand(KM.CtrlCmd | KC.KeyO, () => this.openFile());
    this.editor.addCommand(KM.CtrlCmd | KM.Shift | KC.KeyU, () => this.changeCase(true));
    this.editor.addCommand(KM.CtrlCmd | KM.Shift | KC.KeyL, () => this.changeCase(false));
    this.model.onDidChangeContent(() => {
      this.updateDirty();
      this.ws.persistTabs();
      if (this.hasMarkers) { M.editor.setModelMarkers(this.model, 'dbcentral', []); this.hasMarkers = false; }
    });
  }

  // ----------------------------------------------------------------- state
  get content() { return this.model.getValue(); }

  isDirty() { return this.path ? this.content !== this.savedContent : false; }

  updateDirty() {
    if (this.tab) this.ws.docs.setDirty(this.tab, this.isDirty());
  }

  updateState() {
    const ws = this.ws;
    const b = this.btn;
    b.stop.disabled = !this.running;
    b.exec.disabled = b.execCur.disabled = b.explain.disabled = this.running;
    b.onError.innerHTML = '';
    b.onError.append(...toolButton(ws.continueOnError ? 'continueOnError' : 'stopOnError', '', null).childNodes);
    b.onError.title = ws.continueOnError ? 'Continue executing the script after a failed statement (click to stop on errors)' : 'Stop the script on the first failed statement (click to continue on errors)';
    b.autocommit.classList.toggle('on', ws.autocommit);
    b.commit.disabled = b.rollback.disabled = ws.autocommit && !ws.inTransaction;
    this.limitSel.value = String(ws.settings.limit);
    b.wrap.classList.toggle('on', !!this.wrapOn);
    b.invisibles.classList.toggle('on', !!this.invisiblesOn);
  }

  toggleOption(kind) {
    if (kind === 'wrap') {
      this.wrapOn = !this.wrapOn;
      this.editor.updateOptions({ wordWrap: this.wrapOn ? 'on' : 'off' });
    } else {
      this.invisiblesOn = !this.invisiblesOn;
      this.editor.updateOptions({ renderWhitespace: this.invisiblesOn ? 'all' : 'none', renderControlCharacters: this.invisiblesOn });
    }
    this.updateState();
  }

  focus() { setTimeout(() => this.editor.focus(), 0); }
  onShow() { this.editor.layout(); this.focus(); }

  serialize() { return { id: this.id, title: this.title, content: this.content, path: this.path, savedContent: this.savedContent }; }

  dispose() {
    this.editor.dispose();
    this.model.dispose();
    this.el.remove();
  }

  insertText(text, { replaceAll = false } = {}) {
    const ed = this.editor;
    if (replaceAll) {
      ed.executeEdits('dbcentral', [{ range: this.model.getFullModelRange(), text }]);
    } else {
      const sel = ed.getSelection();
      ed.executeEdits('dbcentral', [{ range: sel, text, forceMoveMarkers: true }]);
    }
    ed.pushUndoStop();
    this.focus();
  }

  appendText(text) {
    const cur = this.content;
    const prefix = cur.trim() ? (cur.endsWith('\n') ? '\n' : '\n\n') : '';
    const end = this.model.getFullModelRange().getEndPosition();
    this.editor.executeEdits('dbcentral', [{ range: new window.monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: prefix + text }]);
    const newEnd = this.model.getFullModelRange().getEndPosition();
    this.editor.setPosition(newEnd);
    this.editor.revealLine(newEnd.lineNumber);
    this.focus();
  }

  // ----------------------------------------------------------------- execution
  collectStatements(mode) {
    const model = this.model;
    const sel = this.editor.getSelection();
    const opts = { dialect: this.ws.dialect, backslash: this.ws.backslash };
    if (sel && !sel.isEmpty()) {
      const text = model.getValueInRange(sel);
      const base = model.getOffsetAt(sel.getStartPosition());
      return { stmts: splitStatements(text, opts), base };
    }
    const text = model.getValue();
    let stmts = splitStatements(text, opts);
    if (mode === 'current') {
      const s = statementAt(stmts, model.getOffsetAt(this.editor.getPosition()), text);
      stmts = s ? [s] : [];
    }
    return { stmts, base: 0 };
  }

  async run(mode) {
    if (this.running) return;
    const { stmts, base } = this.collectStatements(mode);
    if (!stmts.length) { toast('There is no SQL statement to execute.', 'warning'); return; }
    window.monaco.editor.setModelMarkers(this.model, 'dbcentral', []);
    this.results.clearUnpinned();
    this.running = true;
    this.cancelRequested = false;
    this.ws.notifyState();
    try {
      for (const st of stmts) {
        if (this.cancelRequested) break;
        const r = await this.ws.executeStatement(st.text);
        if (r.ok) {
          for (const res of r.data.results) {
            if (res.kind === 'rows') {
              this.results.add(res, { sql: r.sql, originalSql: st.text, exec_ms: r.data.exec_ms, fetch_ms: r.data.fetch_ms, round_trip_ms: r.ms, time: Date.now() });
            }
          }
        } else {
          this.markError(st, base, r.error);
          if (!this.ws.continueOnError || this.cancelRequested) break;
        }
      }
    } finally {
      this.running = false;
      this.ws.notifyState();
    }
  }

  async rerunFor(view) {
    const sql = view.meta.originalSql || view.meta.sql;
    const r = await this.ws.executeStatement(sql);
    if (r.ok) {
      const res = r.data.results.find((x) => x.kind === 'rows');
      if (res) view.load(res, { sql: r.sql, exec_ms: r.data.exec_ms, fetch_ms: r.data.fetch_ms, round_trip_ms: r.ms, time: Date.now() });
    }
  }

  markError(stmt, base, message) {
    const model = this.model;
    const start = base + stmt.start;
    let pos = model.getPositionAt(start);
    let line = pos.lineNumber;
    const lm = /at line (\d+)/.exec(message || '');
    if (lm) line = Math.min(model.getLineCount(), pos.lineNumber + Number(lm[1]) - 1);
    let c1 = 1, c2 = model.getLineMaxColumn(line);
    const near = /near ['"]([\s\S]{1,60})/.exec(message || '');
    const named = /(?:Unknown column|Table|column|no such (?:column|table)):? '?([^'\s]+)'?/i.exec(message || '');
    const word = named ? named[1].split('.').pop() : null;
    const wordIdx = word ? stmt.text.search(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)) : -1;
    if (!near && wordIdx >= 0) {
      const p = model.getPositionAt(start + wordIdx);
      line = p.lineNumber;
      c1 = p.column;
      c2 = c1 + word.length;
    } else if (near) {
      const frag = near[1].replace(/['"]\s*(at line \d+)?$/, '').slice(0, 25);
      const idx = frag ? stmt.text.indexOf(frag) : -1;
      if (idx >= 0) {
        const p = model.getPositionAt(start + idx);
        line = p.lineNumber;
        c1 = p.column;
        c2 = Math.min(model.getLineMaxColumn(line), c1 + Math.max(frag.split('\n')[0].length, 1));
      }
    } else if (!lm) {
      const endPos = model.getPositionAt(base + stmt.end);
      if (endPos.lineNumber === line) c2 = endPos.column;
      c1 = pos.column;
    }
    window.monaco.editor.setModelMarkers(model, 'dbcentral', [{
      severity: window.monaco.MarkerSeverity.Error, message, startLineNumber: line, startColumn: c1, endLineNumber: line, endColumn: c2,
    }]);
    this.hasMarkers = true;
    this.editor.revealLineInCenterIfOutsideViewport(line);
  }

  async stop() {
    if (!this.running) return;
    this.cancelRequested = true;
    await this.ws.cancel();
  }

  async explain() {
    const { stmts } = this.collectStatements('current');
    if (!stmts.length) { toast('Place the cursor on a statement to explain.', 'warning'); return; }
    const sql = stmts[0].text;
    this.results.clearUnpinned();
    const r = await this.ws.executeStatement(sql, { limit: false, explainOnly: true });
    if (r.ok && r.plan) {
      const res = r.plan.table || { columns: [{ name: 'plan', kind: 'str' }], rows: [], editable: null };
      const view = this.results.add({ ...res, editable: null, read_only_reason: 'Execution plan' }, { sql: 'EXPLAIN ' + sql, originalSql: sql, time: Date.now() });
      view.plan = r.plan;
      view.setMode('plan');
    } else if (!r.ok) {
      this.markError(stmts[0], 0, r.error);
    }
  }

  // ----------------------------------------------------------------- editing helpers
  beautify() {
    const fmt = window.sqlFormatter;
    if (!fmt) { toast('SQL formatter not available.', 'error'); return; }
    const sel = this.editor.getSelection();
    const hasSel = sel && !sel.isEmpty();
    const text = hasSel ? this.model.getValueInRange(sel) : this.content;
    if (/^\s*DELIMITER\s/im.test(text)) { toast('Beautify does not support DELIMITER blocks. Select a single statement to format it.', 'warning'); return; }
    const stmts = splitStatements(text, { dialect: this.ws.dialect, backslash: this.ws.backslash });
    if (!stmts.length) return;
    const lang = this.ws.driver === 'mysql' ? (this.ws.info.is_mariadb ? 'mariadb' : 'mysql') : this.ws.driver === 'odbc' ? 'sql' : 'sqlite';
    const out = stmts.map((s) => {
      try {
        return fmt.format(s.text, { language: lang, keywordCase: 'upper', tabWidth: 4, linesBetweenQueries: 1 });
      } catch {
        return s.text;
      }
    }).join(';\n\n') + ';\n';
    if (hasSel) this.editor.executeEdits('beautify', [{ range: sel, text: out }]);
    else this.editor.executeEdits('beautify', [{ range: this.model.getFullModelRange(), text: out }]);
    this.editor.pushUndoStop();
  }

  changeCase(upper) {
    const sel = this.editor.getSelection();
    if (!sel || sel.isEmpty()) return;
    const t = this.model.getValueInRange(sel);
    this.editor.executeEdits('case', [{ range: sel, text: upper ? t.toUpperCase() : t.toLowerCase() }]);
  }

  async saveSnippet() {
    const sel = this.editor.getSelection();
    let text = sel && !sel.isEmpty() ? this.model.getValueInRange(sel) : '';
    if (!text) {
      const { stmts } = this.collectStatements('current');
      text = stmts[0]?.text || '';
    }
    if (!text.trim()) { toast('Nothing to save as a snippet.', 'warning'); return; }
    const { editSnippetDialog } = await import('./snippets.js');
    const saved = await editSnippetDialog(this.ws.app.snippets, null, { name: text.trim().split('\n')[0].slice(0, 40), text });
    if (saved) toast('Snippet saved.', 'success');
  }

  // ----------------------------------------------------------------- files
  async openFile() {
    try {
      const path = await pickOpenFile('Open SQL Script');
      if (!path) return;
      const f = await readFile(path);
      addRecent(path);
      if (!this.content.trim() && !this.path) {
        this.loadFile(f);
      } else {
        this.ws.openQueryTab({ title: f.name, content: f.content, path: f.path });
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  loadFile(f) {
    this.path = f.path;
    this.savedContent = f.content;
    this.model.setValue(f.content);
    this.title = f.name;
    if (this.tab) this.ws.docs.setTitle(this.tab, f.name, f.path);
    this.updateDirty();
  }

  async save(saveAs = false) {
    try {
      let path = this.path;
      if (!path || saveAs) {
        const base = this.title.replace(/[^\w.\- ]+/g, '_');
        path = await pickSaveFile('Save SQL Script', base.endsWith('.sql') ? base : base + '.sql', SQL_FILTERS, 'sql');
        if (!path) return false;
      }
      const content = this.content;
      const r = await writeFile(path, content);
      this.path = r.path;
      this.savedContent = content;
      this.title = r.name;
      if (this.tab) this.ws.docs.setTitle(this.tab, r.name, r.path);
      this.updateDirty();
      addRecent(r.path);
      this.ws.persistTabs();
      toast('Saved ' + r.path, 'success', 2000);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  }

  async confirmClose() {
    if (this.results.hasUnsavedEdits()) {
      const ok = await modal({
        title: 'Close Tab', content: h('div', null, `"${this.title}" has result rows with changes that were not applied. Close anyway?`),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Discard Changes', value: true, primary: true, danger: true }], closeValue: false,
      });
      if (!ok) return false;
    }
    const dirty = this.isDirty() || (!this.path && this.content.trim().length > 0);
    if (!dirty) return true;
    const choice = await modal({
      title: 'Close SQL Tab', closeValue: 'cancel',
      content: h('div', { class: 'msg-text' }, `Do you want to save the changes to "${this.title}" before closing?`),
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: "Don't Save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }],
    });
    if (choice === 'cancel') return false;
    if (choice === 'save') return this.save();
    return true;
  }
}
