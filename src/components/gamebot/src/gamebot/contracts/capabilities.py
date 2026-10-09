"""稳定能力 ID。AI 只认这些语义，不认版本/模组细节。"""

# 通用
STATE_QUERY = "generic.state.query"

# Minecraft
CHAT_SAY = "minecraft.chat.say"
SERVER_COMMAND = "minecraft.server.command"
POSITION_READ = "minecraft.player.position.read"
HEALTH_READ = "minecraft.player.health.read"
INVENTORY_READ = "minecraft.inventory.read"
BLOCK_SCAN = "minecraft.block.scan"
RECIPE_QUERY = "minecraft.recipe.query"
ENTITY_NEARBY = "minecraft.entity.nearby"
MOVE_TO = "minecraft.player.move_to"
LOOK_AT = "minecraft.player.look_at"
COLLECT = "minecraft.world.collect"
CRAFT = "minecraft.inventory.craft"
PLACE_BLOCK = "minecraft.world.place_block"
INTERACT = "minecraft.world.interact"
OPEN_CONTAINER = "minecraft.container.open"
TRANSFER_ITEM = "minecraft.container.transfer"
SELECT_ITEM = "minecraft.inventory.select"
DROP_ITEM = "minecraft.inventory.drop"
USE_ITEM = "minecraft.item.use"
USE_ITEM_ON_BLOCK = "minecraft.world.use_item_on_block"
ATTACK_BLOCK = "minecraft.world.attack_block"
ENTITY_ATTACK = "minecraft.entity.attack"
PLAYER_ACTIVITY = "minecraft.player.activity.observe"
CONTAINER_FIND_ITEM = "minecraft.container.find_item"

# 模组扩展（整合包 = Provider 组合，不按整合包名适配）
MOD_CREATE = "minecraft.mod.create"
MOD_AE2 = "minecraft.mod.ae2"
MOD_BOTANIA = "minecraft.mod.botania"

# 视觉
VISION_OBSERVE = "vision.desktop.observe"
VISION_CLICK = "vision.desktop.click"
VISION_TYPE = "vision.desktop.type"
VISION_CONFIRM = "vision.desktop.confirm"

# 文明6陪玩
CIV_STATE_READ = "civilization.state.read"
CIV_SAFE_ACTION = "civilization.action.safe"
CIV_CONFIRM_ACTION = "civilization.action.confirm"
CIV_COMPANION_CHAT = "civilization.companion.chat"

# 动作名 → 所需能力。query_state 始终放行。
ACTION_REQUIRED_CAPABILITY = {
    "say": CHAT_SAY,
    "run_command": SERVER_COMMAND,
    "query_state": STATE_QUERY,
    "move_to": MOVE_TO,
    "look_at": LOOK_AT,
    "collect": COLLECT,
    "craft": CRAFT,
    "place_block": PLACE_BLOCK,
    "interact": INTERACT,
    "open_container": OPEN_CONTAINER,
    "transfer_item": TRANSFER_ITEM,
    "select_item": SELECT_ITEM,
    "drop_item": DROP_ITEM,
    "use_item": USE_ITEM,
    "use_item_on_block": USE_ITEM_ON_BLOCK,
    "attack_block": ATTACK_BLOCK,
    "attack_entity": ENTITY_ATTACK,
    "find_item": CONTAINER_FIND_ITEM,
    "vision_observe": VISION_OBSERVE,
    "vision_click": VISION_CLICK,
    "vision_type": VISION_TYPE,
}

BASIC_ACTIONS = ("say", "run_command", "query_state")
SEMANTIC_ACTIONS = (
    "move_to",
    "look_at",
    "collect",
    "craft",
    "place_block",
    "interact",
    "open_container",
    "transfer_item",
    "select_item",
    "drop_item",
    "use_item",
    "use_item_on_block",
    "attack_block",
    "attack_entity",
    "find_item",
)
VISION_ACTIONS = ("vision_observe", "vision_click", "vision_type")
