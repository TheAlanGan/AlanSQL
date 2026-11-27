"""Connection profiles, groups, vault passwords, and the move from the app's old name (SQLDesk)."""
import json

import keyring

from dbcentral import config, store


def test_profile_crud_and_cleaning(isolated_data):
    p = store.save_profile({"name": "Dev", "driver": "mysql", "port": "3307", "bogus": 1, "ssh": 1})
    assert p["port"] == 3307 and p["ssh"] is True and "bogus" not in p
    assert store.get_profile(p["id"])["name"] == "Dev"
    store.save_profile({"name": "Dev 2", "driver": "mysql"}, p["id"])
    assert [x["name"] for x in store.list_profiles()] == ["Dev 2"]
    store.delete_profile(p["id"])
    assert store.list_profiles() == []


def test_unknown_driver_falls_back_to_mysql():
    assert store.clean_profile({"driver": "oracle"})["driver"] == "mysql"


def test_groups():
    a = store.save_profile({"name": "a", "driver": "mysql"})
    b = store.save_profile({"name": "b", "driver": "mysql", "group": "Prod"})
    store.set_group([a["id"]], "Prod")
    assert {p["name"]: p.get("group") for p in store.list_profiles()} == {"a": "Prod", "b": "Prod"}
    assert store.rename_group("Prod", "Production") == 2
    assert {p.get("group") for p in store.list_profiles()} == {"Production"}
    store.set_group([b["id"]], "")
    store.rename_group("Production", "")
    assert all("group" not in p for p in store.list_profiles())


def test_passwords_live_in_the_vault_not_the_file(isolated_data, memory_vault):
    p = store.save_profile({"name": "x", "driver": "mysql"})
    store.set_password(p["id"], "s3cret")
    store.set_password(store.ssh_secret_id(p["id"]), "sshpw")
    assert store.get_password(p["id"]) == "s3cret"
    assert "s3cret" not in (isolated_data / "connections.json").read_text(encoding="utf-8")
    listed = store.list_profiles()[0]
    assert listed["has_password"] is True
    store.delete_profile(p["id"])
    assert memory_vault.store == {}


def test_old_vault_entries_move_on_first_use(memory_vault):
    keyring.set_password("SQLDesk", "abc", "old")
    assert store.get_password("abc") == "old"
    assert memory_vault.store == {("DBCentral", "abc"): "old"}


def test_clearing_a_password_also_removes_the_old_copy(memory_vault):
    keyring.set_password("SQLDesk", "abc", "stale")
    keyring.set_password("DBCentral", "abc", "new")
    store.set_password("abc", None)
    assert store.get_password("abc") is None and memory_vault.store == {}


def test_save_json_is_atomic_and_load_tolerates_bad_files(isolated_data):
    config.save_json("x.json", {"a": 1})
    assert config.load_json("x.json", None) == {"a": 1}
    (isolated_data / "bad.json").write_text("{not json", encoding="utf-8")
    assert config.load_json("bad.json", "default") == "default"
    assert not list(isolated_data.glob(".tmp-*"))


def test_old_data_folder_is_moved(tmp_path, monkeypatch):
    appdata = tmp_path / "roaming"
    old = appdata / "SQLDesk"
    old.mkdir(parents=True)
    (old / "connections.json").write_text(json.dumps([{"id": "1", "name": "kept"}]), encoding="utf-8")
    monkeypatch.delenv("DBCENTRAL_DATA")
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.setattr(config.os, "name", "nt")
    d = config.data_dir()
    assert d == appdata / "DBCentral" and not old.exists()
    assert config.load_json("connections.json", [])[0]["name"] == "kept"


def test_old_data_merges_into_an_existing_new_folder(tmp_path, monkeypatch):
    """A new-name folder that already exists (e.g. a leftover) must not hide the user's real settings."""
    appdata = tmp_path / "roaming"
    old, new = appdata / "SQLDesk", appdata / "DBCentral"
    (old / "window-profile").mkdir(parents=True)
    (old / "window-profile" / "Prefs").write_text("old profile", encoding="utf-8")
    (old / "connections.json").write_text('[{"id": "1", "name": "real"}]', encoding="utf-8")
    (old / "state-tabs-1.json").write_text("{}", encoding="utf-8")
    (old / "app.log").write_text("log", encoding="utf-8")
    (new / "window-profile").mkdir(parents=True)
    (new / "window-profile" / "Prefs").write_text("new profile", encoding="utf-8")
    (new / "state-tabs-1.json").write_text('{"keep": "mine"}', encoding="utf-8")
    monkeypatch.delenv("DBCENTRAL_DATA")
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.setattr(config.os, "name", "nt")
    assert config.data_dir() == new
    assert config.load_json("connections.json", [])[0]["name"] == "real"           # copied over
    assert (new / "state-tabs-1.json").read_text(encoding="utf-8") == '{"keep": "mine"}'   # never overwritten
    assert (new / "window-profile" / "Prefs").read_text(encoding="utf-8") == "new profile"
    assert not (new / "app.log").exists() and old.exists()                        # old folder left as a backup
    # only once: a later change in the old folder is not copied again
    (old / "later.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config, "_migrated", False)
    config.data_dir()
    assert not (new / "later.json").exists()

