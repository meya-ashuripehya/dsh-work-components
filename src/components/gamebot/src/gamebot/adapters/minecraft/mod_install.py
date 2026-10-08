"""把 Minaret 模组放进玩家选择的 Minecraft mods 目录。"""
from __future__ import annotations

import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List


def normalize_mods_dir(path: Path) -> Path:
    """游戏目录、实例目录收成 mods；已经是 mods 目录则原样返回。"""
    if path.name.lower() == "mods":
        return path
    direct = path / "mods"
    if direct.exists():
        return direct
    for nested in (path / "minecraft" / "mods", path / ".minecraft" / "mods"):
        if nested.exists():
            return nested
    if (path / "versions").exists() or (path / "saves").exists() or (path / "options.txt").exists():
        return path / "mods"
    if (path / "minecraft").is_dir():
        return path / "minecraft" / "mods"
    if (path / ".minecraft").is_dir():
        return path / ".minecraft" / "mods"
    if (path / "manifest.json").exists() or (path / "instance.cfg").exists() or (path / "mmc-pack.json").exists():
        if (path / "minecraft").is_dir():
            return path / "minecraft" / "mods"
        return path / "mods"
    return path


def locate_jar() -> Path | None:
    override = os.environ.get("GAMEBOT_MINARET_JAR")
    if override is not None:
        path = Path(override)
        return path if path.is_file() else None
    libs = Path(__file__).resolve().parents[4] / "minecraft-neoforge-bridge" / "build" / "libs"
    if not libs.is_dir():
        return None
    jars = [
        item
        for item in libs.glob("minaret-*.jar")
        if item.is_file() and "sources" not in item.name and "javadoc" not in item.name
    ]
    if not jars:
        return None
    return sorted(jars, key=lambda item: item.stat().st_mtime)[-1]


def _example_patterns() -> List[Dict[str, Any]]:
    return [
        {
            "label": "官方启动器",
            "path": r"%APPDATA%\.minecraft\mods",
            "exists": False,
            "selectable": False,
            "note": "示例",
        },
        {
            "label": "CurseForge",
            "path": r"%USERPROFILE%\curseforge\minecraft\Instances\<实例名>\mods",
            "exists": False,
            "selectable": False,
            "note": "示例",
        },
        {
            "label": "Prism Launcher",
            "path": r"%APPDATA%\PrismLauncher\instances\<实例名>\minecraft\mods",
            "exists": False,
            "selectable": False,
            "note": "示例",
        },
        {
            "label": "Modrinth",
            "path": r"%APPDATA%\ModrinthApp\profiles\<实例名>\mods",
            "exists": False,
            "selectable": False,
            "note": "示例",
        },
        {
            "label": "PCL / HMCL / MultiMC",
            "path": r"<启动器实例目录>\.minecraft\mods 或 minecraft\mods",
            "exists": False,
            "selectable": False,
            "note": "示例",
        },
    ]


def _scan_children(root: Path, relative: tuple[str, ...], label: str, limit: int = 24) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    if not root.is_dir():
        return found
    try:
        children = sorted((item for item in root.iterdir() if item.is_dir()), key=lambda item: item.name.lower())
    except OSError:
        return found
    for child in children:
        if len(found) >= limit:
            break
        candidate = child.joinpath(*relative)
        if candidate.is_dir():
            found.append(
                {
                    "label": f"{label} · {child.name}",
                    "path": str(candidate),
                    "exists": True,
                    "selectable": True,
                    "note": "已找到",
                }
            )
    return found


def location_hints() -> Dict[str, List[Dict[str, Any]]]:
    detected: List[Dict[str, Any]] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        official = Path(appdata) / ".minecraft" / "mods"
        if official.is_dir():
            detected.append(
                {
                    "label": "官方启动器",
                    "path": str(official),
                    "exists": True,
                    "selectable": True,
                    "note": "已找到",
                }
            )
        root = Path(appdata)
        detected.extend(_scan_children(root / "PrismLauncher" / "instances", ("minecraft", "mods"), "Prism Launcher"))
        detected.extend(_scan_children(root / "PrismLauncher" / "instances", (".minecraft", "mods"), "Prism Launcher"))
        detected.extend(_scan_children(root / "ModrinthApp" / "profiles", ("mods",), "Modrinth"))
        detected.extend(_scan_children(root / "com.modrinth.theseus" / "profiles", ("mods",), "Modrinth"))
        detected.extend(_scan_children(root / "MultiMC" / "instances", ("minecraft", "mods"), "MultiMC"))
    home = Path.home()
    detected.extend(_scan_children(home / "curseforge" / "minecraft" / "Instances", ("mods",), "CurseForge"))
    deduped: List[Dict[str, Any]] = []
    seen = set()
    for item in detected:
        key = str(item.get("path") or "").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return {"examples": _example_patterns(), "detected": deduped}


def _installed_jars(target: Path | None) -> List[Path]:
    if target is None or not target.is_dir():
        return []
    return [
        item
        for item in target.glob("minaret-*.jar")
        if item.is_file() and ".bak-" not in item.name
    ]


def inspect_mod(config: Dict[str, Any] | None = None) -> Dict[str, Any]:
    data = dict(config or {})
    raw = str(data.get("MC_MODS_DIR") or "").strip()
    target = normalize_mods_dir(Path(raw)) if raw else None
    jar = locate_jar()
    installed = _installed_jars(target)
    hints = location_hints()
    return {
        "ok": True,
        "needs_mod": True,
        "source_ready": jar is not None,
        "version": jar.name if jar else "",
        "installed_version": installed[-1].name if installed else "",
        "installed": bool(installed),
        "mods_dir": "" if target is None else str(target),
        "path": "" if not installed else str(installed[-1]),
        "examples": hints["examples"],
        "detected": hints["detected"],
        "restart_required": True,
        "message": "模组已在所选文件夹中。" if installed else "",
    }


def install_mod(config: Dict[str, Any] | None = None) -> Dict[str, Any]:
    data = dict(config or {})
    raw = str(data.get("MC_MODS_DIR") or "").strip()
    if not raw:
        raise FileNotFoundError("请先选择模组文件夹")
    jar = locate_jar()
    if jar is None:
        raise FileNotFoundError(
            "未找到 Minaret 模组文件。请先在 minecraft-neoforge-bridge 目录执行 .\\gradlew.bat build，再重新选择文件夹。"
        )
    target = normalize_mods_dir(Path(raw))
    target.mkdir(parents=True, exist_ok=True)
    dest = target / jar.name
    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    for old in _installed_jars(target):
        backup = old.with_name(f"{old.name}.bak-{stamp}")
        if old.resolve() != jar.resolve():
            shutil.copy2(old, backup)
        if old.resolve() != dest.resolve():
            old.unlink()
    if dest.exists() and dest.resolve() != jar.resolve():
        dest.unlink()
    if dest.resolve() != jar.resolve():
        shutil.copy2(jar, dest)
    status = inspect_mod({"MC_MODS_DIR": str(target)})
    status["installed_now"] = True
    status["message"] = "Minaret 模组已放入 mods 文件夹。请重启 Minecraft 后再启动服务。"
    return status
