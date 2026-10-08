"""Minecraft 桥接专用观测模型。不进入跨游戏通用契约。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ItemView(BaseModel):
    item_id: str
    count: int = 0
    display_name: Optional[str] = None
    damage: int = 0
    max_damage: int = 0


class BlockView(BaseModel):
    block_id: str
    pos: Dict[str, int]
    state: Dict[str, str] = Field(default_factory=dict)
    block_entity_type: Optional[str] = None
    distance: float = 0


class PlayerView(BaseModel):
    uuid: Optional[str] = None
    name: str
    position: Optional[Dict[str, float]] = None
    distance: float = 0
    pose: Optional[str] = None
    main_hand: Optional[ItemView] = None


class ScreenView(BaseModel):
    id: Optional[str] = None
    open: bool = False


class MinecraftSnapshot(BaseModel):
    player: Dict[str, Any] = Field(default_factory=dict)
    inventory: Dict[str, Any] = Field(default_factory=dict)
    nearby_blocks: List[BlockView] = Field(default_factory=list)
    nearby_players: List[PlayerView] = Field(default_factory=list)
    screen: ScreenView = Field(default_factory=ScreenView)
