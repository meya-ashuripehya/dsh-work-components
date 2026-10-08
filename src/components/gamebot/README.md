# GameBot（dsh-work-components 内嵌）

本目录是 **GameBot 本体 + MCP 桥**，随 `dsh-work-components` 一起维护并随包发布，不依赖外部仓库。

## 布局

- `index.mjs` — 三张游戏卡（`gamebot-minecraft` / `gamebot-civilization` / `gamebot-vision`）与共享 Python 环境的准备
- `process.mjs` — 共享 REST body 的启停（引用计数；只杀本插件拉起的进程；退出钩子在插件生命周期里注册）
- `fields.mjs` — 每张卡的设置字段（`lib/client.js` 里的字段由 `scripts/gen-gamebot-fields.mjs` 生成）
- `pyproject.toml` + `src/gamebot/` — Python 代码（FastAPI REST + `mcp_bridge`）。只用 `pyproject.toml` 的依赖列表，代码经 `PYTHONPATH` 运行，不安装、不往本目录写文件

可写状态都在插件数据目录 `<DSH_HOME>/data/dsh-work-components/gamebot/`：`.venv/`（共享 Python 环境）和 `data/`（`game-configs.json`、记忆等，含服务商密钥明文）。

## 使用

1. 设置页 →「游戏」→ 任一游戏卡 → 打开「启用」。没有「下载安装」：第一次启用时自动用托管的 uv 建 Python 3.12 venv，并**从 PyPI 下载安装依赖**（约半分钟到几分钟，走设置里的下载代理）。装好后写 `.dsh-gamebot-ready.json`；中途失败下次会重建。
2. 启用后自动启动 REST（默认 `http://127.0.0.1:8766`）并挂载该游戏的 MCP 桥
3. 关闭全部游戏卡 → 停止我们拉起的 body；插件停用 / 卸载时同样会停掉

**每次应用/会话启动，所有游戏卡默认关闭**（需重新打开启用）；`gamebotUrl` / `gamebotRoot` 会记住。

## 双脑警告

不要同时让 DSH 桌面大脑与 GameBot 自带大脑对同一游戏发动作。

## 可选覆盖

- `gamebotUrl`：REST 地址
- `gamebotRoot`：指向外部 GameBot 目录（留空则用本目录）。填写时，它自己的 `data/` 与 `.venv` 留在那个目录里，首次加载会从它的 `data/game-configs.json` 一次性导入设置
- `GAMEBOT_MINECRAFT_BRIDGE_DIR`（环境变量）：Mineflayer 驱动用的外部 `minecraft-bridge` 目录。桥不随包提供，未设置时 Minecraft 只用 minaret 驱动
