# About 建议文案

只给仓库所有者手动粘贴。本轮不改远端 About，也不替任何市场页面提交。

可用的短句：

> dsh-work-components 0.5.0 把桌面经纪人移出 npm 包，改为设置页按需下载并校验 SHA-256 / SHA-512。插件更新在调用宿主安装前核对 npm dist.integrity。兼容声明只写 DeepSeek Harness 0.2.2-rc.5，不代表全部 0.2.x。

不要写成：

- 已上架、已收录、已通过市场审核
- npm 已验证这一个候选（在真正 `npm publish` 之前）
- 打开开关即可使用桌面控制，无需下载
- 已在 Desktop 完成安装、设置持久化和 UIA 验收
- 已完成安全审计

Web 与 Desktop 的安装命令必须分成两行，并且 Desktop 那一行要等该 profile 的 CLI 实际装过之后再写。现在两行都还不能写成已验证命令。
