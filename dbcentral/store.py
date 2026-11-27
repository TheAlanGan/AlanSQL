"""Connection profiles (stored as JSON) and passwords (stored in the OS vault via keyring)."""
import time
import uuid

from .config import load_json, save_json

KEYRING_SERVICE = "DBCentral"
LEGACY_SERVICES = ("SQLDesk",)   # the app's former name; passwords saved under it are moved on first use
PROFILES_FILE = "connections.json"

PROFILE_FIELDS = {
    "name": str,
    "driver": str,            # "mysql" | "sqlite"
    "group": str,
    "host": str,
    "port": int,
    "user": str,
    "schema": str,
    "ssl_mode": str,          # disabled | preferred | required | verify_ca | verify_identity
    "ssl_ca": str,
    "ssl_cert": str,
    "ssl_key": str,
    "connect_timeout": int,
    "init_command": str,
    "file": str,              # sqlite path
    "create_if_missing": bool,
    "foreign_keys": bool,
    "color": str,
    "ssh": bool,              # MySQL over an SSH tunnel
    "ssh_host": str,
    "ssh_port": int,
    "ssh_user": str,
    "ssh_auth": str,          # password | key | agent
    "ssh_key_file": str,
    "odbc_mode": str,         # dsn | string
    "odbc_dsn": str,
    "odbc_connstr": str,      # without the password: that goes to the vault
}

PASSWORD_DRIVERS = ("mysql", "odbc")


def ssh_secret_id(profile_id: str) -> str:
    """Vault entry for the SSH password or key passphrase of a connection."""
    return f"{profile_id}:ssh"


def _keyring():
    try:
        import keyring  # noqa: WPS433
        return keyring
    except Exception:  # pragma: no cover - keyring missing
        return None


def get_password(profile_id: str):
    kr = _keyring()
    if not kr:
        return None
    try:
        pw = kr.get_password(KEYRING_SERVICE, profile_id)
        for old in LEGACY_SERVICES:
            if pw is not None:
                break
            pw = kr.get_password(old, profile_id)
            if pw is not None:
                kr.set_password(KEYRING_SERVICE, profile_id, pw)
                kr.delete_password(old, profile_id)
        return pw
    except Exception:
        return None


def set_password(profile_id: str, password):
    kr = _keyring()
    if not kr:
        raise RuntimeError("No password vault (keyring) is available on this system.")
    if password is None:
        for service in (KEYRING_SERVICE, *LEGACY_SERVICES):
            try:
                kr.delete_password(service, profile_id)
            except Exception:
                pass
    else:
        kr.set_password(KEYRING_SERVICE, profile_id, password)


def clean_profile(data: dict) -> dict:
    out = {}
    for key, typ in PROFILE_FIELDS.items():
        if key not in data or data[key] is None:
            continue
        val = data[key]
        try:
            if typ is int:
                val = int(val) if str(val).strip() != "" else None
            elif typ is bool:
                val = bool(val)
            else:
                val = str(val)
        except (TypeError, ValueError):
            continue
        if val is not None:
            out[key] = val
    if out.get("driver") not in ("mysql", "sqlite", "odbc"):
        out["driver"] = "mysql"
    out.setdefault("name", "New Connection")
    return out


def list_profiles():
    profiles = load_json(PROFILES_FILE, [])
    for p in profiles:
        p["has_password"] = p.get("driver") in PASSWORD_DRIVERS and get_password(p["id"]) is not None
        p["has_ssh_password"] = bool(p.get("ssh")) and get_password(ssh_secret_id(p["id"])) is not None
    return profiles


def get_profile(profile_id: str):
    for p in load_json(PROFILES_FILE, []):
        if p.get("id") == profile_id:
            return p
    return None


def save_profile(data: dict, profile_id: str | None = None) -> dict:
    profiles = load_json(PROFILES_FILE, [])
    cleaned = clean_profile(data)
    if profile_id:
        for i, p in enumerate(profiles):
            if p.get("id") == profile_id:
                cleaned["id"] = profile_id
                cleaned["created"] = p.get("created", time.time())
                cleaned["last_used"] = p.get("last_used")
                profiles[i] = cleaned
                break
        else:
            raise KeyError(profile_id)
    else:
        cleaned["id"] = uuid.uuid4().hex[:12]
        cleaned["created"] = time.time()
        profiles.append(cleaned)
    save_json(PROFILES_FILE, profiles)
    return cleaned


def delete_profile(profile_id: str) -> None:
    profiles = [p for p in load_json(PROFILES_FILE, []) if p.get("id") != profile_id]
    save_json(PROFILES_FILE, profiles)
    for key in (profile_id, ssh_secret_id(profile_id)):
        try:
            set_password(key, None)
        except Exception:
            pass


def touch_profile(profile_id: str) -> None:
    profiles = load_json(PROFILES_FILE, [])
    for p in profiles:
        if p.get("id") == profile_id:
            p["last_used"] = time.time()
    save_json(PROFILES_FILE, profiles)


def set_group(profile_ids: list, group: str) -> None:
    """Put connections into a group ('' removes them from any group)."""
    group = (group or "").strip()
    profiles = load_json(PROFILES_FILE, [])
    for p in profiles:
        if p.get("id") in profile_ids:
            if group:
                p["group"] = group
            else:
                p.pop("group", None)
    save_json(PROFILES_FILE, profiles)


def rename_group(old: str, new: str) -> int:
    """Rename a group, or dissolve it when new is ''. Returns how many connections changed."""
    new = (new or "").strip()
    profiles = load_json(PROFILES_FILE, [])
    n = 0
    for p in profiles:
        if (p.get("group") or "") == old:
            n += 1
            if new:
                p["group"] = new
            else:
                p.pop("group", None)
    save_json(PROFILES_FILE, profiles)
    return n


def reorder_profiles(ids: list) -> None:
    profiles = load_json(PROFILES_FILE, [])
    order = {pid: i for i, pid in enumerate(ids)}
    profiles.sort(key=lambda p: order.get(p.get("id"), len(order)))
    save_json(PROFILES_FILE, profiles)
