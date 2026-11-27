# DBCentral

A personal, MySQL Workbench–style SQL client for **MySQL / MariaDB** and **SQLite**, plus a generic
**ODBC** connection for browsing and querying other databases (SQL Server, Access, PostgreSQL, ...).
It runs as a small local Python server and opens in a frameless Microsoft Edge "app" window,
so it looks and behaves like a desktop application.

## Start it

```bat
DBCentral.bat
```

Requirements: Windows 10 or 11 and Python 3.10 or newer (64-bit). The first start runs `setup.bat`,
which creates `.venv` and installs the dependencies from `requirements.txt`, and offers to create
desktop and Start menu shortcuts. The server listens on `127.0.0.1` only, on port 8765 (or the next free port),
and every API call needs a random token that the launcher passes to the window. The server shuts
itself down about a minute after the last DBCentral window closes.

Other ways to run it:

```bat
.venv\Scripts\python.exe launch.py --no-window    &rem print the URL instead of opening a window
.venv\Scripts\python.exe launch.py --keep-alive   &rem keep running after the window closes
```

## Install on another PC

1. On this PC, run `make_dist.bat`. It creates `dist\DBCentral-<version>.zip` (about 13 MB), which holds
   the app plus the Python packages for 64-bit Python 3.10 to 3.14, so setup also works offline.
   Use `make_dist.bat --no-wheels` for a smaller zip whose setup downloads the packages instead.
2. Copy the zip to the other PC, unzip it anywhere, and double-click `DBCentral.bat`.
   The first start finds Python (the `py` launcher, or `python` on PATH), creates a `.venv` for
   that PC, installs the packages and offers to create shortcuts. Later starts open the app directly.

Don't copy the `.venv` folder between PCs: it is tied to the Python installation it was made with.
If one is copied anyway, setup notices that it doesn't work and rebuilds it. To recreate the
shortcuts later, run `powershell -ExecutionPolicy Bypass -File tools\shortcut.ps1`.
Connections, history and passwords are stored per Windows user, so they are not copied along.

## Features

**Home screen**
- Connection tiles for MySQL/MariaDB and SQLite, with color tags, filtering, duplicating and reordering.
- **Connection groups**: set a Group in the connection dialog, use a tile's **Move to Group** menu, or
  drag a tile onto a group heading. Groups are collapsible headings (remembered between starts), with
  a + button to add a connection to that group. Right-click a group heading to rename it or ungroup
  its connections. The filter box also matches group names.
- "Setup New Connection" dialog with Parameters, SSL and Advanced tabs, plus **Test Connection**.
- Passwords are optionally stored in the Windows Credential Manager. If a password isn't stored,
  you're prompted for it when you connect.
- **SSH tunnels**: choose "MySQL / MariaDB (Standard TCP/IP over SSH)" as the connection type to reach a
  server that only accepts local connections. Log in to SSH with a password, a private key file
  (OpenSSH or PEM format, with an optional passphrase) or an SSH agent (Pageant or the Windows OpenSSH
  agent). The MySQL hostname is then resolved on the SSH server, usually `127.0.0.1`.
  The first time you connect to an SSH server, DBCentral shows its host key fingerprint and asks you
  to trust it; after that it refuses to connect if the key changes. Every query tab, export and import
  runs through the same SSH session, and no local port is opened. SSL to MySQL still works on top.
- **Other databases (ODBC)**: the third home-screen section connects through any 64-bit ODBC driver
  installed in Windows, such as SQL Server, Access, Excel/CSV files, PostgreSQL or Oracle. Pick a
  data source (DSN) set up in "ODBC Data Sources (64-bit)", or type a connection string; a driver
  list inserts a starting template. Leave the username empty for Windows authentication. A password
  goes in its own field and is kept in the vault, never in the saved connection string.
  - **What works:**
    - browsing schemas, tables, views and columns
    - running queries with the row limit, Stop, transactions, autocomplete and exporting results
    - Select Rows, the Table Inspector (with a generated CREATE TABLE) and the ER diagram (when the
      driver reports foreign keys)
  - **What's MySQL/SQLite only and hidden on ODBC:** the table and view designers, Data
    Export/Import, the import wizard, result editing, Explain and the administration pages.
  - **Driver differences:** catalog support varies by driver. For example, the Access driver can't
    report keys, so DBCentral detects the primary key from the indexes.

**SQL editor** (Monaco, the VS Code editor)
- Multiple query tabs, restored automatically for each connection the next time you open it.
- `Ctrl+Enter` runs the statement under the cursor; `Ctrl+Shift+Enter` runs everything (or the selection).
- Handles `DELIMITER $$` blocks and `BEGIN … END` bodies in procedures, functions and triggers.
- Automatic `LIMIT` on SELECTs (row-limit dropdown), and a toggle to stop or continue after an error.
- Autocomplete for keywords, functions, schemas, tables and columns (including `alias.` and `schema.`).
- Errors are underlined in the editor. Explain (`Ctrl+Alt+X`) shows a Visual Explain.
- Beautify (`Ctrl+B`), find/replace, comment toggling, word wrap and invisible characters.
- Open/save `.sql` files with native Windows dialogs, plus a recent-files list.
- Commit, rollback and auto-commit toggle; Stop cancels the running query.

**Result grid**
- Fast virtualized grid with sorting, row filtering, column resizing, and NULL/BLOB indicators.
- **Edit results in place** when the result comes from a single table that has a primary key
  (or a `rowid` in SQLite). You can edit cells, add rows and delete rows. Apply shows the generated
  SQL for review before it runs inside a transaction.
- Side views: Form Editor, Field Types, Query Stats and Execution Plan.
- Value viewer/editor with Text, Binary (hex) and JSON views.
- Export to CSV, TSV, JSON, SQL INSERT statements, HTML, Markdown or XML; copy rows or fields in several formats.

**Navigator**
- Schema tree with Tables, Views, Stored Procedures and Functions, and for each table its
  Columns, Indexes, Foreign Keys and Triggers. Includes an object filter and hover shortcuts.
- Context menus like Workbench's: Select Rows, Table Inspector, Copy to Clipboard / Send to SQL Editor
  (name, SELECT/INSERT/UPDATE/DELETE templates, CREATE statement), Create/Alter/Drop/Truncate/Rename,
  Table Maintenance, and Set as Default Schema (double-click a schema to set it).
- Information panel with Object Info and Session tabs.

**Designers and inspectors**
- **Table editor** (create and alter): columns with PK/NN/UQ/UN/ZF/AI/G flags, data types,
  defaults and generated expressions, charset/collation, comments, indexes, foreign keys, triggers,
  engine and other options. Generates minimal `ALTER TABLE` statements. On SQLite it rebuilds the
  table safely when an in-place ALTER isn't possible.
- View, stored procedure, function and trigger editors (DDL with Apply and Revert).
- **Procedures & Functions** page (MySQL/MariaDB), opened from a schema's context menu or **Database >
  Procedures & Functions**. It lists every routine in a schema with its parameters, return type,
  deterministic flag, SQL data access, security, definer, dates and comment. You can filter and
  sort the list. Select a routine to see its definition, then Execute, Edit, Duplicate, Copy or Drop
  it. **Export** opens the CREATE statements of the listed routines in a SQL editor, ready to run
  on another server.
- **Execute / Call dialog**: one field per parameter (with IN / OUT / INOUT shown), a NULL checkbox,
  and a live preview of the SQL. Numbers are passed as numbers and other values as quoted text (so
  '007' stays text). Start a value with `=` to pass an expression such as `=NOW()`. INOUT values are
  set before the call, and OUT and INOUT values are shown after it. The last values you used are
  remembered for each routine.
- Selecting a procedure or function in the Navigator shows its parameters and characteristics in
  the Information panel.
- Table Inspector (info, columns, indexes, foreign keys, triggers, DDL) and Schema Inspector (sizes, row counts).
- **ER diagram** (reverse engineering): drag tables around, see relationships with crow's-foot
  markers, show keys only, zoom, and export to SVG or PNG.

**Schema Compare / Synchronize** (MySQL/MariaDB)
- Open it from **Database > Compare / Synchronize Schemas** or a schema's context menu. Pick a source
  (the schema to copy from) and a target (the schema to change). They can be on the same or on
  different open connections.
- Lists every table, view, stored procedure, function and trigger as Create, Alter, Drop or
  Identical, with a side-by-side diff of the definitions and the SQL for each object.
- Tables are diffed column by column: ADD / MODIFY / DROP COLUMN (keeping column order), indexes,
  primary keys, foreign keys, CHECK constraints and table options (engine, charset, comment, ...).
  Existing data is kept, except in dropped columns. A renamed column shows up as drop + add.
- The script is ordered so it applies cleanly: foreign keys are dropped first and added last,
  routines are created before the views that use them, and views after the views they select from.
- Objects to drop are not selected by default. Tick the ones you want, review the script, then apply it
  to the target (on a separate connection), open it in a SQL editor, or save it to a file.
- Options: ignore DEFINER differences, ignore integer display widths (INT(11) vs INT), ignore column
  order, and keep DEFINER clauses in the script. Events and partitioning are not synchronized.

**Administration** (MySQL/MariaDB)
- Server Status dashboard with live charts for connections, queries per second, traffic and InnoDB.
- Client Connections (process list, with Kill Query and Kill Connection).
- Users and Privileges: login, account limits, global roles and per-schema privileges.
- Status and System Variables.
- Data Export (SQL dump of selected tables, plus routines and triggers) and Data Import/Restore;
  both also work for SQLite.
- **Performance Reports** (Server menu, or Administration > Performance Reports): Workbench's reports,
  read from the server's `sys` schema, in seven groups:
  - Memory Usage
  - Hot Spots for I/O
  - High Cost SQL Statements: statement analysis, slowest 5%, temp tables, sorting, full table
    scans, errors
  - Database Schema Statistics: largest tables, table and index statistics, unused and redundant
    indexes, AUTO_INCREMENT headroom
  - Wait Event Times
  - InnoDB buffer pool and lock waits
  - User Resource Use

  Times and sizes are shown readably ("12.4 ms", "1.5 GiB") but sort by their real values. You can
  export a report to CSV, copy its query, and reset the collected statistics to measure from a
  clean start. Most reports need the Performance Schema. It is off by default in MariaDB, and the
  page explains how to turn it on. Largest Tables, Redundant Indexes, AUTO_INCREMENT and the InnoDB
  reports work without it.

**Table Data Import Wizard**
- Import a CSV, TSV or JSON file (array of objects or arrays, or JSON Lines) into a new or existing table.
  Open it from a table's or schema's context menu in the Navigator, or from **Server > Table Data Import Wizard**.
- Detects the encoding, field separator and header row; you can change them and see the preview update.
- Maps file columns to table columns by name (or by position). For a new table it suggests column
  types from the data (INT, DECIMAL, DATE, DATETIME, VARCHAR, JSON, ...), which you can edit, and
  lets you choose the primary key. The CREATE TABLE statement is shown before anything runs.
- Options for empty values, `NULL` / `\N` text, trimming, deleting existing rows first, and foreign key checks.
- Runs in one transaction on a separate connection, with progress and a Stop button. On an error it
  either rolls everything back or skips the failing rows and lists them.

**Other**
- Output panel (Action Output, with timings) and History Output (searchable, saved per connection).
- SQL snippets panel with built-in templates and your own saved queries ("My Snippets").
  Save the current statement with the ★ button in the editor. Your snippets can be organized into
  **folders**: choose or type a folder when saving, drag snippets onto a folder, or use **Move to
  Folder**. Right-click a folder to add a snippet to it, rename it, or delete it (keeping or deleting
  its snippets). A built-in template can be copied into My Snippets to customize it.
- Light and dark themes, adjustable editor font size, and a "Safe Updates" option.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Enter | Execute current statement |
| Ctrl+Shift+Enter | Execute all / selection |
| Ctrl+Alt+X | Explain current statement |
| Ctrl+Space | Autocomplete |
| Ctrl+B | Beautify |
| Ctrl+S / Ctrl+Shift+S | Save script / Save as |
| Ctrl+O | Open script |
| Ctrl+Alt+T | New query tab |
| F5 | Refresh navigator |

## Tests

```bat
run_tests.bat
```

The first run installs `pytest` (from `requirements-dev.txt`, which isn't part of the transfer zip).
The tests use a temporary data folder and an in-memory password vault, so your real settings and
saved passwords are never touched. The fast tests need no database server: they cover the script
splitter, the CSV/JSON import, schema compare, settings and passwords, the SQLite driver and the
HTTP API.

The MySQL/MariaDB tests (queries and the row cap, Stop, procedures, imports, Schema Sync round
trips, backup and restore, performance reports, SSH tunnels) run only when you point them at a
**test** server. They create and drop schemas named `dbcentral_*`:

```bat
set DBCENTRAL_TEST_MYSQL=root:password@127.0.0.1:3306
run_tests.bat
```

Extra arguments go to pytest, for example `run_tests.bat -k import` or `run_tests.bat -x`.

## Where data is stored

Everything lives in `%APPDATA%\DBCentral`: connection profiles, tabs, history, snippets,
preferences and the window profile. Set the `DBCENTRAL_DATA` environment variable to use a different
folder. Passwords are never written to these files; they go to the Windows Credential Manager under
"DBCentral" (SSH passwords and key passphrases too). SSH host keys you trust are saved in
`%APPDATA%\DBCentral\known_hosts`; keys in your own `~\.ssh\known_hosts` are accepted as well.

## Project layout

```
launch.py            launcher (server + app window, auto shutdown)
dbcentral/server.py    HTTP API (Flask, served by waitress)
dbcentral/drivers/     MySQL (PyMySQL) and SQLite drivers
dbcentral/dump.py      SQL export / import
dbcentral/dataimport.py  CSV / JSON table import (Table Data Import Wizard)
dbcentral/sshtunnel.py   SSH tunnels for MySQL connections (paramiko)
dbcentral/drivers/odbc.py  generic ODBC driver (pyodbc)
dbcentral/schemadiff.py  schema compare and synchronization script generator
dbcentral/perfreports.py performance report catalog (sys schema)
dbcentral/sqlsplit.py  script splitter (DELIMITER, compound statements)
static/              UI (plain ES modules, no build step)
static/vendor/       Monaco editor 0.52.2 and sql-formatter 15.9.1 (MIT licensed)
tools/make_dist.py   builds the zip for other PCs (run via make_dist.bat)
tools/shortcut.ps1   creates the desktop / Start menu shortcuts
```

## License

MIT - see [LICENSE](LICENSE). The bundled Monaco editor and sql-formatter keep their own MIT licenses (in `static/vendor/`).
