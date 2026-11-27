"""Open database sessions, keyed by session id and owned by a UI client (browser window)."""
import threading
import time
import uuid

from .drivers import make_driver

CLIENT_TIMEOUT = 120  # seconds without heartbeat before a client's sessions are closed


class Session:
    def __init__(self, profile, driver, client_id):
        self.id = uuid.uuid4().hex
        self.profile = profile
        self.driver = driver
        self.client_id = client_id
        self.created = time.time()


_sessions = {}
_clients = {}
_lock = threading.Lock()


def open_session(profile, password, client_id, **ssh):
    driver = make_driver(profile, password, **ssh)
    try:
        driver.connect()
    except BaseException:
        driver.close()
        raise
    if hasattr(driver, "warm_up"):
        driver.warm_up()
    s = Session(profile, driver, client_id)
    with _lock:
        _sessions[s.id] = s
        _clients.setdefault(client_id, time.time())
    return s


def get(sid):
    s = _sessions.get(sid)
    if s is None:
        raise KeyError("This connection was closed. Please reconnect.")
    return s


def close(sid):
    with _lock:
        s = _sessions.pop(sid, None)
    if s:
        threading.Thread(target=s.driver.close, daemon=True).start()


def close_all():
    with _lock:
        items = list(_sessions.values())
        _sessions.clear()
    for s in items:
        try:
            s.driver.close()
        except Exception:
            pass


def heartbeat(client_id):
    with _lock:
        _clients[client_id] = time.time()


def last_heartbeat():
    return max(_clients.values()) if _clients else None


def reap():
    now = time.time()
    with _lock:
        dead_clients = {c for c, t in _clients.items() if now - t > CLIENT_TIMEOUT}
        for c in dead_clients:
            _clients.pop(c, None)
        doomed = [sid for sid, s in _sessions.items() if s.client_id in dead_clients]
    for sid in doomed:
        close(sid)
    return len(doomed)
