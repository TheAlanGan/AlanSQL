"""SSH tunnels for MySQL connections ("Standard TCP/IP over SSH").

Each database connection gets its own SSH channel on one shared SSH session. The channel is bridged to
a local socket pair, so no TCP port is opened on this machine. Host keys are checked against
~/.ssh/known_hosts and DBCentral's own known_hosts file; unknown hosts must be confirmed by the user.
"""
import base64
import hashlib
import os
import re
import socket
import threading

from .config import data_dir
from .drivers.base import DBError

KNOWN_HOSTS_FILE = "known_hosts"
_known_lock = threading.Lock()


class SSHError(DBError):
    def __init__(self, message, code=None, details=None):
        super().__init__(message, code)
        self.details = details


def fingerprint(key):
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def _host_id(host, port):
    return host if int(port) == 22 else f"[{host}]:{port}"


def _paramiko():
    try:
        import logging
        import paramiko
        logging.getLogger("paramiko").addHandler(logging.NullHandler())
        logging.getLogger("paramiko").propagate = False
    except ImportError:
        raise SSHError("SSH support needs the 'paramiko' package. Run setup.bat again to install it.") from None
    return paramiko


def _load_known_hosts(paramiko):
    """(merged HostKeys, path of DBCentral's own known_hosts file)."""
    keys = paramiko.HostKeys()
    own = os.path.join(str(data_dir()), KNOWN_HOSTS_FILE)
    for path in (os.path.expanduser(os.path.join("~", ".ssh", "known_hosts")), own):
        if os.path.isfile(path):
            try:
                keys.load(path)
            except Exception:  # noqa: BLE001 - a malformed line should not block connecting
                pass
    return keys, own


def _remember_host(paramiko, host_id, key, path):
    with _known_lock:
        own = paramiko.HostKeys()
        if os.path.isfile(path):
            try:
                own.load(path)
            except Exception:  # noqa: BLE001
                pass
        own.add(host_id, key.get_name(), key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        own.save(path)


class SSHTunnel:
    """One SSH session; open_socket() returns a socket connected to remote_host:remote_port via SSH."""

    def __init__(self, profile, secret=None, accept_host_key=None):
        p = profile
        self.host = (p.get("ssh_host") or "").strip()
        self.port = int(p.get("ssh_port") or 22)
        self.user = (p.get("ssh_user") or "").strip()
        self.auth = p.get("ssh_auth") or "password"
        self.key_file = (p.get("ssh_key_file") or "").strip()
        self.secret = secret
        self.accept_host_key = accept_host_key
        self.timeout = int(p.get("connect_timeout") or 10)
        self.remote_host = p.get("host") or "127.0.0.1"
        self.remote_port = int(p.get("port") or 3306)
        self.transport = None
        self._lock = threading.Lock()
        if not self.host:
            raise SSHError("Enter the SSH hostname.")
        if not self.user:
            raise SSHError("Enter the SSH username.")

    @property
    def label(self):
        return f"{self.user}@{self.host}" + ("" if self.port == 22 else f":{self.port}")

    # ------------------------------------------------------------------ session
    def _connect(self):
        paramiko = _paramiko()
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as e:
            raise SSHError(f"Could not reach the SSH server {self.host}:{self.port}: {e.strerror or e}") from None
        t = paramiko.Transport(sock)
        try:
            t.banner_timeout = t.auth_timeout = self.timeout
            known, _own = _load_known_hosts(paramiko)
            entry = known.lookup(_host_id(self.host, self.port))
            if entry:   # negotiate a host key type we already know, as OpenSSH does
                opts = t.get_security_options()
                kinds = list(entry.keys())
                pref = [k for k in opts.key_types if k in kinds or (k.startswith("rsa-sha2") and "ssh-rsa" in kinds)]
                opts.key_types = pref + [k for k in opts.key_types if k not in pref]
            try:
                t.start_client(timeout=self.timeout)
            except (paramiko.SSHException, EOFError, OSError) as e:
                raise SSHError(f"SSH handshake with {self.host}:{self.port} failed: {e}") from None
            self._check_host_key(paramiko, t)
            self._authenticate(paramiko, t)
            t.set_keepalive(30)
        except BaseException:
            t.close()
            raise
        return t

    def _check_host_key(self, paramiko, t):
        key = t.get_remote_server_key()
        host_id = _host_id(self.host, self.port)
        known, own_path = _load_known_hosts(paramiko)
        entry = known.lookup(host_id)
        fp = fingerprint(key)
        if entry:
            if entry.get(key.get_name()) == key:
                return
            old = entry.get(key.get_name()) or next(iter(entry.values()))
            raise SSHError(
                f"WARNING: the host key of {host_id} has changed. It could be that someone is intercepting "
                f"the connection, or the server was reinstalled. Expected {fingerprint(old)} "
                f"({old.get_name()}), got {fp} ({key.get_name()}). If the change is expected, remove the old "
                f"entry for {host_id} from your known_hosts file and connect again.",
                code="ssh_host_key_changed", details={"host": host_id, "fingerprint": fp})
        if self.accept_host_key and self.accept_host_key == fp:
            _remember_host(paramiko, host_id, key, own_path)
            return
        raise SSHError(f"The authenticity of the SSH server {host_id} can't be established.",
                       code="ssh_unknown_host",
                       details={"host": host_id, "fingerprint": fp, "key_type": key.get_name()})

    def _authenticate(self, paramiko, t):
        user = self.user
        try:
            if self.auth == "agent":
                keys = paramiko.Agent().get_keys()
                if not keys:
                    raise SSHError("No keys are loaded in an SSH agent (Pageant or the Windows OpenSSH agent).")
                for k in keys:
                    try:
                        t.auth_publickey(user, k)
                        if t.is_authenticated():
                            return
                    except paramiko.AuthenticationException:
                        continue
                raise SSHError(f"The SSH server rejected all {len(keys)} key(s) from the SSH agent for {user}.",
                               code="ssh_auth_failed")
            if self.auth == "key":
                pkey = self._load_key(paramiko)
                t.auth_publickey(user, pkey)
                return
            if self.secret is None:
                raise SSHError("The SSH password is needed.", code="ssh_need_password")
            try:
                t.auth_password(user, self.secret)
            except paramiko.BadAuthenticationType as e:
                if "keyboard-interactive" not in (e.allowed_types or []):
                    raise SSHError(f"The SSH server does not accept passwords for {user} "
                                   f"(it allows: {', '.join(e.allowed_types)}). Use a key file or an SSH agent.",
                                   code="ssh_auth_failed") from None
                t.auth_interactive(user, lambda _title, _instr, prompts: [self.secret] * len(prompts))
        except paramiko.AuthenticationException as e:
            what = "password" if self.auth == "password" else "key"
            raise SSHError(f"SSH authentication failed for {user}@{self.host} ({what} rejected): {e}",
                           code="ssh_auth_failed") from None
        except paramiko.SSHException as e:
            raise SSHError(f"SSH error during authentication: {e}") from None

    def _load_key(self, paramiko):
        path = os.path.expanduser(self.key_file)
        if not path:
            raise SSHError("Choose the SSH private key file.")
        if not os.path.isfile(path):
            raise SSHError(f"SSH key file not found: {path}")
        with open(path, "rb") as fh:
            head = fh.read(64)
        if head.startswith(b"PuTTY-User-Key-File"):
            raise SSHError("PuTTY .ppk keys are not supported. In PuTTYgen, use Conversions > Export OpenSSH key, "
                           "or load the key into Pageant and choose 'SSH agent'.")
        try:
            try:    # the passphrase argument is a str in paramiko 4+, bytes in 3.x
                return paramiko.PKey.from_path(path, self.secret or None)
            except TypeError:
                return paramiko.PKey.from_path(path, self.secret.encode() if self.secret else None)
        except paramiko.PasswordRequiredException:
            raise SSHError("The SSH key file is protected by a passphrase.", code="ssh_need_passphrase") from None
        except (paramiko.SSHException, ValueError, TypeError) as e:
            if self.secret:
                raise SSHError("Wrong passphrase for the SSH key file.", code="ssh_need_passphrase") from None
            if re.search(r"password|passphrase|encrypted", str(e), re.I):
                raise SSHError("The SSH key file is protected by a passphrase.", code="ssh_need_passphrase") from None
            raise SSHError(f"Could not read the SSH key file: {e}") from None

    def start(self):
        with self._lock:
            if self.transport is None or not self.transport.is_active():
                if self.transport is not None:
                    self.transport.close()
                self.transport = self._connect()
        return self

    # ------------------------------------------------------------------ channels
    def open_socket(self):
        """A connected socket whose other end is remote_host:remote_port, as seen from the SSH server."""
        paramiko = _paramiko()
        self.start()
        try:
            chan = self.transport.open_channel("direct-tcpip", (self.remote_host, self.remote_port),
                                               ("127.0.0.1", 0), timeout=self.timeout)
        except paramiko.ChannelException as e:
            raise SSHError(f"The SSH server could not connect to MySQL at {self.remote_host}:{self.remote_port} "
                           f"({e.text or 'connection refused'}). The MySQL hostname is resolved on the SSH server.") from None
        except (paramiko.SSHException, OSError, EOFError) as e:
            raise SSHError(f"Could not open an SSH channel: {e}") from None
        ours, theirs = socket.socketpair()
        _bridge(theirs, chan)
        return ours

    def close(self):
        with self._lock:
            if self.transport is not None:
                self.transport.close()
                self.transport = None


def _bridge(sock, chan):
    """Copy bytes both ways between a local socket and an SSH channel until either side closes."""
    def pump(src_recv, dst_send, on_end):
        try:
            while True:
                data = src_recv(65536)
                if not data:
                    break
                dst_send(data)
        except Exception:  # noqa: BLE001 - either side went away
            pass
        finally:
            on_end()

    def close_all():
        for c in (sock, chan):
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=pump, args=(sock.recv, chan.sendall, close_all), daemon=True, name="ssh-up").start()
    threading.Thread(target=pump, args=(chan.recv, sock.sendall, close_all), daemon=True, name="ssh-down").start()
