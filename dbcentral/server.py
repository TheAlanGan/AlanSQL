"""HTTP API + static file server for the DBCentral UI."""
import os
import re
import time
from functools import wraps
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

from . import APP_NAME, __version__, dataimport, dialogs, dump, jobs, perfreports, schemadiff, sessions, store
from .config import load_json, save_json
from .drivers import DBError, make_driver

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
MAX_FILE_BYTES = 64 * 1024 * 1024
STATE_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def create_app(token: str, port: int):
    app = Flask(__name__, static_folder=None)
    app.json.sort_keys = False
    app.json.ensure_ascii = False
    app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_BYTES
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    app.config["DBCENTRAL_TOKEN"] = token

    # ------------------------------------------------------------------ guards
    @app.before_request
    def guard():
        if request.host not in allowed_hosts:
            abort(403)
        if request.path.startswith("/api/") and request.path != "/api/ping":
            if request.headers.get("X-DBCentral-Token") != token:
                return jsonify(error="Invalid or missing session token. Reopen DBCentral from its launcher."), 403
        return None

    @app.after_request
    def headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(DBError)
    def db_error(e):
        return jsonify(error=e.message, code=e.code, details=getattr(e, "details", None)), 400

    @app.errorhandler(KeyError)
    def key_error(e):
        msg = e.args[0] if e.args else "Not found"
        return jsonify(error=str(msg), code="not_found"), 404

    @app.errorhandler(ValueError)
    def value_error(e):
        return jsonify(error=str(e)), 400

    def body():
        return request.get_json(silent=True) or {}

    def with_session(fn):
        @wraps(fn)
        def wrapper(sid, *a, **kw):
            return fn(sessions.get(sid), *a, **kw)
        return wrapper

    # ------------------------------------------------------------------ static
    @app.get("/")
    def index():
        resp = send_from_directory(STATIC_DIR, "index.html", max_age=0)
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/static/<path:path>")
    def static_files(path):
        max_age = 86400 if path.startswith("vendor/") else 0
        return send_from_directory(STATIC_DIR, path, max_age=max_age)

    # ------------------------------------------------------------------ misc
    @app.get("/api/ping")
    def ping():
        return jsonify(app=APP_NAME, version=__version__)

    @app.post("/api/heartbeat")
    def heartbeat():
        cid = body().get("client_id") or "default"
        sessions.heartbeat(cid)
        return jsonify(ok=True, time=time.time())

    @app.get("/api/state/<key>")
    def get_state(key):
        if not STATE_KEY_RE.match(key):
            abort(400)
        return jsonify(value=load_json(f"state-{key}.json", None))

    @app.put("/api/state/<key>")
    def put_state(key):
        if not STATE_KEY_RE.match(key):
            abort(400)
        save_json(f"state-{key}.json", body().get("value"))
        return jsonify(ok=True)

    # ------------------------------------------------------------------ dialogs/files
    @app.post("/api/dialog/open")
    def dialog_open():
        b = body()
        path = dialogs.file_dialog(False, b.get("title"), b.get("filters"), None, None, b.get("initial_dir"))
        return jsonify(path=path)

    @app.post("/api/dialog/save")
    def dialog_save():
        b = body()
        path = dialogs.file_dialog(True, b.get("title"), b.get("filters"), b.get("default_name"),
                                   b.get("default_ext"), b.get("initial_dir"))
        return jsonify(path=path)

    def _check_path(path):
        if not path or not dialogs.is_approved(path):
            raise ValueError("Access to this file was not granted. Choose it with the file dialog first.")
        return os.path.abspath(path)

    @app.post("/api/files/read")
    def file_read():
        path = _check_path(body().get("path"))
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            raise ValueError(f"File is too large to open in the editor ({size:,} bytes).")
        with open(path, "rb") as fh:
            raw = fh.read()
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        return jsonify(path=path, name=os.path.basename(path), content=text)

    @app.post("/api/files/write")
    def file_write():
        b = body()
        path = _check_path(b.get("path"))
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(b.get("content") or "")
        return jsonify(ok=True, path=path, name=os.path.basename(path))

    @app.post("/api/files/approve-recent")
    def approve_recent():
        """Re-grant access to files from the recent-files list (paths the user opened before)."""
        recent = load_json("recent-files.json", [])
        path = body().get("path")
        if path in recent and os.path.exists(path):
            dialogs.approve(path)
            return jsonify(ok=True)
        return jsonify(ok=False), 404

    @app.post("/api/files/recent")
    def add_recent():
        path = body().get("path")
        if path and dialogs.is_approved(path):
            recent = [p for p in load_json("recent-files.json", []) if p != path]
            recent.insert(0, path)
            save_json("recent-files.json", recent[:15])
        return jsonify(recent=load_json("recent-files.json", []))

    @app.get("/api/files/recent")
    def list_recent():
        return jsonify(recent=[p for p in load_json("recent-files.json", []) if os.path.exists(p)])

    # ------------------------------------------------------------------ connections
    @app.get("/api/connections")
    def list_connections():
        return jsonify(connections=store.list_profiles())

    @app.post("/api/connections")
    def create_connection():
        b = body()
        p = store.save_profile(b.get("profile") or {})
        if "password" in b and b.get("save_password") and p["driver"] in store.PASSWORD_DRIVERS:
            store.set_password(p["id"], b.get("password") or "")
        _save_ssh_secret(p, b)
        return jsonify(connection=p)

    @app.put("/api/connections/<pid>")
    def update_connection(pid):
        b = body()
        p = store.save_profile(b.get("profile") or {}, pid)
        if b.get("save_password") and "password" in b:
            store.set_password(pid, b.get("password") or "")
        elif b.get("clear_password"):
            store.set_password(pid, None)
        _save_ssh_secret(p, b)
        return jsonify(connection=p)

    def _save_ssh_secret(p, b):
        key = store.ssh_secret_id(p["id"])
        if not p.get("ssh") or b.get("clear_ssh_password"):
            store.set_password(key, None)
        elif b.get("save_ssh_password") and b.get("ssh_password") is not None:
            store.set_password(key, b["ssh_password"])

    @app.delete("/api/connections/<pid>")
    def delete_connection(pid):
        store.delete_profile(pid)
        return jsonify(ok=True)

    @app.post("/api/connections/<pid>/duplicate")
    def duplicate_connection(pid):
        src = store.get_profile(pid)
        if not src:
            raise KeyError("Connection not found")
        copy = dict(src)
        copy["name"] = f"{src.get('name', 'Connection')} (copy)"
        p = store.save_profile(copy)
        for src_key, dst_key in ((pid, p["id"]), (store.ssh_secret_id(pid), store.ssh_secret_id(p["id"]))):
            pw = store.get_password(src_key)
            if pw is not None:
                store.set_password(dst_key, pw)
        return jsonify(connection=p)

    @app.post("/api/connections/set-group")
    def set_connection_group():
        b = body()
        store.set_group(b.get("ids") or [], b.get("group") or "")
        return jsonify(ok=True)

    @app.post("/api/connections/rename-group")
    def rename_connection_group():
        b = body()
        if not b.get("from"):
            raise ValueError("No group given.")
        return jsonify(changed=store.rename_group(b["from"], b.get("to") or ""))

    @app.post("/api/connections/reorder")
    def reorder_connections():
        store.reorder_profiles(body().get("ids") or [])
        return jsonify(ok=True)

    @app.get("/api/odbc/sources")
    def odbc_sources():
        from .drivers.odbc import list_sources
        return jsonify(list_sources())

    @app.post("/api/connections/test")
    def test_connection():
        b = body()
        profile = store.clean_profile(b.get("profile") or {})
        password = b.get("password")
        if password is None and b.get("id"):
            password = store.get_password(b["id"])
        drv = make_driver(profile, password, **_ssh_args(profile, b, b.get("id")))
        t0 = time.perf_counter()
        try:
            drv.connect()
            info = drv.info()
        finally:
            drv.close()
        return jsonify(ok=True, info=info, ms=round((time.perf_counter() - t0) * 1000, 1))

    def _ssh_args(profile, b, profile_id=None):
        if profile.get("driver") != "mysql" or not profile.get("ssh"):
            return {}
        secret = b.get("ssh_password")
        if secret is None and profile_id:
            secret = store.get_password(store.ssh_secret_id(profile_id))
        return {"ssh_secret": secret, "accept_host_key": b.get("accept_host_key")}

    # ------------------------------------------------------------------ sessions
    @app.post("/api/sessions")
    def open_session():
        b = body()
        profile = store.get_profile(b.get("connection_id") or "")
        if profile is None:
            raise KeyError("Connection profile not found.")
        password = b.get("password")
        need = []
        if profile.get("driver") in store.PASSWORD_DRIVERS and password is None:
            password = store.get_password(profile["id"])
            # ODBC sources often use Windows login: only ask when a user name is set
            asks = profile.get("driver") == "mysql" or bool(profile.get("user"))
            if password is None and asks and not b.get("try_empty"):
                need.append("password")
        ssh = _ssh_args(profile, b, profile["id"])
        if profile.get("driver") == "mysql" and profile.get("ssh") and (profile.get("ssh_auth") or "password") == "password"                 and ssh["ssh_secret"] is None:
            need.append("ssh_password")
        if need:
            return jsonify(need_password=True, need=need, profile=profile), 401
        s = sessions.open_session(profile, password, b.get("client_id") or "default", **ssh)
        for flag, key, value in (("save_password", profile["id"], password),
                                 ("save_ssh_password", store.ssh_secret_id(profile["id"]), b.get("ssh_password"))):
            if b.get(flag) and value is not None:
                try:
                    store.set_password(key, value)
                except Exception:
                    pass
        store.touch_profile(profile["id"])
        return jsonify(sid=s.id, info=s.driver.info(), profile=profile)

    @app.delete("/api/sessions/<sid>")
    def close_session(sid):
        sessions.close(sid)
        return jsonify(ok=True)

    @app.get("/api/sessions/<sid>/info")
    @with_session
    def session_info(s):
        info = s.driver.info()
        info["in_transaction"] = s.driver.in_transaction()
        return jsonify(info)

    @app.post("/api/sessions/<sid>/execute")
    @with_session
    def execute(s):
        b = body()
        sql = b.get("sql") or ""
        if not sql.strip():
            raise ValueError("Nothing to execute.")
        res = s.driver.execute(sql, int(b.get("max_rows") or 0))
        return jsonify(res)

    @app.post("/api/sessions/<sid>/cancel")
    @with_session
    def cancel(s):
        return jsonify(ok=s.driver.cancel())

    @app.post("/api/sessions/<sid>/autocommit")
    @with_session
    def autocommit(s):
        s.driver.set_autocommit(bool(body().get("enabled", True)))
        return jsonify(autocommit=s.driver.autocommit, in_transaction=s.driver.in_transaction())

    @app.post("/api/sessions/<sid>/commit")
    @with_session
    def commit(s):
        s.driver.commit()
        return jsonify(ok=True, in_transaction=s.driver.in_transaction())

    @app.post("/api/sessions/<sid>/rollback")
    @with_session
    def rollback(s):
        s.driver.rollback()
        return jsonify(ok=True, in_transaction=s.driver.in_transaction())

    @app.post("/api/sessions/<sid>/use")
    @with_session
    def use(s):
        schema = s.driver.use_schema(body().get("schema"))
        return jsonify(current_schema=schema)

    @app.post("/api/sessions/<sid>/script")
    @with_session
    def script(s):
        b = body()
        res = s.driver.run_script(b.get("statements") or [], bool(b.get("stop_on_error", True)),
                                  bool(b.get("transaction", False)))
        res["current_schema"] = s.driver.current_schema
        res["in_transaction"] = s.driver.in_transaction()
        return jsonify(res)

    @app.post("/api/sessions/<sid>/build_edits")
    @with_session
    def build_edits(s):
        b = body()
        return jsonify(statements=s.driver.build_edits(b.get("schema"), b["table"], b.get("changes") or {}))

    @app.get("/api/sessions/<sid>/schemas")
    @with_session
    def schemas(s):
        return jsonify(schemas=s.driver.list_schemas(), current_schema=s.driver.current_schema)

    @app.get("/api/sessions/<sid>/objects")
    @with_session
    def objects(s):
        return jsonify(s.driver.schema_objects(request.args["schema"]))

    @app.get("/api/sessions/<sid>/table")
    @with_session
    def table(s):
        return jsonify(s.driver.table_details(request.args.get("schema"), request.args["table"]))

    @app.get("/api/sessions/<sid>/routines")
    @with_session
    def routines(s):
        return jsonify(routines=s.driver.routines(request.args["schema"], request.args.get("name") or None))

    @app.get("/api/sessions/<sid>/fks")
    @with_session
    def schema_fks(s):
        return jsonify(fks=s.driver.schema_fks(request.args["schema"]))

    @app.get("/api/sessions/<sid>/ddl")
    @with_session
    def ddl(s):
        a = request.args
        return jsonify(ddl=s.driver.get_ddl(a.get("schema"), a["name"], a.get("type", "table")))

    @app.get("/api/sessions/<sid>/completion")
    @with_session
    def completion(s):
        return jsonify(tables=s.driver.completion_columns(request.args["schema"]))

    @app.get("/api/sessions/<sid>/meta")
    @with_session
    def meta(s):
        return jsonify(s.driver.meta())

    @app.post("/api/sessions/<sid>/explain")
    @with_session
    def explain(s):
        return jsonify(s.driver.explain(body().get("sql") or ""))

    # ------------------------------------------------------------------ admin (MySQL)
    def _admin(s):
        if not s.driver.features.get("admin"):
            raise ValueError("Administration features are only available for MySQL/MariaDB connections.")
        return s.driver

    @app.get("/api/sessions/<sid>/admin/status")
    @with_session
    def admin_status(s):
        return jsonify(_admin(s).admin_status())

    @app.get("/api/sessions/<sid>/admin/processlist")
    @with_session
    def admin_processlist(s):
        return jsonify(rows=_admin(s).processlist())

    @app.post("/api/sessions/<sid>/admin/kill")
    @with_session
    def admin_kill(s):
        b = body()
        _admin(s).kill(b["id"], bool(b.get("query_only")))
        return jsonify(ok=True)

    @app.get("/api/sessions/<sid>/admin/variables")
    @with_session
    def admin_variables(s):
        return jsonify(rows=_admin(s).variables(request.args.get("kind", "system")))

    @app.get("/api/sessions/<sid>/admin/users")
    @with_session
    def admin_users(s):
        return jsonify(users=_admin(s).users())

    @app.get("/api/sessions/<sid>/admin/user")
    @with_session
    def admin_user(s):
        return jsonify(_admin(s).user_details(request.args["user"], request.args["host"]))

    # ------------------------------------------------------------------ export / import jobs
    @app.post("/api/sessions/<sid>/export")
    @with_session
    def export(s):
        b = body()
        path = _check_path(b.get("path"))
        fn = dump.export_mysql if s.driver.kind == "mysql" else dump.export_sqlite
        job = jobs.start("export", f"Export {b.get('schema')}", lambda j: fn(s.driver, b, path, j))
        return jsonify(job=job.to_dict())

    @app.post("/api/sessions/<sid>/import")
    @with_session
    def import_(s):
        b = body()
        path = _check_path(b.get("path"))
        job = jobs.start("import", f"Import {os.path.basename(path)}",
                         lambda j: dump.import_sql(s.driver, b, path, j))
        return jsonify(job=job.to_dict())

    @app.post("/api/sessions/<sid>/import-data/preview")
    @with_session
    def import_data_preview(s):
        b = body()
        return jsonify(dataimport.preview(s.driver, _check_path(b.get("path")), b.get("options") or {}))

    @app.post("/api/sessions/<sid>/import-data/sql")
    @with_session
    def import_data_sql(s):
        b = body()
        return jsonify(statements=dataimport.create_table_sql(s.driver, b.get("schema"), b.get("table"),
                                                              b.get("columns") or [], b.get("drop")))

    @app.post("/api/sessions/<sid>/import-data")
    @with_session
    def import_data(s):
        b = body()
        path = _check_path(b.get("path"))
        job = jobs.start("import-data", f"Import {os.path.basename(path)} into {b.get('table')}",
                         lambda j: dataimport.import_data(s.driver, b, path, j))
        return jsonify(job=job.to_dict())

    @app.get("/api/sessions/<sid>/perf/status")
    @with_session
    def perf_status(s):
        return jsonify(perfreports.status(s.driver))

    @app.get("/api/sessions/<sid>/perf/report")
    @with_session
    def perf_report(s):
        return jsonify(perfreports.run(s.driver, request.args.get("id"), request.args.get("limit", 1000)))

    @app.post("/api/sessions/<sid>/perf/reset")
    @with_session
    def perf_reset(s):
        return jsonify(perfreports.reset(s.driver))

    @app.post("/api/schema-diff")
    def schema_diff():
        b = body()
        src, tgt = b.get("source") or {}, b.get("target") or {}
        s1, s2 = sessions.get(src.get("sid")), sessions.get(tgt.get("sid"))
        if not src.get("schema") or not tgt.get("schema"):
            raise ValueError("Choose both schemas.")
        return jsonify(schemadiff.compare(s1.driver, src["schema"], s2.driver, tgt["schema"], b.get("options") or {}))

    @app.post("/api/sessions/<sid>/apply-script")
    @with_session
    def apply_script(s):
        b = body()
        if s.driver.kind != "mysql":
            raise ValueError("Only available for MySQL / MariaDB connections.")
        return jsonify(schemadiff.apply_script(s.driver, b.get("statements") or [], b.get("stop_on_error", True)))

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id):
        job = jobs.get(job_id)
        if not job:
            raise KeyError("Job not found")
        return jsonify(job=job.to_dict())

    @app.post("/api/jobs/<job_id>/cancel")
    def job_cancel(job_id):
        job = jobs.get(job_id)
        if job:
            job.cancel_requested = True
        return jsonify(ok=True)

    return app
