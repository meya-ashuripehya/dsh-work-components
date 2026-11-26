# 兼容性

本页只记录已经对照过的规则和明确没有运行的项目。没有出现在「已对照」里的版本，都不能写成兼容。

## 已对照的门控

规则来自本机 `@deepseek-ai/dsh-app-boot@0.2.2-rc.5` 的 `evaluatePluginCompatibility`，移植在 `src/plugin-compatibility.mjs`。单测在 `src/plugin-compatibility.test.mjs`。0.2.2-rc.5 的函数体与上一版 0.2.1-rc.5 相同：有 `engines.dsh` 时只看它。

- 自身有 `engines.dsh` 时只看这一条，忽略 peer。
- 否则只检查名为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer。
- peer 上的 `workspace:^`、`workspace:~`、`workspace:*` 表示当前运行时。写在 `engines.dsh` 里的 `workspace:` 不改写，算不匹配。
- 用 `semver.satisfies(runtime, range, { includePrerelease: true })`。
- 没有 `engines.dsh` 也没有 `peerDependencies` 时返回跳过。跳过不是兼容。
- 不读取 `peerDependenciesMeta.optional`。写成 optional 也不会放过不匹配的运行时。
- 测试不使用 allow-version 豁免。

本包声明 `engines.dsh` 与可选 peer 都是 `0.2.2-rc.5`。这是精确版本，不包含 `0.2.1-rc.5`、`0.2.0-rc.2`、稳定版 `0.2.0` 或其他 `0.2.x`。下表是门控结果，不是实机安装结果。

| 运行时 | 门控 | 实机 |
| --- | --- | --- |
| `0.2.2-rc.5` | `engines.dsh` 匹配 | 2026-11-25 重启本机 Desktop 后，设置页左侧有「工作组件」，页内能看到组件列表 |
| `0.2.1-rc.5` | 不匹配，不再宣称 | 上一轮对照过门控，没有完成隔离安装 |
| `0.2.0-rc.2` | 不匹配，未验证 | 未运行 |
| `0.2.0` | 不匹配，不宣称兼容 | 未运行 |
| 其他 `0.2.x` | 不宣称 | 未运行 |
| 本机 Desktop | `C:\Users\10917\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 是 `@deepseek-ai/dsh-desktop` `0.2.2-rc.5` | 见验证记录 |

捆绑进 `devDependencies` 的宿主包没有抄进 `peerDependencies`。

## 三层 inject

| 层 | 位置 | 值 |
| --- | --- | --- |
| 包级客户端 | `package.json` `dsh.client.inject` | `@deepseek-ai/dsh-client-ui-renderer`（`super(ctx, "slots")`）、`@deepseek-ai/dsh-client-ui-conversation`。`0.2.2-rc.5` 里没有 `@deepseek-ai/dsh-client-runtime`，也没有独立的 `@deepseek-ai/dsh-client-ui-slots` 包 |
| 浏览器客户端 | `lib/client.js` | 服务名 `slots`、`sessions`、`uiConversation`。`sessions` 由宿主包 `@deepseek-ai/dsh-session` 提供，不是客户端包名 |
| 服务 | `src/index.mjs` | `tools`、`agents`、`sessions`、`sessionController`、`schedule` |

`exports["./client"]` 指向 `lib/client.js`，给浏览器加载。不要用 Node 的 import 结果判断这个入口。

## 生命周期证据

安装、激活、浏览器设置持久化、图片卡片、预览、侧栏、停用和重装都没有在隔离宿主里运行。清单见 `docs/release/host-not-run.md`。
