"""安装文明6游戏内陪玩面板。已有文件先备份，且只在玩家主动调用时复制。"""
from __future__ import annotations

import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List


MOD_NAME = "TRIXCompanion"
VERSION = "1"


def mod_source() -> Path:
    return Path(__file__).resolve().parent / "mod" / MOD_NAME


def candidate_mod_dirs() -> List[Path]:
    found: List[Path] = []
    home = Path.home()
    roots = [home / "Documents", home / "OneDrive" / "Documents"]
    profile = os.environ.get("USERPROFILE")
    if profile:
        roots.append(Path(profile) / "Documents")
        roots.append(Path(profile) / "OneDrive" / "Documents")
    for env_name in ("OneDrive", "OneDriveCommercial", "OneDriveConsumer"):
        raw = os.environ.get(env_name)
        if raw:
            roots.append(Path(raw) / "Documents")
    seen = set()
    for root in roots:
        path = root / "My Games" / "Sid Meier's Civilization VI" / "Mods"
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        found.append(path)
    return found


def normalize_mods_dir(path: Path) -> Path:
    """游戏根目录收成 Mods；已经是 Mods 目录则原样返回。"""
    if path.name.lower() == "mods":
        return path
    if path.name.lower().startswith("sid meier") or (path / "Mods").exists():
        return path / "Mods"
    return path


def resolve_mods_dir(config: Dict[str, Any] | None = None) -> Path | None:
    data = dict(config or {})
    raw = str(data.get("CIV6_MODS_DIR") or "").strip()
    if raw:
        return normalize_mods_dir(Path(raw))
    for path in candidate_mod_dirs():
        if path.exists() or path.parent.exists():
            return path
    return None


def location_hints() -> Dict[str, List[Dict[str, Any]]]:
    examples = [
        {
            "label": "文档目录",
            "path": r"%USERPROFILE%\Documents\My Games\Sid Meier's Civilization VI\Mods",
            "exists": False,
            "selectable": False,
            "note": "示例",
        },
        {
            "label": "OneDrive 文档",
            "path": r"%USERPROFILE%\OneDrive\Documents\My Games\Sid Meier's Civilization VI\Mods",
            "exists": False,
            "selectable": False,
            "note": "示例",
        },
    ]
    detected: List[Dict[str, Any]] = []
    seen = set()
    for path in candidate_mod_dirs():
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        exists = path.exists()
        if not exists and not path.parent.exists():
            continue
        detected.append(
            {
                "label": "本机文明6 Mods",
                "path": str(path),
                "exists": exists,
                "selectable": True,
                "note": "已找到" if exists else "上级目录存在，植入时会创建 Mods",
            }
        )
    return {"examples": examples, "detected": detected}


def inspect_mod(config: Dict[str, Any] | None = None) -> Dict[str, Any]:
    source = mod_source()
    target_root = resolve_mods_dir(config)
    installed = target_root / MOD_NAME if target_root else None
    version = ""
    if installed and (installed / "VERSION").exists():
        version = (installed / "VERSION").read_text(encoding="utf-8").strip()
    return {
        "ok": True,
        "source_ready": source.exists(),
        "version": VERSION,
        "installed_version": version,
        "installed": bool(installed and installed.exists()),
        "mods_dir": "" if target_root is None else str(target_root),
        "path": "" if installed is None else str(installed),
        "restart_required": True,
    }


def install_mod(config: Dict[str, Any] | None = None) -> Dict[str, Any]:
    source = mod_source()
    if not source.exists():
        raise FileNotFoundError("companion mod source is missing")
    target_root = resolve_mods_dir(config)
    if target_root is None:
        raise FileNotFoundError("未找到文明6 Mods 目录，请先填写 CIV6_MODS_DIR")
    target_root.mkdir(parents=True, exist_ok=True)
    dest = target_root / MOD_NAME
    if dest.exists():
        stamp = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = target_root / f"{MOD_NAME}.bak-{stamp}"
        shutil.copytree(dest, backup)
        shutil.rmtree(dest)
    shutil.copytree(source, dest)
    status = inspect_mod({"CIV6_MODS_DIR": str(target_root)})
    status["installed_now"] = True
    status["message"] = "面板文件已安装。请在文明6模组列表启用 TRIX Companion，然后返回主菜单或重启游戏。"
    return status
