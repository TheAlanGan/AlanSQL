// Table Data Import Wizard: import a CSV / TSV / JSON file into a new or existing table.
import { api } from './api.js';
import { h, modal, select, field, checkbox, toast, icon, formatNumber, formatBytes, debounce } from './ui.js';
import { pickOpenFile } from './files.js';

const FILE_FILTERS = [['Data Files', '*.csv;*.tsv;*.txt;*.json;*.jsonl;*.ndjson'], ['CSV Files', '*.csv;*.tsv;*.txt'],
  ['JSON Files', '*.json;*.jsonl;*.ndjson'], ['All Files', '*.*']];
const ENCODINGS = [['auto', 'Auto-detect'], ['utf-8', 'UTF-8'], ['utf-8-sig', 'UTF-8 with BOM'], ['utf-16', 'UTF-16'],
  ['cp1252', 'Windows-1252 (Western)'], ['latin-1', 'ISO-8859-1 (Latin-1)'], ['cp1250', 'Windows-1250 (Central European)'],
  ['cp1251', 'Windows-1251 (Cyrillic)'], ['shift_jis', 'Shift-JIS'], ['gb18030', 'GB18030'], ['big5', 'Big5']];
const DELIMS = [['auto', 'Auto-detect'], [',', 'Comma ( , )'], [';', 'Semicolon ( ; )'], ['\t', 'Tab'], ['|', 'Pipe ( | )']];
const QUOTES = [['"', 'Double quote ( " )'], ["'", "Single quote ( ' )"], ['none', 'None']];
const MYSQL_TYPES = ['INT', 'BIGINT', 'TINYINT(1)', 'DECIMAL(10,2)', 'DOUBLE', 'VARCHAR(45)', 'VARCHAR(255)', 'TEXT',
  'MEDIUMTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'JSON', 'BLOB'];
const SQLITE_TYPES = ['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB'];
const STEPS = ['Select File', 'Destination', 'Configure Import', 'Import Data'];
let listSeq = 0;

export function openImportWizard(ws, { schema, table } = {}) {
  const schemas = ws.navigator.schemas.filter((s) => !s.system).map((s) => s.name);
  if (!schemas.length) { toast('Create a schema first.', 'warning'); return null; }
  const st = {
    path: '', size: 0, format: 'auto',
    mode: table ? 'existing' : 'new',
    schema: schema && schemas.includes(schema) ? schema : (ws.currentSchema && schemas.includes(ws.currentSchema) ? ws.currentSchema : schemas[0]),
    table: table || '', newTable: '', truncate: false, drop: false,
    opts: { encoding: 'auto', delimiter: 'auto', quotechar: '"', header: true, skip_rows: 0 },
    preview: null, previewKey: '', map: [], tableCols: [], tableColsKey: '',
    empty: 'auto', nullText: true, trim: false, onError: 'stop', fkChecks: true,
  };
  let step = 0;
  let ctrl = null;
  let job = null;          // running job
  let finished = null;     // job result
  const pageEl = h('div', { class: 'wiz-page' });
  const stepsEl = h('div', { class: 'wiz-steps' });
  const content = h('div', { class: 'wiz' }, stepsEl, pageEl);

  const renderSteps = () => {
    stepsEl.innerHTML = '';
    STEPS.forEach((s, i) => stepsEl.append(h('div', { class: 'wiz-step' + (i === step ? ' active' : i < step ? ' done' : '') },
      h('span', { class: 'wiz-num' }, i < step ? '✓' : String(i + 1)), s)));
  };

  const setButtons = () => {
    if (!ctrl) return;
    const b = ctrl.buttons;
    b.back.disabled = step === 0 || !!job || (!!finished && finished.inserted >= 0);
    b.next.disabled = !!job;
    b.next.textContent = finished && finished.inserted >= 0 ? 'Finish' : finished ? 'Try Again' : step === STEPS.length - 1 ? 'Start Import' : 'Next >';
    b.cancel.textContent = job ? 'Stop Import' : 'Cancel';
    b.cancel.style.display = finished && finished.inserted >= 0 ? 'none' : '';
    b.open.style.display = finished && finished.inserted >= 0 ? '' : 'none';
  };

  async function show(i) {
    step = i;
    renderSteps();
    pageEl.innerHTML = '';
    pageEl.append(h('div', { class: 'muted' }, 'Loading...'));
    try {
      const page = await [pageFile, pageDest, pageConfig, pageImport][i]();
      pageEl.innerHTML = '';
      pageEl.append(page);
    } catch (e) {
      pageEl.innerHTML = '';
      pageEl.append(h('div', { class: 'error-box' }, icon('error'), e.message || String(e)));
    }
    setButtons();
  }

  // ---------------------------------------------------------------- step 1: file
  function pageFile() {
    const path = h('input', { class: 'input', readOnly: true, value: st.path, placeholder: 'Choose a CSV, TSV or JSON file...' });
    const info = h('div', { class: 'muted' }, st.path ? fileInfo() : '');
    const fmt = select([['auto', 'Detect from file extension'], ['csv', 'CSV / delimited text'], ['json', 'JSON (array of objects, or JSON Lines)']],
      st.format, (v) => { st.format = v; st.previewKey = ''; });
    const browse = async () => {
      try {
        const p = await pickOpenFile('Select File to Import', FILE_FILTERS);
        if (!p) return;
        st.path = p; path.value = p; st.previewKey = '';
        if (!st.newTable || st.newTable === st.autoName) {
          st.autoName = p.split(/[\\/]/).pop().replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'imported';
          st.newTable = st.autoName;
        }
        info.textContent = 'Reading file...';
        const r = await loadPreview(true);
        st.size = r.size;
        info.textContent = fileInfo();
      } catch (e) { info.textContent = ''; toast(e.message, 'error'); }
    };
    return h('div', { class: 'form' },
      h('h3', null, 'Select the file to import'),
      h('p', { class: 'muted' }, 'Import rows from a CSV, TSV or JSON file into a table. You can create a new table from the file or add the rows to an existing table.'),
      h('div', { class: 'row' }, path, h('button', { class: 'btn', onclick: browse }, 'Browse...')),
      info,
      field('File format:', fmt));
  }

  function fileInfo() {
    const p = st.preview;
    if (!p) return '';
    const o = p.options;
    const enc = (ENCODINGS.find((e) => e[0] === o.encoding) || [0, o.encoding])[1];
    const parts = [formatBytes(p.size), (p.estimated ? '~' : '') + formatNumber(p.total_rows) + ' rows', p.columns.length + ' columns',
      o.format === 'json' ? 'JSON' : 'CSV, ' + (DELIMS.find((d) => d[0] === o.delimiter) || [0, o.delimiter])[1].toLowerCase(), enc];
    return parts.join(' · ');
  }

  async function loadPreview(force) {
    const options = { ...st.opts, format: st.format };
    const key = st.path + '|' + JSON.stringify(options);
    if (!force && st.preview && key === st.previewKey) return st.preview;
    const r = await api.post(`/sessions/${ws.sid}/import-data/preview`, { path: st.path, options });
    const oldNames = st.preview ? st.preview.columns.map((c) => c.name).join('\u0001') : null;
    st.preview = r;
    st.previewKey = key;
    st.size = r.size;
    if (oldNames !== r.columns.map((c) => c.name).join('\u0001')) st.map = [];
    return r;
  }

  // ---------------------------------------------------------------- step 2: destination
  async function pageDest() {
    const objs = await api.get(`/sessions/${ws.sid}/objects?schema=${encodeURIComponent(st.schema)}`);
    const tables = objs.tables.map((t) => t.name);
    if (!tables.includes(st.table)) st.table = tables[0] || '';
    const radio = (value, label) => {
      const r = h('input', { type: 'radio', name: 'wiz-dest', checked: st.mode === value });
      r.addEventListener('change', () => { st.mode = value; sync(); });
      return h('label', { class: 'check' }, r, h('span', { class: 'strong' }, label));
    };
    const schemaSel = select(schemas, st.schema, async (v) => { st.schema = v; st.tableColsKey = ''; show(1); });
    const tableSel = select(tables.length ? tables : [['', '(no tables in this schema)']], st.table, (v) => { st.table = v; st.map = []; });
    const truncate = checkbox('Delete all existing rows before importing', st.truncate, (v) => { st.truncate = v; });
    const name = h('input', { class: 'input', value: st.newTable, placeholder: 'table_name', oninput: () => { st.newTable = name.value.trim(); } });
    const drop = checkbox('Drop the table first if it already exists', st.drop, (v) => { st.drop = v; });
    const existingBox = h('div', { class: 'wiz-indent form' }, field('Table:', tableSel), truncate);
    const newBox = h('div', { class: 'wiz-indent form' }, field('New table name:', name), drop);
    const sync = () => {
      existingBox.classList.toggle('disabled', st.mode !== 'existing');
      newBox.classList.toggle('disabled', st.mode !== 'new');
      if (st.mode === 'new') setTimeout(() => name.focus(), 0);
    };
    sync();
    return h('div', { class: 'form' },
      h('h3', null, 'Choose the destination table'),
      field(ws.driver === 'mysql' ? 'Schema:' : 'Database:', schemaSel),
      radio('existing', 'Use an existing table'), existingBox,
      radio('new', 'Create a new table'), newBox);
  }

  // ---------------------------------------------------------------- step 3: configure
  async function loadTableCols() {
    const key = st.schema + '.' + st.table;
    if (st.tableColsKey === key) return;
    const objs = await api.get(`/sessions/${ws.sid}/objects?schema=${encodeURIComponent(st.schema)}`);
    st.tableCols = (objs.columns[st.table] || []).filter((c) => !c.gen_expr && !/GENERATED/i.test(c.extra || ''));
    st.tableColsKey = key;
    st.map = [];
  }

  function buildMap() {
    const src = st.preview.columns;
    const key = st.mode + '|' + st.schema + '.' + st.table + '|' + src.map((c) => c.name).join('|');
    if (st.map.length === src.length && st.mapKey === key) return;
    st.mapKey = key;
    if (st.mode === 'existing') {
      const byName = new Map(st.tableCols.map((c) => [c.name.toLowerCase(), c.name]));
      const anyMatch = src.some((c) => byName.has(c.name.toLowerCase()));
      st.map = src.map((c, i) => {
        const t = anyMatch ? (byName.get(c.name.toLowerCase()) || '') : (st.tableCols[i]?.name || '');
        return { include: !!t, target: t, name: c.name, type: c.type, pk: false };
      });
    } else {
      st.map = src.map((c, i) => ({ include: true, target: c.name, name: c.name, type: c.type, pk: i === 0 && /^id$/i.test(c.name) }));
    }
  }

  async function pageConfig() {
    if (st.mode === 'existing') await loadTableCols();
    await loadPreview(false);
    buildMap();
    const optsBox = h('div', { class: 'wiz-opts' });
    const mapBox = h('div', { class: 'wiz-scroll wiz-map' });
    const prevBox = h('div', { class: 'wiz-scroll wiz-preview' });
    const status = h('div', { class: 'muted' });
    const refresh = debounce(async () => {
      status.textContent = 'Reading file...';
      try {
        await loadPreview(false);
        buildMap();
        renderMap(); renderPreview();
        status.textContent = fileInfo();
      } catch (e) { status.textContent = ''; prevBox.innerHTML = ''; prevBox.append(h('div', { class: 'error-box' }, icon('error'), e.message)); }
    }, 250);
    const csv = st.preview.options.format === 'csv';
    const setOpt = (k) => (v) => { st.opts[k] = v; refresh(); };
    const skip = h('input', { class: 'input', type: 'number', min: 0, value: st.opts.skip_rows, style: { width: '70px' },
      oninput: () => { st.opts.skip_rows = Math.max(0, parseInt(skip.value, 10) || 0); refresh(); } });
    optsBox.append(...[
      field('Encoding:', select(ENCODINGS, st.opts.encoding, setOpt('encoding'))),
      csv ? field('Field separator:', select(DELIMS, st.opts.delimiter, setOpt('delimiter'))) : null,
      csv ? field('Quote character:', select(QUOTES, st.opts.quotechar, setOpt('quotechar'))) : null,
      field('Skip rows at top:', skip),
      csv ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, ' '), checkbox('First row contains column names', st.opts.header, (v) => { st.opts.header = v; refresh(); })) : null,
    ].filter(Boolean));

    function renderMap() {
      mapBox.innerHTML = '';
      const existing = st.mode === 'existing';
      const listId = 'wiz-types-' + (++listSeq);
      const types = ws.driver === 'mysql' ? MYSQL_TYPES : SQLITE_TYPES;
      const head = existing ? ['', 'Source Column', 'Destination Column', 'Destination Type'] : ['', 'Source Column', 'New Column Name', 'Type', 'PK'];
      const tb = h('tbody');
      st.map.forEach((m, i) => {
        const inc = h('input', { type: 'checkbox', checked: m.include, onchange: () => { m.include = inc.checked; row.classList.toggle('wiz-off', !m.include); } });
        let cells;
        if (existing) {
          const typeCell = h('td', { class: 'muted' });
          const showType = () => { typeCell.textContent = st.tableCols.find((c) => c.name === m.target)?.column_type || ''; };
          const sel = select([['', '(skip this column)'], ...st.tableCols.map((c) => [c.name, c.name])], m.target, (v) => {
            m.target = v; m.include = !!v; inc.checked = !!v; row.classList.toggle('wiz-off', !m.include); showType();
          });
          showType();
          cells = [h('td', null, sel), typeCell];
        } else {
          const nameIn = h('input', { class: 'input', value: m.name, oninput: () => { m.name = nameIn.value; } });
          const typeIn = h('input', { class: 'input', value: m.type, list: listId, oninput: () => { m.type = typeIn.value; } });
          const pk = h('input', { type: 'checkbox', checked: m.pk, onchange: () => { m.pk = pk.checked; } });
          cells = [h('td', null, nameIn), h('td', null, typeIn), h('td', { class: 'center' }, pk)];
        }
        const sample = st.preview.rows.find((r) => r[i] !== null && r[i] !== undefined && r[i] !== '')?.[i];
        const row = h('tr', { class: m.include ? '' : 'wiz-off' }, h('td', { class: 'center' }, inc),
          h('td', { title: sample !== undefined ? 'Example: ' + String(sample).slice(0, 200) : '' }, st.preview.columns[i].name), ...cells);
        tb.append(row);
      });
      mapBox.append(h('table', { class: 'grid-table' }, h('thead', null, h('tr', null, ...head.map((x) => h('th', null, x)))), tb),
        ...(existing ? [] : [h('datalist', { id: listId }, ...types.map((t) => h('option', { value: t })))]));
    }

    function renderPreview() {
      prevBox.innerHTML = '';
      const p = st.preview;
      const tb = h('tbody');
      for (const r of p.rows.slice(0, 50)) {
        tb.append(h('tr', null, ...p.columns.map((_, i) => {
          const v = r[i];
          if (v === null || v === undefined) return h('td', null, h('span', { class: 'nullv' }, 'NULL'));
          const s = String(v);
          return h('td', { title: s.length > 60 ? s.slice(0, 1000) : '' }, s.length > 60 ? s.slice(0, 60) + '…' : s);
        })));
      }
      prevBox.append(h('table', { class: 'grid-table' }, h('thead', null, h('tr', null, ...p.columns.map((c) => h('th', null, c.name)))), tb));
    }

    renderMap(); renderPreview();
    status.textContent = fileInfo();
    const empty = select([['auto', 'NULL for non-text columns, empty string for text'], ['null', 'Always NULL'], ['keep', 'Keep as empty string']], st.empty, (v) => { st.empty = v; });
    const onErr = select([['stop', 'Stop and roll back everything'], ['skip', 'Skip the failing rows and continue']], st.onError, (v) => { st.onError = v; });
    return h('div', { class: 'form wiz-config' },
      optsBox, status,
      h('div', { class: 'section-title' }, 'Column mapping'), mapBox,
      h('div', { class: 'section-title' }, 'Data preview (first rows)'), prevBox,
      h('div', { class: 'wiz-opts' },
        field('Empty values:', empty),
        field('When a row fails:', onErr)),
      h('div', { class: 'wiz-opts' },
        checkbox('Treat the text NULL and \\N as NULL', st.nullText, (v) => { st.nullText = v; }),
        checkbox('Trim spaces around values', st.trim, (v) => { st.trim = v; }),
        checkbox('Check foreign keys', st.fkChecks, (v) => { st.fkChecks = v; })));
  }

  // ---------------------------------------------------------------- step 4: import
  function request() {
    const p = st.preview;
    const included = st.map.map((m, i) => ({ ...m, source: i })).filter((m) => m.include);
    const isNew = st.mode === 'new';
    return {
      path: st.path,
      format: p.options.format, encoding: p.options.encoding, delimiter: p.options.delimiter,
      quotechar: p.options.quotechar === '' ? 'none' : p.options.quotechar, header: p.options.header, skip_rows: p.options.skip_rows,
      schema: st.schema, table: isNew ? st.newTable : st.table,
      create: isNew, drop: isNew && st.drop, truncate: !isNew && st.truncate,
      columns: isNew ? included.map((m) => ({ name: m.name.trim(), type: m.type.trim(), pk: m.pk })) : [],
      mapping: included.map((m) => ({ source: m.source, target: isNew ? m.name.trim() : m.target,
        type: isNew ? m.type : (st.tableCols.find((c) => c.name === m.target)?.column_type || '') })),
      empty: st.empty, null_strings: st.nullText ? ['NULL', '\\N'] : [], trim: st.trim,
      on_error: st.onError, fk_checks: st.fkChecks,
    };
  }

  const prog = { bar: h('div', { style: { width: '0%' } }), status: h('div', { class: 'muted' }), log: h('div', { class: 'job-log' }) };

  async function pageImport() {
    if (finished || job) return resultPage();
    const req = request();
    const p = st.preview;
    const target = ws.driver === 'mysql' || st.schema !== 'main' ? `${st.schema}.${req.table}` : req.table;
    const rows = [
      ['File', st.path],
      ['Format', p.options.format === 'json' ? `JSON, ${p.options.encoding}` : `CSV, ${(DELIMS.find((d) => d[0] === p.options.delimiter) || [0, p.options.delimiter])[1].toLowerCase()}, ${p.options.encoding}${p.options.header ? ', header row' : ''}`],
      ['Rows', (p.estimated ? 'about ' : '') + formatNumber(p.total_rows)],
      ['Destination', `${target} (${req.create ? 'new table' + (req.drop ? ', dropped first if it exists' : '') : 'existing table' + (req.truncate ? ', existing rows deleted first' : '')})`],
      ['Columns', req.mapping.map((m) => (p.columns[m.source].name === m.target ? m.target : `${p.columns[m.source].name} → ${m.target}`)).join(', ')],
      ['On error', st.onError === 'stop' ? 'Stop and roll back everything' : 'Skip failing rows'],
    ];
    const page = h('div', { class: 'form' }, h('h3', null, 'Ready to import'),
      h('table', { class: 'kv-table' }, ...rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))));
    if (req.create) {
      const r = await api.post(`/sessions/${ws.sid}/import-data/sql`, { schema: req.schema, table: req.table, columns: req.columns, drop: req.drop });
      page.append(h('div', { class: 'section-title' }, 'The table will be created with:'), h('pre', { class: 'sql-pre small' }, r.statements.join(';\n\n') + ';'));
    }
    page.append(h('p', { class: 'muted' }, 'All rows are inserted in one transaction. Click Start Import to begin.'));
    return page;
  }

  function resultPage() {
    const page = h('div', { class: 'form' }, h('h3', null, finished ? 'Import finished' : 'Importing...'),
      h('div', { class: 'progress' }, prog.bar), prog.status, prog.log);
    return page;
  }

  function validate() {
    if (step === 0 && !st.path) throw new Error('Choose the file to import first.');
    if (step === 1) {
      if (st.mode === 'existing' && !st.table) throw new Error('Choose a destination table, or create a new one.');
      if (st.mode === 'new' && !st.newTable) throw new Error('Enter a name for the new table.');
    }
    if (step === 2) {
      const inc = st.map.filter((m) => m.include);
      if (!inc.length) throw new Error('Select at least one column to import.');
      if (st.mode === 'new') {
        const names = inc.map((m) => m.name.trim().toLowerCase());
        if (names.some((n) => !n)) throw new Error('Every imported column needs a name.');
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) throw new Error(`The column name "${dup}" is used twice.`);
        if (inc.some((m) => !m.type.trim())) throw new Error('Every imported column needs a type.');
      } else {
        const t = inc.map((m) => m.target);
        const dup = t.find((n, i) => t.indexOf(n) !== i);
        if (dup) throw new Error(`Two source columns are mapped to "${dup}".`);
      }
    }
  }

  async function startImport() {
    const req = request();
    const r = await api.post(`/sessions/${ws.sid}/import-data`, req);
    job = r.job;
    prog.bar.style.width = '0%'; prog.status.className = 'muted'; prog.status.textContent = 'Starting...'; prog.log.textContent = '';
    await show(3);
    const target = ws.driver === 'mysql' || req.schema !== 'main' ? `${req.schema}.${req.table}` : req.table;
    for (;;) {
      let j;
      try { j = (await api.get('/jobs/' + job.id)).job; } catch (e) { prog.status.textContent = e.message; break; }
      prog.bar.style.width = Math.round(j.progress * 100) + '%';
      prog.status.textContent = j.status === 'error' ? 'Error: ' + j.error : j.message;
      prog.log.textContent = j.log.join('\n');
      prog.log.scrollTop = prog.log.scrollHeight;
      if (j.status !== 'running') {
        job = null;
        if (j.status === 'done') {
          const res = j.result;
          finished = res;
          let msg = `${formatNumber(res.inserted)} row(s) imported into ${target} in ${res.seconds}s`;
          if (res.skipped) msg += `, ${formatNumber(res.skipped)} row(s) skipped`;
          prog.status.textContent = msg + '.';
          prog.status.className = res.skipped ? '' : 'strong';
          ws.logOutput({ action: `Import ${st.path} into ${target}`, ok: !res.skipped, message: msg });
        } else {
          finished = { inserted: -1 };
          prog.bar.style.width = '0%';
          prog.log.textContent = j.log.filter((l) => !l.startsWith('Row ') || st.onError !== 'stop').join('\n');
          const msg = j.status === 'cancelled' ? 'Import stopped. No rows were imported.' : `Import failed. No rows were imported. ${j.error}`;
          prog.status.textContent = msg;
          prog.status.className = 'error-box';
          ws.logOutput({ action: `Import ${st.path} into ${target}`, ok: false, message: j.status === 'cancelled' ? 'Stopped by user' : j.error });
        }
        if (req.create || finished.inserted > 0) ws.navigator.refreshSchema(req.schema);
        const h3 = pageEl.querySelector('h3');
        if (h3) h3.textContent = j.status === 'done' ? 'Import finished' : j.status === 'cancelled' ? 'Import stopped' : 'Import failed';
        break;
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    setButtons();
  }

  const done = modal({
    title: 'Table Data Import Wizard', content, width: 900, className: 'wizard-modal', closeValue: null,
    onOpen: (c) => { ctrl = c; show(0); },
    buttons: [
      { key: 'open', label: 'Open Table', onClick: () => { const r = request(); ws.selectRows(r.schema, r.table); return null; } },
      '-',
      { key: 'back', label: '< Back', onClick: () => { if (finished) { finished = null; show(2); } else if (step > 0) show(step - 1); return false; } },
      { key: 'next', label: 'Next >', primary: true, onClick: async () => {
        if (finished && finished.inserted >= 0) return null;
        if (finished) { finished = null; await show(3); return false; }
        validate();
        if (step === 0) await loadPreview(false);
        if (step === STEPS.length - 1) {
          ctrl.buttons.next.disabled = true;
          try { await startImport(); } finally { setButtons(); }
          return false;
        }
        await show(step + 1);
        return false;
      } },
      { key: 'cancel', label: 'Cancel', onClick: async () => {
        if (job) { await api.post(`/jobs/${job.id}/cancel`, {}); return false; }
        return null;
      } },
    ],
  });
  return done;
}
