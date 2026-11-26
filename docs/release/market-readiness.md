# 市场就绪说明

状态日期：2026-11-26。`0.5.0` 是正式版，由 tag `v0.5.0` 触发 `.github/workflows/publish.yml` 发布到 npm `latest`。下面 2026-11-25 的段落是当时 `0.4.4` 候选的记录，不是这一版「尚未发布」的结论。本文不是市场收录、自动安装资格、运行验证或安全审计。

## 基线

- 仓库：`dsh-work-components`，工作区 `S:\TRIX\dsh-workbench`。
- HEAD：`57c5901`（`0.4.4-beta.1`）。候选不是只打包这个提交。
- 版本字段：`0.4.4`。没有发现需要把插件自身 API 升到 `0.5.0` 的破坏性迁移。宿主声明故意收窄，见 `docs/compatibility.md`。
- 本机候选构建工具链：Node v22.23.4，npm 10.9.9，.NET SDK 10.0.401。CI 工作流指定 Node 22 与 .NET SDK 8。仓库清单不再保存某一台机器编出的哈希。发布哈希只来自同一次 CI 编译的 exe。
- 旧的 CI 结论和 npm `0.4.3` 体积结论不沿用。npm `latest` 在核对时是 `0.4.3`，那份 tarball 约 72 MiB，超过严格市场 50 MiB。

## 三份检查

`node scripts/verify-package.mjs` 把结果拆开：

| 参数 | 看什么 | 不能当成什么 |
| --- | --- | --- |
| `--source` | 仓库里的 `prepare`、手写 `lib/client.js`、`files` 是否还用宽 glob | 发布包已经完整 |
| `--tgz <file> --require-size` | 真实 tarball 的成员、悬空 `prepare`、敏感文件、经纪人 exe、体积预算 | 宿主里能启用 |
| `--host` | 只有给出证据文件才记录宿主结果；缺证据时 `status=not-run`、`certified=false`，退出码仍为 0 | 认证通过 |

体积：市场上限 `52428800` 字节（50 MiB）。检查预算再留 5 MiB，即 `47185920` 字节。超过预算时 `--require-size` 失败。tarball 自己的 SHA-512 写在检查输出里，不写回本文件，避免摘要把自身算进去。

## 经纪人

保留自包含单文件会被 tarball 顶过 50 MiB。已选择按需安装，而不是 trimming 或 NativeAOT。仓库里的 `broker-manifest.json` 是无哈希模板，安装会拒绝。`publish.yml` 在 Windows 上用 .NET 8 编译 exe，上传为 artifact，打包时写入哈希，校验 tarball，创建 draft Release，回读资产并比对字节数和哈希，通过后才 `npm publish`，最后才把 Release 从 draft 改为正式。本轮没有推 tag，所以 Release 资产仍未上传。

## 发布流

1. 在仓库外快照上 `npm ci` 和 `npm run build`。快照规则见 `scripts/make-release-snapshot.mjs`。不要用 `git archive HEAD`，也不要整目录复制。
2. `node scripts/pack-release.mjs` 打一份 tarball。
3. `node scripts/verify-package.mjs --tgz <该文件> --require-size`。
4. 临时目录 `npm install <该文件> --ignore-scripts`，确认生产依赖能装上，且包内没有 `prepare`。
5. 真正发布时由 `.github/workflows/publish.yml` 对同一份 tarball 执行 `npm publish`，并带 provenance。本轮不执行。

## 本轮不做

不推 tag，不 `npm publish`，不改远端 About，不提交市场申请，不改真实 Desktop profile，不热改 `app.asar`，不启动远程通道，不用真实 token。

## 用语

| 说法 | 本候选 |
| --- | --- |
| 清单里写了 profile | 是，`dsh.marketplace.profiles=["web"]` |
| 市场已收录 | 否 |
| npm 已验证这份候选 | 否，尚未发布 |
| 可自动安装 | 未验证 |
| 运行已验证 | 否 |
| 已做安全审计 | 否 |

安装命令也不能混写。Web 宿主用它自己的 `dsh plugin add`。Desktop 只有在该 profile 的 `dsh` CLI 上单独验证之后才能写 Desktop 命令。本轮没有 Desktop 安装证据。
