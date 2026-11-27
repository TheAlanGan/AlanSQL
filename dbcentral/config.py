"""Paths and small JSON persistence helpers."""
import json
import os
import shutil
import tempfile
import threading
from pathlib import Path

_lock = threading.Lock()
_migrated = False


MIGRATED_MARKER = ".migrated"


def _migrate(olds, new: Path) -> None:
    """Bring the data folder over from the app's former name (SQLDesk), once.

    The first old folder that exists is used. It is renamed when possible. Otherwise, or when a folder
    with the new name already exists, the settings are merged: files the new folder doesn't have yet
    are copied, nothing is overwritten, and the browser window profile is only copied when the new
    folder has none.
    """
    global _migrated
    if _migrated:
        return
    _migrated = True
    old = next((o for o in olds if o.is_dir()), None)
    if old is None or (new / MIGRATED_MARKER).exists():
        return
    note = f"Settings copied from {old}\n"
    if not new.exists():
        try:
            old.rename(new)
            (new / MIGRATED_MARKER).write_text(note, encoding="utf-8")
            return
        except OSError:          # e.g. the old version is still running; copy instead
            if new.exists():
                return
    skip = {"instance.json", MIGRATED_MARKER} | ({"window-profile"} if (new / "window-profile").exists() else set())

    def copy_missing(src, dst):
        if not os.path.exists(dst):
            shutil.copy2(src, dst)
    try:
        shutil.copytree(old, new, dirs_exist_ok=True, copy_function=copy_missing,
                        ignore=lambda folder, names: [n for n in names if n in skip or n.endswith(".log")])
    except (OSError, shutil.Error):
        pass
    try:
        (new / MIGRATED_MARKER).write_text(note, encoding="utf-8")
    except OSError:
        pass


def data_dir() -> Path:
    override = os.environ.get("DBCENTRAL_DATA")
    if override:
        base = Path(override)
    elif os.name == "nt":
        appdata = Path(os.environ.get("APPDATA", Path.home()))
        base = appdata / "DBCentral"
        _migrate([appdata / "SQLDesk"], base)
    else:
        base = Path.home() / ".dbcentral"
        _migrate([Path.home() / ".sqldesk"], base)
    base.mkdir(parents=True, exist_ok=True)
    return base


def load_json(name: str, default):
    path = data_dir() / name
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        return default


def save_json(name: str, value) -> None:
    path = data_dir() / name
    with _lock:
        fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(value, fh, indent=2, ensure_ascii=False)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
