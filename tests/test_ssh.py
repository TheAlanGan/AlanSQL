"""SSH tunnels, through a small SSH server started inside the test run (needs the MySQL test server,
which it forwards to). Covers host-key trust, a changed host key, passwords and key files."""
import base64
import socket
import threading

import paramiko
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from dbcentral.drivers import make_driver
from dbcentral.drivers.base import DBError

pytestmark = pytest.mark.mysql

USER, PASSWORD, PASSPHRASE = "tunnel", "tunnel-pw", "key-pass"


class _Server(paramiko.ServerInterface):
    def __init__(self, authorized):
        self.authorized, self.pending = authorized, {}

    def get_allowed_auths(self, username):
        return "password,publickey"

    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username, password) == (USER, PASSWORD) else paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, key):
        return paramiko.AUTH_SUCCESSFUL if username == USER and key == self.authorized else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        try:
            self.pending[chanid] = socket.create_connection(destination, timeout=5)
        except OSError:
            return paramiko.OPEN_FAILED_CONNECT_FAILED
        return paramiko.OPEN_SUCCEEDED


def _pump(a, b):
    def run(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except Exception:  # noqa: BLE001
            pass
        for x in (a, b):
            try:
                x.close()
            except Exception:  # noqa: BLE001
                pass
    threading.Thread(target=run, args=(a, b), daemon=True).start()
    threading.Thread(target=run, args=(b, a), daemon=True).start()


class SSHServer:
    def __init__(self, host_key, authorized):
        self.host_key, self.authorized = host_key, authorized
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(10)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                client, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client):
        t = paramiko.Transport(client)
        t.add_server_key(self.host_key)
        srv = _Server(self.authorized)
        try:
            t.start_server(server=srv)
        except Exception:  # noqa: BLE001
            return
        while t.is_active():
            chan = t.accept(1)
            if chan is not None:
                target = srv.pending.pop(chan.get_id(), None)
                if target is None:
                    chan.close()
                else:
                    _pump(chan, target)

    def close(self):
        self.sock.close()


@pytest.fixture(scope="module")
def keys(tmp_path_factory):
    folder = tmp_path_factory.mktemp("keys")
    k = ed25519.Ed25519PrivateKey.generate()
    (folder / "id_ed25519").write_bytes(k.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
        serialization.BestAvailableEncryption(PASSPHRASE.encode())))
    pub = k.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
    authorized = paramiko.Ed25519Key(data=base64.b64decode(pub.split()[1]))
    return {"key_file": str(folder / "id_ed25519"), "authorized": authorized,
            "host_a": paramiko.RSAKey.generate(2048), "host_b": paramiko.RSAKey.generate(2048)}


@pytest.fixture
def ssh(keys):
    servers = []

    def start(host_key="host_a"):
        s = SSHServer(keys[host_key], keys["authorized"])
        servers.append(s)
        return s
    yield start
    for s in servers:
        s.close()


def profile(mysql_conf, ssh_port, **extra):
    base, _password = mysql_conf
    return {**base, "ssh": True, "ssh_host": "127.0.0.1", "ssh_port": ssh_port, "ssh_user": USER, "ssh_auth": "password", **extra}


def connect(mysql_conf, prof, **kw):
    d = make_driver(prof, mysql_conf[1], **kw)
    d.connect()
    return d


def trusted_fingerprint(mysql_conf, prof, secret):
    with pytest.raises(DBError) as e:
        connect(mysql_conf, prof, ssh_secret=secret)
    assert e.value.code == "ssh_unknown_host"
    return e.value.details["fingerprint"]


def test_password_login_and_host_key_trust(mysql_conf, ssh, isolated_data):
    srv = ssh()
    prof = profile(mysql_conf, srv.port)
    fp = trusted_fingerprint(mysql_conf, prof, PASSWORD)
    with pytest.raises(DBError, match="authenticity"):
        connect(mysql_conf, prof, ssh_secret=PASSWORD, accept_host_key="SHA256:not-the-key")
    d = connect(mysql_conf, prof, ssh_secret=PASSWORD, accept_host_key=fp)
    assert d.info()["ssh"].startswith(USER + "@")
    assert d.execute("SELECT 1")["results"][0]["rows"] == [[1]]
    r = d.execute("SELECT * FROM information_schema.COLLATIONS", 3)["results"][0]   # row cap via the tunnel
    assert len(r["rows"]) == 3 and r["truncated"]
    assert d.execute("SELECT 2")["results"][0]["rows"] == [[2]]
    d.close()
    assert (isolated_data / "known_hosts").exists()
    d = connect(mysql_conf, prof, ssh_secret=PASSWORD)          # now trusted without asking
    d.close()


def test_changed_host_key_is_refused(mysql_conf, ssh):
    first = ssh("host_a")
    prof = profile(mysql_conf, first.port)
    connect(mysql_conf, prof, ssh_secret=PASSWORD, accept_host_key=trusted_fingerprint(mysql_conf, prof, PASSWORD)).close()
    first.close()
    second = ssh("host_b")                    # a different key at the same address
    prof2 = profile(mysql_conf, first.port)
    if second.port != first.port:             # the OS may not hand out the same port; fake the old entry instead
        from dbcentral import sshtunnel
        keys_file = sshtunnel._load_known_hosts(paramiko)[1]
        text = open(keys_file, encoding="utf-8").read().replace(f"]:{first.port}", f"]:{second.port}")
        open(keys_file, "w", encoding="utf-8").write(text)
        prof2 = profile(mysql_conf, second.port)
    with pytest.raises(DBError) as e:
        connect(mysql_conf, prof2, ssh_secret=PASSWORD, accept_host_key="anything")
    assert e.value.code == "ssh_host_key_changed"


def test_wrong_password(mysql_conf, ssh):
    srv = ssh()
    prof = profile(mysql_conf, srv.port)
    fp = trusted_fingerprint(mysql_conf, prof, PASSWORD)
    with pytest.raises(DBError) as e:
        connect(mysql_conf, prof, ssh_secret="wrong", accept_host_key=fp)
    assert e.value.code == "ssh_auth_failed"


def test_key_file_with_passphrase(mysql_conf, ssh, keys):
    srv = ssh()
    prof = profile(mysql_conf, srv.port, ssh_auth="key", ssh_key_file=keys["key_file"])
    fp = trusted_fingerprint(mysql_conf, prof, PASSPHRASE)
    for secret in (None, "wrong"):
        with pytest.raises(DBError) as e:
            connect(mysql_conf, prof, ssh_secret=secret, accept_host_key=fp)
        assert e.value.code == "ssh_need_passphrase"
    d = connect(mysql_conf, prof, ssh_secret=PASSPHRASE, accept_host_key=fp)
    assert d.execute("SELECT 1")["results"][0]["rows"] == [[1]]
    d.close()


def test_unreachable_targets(mysql_conf, ssh):
    with pytest.raises(DBError, match="Could not reach the SSH server"):
        connect(mysql_conf, profile(mysql_conf, 1), ssh_secret=PASSWORD)
    srv = ssh()
    prof = profile(mysql_conf, srv.port, port=1)                # MySQL port closed behind the tunnel
    fp = trusted_fingerprint(mysql_conf, prof, PASSWORD)
    with pytest.raises(DBError, match="could not connect to MySQL"):
        connect(mysql_conf, prof, ssh_secret=PASSWORD, accept_host_key=fp)
