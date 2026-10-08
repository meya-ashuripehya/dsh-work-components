# GameBot（dsh-workbench 内嵌）

本目录是 **GameBot 本体 + MCP 桥**，随 `dsh-workbench` 一起维护，不再依赖手动运行 `S:\TRIX\TRIX-GAMEBOT\start-gamebot.bat`。

## 布局

- `index.mjs` — 工作组件（启用 / 安装 / 探测）
- `process.mjs` — REST body 进程启停（仅杀掉本组件拉起的进程）
- `pyproject.toml` + `src/gamebot/` — Python 包（FastAPI REST + `mcp_bridge`）
- `.venv/` — 「下载安装」创建的本地虚拟环境（勿提交）

## 使用

1. 设置页 →「游戏」→ GameBot →「下载安装」（创建 `.venv` 并 `pip install -e .`）
2. 打开「启用」→ 自动启动 REST（默认 `http://127.0.0.1:8766`）并挂载 MCP 桥
3. 关闭「启用」或卸载 → 停止我们拉起的 body + MCP

**每次应用/会话启动，GameBot 默认关闭**（需重新打开启用）；`gamebotUrl` / `gamebotRoot` 会记住。

## 双脑警告

不要同时让 DSH 桌面大脑与 GameBot 自带大脑对同一游戏发动作。

## 可选覆盖

- `gamebotUrl`：REST 地址
- `gamebotRoot`：指向外部仓库（留空则用本目录）
