"""Start the DBCentral server and open it in a chromeless app window (Edge/Chrome), or the default browser.

    python launch.py              # start + open window; exits ~1 minute after the last window closes
    python launch.py --no-window  # just run the server and print the URL
    python launch.py --keep-alive # don't exit when windows are closed
"""
import argparse
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dbcentral import APP_NAME, sessions  # noqa: E402
from dbcentral.config import data_dir  # noqa: E402

DEFAULT_PORT = 8765
IDLE_EXIT_SECONDS = 60
INSTANCE_FILE = "instance.json"


def find_browser():
    candidates = []
    for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            candidates.append(os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
            candidates.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    for name in ("msedge", "google-chrome", "chromium", "chromium-browser", "chrome"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def open_window(url):
    browser = find_browser()
    if browser:
        profile = data_dir() / "window-profile"
        args = [browser, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1440,900",
                "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"]
        flags = 0
        if os.name == "nt":
            flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(args, close_fds=True, creationflags=flags)
    else:
        webbrowser.open(url)


def existing_instance():
    path = data_dir() / INSTANCE_FILE
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
        with urllib.request.urlopen(f"http://127.0.0.1:{info['port']}/api/ping", timeout=1.5) as r:
            if json.loads(r.read().decode()).get("app") == APP_NAME:
                return info
    except Exception:
        pass
    return None


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def main():
    if sys.stdout is None or sys.stderr is None:  # started with pythonw.exe: log to a file instead
        log = open(data_dir() / "dbcentral.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log
    ap = argparse.ArgumentParser(description=f"{APP_NAME} launcher")
    ap.add_argument("--port", type=int, default=int(os.environ.get("DBCENTRAL_PORT") or DEFAULT_PORT))
    ap.add_argument("--no-window", action="store_true", help="don't open an app window")
    ap.add_argument("--keep-alive", action="store_true", help="keep running after all windows close")
    args = ap.parse_args()

    running = existing_instance()
    if running:
        url = f"http://127.0.0.1:{running['port']}/?t={running['token']}"
        print(f"{APP_NAME} is already running: {url}")
        if not args.no_window:
            open_window(url)
        return

    port = args.port
    while not port_free(port):
        port += 1
    token = secrets.token_urlsafe(24)

    from waitress import create_server
    from dbcentral.server import create_app

    app = create_app(token, port)
    server = create_server(app, host="127.0.0.1", port=port, threads=12, channel_timeout=3600,
                           ident=APP_NAME)
    url = f"http://127.0.0.1:{port}/?t={token}"
    inst = data_dir() / INSTANCE_FILE
    inst.write_text(json.dumps({"port": port, "token": token, "pid": os.getpid()}), encoding="utf-8")
    print(f"{APP_NAME} running at {url}", flush=True)

    started = time.time()

    def watchdog():
        while True:
            time.sleep(10)
            sessions.reap()
            if args.keep_alive:
                continue
            last = sessions.last_heartbeat()
            idle_since = last if last else started
            grace = IDLE_EXIT_SECONDS if last else 300
            if time.time() - idle_since > grace:
                print("No open windows; shutting down.", flush=True)
                sessions.close_all()
                try:
                    inst.unlink()
                except OSError:
                    pass
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    if not args.no_window:
        threading.Timer(0.4, open_window, args=(url,)).start()
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        sessions.close_all()
        try:
            inst.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
