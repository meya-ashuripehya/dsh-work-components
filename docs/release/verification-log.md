# 验证记录（2026-11-25）

## 0.2.2-rc.5 设置页（同日补充）

本机 Desktop 已是 `@deepseek-ai/dsh-desktop` `0.2.2-rc.5`。当时 `engines.dsh` 仍是精确的 `0.2.1-rc.5`。宿主自己的 `evaluatePluginCompatibility` 对这份旧声明返回 `requirements["engines.dsh"] = "0.2.1-rc.5"`、`exempted: false`，于是跳过整个 bundle，设置页不会注册「工作组件」。`settings.section` 的注册形状没有变，仍是 `id`、`order`、`label`。

已把 `engines.dsh` 和可选 peer 改成精确的 `0.2.2-rc.5`。同一份宿主函数对新声明返回通过。`0.2.1-rc.5` 不再在声明里。单测 7 项通过。

重启后的窗口标题是 DeepSeek Harness。设置页左侧能看到「工作组件」，右侧是 Cloudflare、GitHub、ComfyUI、FFmpeg、Office、Blender 等组件列表。这只说明这个菜单重新注册了。隔离安装、停用重装、UIA、远程 CI、Release 上传和 npm 发布仍然没有做。

重启过程中，先结束了两个子进程，渲染进程崩溃，窗口一度显示「无法使用」。随后整实例已重新拉起。ToDesk 服务当时是 Running，3 个进程，日志在 1 分钟内有写入。


状态：候选整改已实现部分，尚未完成发布验收。

没有推 tag，没有 `npm publish`，没有上传 GitHub Release，没有改远端 About，没有提交市场申请。远程 CI 没有在这次记录里跑过。

## 基线

- 工作区 `S:\TRIX\dsh-workbench`，HEAD `57c5901`，改动仍未提交。
- 快照 `S:\TRIX\dsh-044-snapshot-rc5`，905 个文件，`SHA256SUMS` 与工作区一致后再打包。快照本身不是 git 仓库。
- 快照里 `npm ci` 会跑 `prepare`，并在快照内重新编译经纪人。这次产物是 79,395,435 字节。工作区里原有的 exe 是 79,395,535 字节。两份不能互换。

## 同一份模板 tarball

`S:\TRIX\dsh-044-snapshot-rc5\release-artifacts\dsh-work-components-0.4.4.tgz`

- 字节：2,678,249
- 成员：187
- SHA-512：`d47faebe7d43d3eb911da59b407f9197b8bd16419393b1807c5ff50bbac9c5deb7649134503363133fa392c5a572030d9520723fe5cddfccd529533b9474a9b7`
- `node scripts/verify-package.mjs --source --tgz <该文件> --require-size`：source 与 tgz 都是 pass
- 包内清单是无哈希模板（`status=unavailable`）。安装会拒绝下载。
- 解压后的 `loadManifest(包根)` 能读到 `src/components/desktop/broker-manifest.json`。`lib/index.mjs` 里没有 `new URL("./broker-manifest.json"`。
- 副本：`S:\TRIX\dsh-workbench\release-artifacts\dsh-work-components-0.4.4.tgz`，以及 `C:\Users\10917\Downloads\dsh-output\dsh-work-components-0.4.4.tgz`

## 哈希绑定演练（不是 Release）

另打一份 tarball，只存在于 `C:\Users\10917\AppData\Local\Temp\dsh-broker-drill2\dsh-work-components-0.4.4.tgz`。

- 字节：2,678,340
- SHA-512：`8223d5ef7077d5c8bf8a6f92cf97423385ece6982fea2fb69034ca47a0b9b489350d6f75ade964bc86e9df6a9e5125de72faf84b6e0db8558ec86ec85246dae4`
- `verify-package.mjs --tgz <该文件> --require-size --broker-asset <快照里刚编译的 exe>`：pass
- 这份哈希对应快照里本地 SDK 编译的 exe，不是 CI 的 .NET 8 产物，也没有上传。

## 快照上的命令

- `npm ci`：成功。生产依赖有 2 个 high，没有因此改 override。
- `npm run check`：`check ok`（v0.4.4）
- `npm run smoke`：`smoke ok`。这是脚本里的模拟调用，不是宿主端到端。
- 打包前 `node scripts/snapshot-freshness.mjs S:\TRIX\dsh-044-snapshot-rc5`：905 个文件一致。
- 本文件写完后只同步这一份记录到快照并更新它在 `SHA256SUMS` 里的一行。它不在 npm `files` 里，所以上面的模板 tarball 哈希不变。

## 兼容声明

- `engines.dsh` 与可选 peer 都是精确的 `0.2.1-rc.5`。
- 移植的门控与本机 `dsh-app-boot@0.2.1-rc.5` 一致：有 `engines.dsh` 时只看它。`0.2.0-rc.2`、稳定版 `0.2.0`、`0.2.1`、`0.2.1-rc.4` 都不匹配。
- `dsh.client.inject` 是 `@deepseek-ai/dsh-client-ui-renderer`（`slots`）和 `@deepseek-ai/dsh-client-ui-conversation`（`uiConversation`）。`sessions` 仍是 `lib/client.js` 里的服务名，由宿主包 `@deepseek-ai/dsh-session` 提供。
- 本机 Desktop 路径：`C:\Users\10917\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，包名 `@deepseek-ai/dsh-desktop`，版本 `0.2.1-rc.5`。

## 宿主实测

没有完成。不能把下面的退出码写成安装成功。

- Desktop CLI：`resources\runtime\cli\bin\dsh.cmd`。在 `DSH_HOME=C:\Users\10917\AppData\Local\Temp\dsh-iso-044` 下执行 `plugin --profile iso044 add <模板 tarball>`。参数已经进到包装脚本，进程退出码 0，标准输出为空，临时主目录没有生成 profile。
- 真实 profile `C:\Users\10917\.dsh\profiles\desktop` 在这次调用前后没有新的文件写入。没有 `iso044` profile。
- 本机没有另一份 Web CLI。浏览器没有打开，专用端口没有服务。
- 因此：inventory、bundle 在真实宿主里的解析、工具注册、五类槽位和 `uiConversation.events.register` 都是 not-run。

## 仍未运行

- 远程 GitHub Actions（含 Windows 上的编译、注入、校验演练，以及 tag 上的 draft Release 回读和 `npm publish`）
- Release 资产上传与回读
- npm 发布和市场提交
- 隔离宿主里的安装、激活、浏览器设置页、图片卡片、侧栏、停用重装
- 桌面经纪人下载、启动和 UI Automation
