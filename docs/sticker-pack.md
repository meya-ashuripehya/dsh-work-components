# 表情包管理设计（Sticker Pack）

> 状态：**P0 实现中 / 基本完成**（store + 三工具 + 设置卡 + OPEN_TOOLS；recent 缓冲已实现，入站自动写入钩子仍为 P1）。  
> 仓库：`S:\TRIX\dsh-workbench`（包名 `dsh-work-components`）。机器：Ashuripehya。  
> 日期：2026-10-28（America/New_York）。**无 commit。**  
> 用户诉求：设计表情包管理，并提供工具让 AI 可以保存 / 发送表情包。

---

## 0. 现状调研摘要

### 0.1 仓库边界

- 工作组件与通道都在 **`dsh-workbench`**（npm 名 `dsh-work-components`）。没有独立的 `S:\TRIX\dsh-work-components` 目录。
- 可写状态一律在 **`dataDir()`** = `$DSH_HOME/data/dsh-work-components`（默认 `~/.dsh/data/dsh-work-components`，可用 `DSH_WORKBENCH_DATA_DIR` 覆盖）。参考：`src/tools.mjs`、`docs/component-module.md`。

### 0.2 通道出站：今天怎么发图

| 通道 | 机制 | 能力 | 真·贴纸 API |
| --- | --- | --- | --- |
| **Telegram（通道）** | `@wsz987/channel-telegram` `upstream.sendMedia` → `sendPhoto` / `sendDocument` / `sendAudio` / `sendVideo` | `capabilities.image/file/audio/video = true`；`outboxCapabilities.proactiveMedia = true` | **无**（未接 `sendSticker`） |
| **QQ（通道）** | `@wsz987/channel-qq` `client.sendMedia` → SDK `uploadMedia` + `fileData`（bytes） | 同上，IMAGE / VOICE / VIDEO / FILE | **无**（平台侧就是图片/文件） |
| **Harness 回合末转发** | vendor patch：`ReplyRouter.collectToolResultImages` + `deliverTurnImages` | 收集本回合 tool-result 里 `{ type:'image', attachment }`，用宿主 `attachments.readImage` 取字节，再 `adapter.send({ parts:[{ type:'image', localData }] })` | 等同普通图 |
| **主动出站** | harness `send_channel_message` | 参数仅 `{ text?, attachment_id? }`，目标来自会话绑定；经 outbox + attachmentResolver | 依赖私有附件库里已有 media |
| **聊天室** | `mm_send_image` / `send_attachment` | 入房间附件 + 绑定 Telegram 群以 **photo** 发出 | 普通图 |
| **桌面会话** | 宿主 `mm_send_image`（`src/index.mjs`） | `attachments.saveImage` → MmCard；模型侧 text+image | 普通图 |

**结论（发送）：** MVP 应把表情包当作 **本地图片资产**，出站一律走现有 **image 路径**（QQ=`sendMedia` IMAGE；Telegram=`sendPhoto`；桌面=`mm_send_image`/`attachments`）。真·Telegram sticker（`sendSticker` + `file_id`）列为 later。

### 0.3 入站：能不能收到贴纸 / 图

| 表面 | 行为 |
| --- | --- |
| **聊天室 · Telegram** | `telegramFilesOf` **已映射 sticker**：静态 → `kind:image` webp；动图/视频贴纸 → `kind:file`（`.tgs` / `.webm`）+ `emoji` |
| **通道 · Telegram vendor mapper** | `partsFor` 只认 photo / document / audio / voice / video；**sticker 落入 unsupported**（缺口） |
| **通道 · QQ mapper** | 附件按 `content_type` → image / voice|audio / video / file；**无独立 sticker 类型**（用户发图即 image） |
| **Harness 入站** | 带 `localData` 的 image part → `saveImage` → 模型收到真 `ImageBlock`（`message-converter`） |

**结论（保存源）：**  
- QQ / 用户当图片发来的内容：通道入站已能变成 image，可做「最近入站媒体」缓冲后 `sticker_save`。  
- Telegram **通道会话**里的真 sticker：要先补 mapper（或保存时走聊天室附件路径）；MVP 可先支持「本机路径 / 桌面拖入附件 / QQ 入站图 / 聊天室 `#a…`」。

### 0.4 存储与工具登记先例

- **落盘**：`images/<日期>/`（GPT Image）、`notes/notes.json`（原子写）、聊天室 `rooms/<id>/attachments/` + sha256 去重。
- **工具**：`defineTool` + `ctx.tools.register`（或 `inject(['attachments'], …)`）；描述 **英文**；UI **中文**。
- **门闸**：Telegram/QQ 共用 `OPEN_TOOLS`；`mm_send_image` 已在 OPEN；`image_generate` / `image_edit` **不在** OPEN（写盘 + 耗额度）。改本机库的保存类工具应 **仅授权用户**。

### 0.5 LingChat（QQ）

- QQ 出站有 LingChat 分段（`【情绪】台词` → 多条纯文本气泡）。  
- 表情包发送是 **独立工具调用**，不走 LingChat 文本切分；同一回合可先台词再 `sticker_send`（或反之）。无需改 LingChat。

---

## 1. 目标与非目标

### 目标

1. 本机维护一套 **表情包（pack）+ 贴纸（sticker）** 目录，带标签 / 别名，便于人管理、AI 检索。
2. AI 工具：`sticker_search` / `sticker_save` / `sticker_send`（英文名与 schema）。
3. 设置页「工作组件」里一张 **中文卡片** 管理包与导入删除。
4. 按当前会话所在表面发送：桌面卡片、QQ 图、Telegram 图；能力不足时明确降级说明。

### 非目标（v1）

- 不实现 Telegram 官方 sticker set / `sendSticker` / 自定义 sticker pack 上传。
- 不实现 QQ「表情商店」协议或 `.tgs` 动画保真回传（动图可存为文件，发送时降级为静帧或 document，见开放问题）。
- 不做成独立 npm 包 / 不并入 `@wsz987/dsh-channels`。
- 不做跨设备云同步。
- **本设计阶段不落地完整代码**（审批后再开实现）。

---

## 2. 推荐 MVP

| 项 | MVP |
| --- | --- |
| 形态 | 内置「多模态」分组功能卡 `id: "stickers"`，默认 **启用**（无密钥）；关则注销工具 |
| 资产 | 本地文件 + JSON 索引；sha256 去重 |
| 格式 | png / jpg / jpeg / webp / gif（与 `mm_send_image` / MODEL_IMAGE_TYPES 对齐） |
| 工具 | `sticker_search`、`sticker_save`、`sticker_send` |
| 发送 | 一律按 **图片** 出站（复用 harness 图片转发或主动 send + localData） |
| 保存源 | 本机绝对路径；可选「本会话最近一张入站图」；可选聊天室附件 id |
| 权限 | search/send ∈ OPEN_TOOLS；save = **仅授权用户**（owner-gate） |
| UI | 包列表、导入文件、重命名包、编辑标签/别名、删除贴纸/包、预览缩略图 |

Later：`sendSticker`、通道 TG sticker inbound 补丁、动图策略、从 URL 拉取（默认仍禁止远程 URL，与 mm_send 一致）。

---

## 3. 数据模型

### 3.1 目录布局

```
<dataDir>/stickers/
  catalog.json          # 包与贴纸元数据（原子写）
  files/
    <sha256-12>.<ext>   # 内容寻址；同 hash 不重复存
  packs/                # 可选：按包分子目录的「导出友好」视图（软链或复制，v1 可不做）
  recent/               # 可选：通道入站最近媒体环形缓冲（见 3.4）
    index.json
    <entryId>.<ext>
```

与现有一致：可写状态在 `dataDir()`，不进仓库 / 不进 `node_modules`。

### 3.2 `catalog.json`（草案）

```json
{
  "version": 1,
  "packs": [
    {
      "id": "pack_ab12cd34ef56",
      "name": "默认",
      "description": "",
      "createdAt": "2026-10-28T06:00:00.000Z",
      "updatedAt": "2026-10-28T06:00:00.000Z"
    }
  ],
  "stickers": [
    {
      "id": "stk_ff0011223344",
      "packId": "pack_ab12cd34ef56",
      "hash": "sha256…",
      "file": "files/a1b2c3d4e5f6.webp",
      "mediaType": "image/webp",
      "bytes": 12345,
      "width": 512,
      "height": 512,
      "tags": ["开心", "打招呼"],
      "aliases": ["hi", "你好"],
      "emoji": "🙂",
      "source": {
        "channel": "qq|telegram|desktop|chatroom|import",
        "conversationId": "",
        "messageId": "",
        "originalName": "sticker-….webp",
        "attachmentId": ""
      },
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

字段说明：

| 字段 | 用途 |
| --- | --- |
| `id` | 稳定主键；工具按 id 发送 |
| `packId` | 所属包；删除包时策略见开放问题 |
| `hash` / `file` | 去重与落盘相对路径（相对 `stickers/`） |
| `tags` / `aliases` | 检索；别名偏「AI 好记的短名」 |
| `emoji` | 可选展示；来自 TG sticker.emoji 若有 |
| `source` | 溯源；**不含** token / secret |

限制建议（对齐 notes）：`name`/`alias`/`tag` 短字符串上限；单文件 ≤ 5 MB（表情包够用，远低于附件 25 MB）；单包贴纸数软上限（如 200）防目录膨胀。

### 3.3 默认包

首次启用创建 `pack`「默认」；导入未指定包时进默认包。

### 3.4 最近入站媒体缓冲（`sticker_save` 无参时）

通道 / 桌面回合里，当入站含 image（及将来补齐的 sticker→image）时，在 **该 session** 记一条环形缓冲（建议 N=5）：

```json
{
  "sessionId": "…",
  "items": [
    {
      "entryId": "rec_…",
      "savedAt": "…",
      "mediaType": "image/webp",
      "path": "recent/<entryId>.webp",
      "channel": "qq",
      "messageId": "…",
      "width": 512,
      "height": 512
    }
  ]
}
```

- 仅存文件副本 + 元数据；**不**自动进 catalog（需显式 `sticker_save`）。
- 隐私：缓冲只服务「保存」；可在卡片提供「清空最近缓冲」。

---

## 4. 设置 UI（中文卡片）

### 4.1 放置

`lib/client.js` → `FEATURES`，**group: `"多模态"`**，紧挨「媒体卡片」：

| 字段 | 值 |
| --- | --- |
| `id` | `stickers` |
| `title` | `表情包` |
| `desc` | `管理本地表情包；AI 可用 sticker_search / sticker_save / sticker_send。` |
| `keys` | `stickersEnabled`（及可选 `stickersDefaultPackId`） |

状态徽标：`未启用` / `已启用 · N 包 · M 张`。

### 4.2 卡片能力（管理面）

1. **启用开关** `stickersEnabled`（默认 true）。  
2. **包列表**：新建 / 重命名 / 删除（删包确认）。  
3. **贴纸网格**：缩略图、标签、别名；点开可编辑 tags/aliases、换包、删除。  
4. **导入**：本机多选图片 → 选目标包 → 写入 files + catalog。  
5. **导出**（可选 later）：打 zip（catalog 子集 + files）。  
6. **清空最近入站缓冲**。

实现方式：与 notes / gpt-image 类似，走插件 HTTP API（如 `/dsh-workbench/api/stickers/*`）+ 详情页自定义区块；**不要**把二进制塞进 settings JSON。

### 4.3 Schema 键

```text
stickersEnabled: z.boolean().default(true)
stickersDefaultPackId: z.string().default('')  // 空 = 自动「默认」包
```

无密钥字段。

---

## 5. AI 工具（英文）

注册位置建议：`src/stickers/`（`store.mjs` / `tools.mjs` / `index.mjs`），在 `src/index.mjs` 于 `stickersEnabled` 时 `tools.register`；风格对齐 `gpt-image` / `cross-session-tools` / 宿主 `mm_send_*`。

### 5.1 `sticker_search`

```text
name: sticker_search
description: Search the local sticker library by tag, alias, pack name, emoji, or free text.
  Returns id, pack, tags, aliases, path, and dimensions. Does not send anything.
parameters:
  query: string (optional) — keywords; whitespace = AND; matches tags/aliases/pack/emoji/id
  pack: string (optional) — pack id or pack name
  tag: string (optional)
  limit: integer (default 10, max 30)
output: { count, stickers: [{ id, packId, packName, tags, aliases, emoji, path, mediaType, width, height }] }
```

门闸：**OPEN_TOOLS**（只读）。

### 5.2 `sticker_save`

```text
name: sticker_save
description: Save an image into the local sticker library. Source is either an absolute local
  path, a chatroom attachment id (#a…), or omit source to use the most recent inbound image
  in this session (if any). Optional tags/aliases/pack. Owner-authorized turns only on channels.
parameters:
  source: string (optional) — absolute path or room attachment id; omit = recent inbound
  pack: string (optional) — pack id or name (default pack if omitted)
  tags: string[] (optional)
  aliases: string[] (optional)
  emoji: string (optional)
output: { id, packId, path, hash, deduped: boolean, tags, aliases }
```

门闸：**不在 OPEN_TOOLS**（与 `image_edit` 同类：写本机库）。桌面本地回合可用；通道上仅授权用户。

校验：仅允许本地路径 / 附件 id / recent；**拒绝** `http(s)` URL（与 `mm_send_image` 一致）。格式限 png/jpg/jpeg/webp/gif。

### 5.3 `sticker_send`

```text
name: sticker_send
description: Send a sticker from the local library to the current conversation surface.
  Resolve by id, alias, or (if unique) tag. On QQ/Telegram channel sessions this is delivered
  as an image (not a native Telegram sticker). On desktop it appears as an image card.
  Prefer sticker_search first when unsure which id to use.
parameters:
  id: string (optional) — sticker id (preferred)
  alias: string (optional)
  tag: string (optional) — only if exactly one sticker matches
  caption: string (optional) — optional caption where the surface supports it
output: { delivered: boolean, id, path, surface: "desktop"|"telegram"|"qq"|"chatroom", note?: string }
```

门闸：**OPEN_TOOLS**（对齐 `mm_send_image`：发图不改本机，通道非授权用户也可发已有表情）。

解析优先级：`id` > `alias`（精确）> `tag`（唯一命中）；多命中 → 返回候选列表、`delivered:false`。

### 5.4 发送适配（per surface）

| 当前会话 | 行为 |
| --- | --- |
| **桌面 / 普通 DSH** | 读文件 → `attachments.saveImage` → 工具 result 带 image 块 + presentationMeta.mm（同 `mm_send_image`） |
| **Telegram / QQ 通道**（本回合由通道入站触发） | 读文件 → 构造 `{ type:'image', localData, mimeType, name }` 经 adapter.send；**或**先 saveImage 再让 harness `deliverTurnImages` 捡到（与 mm_send 同一补丁路径）。推荐：**主动 adapter/outbox 发一张**，避免依赖「必须出现在 tool-result image 块」的隐式约定；实现时二选一写清。 |
| **聊天室** | 写入房间附件并 `post`（复用 `send_attachment` / `mm_send_image` 房间路径），绑定群以 photo 发出 |
| **无图能力通道** | `delivered:false` + note 说明 |

**不要**在 `sticker_send` 参数里暴露 `chat_id` / `openid` / `recipient`（对齐 `send_channel_message`：目标来自会话绑定）。

### 5.5 OPEN_TOOLS 变更

在 `src/channels/telegram/owner-gate.mjs` 的 `OPEN_TOOLS` 增加：

- `sticker_search`
- `sticker_send`

**不要**加入 `sticker_save`。

---

## 6. 权限与安全

| 动作 | 桌面本地 | 通道授权用户 | 通道非授权用户 |
| --- | --- | --- | --- |
| search | ✓ | ✓ | ✓ |
| send | ✓ | ✓ | ✓（仅发库内已有图） |
| save / 删除 / 改标签 | ✓ | ✓ | ✗ |
| 设置页导入删除 | 本机 UI（用户本人） | — | — |

其它：

- 路径：只读用户指定绝对路径或库内相对 `files/`；禁止 `..` 逃逸。  
- 日志：不打完整二进制；可打 id / hash 前缀 / 相对路径。  
- 无 secrets 字段。

---

## 7. 代码落点（实现时）

| 角色 | 建议路径 |
| --- | --- |
| 存储 / 去重 / catalog | `src/stickers/store.mjs` |
| 工具定义 | `src/stickers/tools.mjs` |
| 功能装配 + API | `src/stickers/index.mjs` |
| 最近入站钩子 | 挂 QQ/Telegram runtime 或 harness inbound 之后（只在 stickersEnabled） |
| Schema | `src/index.mjs` SettingsSchema 增键 |
| UI | `lib/client.js` FEATURES + INPUT_FIELDS + 详情自定义 |
| 门闸 | `owner-gate.mjs` OPEN_TOOLS |
| 测试 | `src/stickers/*.test.mjs`（纯 store + 工具参数；通道发送用 fake adapter） |

打包：若需单独 chunk，仿 `lib/channel-*.mjs`；否则进 `lib/index.mjs` 即可（体积小）。

---

## 8. 与现有能力的关系

```text
用户发图/贴纸
    │
    ├─ 聊天室 TG ── telegramFilesOf（含 sticker）── 房间附件 #a…
    │                                              └─ sticker_save(source=#a…)
    ├─ 通道 QQ ── image part + hydrate ── 模型可见图 + recent 缓冲
    │                                      └─ sticker_save() 无参
    └─ 通道 TG ── 今日 sticker → unsupported（缺口）── MVP 用路径/导入绕过
                                                    later: mapper 补 sticker→image

库内 sticker
    │
    ├─ sticker_search → id
    └─ sticker_send(id)
           ├─ desktop → mm 同款 image card
           ├─ qq/telegram channel → sendMedia / sendPhoto（当普通图）
           └─ chatroom → 房间附件 + 群 photo
```

**不**替代 `mm_send_image`：后者发任意本地图；表情包是带标签的可检索资产库 + 快捷发送。

---

## 9. 实现分期建议

### P0（可审批后的第一刀）

1. `store.mjs` + `catalog.json` + files 内容寻址。  
2. 三工具注册 + owner-gate。  
3. 设置卡：启用开关、包/贴纸列表、本机导入、删除、改 tags/aliases。  
4. `sticker_send`：桌面 MmCard + 通道按 image 发送（至少 QQ + Telegram 通道各测一条）。  
5. `sticker_save`：本机路径 +（若易做）recent 缓冲。

### P1

1. 聊天室附件 id 作为 save source。  
2. 通道 TG inbound sticker → image 的 mapper 补丁（vendor patch）。  
3. UI 缩略图网格体验打磨。

### P2

1. Telegram `sendSticker`（需缓存 platform `file_id` 或上传路径；跨 bot 无效）。  
2. 导出/导入 zip 包。  
3. 动图 / `.tgs` 策略。

---

## 10. 给 Shiro 的开放问题

1. **默认启用还是默认关？**（建议默认开：无密钥、纯本地。）  
2. **非授权通道用户能否 `sticker_send`？**（建议能，对齐 `mm_send_image`；若担心滥用可改为仅授权。）  
3. **删包时**：级联删贴纸文件，还是移入「默认」包？（**已定 P0：级联删除**）  
4. **GIF / 动图**：发送端各通道是否接受动画；不行时是否自动取第一帧？  
5. **Telegram 真 sticker**：P0 是否接受「永远当 sendPhoto」？若否，P2 优先级？  
6. **保存是否允许 URL？**（建议 v1 禁止，与现网 mm_send 一致。）  
7. **卡片分组**：放「多模态」还是新建「收藏 / 资产」？建议多模态。  
8. **是否需要第四个工具 `sticker_list_packs`？**（可并进 `sticker_search` 空 query + pack 过滤，MVP 可不单列。）  
9. **recent 缓冲是否跨会话？**（建议仅当前 session，防串台。）  
10. **QQ LingChat 回合中发表情**：是否要在格式 hint 里提一句「可用 sticker_send」？（可选，非必须。）

---

## 11. 成功标准（设计审批用）

- [x] 写清数据模型、磁盘位置、三工具名与 schema、门闸、per-channel 降级。  
- [x] 标明与 `mm_send_image` / harness `deliverTurnImages` / QQ `sendMedia` / TG `sendPhoto` 的挂载点。  
- [x] 标出 TG 通道 sticker inbound 缺口与「当图发」策略。  
- [x] 列出开放问题，便于你勾选后开做。  
- [x] 你确认 MVP 范围与开放问题后，再开实现（另开任务；**仍不 commit** 除非你要求）。
- [x] P0：store/catalog、三工具+owner-gate、设置卡「表情包」、send 走 image 路径、save 路径+recent 缓冲 API（入站钩子 P1）。

---

## 12. 参考路径（调研时读过）

- `src/chatroom/attachment-tools.mjs`、`attachments.mjs`（mm_send / sticker inbound in chatroom）  
- `src/index.mjs`（宿主 `mm_send_image`）  
- `src/gpt-image/`（数据目录落盘 + defineTool）  
- `src/channels/telegram/owner-gate.mjs`（OPEN_TOOLS）  
- `src/channels/qq/lingchat-segments.mjs`  
- `vendor/wsz987/channel-{qq,telegram,harness}/`（outbound / capabilities / deliverTurnImages patch）  
- `docs/qq-channel-component.md`、`docs/component-module.md`  
- `lib/client.js` FEATURES「多模态」分组
