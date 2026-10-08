"""车万女仆式工作日程：平时按一个模式自己干活，被明确的一次性动作打断后回到休息。

只借用日程的形状（休息 / 跟随 / 一项工作），不依赖女仆实体，也不复制其资源。
"""
from __future__ import annotations

from typing import Dict, Optional


# 键是决策 JSON 里的 mode。休息对应女仆的 idle。
WORK_MODES: Dict[str, str] = {
    "rest": "休息。站着，不主动找活。",
    "follow": "跟随。保持在最近的玩家身边，离远了就走过去，不要干别的活。",
    "farm": "耕种。只处理附近成熟作物：收割，手里有对应种子就补种。没有可收的就停下等待。",
    "feed": "喂养。给附近动物喂它们吃的东西。没有饲料或没有动物就停下。",
    "attack": "护卫。只攻击靠近的敌对生物，绝不攻击玩家。没有威胁就停下。",
    "torch": "照明。在过暗的落脚点放置火把。没有火把就停下。",
    "shears": "剪毛。对附近可剪的羊使用剪刀。没有剪刀或没有羊就停下。",
    "milk": "挤奶。对附近的牛使用空桶。没有桶或没有牛就停下。",
}

_ALIASES = {
    "idle": "rest",
    "休息": "rest",
    "跟随": "follow",
    "耕种": "farm",
    "farming": "farm",
    "喂养": "feed",
    "护卫": "attack",
    "攻击": "attack",
    "guard": "attack",
    "照明": "torch",
    "剪毛": "shears",
    "挤奶": "milk",
}


def canonical_mode(value: object) -> Optional[str]:
    """合法模式返回规范名。缺省或认不出则返回 None，表示这一拍不改日程。"""
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text or text in ("null", "none"):
        return None
    if text in WORK_MODES:
        return text
    return _ALIASES.get(text)


def work_brief(mode: str) -> str:
    return WORK_MODES.get(mode, "")
