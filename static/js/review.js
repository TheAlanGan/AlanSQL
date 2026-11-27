// "Apply SQL Script to Database" review dialog (Workbench style): review/edit -> apply -> result.
import { api } from './api.js';
import { splitStatements } from './sqlparse.js';
import { h, icon, modal } from './ui.js';

export async function reviewAndApply(ws, statements, {
  title = 'Apply SQL Script to Database', transaction = false, intro, stopOnError = true, splitText = true, endpoint,
} = {}) {
  const sqlText = statements.map((s) => s.trim().replace(/;?\s*$/, ';')).join('\n');
  const edHost = h('div', { class: 'review-editor' });
  const page1 = h('div', { class: 'review-page' },
    h('div', { class: 'review-intro' }, icon('info'), h('span', null, intro || 'Please review the SQL script to be applied on the database. You can edit it before applying.')),
    edHost);
  const log = h('div', { class: 'review-log' });
  const page2 = h('div', { class: 'review-page hidden' }, log);
  const content = h('div', { class: 'review' }, page1, page2);
  let editor = null;
  let applied = false;

  const result = await modal({
    title, width: 820, content, className: 'review-dialog', closeValue: false,
    onOpen: () => {
      editor = window.monaco.editor.create(edHost, {
        value: sqlText, language: ws.driver === 'mysql' ? 'mysql' : 'sql', minimap: { enabled: false },
        automaticLayout: true, scrollBeyondLastLine: false, fontSize: 13, lineNumbers: 'on', wordWrap: 'on',
        theme: document.body.classList.contains('dark') ? 'vs-dark' : 'vs',
      });
    },
    buttons: [
      { label: 'Cancel', value: false, key: 'cancel' },
      { label: 'Apply', primary: true, key: 'apply', onClick: async (ctrl) => {
        if (applied) return true;
        const text = editor.getValue();
        const stmts = splitText
          ? splitStatements(text, { dialect: ws.dialect, backslash: ws.backslash }).map((s) => s.text)
          : [text];
        if (!stmts.length) return true;
        page1.classList.add('hidden');
        page2.classList.remove('hidden');
        log.innerHTML = '';
        log.append(h('div', { class: 'review-step' }, icon('spinner'), ' Executing SQL statements...'));
        ctrl.setBusy(true);
        let res;
        try {
          res = await api.post(endpoint || `/sessions/${ws.sid}/script`, { statements: stmts, stop_on_error: stopOnError, transaction });
        } catch (e) {
          res = { ok: false, results: [{ ok: false, sql: '', error: e.message }] };
        }
        ctrl.setBusy(false);
        log.innerHTML = '';
        for (const r of res.results) {
          ws.logOutput({ action: r.sql, ok: r.ok, message: r.ok ? `${r.affected ?? 0} row(s) affected` : r.error, ms: r.ms });
        }
        if (res.current_schema !== undefined) ws.setCurrentSchema(res.current_schema);
        if (res.in_transaction !== undefined) ws.setTransactionState(res.in_transaction);
        if (res.ok) {
          applied = true;
          log.append(h('div', { class: 'review-step ok' }, icon('ok'), ` SQL script was successfully applied to the database (${res.results.length} statement${res.results.length === 1 ? '' : 's'}).`));
          ctrl.buttons.apply.textContent = 'Finish';
          ctrl.buttons.cancel.classList.add('hidden');
          return false;
        }
        const failed = res.results.find((r) => !r.ok);
        log.append(
          h('div', { class: 'review-step err' }, icon('error'), ' ERROR: ', failed?.error || 'Unknown error'),
          failed?.sql ? h('pre', { class: 'sql-pre' }, failed.sql) : null,
          h('div', { class: 'muted' }, res.rolled_back ? 'The transaction was rolled back; no changes were made.' : `${res.results.filter((r) => r.ok).length} statement(s) succeeded before the error.`),
        );
        ctrl.buttons.apply.textContent = 'Back';
        ctrl.buttons.apply.onclick = null;
        const back = ctrl.buttons.apply;
        const handler = (ev) => {
          ev.stopImmediatePropagation();
          page2.classList.add('hidden');
          page1.classList.remove('hidden');
          back.textContent = 'Apply';
          back.removeEventListener('click', handler, true);
        };
        back.addEventListener('click', handler, true);
        return false;
      } },
    ],
  });
  editor?.dispose();
  return applied || result === true;
}
