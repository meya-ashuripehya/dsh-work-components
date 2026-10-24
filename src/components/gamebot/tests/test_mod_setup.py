from pathlib import Path

import pytest

from gamebot.adapters.civilization.mod_install import normalize_mods_dir as normalize_civ
from gamebot.adapters.minecraft.mod_install import normalize_mods_dir as normalize_minecraft


@pytest.fixture
def config_file(tmp_path, monkeypatch):
    path = tmp_path / "game-configs.json"
    monkeypatch.setenv("GAMEBOT_CONFIG_FILE", str(path))
    return path


def test_location_examples_and_vision_skips_mod(client, config_file):
    minecraft = client.get("/v1/games/minecraft/mod")
    assert minecraft.status_code == 200
    body = minecraft.json()
    assert body["needs_mod"] is True
    labels = [item["label"] for item in body["examples"]]
    assert "官方启动器" in labels
    assert "CurseForge" in labels
    assert all(item["selectable"] is False for item in body["examples"])

    vision = client.get("/v1/games/vision/mod")
    assert vision.status_code == 200
    assert vision.json()["needs_mod"] is False
    assert vision.json()["installed"] is True


def test_minecraft_install_copies_jar_without_marking_config_saved(client, config_file, tmp_path, monkeypatch):
    jar = tmp_path / "minaret-1.0.0.jar"
    jar.write_bytes(b"minaret")
    monkeypatch.setenv("GAMEBOT_MINARET_JAR", str(jar))
    instance = tmp_path / "Instance"
    mods = instance / "mods"
    mods.mkdir(parents=True)
    (mods / "minaret-0.9.0.jar").write_bytes(b"old")

    missing = client.post("/v1/games/minecraft/mod/install", json={"mods_dir": ""})
    assert missing.status_code == 400

    installed = client.post("/v1/games/minecraft/mod/install", json={"mods_dir": str(instance)})
    assert installed.status_code == 200
    body = installed.json()
    assert body["installed"] is True
    assert Path(body["mods_dir"]) == mods
    assert (mods / "minaret-1.0.0.jar").read_bytes() == b"minaret"
    assert not (mods / "minaret-0.9.0.jar").exists()
    assert list(mods.glob("minaret-0.9.0.jar.bak-*"))

    saved = client.get("/v1/games/minecraft").json()["game"]["config"]
    assert Path(saved["MC_MODS_DIR"]) == mods
    assert saved["WIZARD_SAVED"] == "0"

    again = client.post("/v1/games/minecraft/mod/install", json={"mods_dir": str(mods)})
    assert again.status_code == 200
    assert list(mods.glob("minaret-1.0.0.jar.bak-*"))


def test_minecraft_install_reports_missing_jar(client, config_file, tmp_path, monkeypatch):
    monkeypatch.setenv("GAMEBOT_MINARET_JAR", "")
    response = client.post("/v1/games/minecraft/mod/install", json={"mods_dir": str(tmp_path / "mods")})
    assert response.status_code == 400
    assert "gradlew" in response.json()["detail"]


def test_civilization_install_accepts_game_root(client, config_file, tmp_path):
    root = tmp_path / "Sid Meier's Civilization VI"
    root.mkdir()
    response = client.post("/v1/games/civilization/mod/install", json={"mods_dir": str(root)})
    assert response.status_code == 200
    assert (root / "Mods" / "TRIXCompanion" / "UI" / "Companion.lua").exists()
    saved = client.get("/v1/games/civilization").json()["game"]["config"]
    assert Path(saved["CIV6_MODS_DIR"]) == root / "Mods"
    assert saved["WIZARD_SAVED"] == "0"


def test_normalize_known_game_roots(tmp_path):
    instance = tmp_path / "pack"
    (instance / "mods").mkdir(parents=True)
    assert normalize_minecraft(instance) == instance / "mods"
    assert normalize_minecraft(instance / "mods") == instance / "mods"
    official = tmp_path / ".minecraft"
    (official / "versions").mkdir(parents=True)
    assert normalize_minecraft(official) == official / "mods"
    civ = tmp_path / "Sid Meier's Civilization VI"
    civ.mkdir()
    assert normalize_civ(civ) == civ / "Mods"
    assert normalize_civ(civ / "Mods") == civ / "Mods"
