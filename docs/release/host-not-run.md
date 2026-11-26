# 宿主与 UIA 检查（未运行）

本文件是未运行记录。`node scripts/verify-package.mjs --host` 在没有证据文件时打印 `status=not-run`、`certified=false`。不要把退出码 0 写成认证。

CI 的 Windows 任务可以编译经纪人并跑完整性单测。无交互桌面，那不是 UIA，也不是端到端。

下面每一项在写出本文件时都还没有隔离宿主证据。`0.2.0-rc.2` 和 `0.2.1-rc.5` 都不在当前声明范围内。本机 Desktop 是 `0.2.2-rc.5`。有证据之后以 `docs/release/verification-log.md` 为准：

- 隔离 `DSH_HOME` 安装候选 tarball
- 激活插件
- 浏览器打开设置页并确认保存后仍在
- 图片卡片与预览
- 侧栏入口
- 停用后重装
- 桌面经纪人启动
- UI Automation 读控件树、点击、输入

桌面经纪人下载也未对 GitHub Release 实拉。该资源尚未上传。单测只覆盖清单拒绝、校验失败不替换、以及本地已有 exe 优先。
