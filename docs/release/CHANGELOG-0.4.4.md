# 0.4.4 更新日志（候选，未单独发布）

这一版没有单独发到 npm，也没有推 `v0.4.4`。其中的改动随 `0.5.0` 发布。正式版说明见 `docs/release/CHANGELOG-0.5.0.md`，英文全文见仓库根目录 `CHANGELOG.md`。下面保留候选当时的记录；经纪人下载地址以 `v0.5.0` 为准。

本轮没有跑真实宿主安装、浏览器设置页和 UI Automation。下面的功能说明只表示代码在候选树里，不表示已经在对应宿主或游戏里验收。

## 打包

- `scripts/pack-release.mjs` 打一份 tarball，并删掉包内 `package.json` 的 `scripts`。发布包不再带着指向不存在的 `scripts/prepare.mjs` 的 `prepare`。Git 安装仍保留 `prepare`。
- `files` 不再使用 `src/components/desktop/**`。桌面相关只收 `index.mjs`、`broker-install.mjs`、`broker-manifest.json`。
- `scripts/verify-package.mjs` 把源码、tarball、宿主分成三份结果。没有宿主证据时是 `not-run`，不是通过。
- CI 和 `publish.yml` 先验证这一份 tarball，再 `npm publish` 这一份。provenance 仍走工作流的 OIDC。本候选没有执行发布。
- `dsh.marketplace.profiles` 只有 `web`。这是清单字段，不是市场收录。没有新增 `dsh-plugin.json`。

## 桌面经纪人

2026-11-25 实测自包含 `DSHDesktopBroker.exe` 为 79,395,535 字节。再压缩也放不进 50 MiB 的严格市场 tarball 上限，所以 npm 包不含这个 exe。

- 不在 `postinstall` 下载。
- 源码目录里已经构建的 `broker/dist` 直接使用。
- 否则只有用户在设置页点击「下载安装」才下载。地址固定为 HTTPS，核对声明大小、SHA-256 和 SHA-512 之后才替换。校验失败不替换已有程序。
- 地址是 `https://github.com/meya-ashuripehya/dsh-work-components/releases/download/v0.4.4/DSHDesktopBroker-win-x64.exe`。仓库清单是无哈希模板，空哈希拒绝下载。`publish.yml` 用同一次编译的 exe 填写哈希并上传这个文件名。tag 还没推，资源还没有上传。
- 桌面组件不再标成内置，安装按钮会显示。`desktopEnabled` 默认仍是关闭。

## 更新与其他下载

- npm 应用更新只读一次版本元数据，核对版本、注册表主机上的 HTTPS tarball、`dist.integrity`（sha512），再核对包内 `package.json` 的名字和版本。下载先落到随机临时文件，通过后才调用 `dsh plugin add`。失败不写 profile。
- 指定的 `targetVersion` 不会被更新的 `latest` 换掉。下载上限 96 MiB。并发更新共用一把锁。
- uv 不再把 `/releases/latest/download/...` 当作最终文件地址。先解析到具体 tag，再用上游 `.sha256` 校验后解压。Node 仍走原来的 SHA-256 校验文件。Godot 的签名校验没有改。

## 宿主声明

- `engines.dsh` 与可选 peer 都是 `0.2.2-rc.5`。不包含 `0.2.1-rc.5`、`0.2.0-rc.2` 或稳定版 `0.2.0`。
- 门控按本机 `dsh-app-boot@0.2.2-rc.5`：有 `engines.dsh` 时只看它。不看 `peerDependenciesMeta.optional`。没有声明时跳过，跳过不是兼容。不匹配时宿主禁用插件，`settings.section` 不会注册。
- 三层 inject 分开：`package.json` 的 `dsh.client.inject` 是 `@deepseek-ai/dsh-client-ui-renderer` 与 `@deepseek-ai/dsh-client-ui-conversation`；`lib/client.js` 是服务名 `slots`、`sessions`、`uiConversation`；`src/index.mjs` 是 `tools`、`agents`、`sessions`、`sessionController`、`schedule`。
- `./client` 是浏览器入口。Node 里 import 失败不算客户端失败。
- 本机 Desktop 在 `C:\Users\10917\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，版本是 `0.2.2-rc.5`。除了这个精确版本，不宣称其他 `0.2.x` 已兼容。宿主从 `0.2.1-rc.5` 升上来之后，旧的精确声明会让设置页失去「工作组件」。

## 通道、记忆、会话、视频、GameBot

这些改动在工作区里，所以进入候选。打包测试不能代替真实宿主或真实游戏。

- 通道包含 `0.4.4-beta.1` 已记录的 QQ、Telegram / QQ 主动发送、元数据前缀、表情包、陪伴压缩、席位管理、沉浸工具和 Google 工具查找。
- 跨会话记忆用进程内句柄让宿主包和通道包看到同一组开关。这个句柄不存放对话正文或凭据。同伴搜索留在调用方预设圈内。
- 会话采样为 DeepSeek 官方和 DeepSeek 账号的消息调用保存每个会话的 `temperature` 和 `top_p`。其他供应商不在范围内。跨站采样请求会被拒绝。
- `describe_video` 和 `watch_video` 把长视频分段（默认 10 分钟、重叠 5 秒、最多同时两个 Gemini 请求），再映射回原时间轴。缓存只存分段参数、模型名和凭据哈希，不存密钥明文。文件会送到 Google。YouTube 链接原样传递，不下载。
- GameBot 仍随包提供。本树的 Minecraft 自主代码包括公开世界记忆、运行状态、动作核对、导航、资源动作、语义感知和玩家私聊，以及 NeoForge 桥源码。公开记忆记录器不写私聊回合。设置页不显示 Minecraft 与文明 VI。视觉桌面驱动、其设置项和截图依赖已删除。本轮没有跑真实 Minecraft，也没有跑 UIA。`scripts/mc-live-*.mjs` 是开发脚本：进入源码快照，不进入 npm tarball。
- 设置响应把已保存的密钥字段换成 `__dsh_secret_saved__`。空字符串不是这个掩码。这不是静态加密。设置、已下载工具和 GameBot 数据仍在 `$DSH_HOME/data/dsh-work-components/`，卸载包不会删这个目录。

## 不进入候选快照

Python `__pycache__`、NeoForge `.eclipse`、`docs/video-segmentation-samples/` 媒体缓存，以及根目录任务稿 `SAMPLING-TASK.md`、`SAMPLING-SLIDERS-TASK.md`、`VIDEO-SEGMENTATION-TASK.md`。这些文件留在本机，不删除。
