# 0.5.0 更新日志

正式版，发布到 npm `latest`。0.4.4 候选没有单独发布，内容包含在这一版里。更长的候选记录见 `docs/release/CHANGELOG-0.4.4.md`，英文全文见仓库根目录 `CHANGELOG.md`。

本轮没有跑真实宿主安装、浏览器设置页和 UI Automation。功能说明只表示代码在发布树里。

## 发布与安装

- 版本是 `0.5.0`。tag `v0.5.0` 触发 `publish.yml`：同一次编译经纪人 exe、把哈希写进该次 tarball 的清单、回读 Release 资产、再 `npm publish` 这一份 tarball。
- 仓库里的 `broker-manifest.json` 仍是无哈希模板，直接拿它下载会被拒绝。正式下载地址是 `https://github.com/meya-ashuripehya/dsh-work-components/releases/download/v0.5.0/DSHDesktopBroker-win-x64.exe`。
- `scripts/pack-release.mjs` 删掉包内 `package.json` 的 `scripts`。发布包没有指向 `scripts/prepare.mjs` 的 `prepare`。`npm install dsh-work-components@0.5.0 --ignore-scripts` 只装生产依赖。从 git 安装仍保留 `prepare`。

## 设置页

- 管理页底部「保存」仍固定在下方。横幅不再使用实心底色、上边线和阴影，背景透明，按钮居中。状态文字在按钮右侧。

## 相对 0.4.4-beta.1 已包含的范围

打包方式、桌面经纪人按需下载、npm 更新完整性校验、宿主声明 `0.2.2-rc.5`、通道与跨会话记忆、DeepSeek 会话采样、长视频分段、Minecraft / 文明 VI 不在设置页显示，以及删除视觉桌面驱动。细节见 0.4.4 候选日志。
