# 安全说明

这是维护者写的边界说明，不是安全审计，也不是渗透测试报告。

## 插件能碰到什么

工作组件会按用户打开的开关启动本机或远程 MCP 服务。桌面控制可以读控件树并发送键鼠和截图。Windows 组件另外覆盖文件、注册表和 PowerShell。Gmail 的 `send_message` 会发信。通道可以连接 Telegram 和 QQ。这些能力默认关闭。

本地组件在子进程里加载。这是崩溃隔离，不是操作系统沙箱。不要运行不信任的本地组件。

## 密钥

设置里标记为 secret 的字段，在返回给浏览器时替换成 `__dsh_secret_saved__`。空字符串不是掩码，表示清空。设置 POST 拒绝 `sec-fetch-site: cross-site`。

不要把「界面不回显」理解成「磁盘上已加密」。设置和服务商密钥可以明文留在 `$DSH_HOME/data/dsh-work-components/`。卸载插件不会删除这个目录。

## 下载

- 插件更新先核对 npm `dist.integrity`（SHA-512）、包名和版本，通过后才调用 `dsh plugin add`。失败不写 profile。
- uv 先钉到具体 GitHub tag，再核对上游 `.sha256`。
- Node 仍使用原有的 SHA-256 校验文件。
- 桌面经纪人只在用户点击「下载安装」时下载，核对 SHA-256 和 SHA-512。不在 `postinstall` 拉二进制。校验失败不替换已有 exe。仓库里的清单是无哈希模板；发布包里的哈希来自同一次构建、并上传到同一个 GitHub Release 的 exe。
- 清单里的哈希如果是空的，下载直接拒绝。

## 报告问题

请到 GitHub Issues 描述现象，不要附上 token、应用专用密码或 profile 里的设置文件。
