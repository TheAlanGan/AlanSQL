from .base import DBError, Driver
from .mysql import MySQLDriver
from .odbc import ODBCDriver
from .sqlite import SQLiteDriver

DRIVERS = {"mysql": MySQLDriver, "sqlite": SQLiteDriver, "odbc": ODBCDriver}


def make_driver(profile, password=None, **ssh) -> Driver:
    """ssh: ssh_secret (SSH password or key passphrase) and accept_host_key (a confirmed fingerprint)."""
    cls = DRIVERS.get(profile.get("driver") or "mysql")
    if cls is None:
        raise DBError(f"Unknown driver: {profile.get('driver')}")
    if cls is MySQLDriver:
        return cls(profile, password, **ssh)
    return cls(profile, password)


__all__ = ["DBError", "Driver", "MySQLDriver", "ODBCDriver", "SQLiteDriver", "DRIVERS", "make_driver"]
