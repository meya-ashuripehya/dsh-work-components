window.__ModuleLoader__.load({
	id: "dsh-work-components",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
/**
 * dsh-workbench — 客户端半边（手写，无需构建）。
 *  1. settings.section「工作组件」设置页：首页是功能列表（按「多模态 / 工作组件 / 游戏 / 通用 / 基础工具」分组，每行显示实时状态），
 *     点击一行进入该功能的管理页（运行状态、下载安装 + 启用旋钮、安装日志、配置），「‹ 返回」或 Esc 回到列表。
 *     「启用」旋钮和安装按钮在同一行靠右，拨动立即保存（只改这一项）。列表行和管理页标题前带通用线条图标（内置 SVG，不用第三方标志）。
 *     组件状态：未安装 / 未启动 / 已启动（MCP 服务器已挂载）/ 已连接（对应程序在运行且 MCP 够得着它，绿色实心徽标）/ 出错；
 *     管理页状态行下面的连接行给出探测细节（程序未运行 / 未连接的原因）。有组件在探测连接时每 5 秒刷新一次状态。
 *     工作组件：Office / Blender / Unity / Godot（Python，uv 安装）、Figma / Photoshop / Chrome（npm，Node.js 安装）。
 *     组件可带安装行下面的说明（/components 里的 note，如 Godot 要装哪个版本的插件）和字段旁的动作按钮
 *     （Godot「安装插件到项目」：POST /dsh-workbench/api/components/godot/addon { project }，成功后记住项目路径）。
 *     「通用」：会话控制、uv、Node.js、下载代理（共享工具，与各工作组件并列成行，不埋在基础工具脚注里）。
 *     「基础工具」：添加工作组件——填写程序名称，复制给 AI 的接入提示词（只加可下载列表，不装进 tools/）。
 *     读写 /dsh-workbench/api/settings，状态来自 /dsh-workbench/api/components，
 *     「下载安装」调用 POST /dsh-workbench/api/components/<id>/install，安装期间轮询状态（不论当前在哪一页）。
 *  2. 多模态 MmCard：运行中 `tool.call.toolview` 只显示 pending/sending；settled 后完整卡片挂在
 *     `conversation.chat.turnTail`（与 deliverables 同属 Host 产物表面），过程折叠后仍可见。
 *     数据经 ConversationNodeDefinition 写入 turn data `mmCards`（presentationMeta.mm / image 合成）；
 *     model 历史仍只含 text+image，不得含 type:mm。loadImage 经 inject uiConversation.imageUrl。
 * 所有网络请求都是同源 fetch 到宿主，插件前端不直连外部资源（CSP）。
 */
var React = require("react");
var h = React.createElement;
var createPortal = React.createPortal;
if (typeof createPortal !== "function") {
  try { createPortal = require("react-dom").createPortal; } catch (_) { createPortal = null; }
}

var API = "/dsh-workbench/api";

var STYLES = [
  ".mm-page{font-size:13px;line-height:1.6;padding:14px 16px;max-width:640px}",
  ".mm-page [hidden]{display:none!important}",
  ".mm-page h3{margin:0 0 4px;font-size:14px}",
  ".mm-page .mm-sub{color:var(--theme-text-secondary,#888);font-size:12px;margin:0 0 14px}",
  ".mm-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}",
  ".mm-field label{font-weight:600;font-size:12px}",
  ".mm-field .mm-desc{color:var(--theme-text-secondary,#888);font-size:11px}",
  ".mm-input{background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:6px 8px;font-size:12px}",
  ".mm-row{display:flex;gap:8px;align-items:center;margin-top:6px}",
  ".mm-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px}",
  ".mm-btn:disabled{opacity:.45;cursor:not-allowed}",
  ".mm-msg{font-size:12px;color:var(--theme-text-secondary,#888)}",
  ".mm-msg.err{color:#e55}",
  ".mm-section{margin:18px 0 6px;padding-top:12px;border-top:1px solid var(--theme-border,#333);font-weight:600;font-size:13px}",
  ".mm-status{font-size:12px;margin:-4px 0 12px;word-break:break-all}",
  ".mm-status.on{color:#3a3}",
  ".mm-status.error{color:#e55}",
  ".mm-status.off{color:var(--theme-text-secondary,#888)}",
  ".mm-status.missing{color:#d93}",
  ".mm-status.ready{color:#3a3}",
  ".mm-status.connected{color:#2da44e;font-weight:600}",
  // 连接行（管理页状态行下面）：已连接 / 程序未运行 / 未连接 / 正在检查
  ".mm-conn{position:relative;font-size:12px;margin:-8px 0 12px;padding-left:14px;word-break:break-all;color:var(--theme-text-secondary,#888)}",
  ".mm-conn::before{content:\"\";position:absolute;left:1px;top:.55em;width:7px;height:7px;border-radius:50%;background:currentColor}",
  ".mm-conn.connected{color:#2da44e}",
  ".mm-conn.no-app,.mm-conn.unreachable{color:#d93}",
  ".mm-conn.mcp-down{color:#e55}",
  ".mm-install{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:-6px 0 8px}",
  ".mm-install .mm-istate{flex-basis:100%}", // 安装步骤单独一行，按钮行不挤
  ".mm-btn.mm-ghost{background:transparent;color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333)}",
  ".mm-istate{font-size:12px;color:var(--theme-text-secondary,#888);word-break:break-all}",
  ".mm-istate.installing,.mm-istate.queued{color:var(--theme-accent,#4a9eff)}",
  ".mm-istate.done{color:#3a3}",
  ".mm-istate.error{color:#e55}",
  ".mm-log{margin:0 0 12px;font-size:12px}",
  ".mm-log summary{cursor:pointer;color:var(--theme-text-secondary,#888);display:flex;align-items:baseline;gap:10px;list-style:none}",
  ".mm-log summary::-webkit-details-marker{display:none}",
  ".mm-log summary::marker{content:none}",
  ".mm-log-label{flex:none}",
  ".mm-log-label::before{content:'\\25B8\\00a0';font-size:10px}",
  ".mm-log[open] .mm-log-label::before{content:'\\25BE\\00a0'}",
  // 实时行：靠右，过长省略。两层叠字：底层整行白色（未下载），上层同样的字用淡蓝流光，按百分比从左裁切（已下载）。百分比未知时上层铺满。
  ".mm-log-live{position:relative;flex:0 1 auto;margin-left:auto;min-width:0;max-width:100%;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;font-weight:400;line-height:1.4;color:#fff}",
  ".mm-log-live[hidden]{display:none}",
  ".mm-log-live-text,.mm-log-live-sheen{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}",
  ".mm-log-live-sheen{position:absolute;left:0;top:0;width:100%;height:100%;color:#8fb3d6;pointer-events:none;background-image:linear-gradient(100deg,#8fb3d6 0%,#8fb3d6 38%,#d6ecff 50%,#8fb3d6 62%,#8fb3d6 100%);background-size:250% 100%;background-repeat:no-repeat;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:mm-live-sheen 2.4s linear infinite}",
  "@keyframes mm-live-sheen{from{background-position:100% 0}to{background-position:0% 0}}",
  "@media (prefers-reduced-motion:reduce){.mm-log-live-sheen{animation:none;background-image:none;-webkit-text-fill-color:currentColor;color:#8fb3d6}}",
  ".mm-log pre{max-height:180px;overflow:auto;margin:4px 0 0;padding:6px 8px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all}",
  // 功能列表（首页）
  ".mm-group{margin:16px 0 6px;font-size:12px;font-weight:600;color:var(--theme-text-secondary,#888)}",
  ".mm-list{border:1px solid var(--theme-border,#333);border-radius:8px;overflow:hidden}",
  ".mm-item{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;outline:none;user-select:none}",
  ".mm-item+.mm-item{border-top:1px solid var(--theme-border,#333)}",
  ".mm-item:hover{background:rgba(127,127,127,.12)}",
  ".mm-item:focus-visible{box-shadow:inset 0 0 0 2px var(--theme-accent,#4a9eff)}",
  ".mm-item-main{flex:1;min-width:0}",
  ".mm-item-name{font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:6px;min-width:0}",
  ".mm-item-desc{color:var(--theme-text-secondary,#888);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".mm-chev{flex:none;color:var(--theme-text-secondary,#888);font-size:18px;line-height:1}",
  ".mm-badge{flex:none;font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;border:1px solid currentColor;white-space:nowrap;color:var(--theme-text-secondary,#888)}",
  ".mm-badge.on,.mm-badge.ready{color:#3a3}",
  ".mm-badge.connected{color:#fff;background:#2da44e;border-color:#2da44e;font-weight:600}",
  ".mm-badge.error{color:#e55}",
  ".mm-badge.missing{color:#d93}",
  ".mm-badge.busy{color:var(--theme-accent,#4a9eff)}",
  // 功能管理页
  ".mm-dhead{display:flex;align-items:center;gap:10px;margin:0 0 12px}",
  ".mm-dhead h3{margin:0;flex:1;min-width:0;display:flex;align-items:center;gap:8px}",
  ".mm-dtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  // 上游仓库外链（标题旁蓝色网址文字，新标签打开）
  ".mm-ext{flex:none;display:inline;max-width:min(42vw,280px);margin:0;padding:0;border:none;border-radius:0;color:#3b82f6;text-decoration:none;font-weight:400;font-size:12px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:baseline}",
  ".mm-ext:hover,.mm-ext:focus-visible{color:#2563eb;text-decoration:underline}",
  ".mm-ext:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}",
  ".mm-item-name .mm-ext{font-size:11px;max-width:min(36vw,220px)}",
  ".mm-dhead .mm-ext{font-size:12px;max-width:min(40vw,260px)}",
  ".mm-btn.mm-back{padding:3px 10px}",
  // 应用图标
  ".mm-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}",
  ".mm-ico svg{display:block;width:100%;height:100%;overflow:visible}",
  ".mm-dhead .mm-ico{width:22px;height:22px}",
  // 「启用」旋钮（button role=switch，和安装按钮同一行靠右）
  ".mm-toggle{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0}",
  ".mm-toggle label{font-size:12px;cursor:pointer;user-select:none}",
  ".mm-tmsg{font-size:12px;color:var(--theme-text-secondary,#888);word-break:break-all}",
  ".mm-tmsg.err{color:#e55}",
  ".mm-tmsg:empty{display:none}",
  ".mm-switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;margin:0;padding:0;border:1px solid var(--theme-border,#555);border-radius:10px;background:rgba(127,127,127,.32);cursor:pointer;transition:background-color .15s,border-color .15s}",
  ".mm-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.4);transition:transform .15s}",
  ".mm-switch[aria-checked=true]{background:var(--theme-accent,#4a9eff);border-color:var(--theme-accent,#4a9eff)}",
  ".mm-switch[aria-checked=true]::after{transform:translateX(16px)}",
  ".mm-switch:focus-visible{outline:2px solid var(--theme-accent,#4a9eff);outline-offset:2px}",
  ".mm-switch:disabled{opacity:.45;cursor:not-allowed}",
  ".mm-switch[aria-busy=true]{cursor:progress}",
  ".mm-note{color:var(--theme-text-secondary,#888);font-size:11px;margin:-2px 0 10px}",
  // 组件说明（安装行下面，如 Godot 插件版本）与字段旁的动作按钮（安装插件到项目）
  ".mm-cnote{font-size:11px;line-height:1.55;margin:-2px 0 12px;padding:6px 9px;border:1px solid var(--theme-border,#333);border-radius:6px;color:var(--theme-text-secondary,#888);word-break:break-all}",
  ".mm-action{flex-wrap:wrap;margin:2px 0 0}",
  ".mm-amsg{flex:1;min-width:0;font-size:12px;color:var(--theme-text-secondary,#888);word-break:break-all}",
  ".mm-amsg.ok{color:#3a3}",
  ".mm-amsg.err{color:#e55}",
  ".mm-amsg:empty{display:none}",
  ".mm-warn{font-size:12px;line-height:1.55;margin:0 0 14px;padding:8px 10px;border-radius:6px;border:1px solid #c9842a;background:rgba(201,132,42,.12);color:#e0a84a;word-break:break-word;white-space:pre-line}",
  ".mm-msg.ok{color:#3a3}",
  ".mm-src{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid var(--theme-border,#555);color:var(--theme-text-secondary,#888);white-space:nowrap}",
  ".mm-src.bundled{color:#6a9;border-color:#6a9}",
  ".mm-src.local{color:#c9842a;border-color:#c9842a}",
  ".mm-src.experimental{color:#e0a84a;border-color:#c9842a;background:rgba(201,132,42,.12)}",
  ".mm-item-name .mm-src{margin-left:2px}",
  ".mm-dhead .mm-src{margin-left:4px}",
  ".mm-pr{margin:12px 0;padding:10px;border:1px solid var(--theme-border,#333);border-radius:8px;background:rgba(127,127,127,.06)}",
  ".mm-pr h4{margin:0 0 6px;font-size:12px}",
  ".mm-pr p{margin:0 0 8px;font-size:12px;color:var(--theme-text-secondary,#888);line-height:1.55}",
  ".mm-pr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".mm-pr pre{margin:8px 0 0;max-height:160px;overflow:auto;padding:6px 8px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all}",
  ".mm-copy-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px}"
].join("\n");

// 设置项（按 key 引用）。type "switch" 是管理页里安装按钮行右侧的「启用」旋钮，拨动即保存，不进下方字段区。
var INPUT_FIELDS = [
  { key: "officeEnabled", label: "启用", type: "switch", desc: "仅 Windows。注意：其中 RunPython 工具会执行模型给出的任意 Python 代码。" },
  { key: "officeRepo", label: "OfficeMCP 仓库目录", type: "text", desc: "已「下载安装」时优先用插件 tools\\officemcp，这里可留空；否则用这里的目录，留空时找插件目录旁边的 officemcp。" },
  { key: "officeFolder", label: "工作根目录", type: "text", desc: "OfficeMCP 读写文件的根目录；留空时使用它的默认值 D:\\@OfficeMCP（没有 D 盘时用 文档\\OfficeMCP）。" },
  { key: "blenderEnabled", label: "启用", type: "switch", desc: "Blender 没开时会在后台反复重连，不影响其他功能。" },
  { key: "blenderPackage", label: "pip 包名", type: "text", desc: "默认 mcp-for-blender（入口命令同名）。改了包名后需要重新「下载安装」；未安装时用 uvx 临时运行。" },
  { key: "unityEnabled", label: "启用", type: "switch", desc: "Unity 没开时会在后台反复重连，不影响其他功能。" },
  { key: "unityPackage", label: "pip 包名", type: "text", desc: "默认 mcpforunityserver（入口命令 mcp-for-unity）。改了包名后需要重新「下载安装」；未安装时用 uvx 临时运行。" },
  { key: "figmaEnabled", label: "启用", type: "switch", desc: "需要 Figma 桌面版。figma-console 模式下要在 Figma 里导入并运行 Desktop Bridge 插件（见上方说明）；Figma 没开时工具会报未连接，不影响其他功能。" },
  { key: "figmaMode", label: "连接方式", type: "select", options: [
    { value: "console", label: "figma-console-mcp（推荐：读写画布，免费计划可用）" },
    { value: "official", label: "官方 Figma 桌面版 MCP（需付费计划的 Dev / Full 席位）" }
  ], desc: "官方桌面版 MCP 要在 Figma 桌面版的 Dev Mode 里打开「启用桌面版 MCP 服务器」，只读、不能改画布；官方远程服务器需要 OAuth 登录，这里不支持。" },
  { key: "figmaToken", label: "个人访问令牌", type: "password", placeholder: "figd_…", desc: "可选。Figma → 设置 → 安全 → 个人访问令牌（figd_ 开头）。读写画布走插件，不需要令牌；读取文件 / 变量 / 评论 / 版本历史等 REST 类工具需要。只在 figma-console 模式下使用。" },
  { key: "figmaOfficialUrl", label: "官方 MCP 地址", type: "text", desc: "官方 Figma 桌面版 MCP 的地址，默认 http://127.0.0.1:3845/mcp；只在「官方」模式下使用。" },
  { key: "figmaPackage", label: "npm 包名", type: "text", desc: "默认 figma-console-mcp（可带版本，如 figma-console-mcp@1.40.7）。改了包名后需要重新「下载安装」；未安装时用 npx 临时运行。" },
  { key: "photoshopEnabled", label: "启用", type: "switch", desc: "Photoshop 没开时工具会报找不到 Photoshop，不影响其他功能。注意：其中 photoshop_execute_script 工具会执行模型给出的任意 ExtendScript。" },
  { key: "photoshopPath", label: "Photoshop 路径", type: "text", placeholder: "C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe", desc: "可选。留空时从注册表自动检测已安装的 Photoshop。" },
  { key: "photoshopPackage", label: "npm 包名", type: "text", desc: "默认 @alisaitteke/photoshop-mcp（可带版本）。改了包名后需要重新「下载安装」；未安装时用 npx 临时运行。" },
  { key: "chromeEnabled", label: "启用", type: "switch", desc: "AI第一次使用此工具时才会启动 Chrome。注意：evaluate_script 会在网页里执行模型给出的 JS，模型能看到页面里的所有内容。" },
  { key: "chromeConnect", label: "连接方式", type: "select", options: [
    { value: "launch", label: "启动独立的 Chrome（默认）" },
    { value: "autoConnect", label: "连接正在运行的 Chrome（autoConnect，Chrome 144+）" },
    { value: "browserUrl", label: "连接调试端口（browserUrl）" }
  ], desc: "「启动独立的 Chrome」：用专用配置目录（默认 %USERPROFILE%\\.cache\\chrome-devtools-mcp），不动你平时的配置，AI第一次使用此工具时才会启动。.cache 目录不存在是正常的，用到时会自动创建。「连接正在运行的 Chrome（autoConnect）」：Chrome 144+，在 chrome://inspect/#remote-debugging 打开「允许为此浏览器实例进行远程调试」；打开开关本身不会弹窗——第一次用浏览器工具连接时，Chrome 才会弹出「允许调试」确认框，点允许即可。此模式不需要也不使用 .cache。「连接调试端口」：必须用 chrome.exe --remote-debugging-port=… --user-data-dir=<非默认目录> 启动；inspect 页开关不会提供 /json/version（会 404），那种情况请改用 autoConnect。" },
  { key: "chromeBrowserUrl", label: "调试地址", type: "text", desc: "只在「连接调试端口（browserUrl）」时使用。Chrome 必须用 --remote-debugging-port 且带非默认 --user-data-dir 启动，例如 chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\\chrome-profile-stable 后填 http://127.0.0.1:9222。chrome://inspect 开关开出的 9222 端口没有 /json/version（会 404），请改用 autoConnect。" },
  { key: "chromeChannel", label: "Chrome 渠道", type: "select", options: ["stable", "beta", "dev", "canary"], desc: "启动或连接哪个渠道的 Chrome，默认正式版（stable）。" },
  { key: "chromeHeadless", label: "窗口", type: "select", bool: true, options: [
    { value: "false", label: "显示窗口" },
    { value: "true", label: "无头（不显示窗口）" }
  ], desc: "只对「启动独立的 Chrome」有效。" },
  { key: "chromeUserDataDir", label: "配置目录", type: "text", desc: "可选，只对「启动独立的 Chrome」有效。留空时用 chrome-devtools-mcp 自己的专用目录（%USERPROFILE%\\.cache\\chrome-devtools-mcp\\chrome-profile）；目录不存在会在第一次启动时自动创建。autoConnect / browserUrl 不用这个目录。" },
  { key: "chromeToolset", label: "工具集", type: "select", options: [
    { value: "standard", label: "标准（约 30 个工具）" },
    { value: "full", label: "完整（再加内存分析、坐标点击、扩展与 PWA 等）" },
    { value: "slim", label: "精简（只有导航 / 执行脚本 / 截图）" }
  ], desc: "工具越多，每次对话占用的上下文越多。扩展与 PWA 工具只在「启动独立的 Chrome」时可用。" },
  { key: "chromePackage", label: "npm 包名", type: "text", desc: "默认 chrome-devtools-mcp（可带版本，如 chrome-devtools-mcp@1.10.1）。改了包名后需要重新「下载安装」；未安装时用 npx 临时运行。" },
  { key: "godotEnabled", label: "启用", type: "switch", desc: "Godot 没开时服务器照常运行、等编辑器连上，不影响其他功能；启用期间占用 HTTP / WebSocket 端口（默认 8000 / 9500）。注意：模型可以改项目里的场景、脚本和资源，也可以运行项目。" },
  { key: "godotProject", label: "Godot 项目路径", type: "text", placeholder: "D:\\Games\\MyGame", desc: "含 project.godot 的文件夹。「安装插件到项目」把与服务器同版本、签名校验过的插件装进 <项目>\\addons\\godot_ai：已是同版本时不改动；已有其他版本时先把旧目录整个挪到 addons\\.godot_ai_backup（需先关闭 Godot），不覆盖。装完在 Godot「项目 → 项目设置 → 插件」里启用 Godot AI。",
    action: { component: "godot", path: "/components/godot/addon", label: "安装插件到项目" } },
  { key: "godotPackage", label: "pip 包名", type: "text", desc: "默认 godot-ai（装最新版并固定下来；可写 godot-ai==4.2.3 这样的版本，对上项目里已有的插件）。改了包名后需要重新「下载安装」；不用 uvx 临时运行。" },
  { key: "godotHttpPort", label: "HTTP 端口", type: "number", min: 1, max: 65535, desc: "godot-ai 共享后端的端口（attach --port），默认 8000；要和 Godot「编辑器设置 → godot_ai/http_port」一致。" },
  { key: "godotWsPort", label: "WebSocket 端口", type: "number", min: 1, max: 65535, desc: "Godot 编辑器插件连接的端口（attach --ws-port），默认 9500；要和「编辑器设置 → godot_ai/ws_port」一致。" },
    
  { key: "windowsEnabled", label: "启用", type: "switch", desc: "仅 Windows。注意：模型可以操作桌面、读写文件并执行 PowerShell。" },
  { key: "windowsMode", label: "连接方式", type: "select", options: [
    { value: "stdio", label: "插件拉起（stdio，推荐）" },
    { value: "http", label: "连接已有 HTTP 服务" }
  ], desc: "stdio：由本插件启动 windows-mcp；http：连接计划任务等方式已启动的服务（默认 127.0.0.1:18765）。" },
  { key: "windowsUrl", label: "HTTP 地址", type: "text", desc: "只在「连接已有 HTTP 服务」时使用，默认 http://127.0.0.1:18765/mcp。" },
  { key: "windowsPackage", label: "pip 包名", type: "text", desc: "默认 windows-mcp。改了包名后需要重新「下载安装」；未安装时用系统 uv tool 或 uvx。" },
  { key: "notionEnabled", label: "启用", type: "switch", desc: "首次连接会弹出 Notion 授权页；token 缓存在 %USERPROFILE%\\.mcp-auth。" },
  { key: "notionUrl", label: "远程地址", type: "text", desc: "默认 https://mcp.notion.com/mcp。" },
  { key: "notionPackage", label: "npm 包名（桥）", type: "text", desc: "默认 mcp-remote。已有 %USERPROFILE%\\.dsh\\mcp-remote 时可直接用，不必再装。" },
  { key: "cloudflareEnabled", label: "启用", type: "switch", desc: "首次连接会弹出 Cloudflare 授权页；插件只预申请 offline_access，请在同意页勾选权限。" },
  { key: "cloudflareUrl", label: "远程地址", type: "text", desc: "默认 https://mcp.cloudflare.com/mcp。" },
  { key: "cloudflarePackage", label: "npm 包名（桥）", type: "text", desc: "默认 mcp-remote。" },
  { key: "cloudflare-docsEnabled", label: "启用", type: "switch", desc: "公开文档 MCP，无需登录。" },
  { key: "cloudflare-docsUrl", label: "远程地址", type: "text", desc: "默认 https://docs.mcp.cloudflare.com/mcp。" },
  { key: "githubEnabled", label: "启用", type: "switch", desc: "需要 GitHub PAT（设置或环境变量 GITHUB_MCP_PAT）。" },
  { key: "githubUrl", label: "托管端点", type: "text", desc: "默认 https://api.githubcopilot.com/mcp/。" },
  { key: "githubToken", label: "GitHub PAT", type: "password", placeholder: "ghp_… / github_pat_…", desc: "优先用这里的 token；留空时读用户环境变量 GITHUB_MCP_PAT。不要提交到 git。" },
  { key: "comfyuiEnabled", label: "启用", type: "switch", desc: "ComfyUI 没开时仍可挂载 MCP（可用工具 launch_comfyui）；本机 8188 开着时状态会注明。" },
  { key: "comfyuiPackage", label: "pip 包名", type: "text", desc: "默认 comfy-mcp。改了包名后需要重新「下载安装」；未安装时用系统 uv tool 或 uvx。" },
  { key: "comfyuiBin", label: "comfy.exe 路径", type: "text", placeholder: "%USERPROFILE%\\…\\uv\\tools\\comfy-cli\\Scripts\\comfy.exe", desc: "可选。作为 COMFY_BIN 传给服务器；留空时用环境变量 COMFY_BIN。" },
    { key: "ffmpegEnabled", label: "启用", type: "switch", desc: "需要本机已安装 ffmpeg / ffprobe（PATH 或下方路径）。未装 FFmpeg 时服务器无法可靠工作；关掉不影响其他功能。" },
  { key: "ffmpegPath", label: "FFmpeg 路径", type: "text", placeholder: "C:\\ffmpeg\\bin\\ffmpeg.exe", desc: "可选。本机 ffmpeg 可执行文件完整路径；留空时从 PATH 查找。填写后启动 MCP 时会把该目录前置到 PATH（便于找到同目录的 ffprobe）。" },
  { key: "ffmpegPackage", label: "pip 包名", type: "text", desc: "默认 kinocut（入口命令 kino，原 mcp-video）。改了包名后需要重新「下载安装」；未安装时用 uvx 临时运行。" },
  { key: "obsidianEnabled", label: "启用", type: "switch", desc: "需要 Obsidian 开着，并启用社区插件 Local REST API。没开时工具会提示未连接，不影响其他功能。" },
  { key: "obsidianApiKey", label: "API 密钥", type: "password", placeholder: "在 Local REST API 插件设置里复制", desc: "必填。Obsidian → 设置 → 社区插件 → Local REST API 中的 API key（Bearer Token）。" },
  { key: "obsidianBaseUrl", label: "API 地址", type: "text", desc: "默认 http://127.0.0.1:27123（需在插件里开启 Non-encrypted HTTP）。HTTPS 默认端口可用 https://127.0.0.1:27124（自签证书由服务器侧跳过校验）。" },
  { key: "obsidianEnableCommands", label: "允许执行命令面板", type: "switch", desc: "对应 OBSIDIAN_ENABLE_COMMANDS。打开后 MCP 可列出并执行 Obsidian 命令（可能含破坏性操作），默认关闭。" },
  { key: "obsidianPackage", label: "npm 包名", type: "text", desc: "默认 obsidian-mcp-server（可带版本）。改了包名后需要重新「下载安装」；未安装时用 npx 临时运行。" },
  { key: "gamebot-minecraftEnabled", label: "启用", type: "switch", desc: "打开后自动启动共享 GameBot REST body，并挂载只含 Minecraft 的 MCP（工具前缀 mcp__gamebot-minecraft__）。所有游戏共用一个 body，全部关闭才停止。每次应用/会话启动默认关闭。注意：勿与 DSH 桌面大脑同时对同一游戏发动作（双脑）。" },
  { key: "gamebot-civilizationEnabled", label: "启用", type: "switch", desc: "打开后自动启动共享 GameBot REST body，并挂载只含 文明 VI 的 MCP（工具前缀 mcp__gamebot-civilization__）。所有游戏共用一个 body，全部关闭才停止。每次应用/会话启动默认关闭。注意：勿与 DSH 桌面大脑同时对同一游戏发动作（双脑）。" },
  { key: "gamebot-visionEnabled", label: "启用", type: "switch", desc: "打开后自动启动共享 GameBot REST body，并挂载只含 视觉兜底 的 MCP（工具前缀 mcp__gamebot-vision__）。所有游戏共用一个 body，全部关闭才停止。每次应用/会话启动默认关闭。注意：勿与 DSH 桌面大脑同时对同一游戏发动作（双脑）。" },
  { key: "gamebotUrl", label: "GameBot REST 地址", type: "text", placeholder: "http://127.0.0.1:8766", desc: "GameBot FastAPI 根地址（探测 /health，工具走 /v1/...）。可跨重启记住。默认 http://127.0.0.1:8766。" },
  /* <gamebot-fields> generated by scripts/gen-gamebot-fields.mjs */
  {"key":"gb_minecraft_driver","label":"驱动","type":"select","options":[{"value":"minaret","label":"minaret（NeoForge 模组 WebSocket）"}],"placeholder":"minaret","desc":"Mineflayer 驱动需要的 Node 桥不随插件提供，已隐藏。 GameBot 配置键 driver。"},
  {"key":"gb_minecraft_NEOFORGE_WS_URL","label":"NeoForge WS 地址","type":"text","placeholder":"ws://127.0.0.1:8765","desc":"GameBot 配置键 NEOFORGE_WS_URL。"},
  {"key":"gb_minecraft_NEOFORGE_WS_AUTH_USER","label":"NeoForge WS 用户","type":"text","desc":"GameBot 配置键 NEOFORGE_WS_AUTH_USER。"},
  {"key":"gb_minecraft_NEOFORGE_WS_AUTH_PASS","label":"NeoForge WS 密码","type":"password","placeholder":"（已保存则留空不变）","desc":"GameBot 配置键 NEOFORGE_WS_AUTH_PASS。"},
  {"key":"gb_minecraft_MC_USERNAME","label":"机器人用户名","type":"text","placeholder":"Player","desc":"GameBot 配置键 MC_USERNAME。"},
  {"key":"gb_minecraft_MC_VERSION","label":"MC 版本","type":"text","placeholder":"1.21.1","desc":"GameBot 配置键 MC_VERSION。"},
  {"key":"gb_minecraft_MC_ARCHIVE","label":"存档 / 档案名","type":"text","desc":"GameBot 配置键 MC_ARCHIVE。"},
  {"key":"gb_minecraft_MC_CHAT_FORWARD","label":"转发游戏聊天","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"1","desc":"GameBot 配置键 MC_CHAT_FORWARD。"},
  {"key":"gb_minecraft_MC_USE_TOOLS","label":"允许工具动作","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"1","desc":"GameBot 配置键 MC_USE_TOOLS。"},
  {"key":"gb_minecraft_MC_CHAT_PREFIX","label":"聊天触发前缀","type":"text","desc":"留空 = 所有聊天都处理。 GameBot 配置键 MC_CHAT_PREFIX。"},
  {"key":"gb_minecraft_MC_CHAT_COOLDOWN_MS","label":"聊天冷却（毫秒）","type":"text","placeholder":"3000","desc":"GameBot 配置键 MC_CHAT_COOLDOWN_MS。"},
  {"key":"gb_minecraft_MC_MODS_DIR","label":"mods 目录","type":"text","desc":"安装 NeoForge 模组时使用的 .minecraft/versions/<版本>/mods。 GameBot 配置键 MC_MODS_DIR。"},
  {"key":"gb_minecraft_LLM_ENABLED","label":"决策大脑（LLM）","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"0","desc":"GameBot 自带大脑是否调用 LLM 做决策。【双脑】用 DSH 驱动时建议关闭。 GameBot 配置键 LLM_ENABLED。"},
  {"key":"gb_minecraft_LLM_PROVIDER","label":"决策服务商","type":"select","options":["openai","deepseek","xai","anthropic","ollama","custom"],"placeholder":"openai","desc":"API 密钥按服务商保存，所有游戏共用同一服务商的密钥。 GameBot 配置键 LLM_PROVIDER。"},
  {"key":"gb_minecraft_LLM_PROTOCOL","label":"决策协议","type":"select","options":["openai-completions","openai-responses","anthropic-messages"],"placeholder":"openai-completions","desc":"GameBot 配置键 LLM_PROTOCOL。"},
  {"key":"gb_minecraft_LLM_BASE_URL","label":"决策 Base URL","type":"text","desc":"留空用服务商默认地址。 GameBot 配置键 LLM_BASE_URL。"},
  {"key":"gb_minecraft_LLM_MODEL","label":"决策模型","type":"text","desc":"GameBot 配置键 LLM_MODEL。"},
  {"key":"gb_minecraft_LLM_API_KEY","label":"决策 API 密钥","type":"password","placeholder":"（已保存则留空不变）","desc":"留空 = 保持 GameBot 已存的该服务商密钥。 GameBot 配置键 LLM_API_KEY。"},
  {"key":"gb_minecraft_LLM_DECISION_TIMEOUT_S","label":"决策超时（秒）","type":"text","placeholder":"60","desc":"GameBot 配置键 LLM_DECISION_TIMEOUT_S。"},
  {"key":"gb_minecraft_LLM_MAX_STEPS","label":"决策最大步数","type":"text","placeholder":"8","desc":"GameBot 配置键 LLM_MAX_STEPS。"},
  {"key":"gb_minecraft_LLM_TEMPERATURE","label":"决策 temperature","type":"text","placeholder":"0.2","desc":"GameBot 配置键 LLM_TEMPERATURE。"},
  {"key":"gb_minecraft_LLM_TOP_P","label":"决策 top_p","type":"text","desc":"留空用默认。 GameBot 配置键 LLM_TOP_P。"},
  {"key":"gb_minecraft_LLM_MAX_TOKENS","label":"决策 max_tokens","type":"text","desc":"GameBot 配置键 LLM_MAX_TOKENS。"},
  {"key":"gb_minecraft_LLM_REASONING_EFFORT","label":"决策推理强度","type":"text","desc":"如 none / low / medium / high；留空用默认。 GameBot 配置键 LLM_REASONING_EFFORT。"},
  {"key":"gb_minecraft_LLM_THINKING_BUDGET","label":"决策思考预算","type":"text","desc":"GameBot 配置键 LLM_THINKING_BUDGET。"},
  {"key":"gb_minecraft_LLM_PERSONA","label":"决策人设","type":"textarea","desc":"留空 = 使用 GameBot 默认人设。 GameBot 配置键 LLM_PERSONA。"},
  {"key":"gb_minecraft_CHAT_ENABLED","label":"聊天模型","type":"select","options":[{"value":"","label":"继承（跟随决策模型）"},{"value":"1","label":"开"},{"value":"0","label":"关"}],"desc":"GameBot 配置键 CHAT_ENABLED。"},
  {"key":"gb_minecraft_CHAT_PROVIDER","label":"聊天服务商","type":"select","options":[{"value":"","label":"继承"},"openai","deepseek","xai","anthropic","ollama","custom"],"desc":"GameBot 配置键 CHAT_PROVIDER。"},
  {"key":"gb_minecraft_CHAT_PROTOCOL","label":"聊天协议","type":"select","options":[{"value":"","label":"继承"},"openai-completions","openai-responses","anthropic-messages"],"desc":"GameBot 配置键 CHAT_PROTOCOL。"},
  {"key":"gb_minecraft_CHAT_BASE_URL","label":"聊天 Base URL","type":"text","desc":"GameBot 配置键 CHAT_BASE_URL。"},
  {"key":"gb_minecraft_CHAT_MODEL","label":"聊天模型名","type":"text","desc":"GameBot 配置键 CHAT_MODEL。"},
  {"key":"gb_minecraft_CHAT_API_KEY","label":"聊天 API 密钥","type":"password","placeholder":"（已保存则留空不变）","desc":"按聊天服务商保存；留空 = 保持已存密钥。 GameBot 配置键 CHAT_API_KEY。"},
  {"key":"gb_minecraft_CHAT_TEMPERATURE","label":"聊天 temperature","type":"text","desc":"GameBot 配置键 CHAT_TEMPERATURE。"},
  {"key":"gb_minecraft_CHAT_TOP_P","label":"聊天 top_p","type":"text","desc":"GameBot 配置键 CHAT_TOP_P。"},
  {"key":"gb_minecraft_CHAT_MAX_TOKENS","label":"聊天 max_tokens","type":"text","desc":"GameBot 配置键 CHAT_MAX_TOKENS。"},
  {"key":"gb_minecraft_CHAT_REASONING_EFFORT","label":"聊天推理强度","type":"text","desc":"GameBot 配置键 CHAT_REASONING_EFFORT。"},
  {"key":"gb_minecraft_CHAT_THINKING_BUDGET","label":"聊天思考预算","type":"text","desc":"GameBot 配置键 CHAT_THINKING_BUDGET。"},
  {"key":"gb_minecraft_CHAT_PERSONA","label":"聊天人设","type":"textarea","desc":"留空 = 使用 GameBot 默认。 GameBot 配置键 CHAT_PERSONA。"},
  {"key":"gb_minecraft_MEMORY_ENABLED","label":"记忆","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"1","desc":"GameBot 配置键 MEMORY_ENABLED。"},
  {"key":"gb_minecraft_MEMORY_BLOCK_SIZE","label":"记忆块大小","type":"text","placeholder":"6","desc":"GameBot 配置键 MEMORY_BLOCK_SIZE。"},
  {"key":"gb_minecraft_DSH_SESSION","label":"DSH 会话 id","type":"text","desc":"可选：经 DSH 宿主内的陪玩桥把交流正文写入这个会话（不直接写会话文件）；留空不写。 GameBot 配置键 DSH_SESSION。"},
  {"key":"gb_civilization_CIV6_MCP_PROJECT","label":"civ6-mcp 项目目录","type":"text","desc":"civ6-mcp 仓库所在目录；留空则沿用 GameBot 已存的值。 GameBot 配置键 CIV6_MCP_PROJECT。"},
  {"key":"gb_civilization_CIV6_MODS_DIR","label":"文明 VI Mods 目录","type":"text","desc":"…\\My Games\\Sid Meier's Civilization VI\\Mods，安装 TRIXCompanion 模组用。 GameBot 配置键 CIV6_MODS_DIR。"},
  {"key":"gb_civilization_CIV_POLL_INTERVAL_S","label":"轮询间隔（秒）","type":"text","placeholder":"1","desc":"GameBot 配置键 CIV_POLL_INTERVAL_S。"},
  {"key":"gb_civilization_CIV_SAFE_AUTO","label":"安全自动（不主动结束回合）","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"1","desc":"GameBot 配置键 CIV_SAFE_AUTO。"},
  {"key":"gb_civilization_CIV_DSH_SESSION","label":"文明 DSH 会话 id","type":"text","desc":"可选：经 DSH 宿主内的陪玩桥把评论写入这个会话（不直接写会话文件）；留空不写。 GameBot 配置键 CIV_DSH_SESSION。"},
  {"key":"gb_civilization_LLM_ENABLED","label":"决策大脑（LLM）","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"0","desc":"GameBot 自带大脑是否调用 LLM 做决策。【双脑】用 DSH 驱动时建议关闭。 GameBot 配置键 LLM_ENABLED。"},
  {"key":"gb_civilization_LLM_PROVIDER","label":"决策服务商","type":"select","options":["openai","deepseek","xai","anthropic","ollama","custom"],"placeholder":"openai","desc":"API 密钥按服务商保存，所有游戏共用同一服务商的密钥。 GameBot 配置键 LLM_PROVIDER。"},
  {"key":"gb_civilization_LLM_PROTOCOL","label":"决策协议","type":"select","options":["openai-completions","openai-responses","anthropic-messages"],"placeholder":"openai-completions","desc":"GameBot 配置键 LLM_PROTOCOL。"},
  {"key":"gb_civilization_LLM_BASE_URL","label":"决策 Base URL","type":"text","desc":"留空用服务商默认地址。 GameBot 配置键 LLM_BASE_URL。"},
  {"key":"gb_civilization_LLM_MODEL","label":"决策模型","type":"text","desc":"GameBot 配置键 LLM_MODEL。"},
  {"key":"gb_civilization_LLM_API_KEY","label":"决策 API 密钥","type":"password","placeholder":"（已保存则留空不变）","desc":"留空 = 保持 GameBot 已存的该服务商密钥。 GameBot 配置键 LLM_API_KEY。"},
  {"key":"gb_civilization_LLM_DECISION_TIMEOUT_S","label":"决策超时（秒）","type":"text","placeholder":"60","desc":"GameBot 配置键 LLM_DECISION_TIMEOUT_S。"},
  {"key":"gb_civilization_LLM_MAX_STEPS","label":"决策最大步数","type":"text","placeholder":"8","desc":"GameBot 配置键 LLM_MAX_STEPS。"},
  {"key":"gb_civilization_LLM_TEMPERATURE","label":"决策 temperature","type":"text","placeholder":"0.2","desc":"GameBot 配置键 LLM_TEMPERATURE。"},
  {"key":"gb_civilization_LLM_TOP_P","label":"决策 top_p","type":"text","desc":"留空用默认。 GameBot 配置键 LLM_TOP_P。"},
  {"key":"gb_civilization_LLM_MAX_TOKENS","label":"决策 max_tokens","type":"text","desc":"GameBot 配置键 LLM_MAX_TOKENS。"},
  {"key":"gb_civilization_LLM_REASONING_EFFORT","label":"决策推理强度","type":"text","desc":"如 none / low / medium / high；留空用默认。 GameBot 配置键 LLM_REASONING_EFFORT。"},
  {"key":"gb_civilization_LLM_THINKING_BUDGET","label":"决策思考预算","type":"text","desc":"GameBot 配置键 LLM_THINKING_BUDGET。"},
  {"key":"gb_civilization_LLM_PERSONA","label":"决策人设","type":"textarea","desc":"留空 = 使用 GameBot 默认人设。 GameBot 配置键 LLM_PERSONA。"},
  {"key":"gb_civilization_CHAT_ENABLED","label":"聊天模型","type":"select","options":[{"value":"","label":"继承（跟随决策模型）"},{"value":"1","label":"开"},{"value":"0","label":"关"}],"desc":"GameBot 配置键 CHAT_ENABLED。"},
  {"key":"gb_civilization_CHAT_PROVIDER","label":"聊天服务商","type":"select","options":[{"value":"","label":"继承"},"openai","deepseek","xai","anthropic","ollama","custom"],"desc":"GameBot 配置键 CHAT_PROVIDER。"},
  {"key":"gb_civilization_CHAT_PROTOCOL","label":"聊天协议","type":"select","options":[{"value":"","label":"继承"},"openai-completions","openai-responses","anthropic-messages"],"desc":"GameBot 配置键 CHAT_PROTOCOL。"},
  {"key":"gb_civilization_CHAT_BASE_URL","label":"聊天 Base URL","type":"text","desc":"GameBot 配置键 CHAT_BASE_URL。"},
  {"key":"gb_civilization_CHAT_MODEL","label":"聊天模型名","type":"text","desc":"GameBot 配置键 CHAT_MODEL。"},
  {"key":"gb_civilization_CHAT_API_KEY","label":"聊天 API 密钥","type":"password","placeholder":"（已保存则留空不变）","desc":"按聊天服务商保存；留空 = 保持已存密钥。 GameBot 配置键 CHAT_API_KEY。"},
  {"key":"gb_civilization_CHAT_TEMPERATURE","label":"聊天 temperature","type":"text","desc":"GameBot 配置键 CHAT_TEMPERATURE。"},
  {"key":"gb_civilization_CHAT_TOP_P","label":"聊天 top_p","type":"text","desc":"GameBot 配置键 CHAT_TOP_P。"},
  {"key":"gb_civilization_CHAT_MAX_TOKENS","label":"聊天 max_tokens","type":"text","desc":"GameBot 配置键 CHAT_MAX_TOKENS。"},
  {"key":"gb_civilization_CHAT_REASONING_EFFORT","label":"聊天推理强度","type":"text","desc":"GameBot 配置键 CHAT_REASONING_EFFORT。"},
  {"key":"gb_civilization_CHAT_THINKING_BUDGET","label":"聊天思考预算","type":"text","desc":"GameBot 配置键 CHAT_THINKING_BUDGET。"},
  {"key":"gb_civilization_CHAT_PERSONA","label":"聊天人设","type":"textarea","desc":"留空 = 使用 GameBot 默认。 GameBot 配置键 CHAT_PERSONA。"},
  {"key":"gb_civilization_MEMORY_ENABLED","label":"记忆","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"1","desc":"GameBot 配置键 MEMORY_ENABLED。"},
  {"key":"gb_civilization_MEMORY_BLOCK_SIZE","label":"记忆块大小","type":"text","placeholder":"6","desc":"GameBot 配置键 MEMORY_BLOCK_SIZE。"},
  {"key":"gb_civilization_DSH_SESSION","label":"DSH 会话 id","type":"text","desc":"可选：经 DSH 宿主内的陪玩桥把交流正文写入这个会话（不直接写会话文件）；留空不写。 GameBot 配置键 DSH_SESSION。"},
  {"key":"gb_vision_monitor","label":"显示器编号","type":"text","placeholder":"1","desc":"GameBot 配置键 monitor。"},
  {"key":"gb_vision_max_px","label":"截图最长边（px）","type":"text","placeholder":"1280","desc":"GameBot 配置键 max_px。"},
  {"key":"gb_vision_settle_s","label":"动作后等待（秒）","type":"text","placeholder":"0.15","desc":"GameBot 配置键 settle_s。"},
  {"key":"gb_vision_evidence_dir","label":"截图证据目录","type":"text","desc":"留空不保存。 GameBot 配置键 evidence_dir。"},
  /* </gamebot-fields> */
  { key: "gamebotRoot", label: "GameBot 目录（可选）", type: "text", placeholder: "（留空=插件内嵌）", desc: "含 pyproject.toml 与 src/gamebot 的目录；留空用插件内嵌 src/components/gamebot（推荐）。Python 环境 .venv 在首次启用时自动准备。" },
  { key: "nodePath", label: "node 路径", type: "text", placeholder: "C:\\Program Files\\nodejs\\node.exe", desc: "插件 tools\\node 里有 Node.js 时优先用它；否则用这里的路径（npm 取同目录），留空时用 PATH 里的 node（需 20.19+ / 22.12+），再退回 DSH 自带的运行时（只能运行，不能安装）。" },
  { key: "npmRegistry", label: "npm 镜像", type: "text", placeholder: "https://registry.npmmirror.com", desc: "可选。安装 npm 组件时使用的镜像地址；留空时使用 npm 自身设置（默认 registry.npmjs.org）。保存后再安装。" },
  { key: "uvPath", label: "uv 路径", type: "text", desc: "插件 tools\\uv 里有 uv 时优先用它；否则用这里的路径（uvx 取同目录），留空时查找 WinGet 安装的 uv，再用 PATH。" },
  { key: "sessionControlsEnabled", label: "启用会话控制", type: "switch", desc: "实验性。默认关闭。关闭后仍保留本页配置；助手消息撤回/重试与输入框暂停熔断会隐藏。启用前会再次确认。" },
  { key: "sessionCircuitEnabled", label: "自动熔断", type: "switch", desc: "同一工具连打 / 步数过多 / 思考过长时自动取消当前回合。" },
  { key: "sessionCircuitMaxSameTool", label: "同工具连续上限", type: "number", min: 2, max: 50, desc: "同一工具（含相同参数）连续调用达到该次数时熔断。" },
  { key: "sessionCircuitMaxSteps", label: "单回合步数上限", type: "number", min: 5, max: 500, desc: "单回合 step/start 次数上限。" },
  { key: "sessionCircuitMaxReasoningChars", label: "思考字符上限", type: "number", min: 1000, max: 5000000, desc: "单回合累计思考字符上限。" },

  { key: "proxy", label: "下载代理", type: "text", desc: "下载安装时使用的 HTTP 代理（uv、Python、Node.js、npm 都走它），例如 http://127.0.0.1:7890；留空时使用环境变量 HTTPS_PROXY / HTTP_PROXY。保存后再安装。" }
];
var FIELD_BY_KEY = {};
INPUT_FIELDS.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });

/** Local component enable switch: same <id>Enabled key as bundled; register dynamically when not in INPUT_FIELDS. Default OFF (fresh install: no MCP until enabled). */
function ensureLocalEnabledField(id) {
  var key = id + "Enabled";
  if (!FIELD_BY_KEY[key]) {
    FIELD_BY_KEY[key] = {
      key: key,
      label: "启用",
      type: "switch",
      desc: "关闭后此组件不会在后台启动，也不影响其它功能。",
      localDynamic: true
    };
  }
  return FIELD_BY_KEY[key];
}

// 列表图标：通用线条，跟随文字颜色。只表达功能类别，不使用第三方标志的图形或品牌色。
function svgIcon(body) {
  return '<svg viewBox="0 0 24 24" width="100%" height="100%" focusable="false" aria-hidden="true">' + body + "</svg>";
}
function strokeIcon(body) {
  return svgIcon('<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + body + "</g>");
}
var ICONS = {
  session: strokeIcon('<path d="M5 4.5h14v15H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  image: strokeIcon('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.8" r="1.7"/><path d="M20.5 15.6l-4.8-4.8L6.2 19.5"/>'),
  office: strokeIcon('<rect x="4" y="3.5" width="16" height="17" rx="1.5"/><path d="M4 8h16M9 8v12.5M4 13h16"/>'),
  blender: strokeIcon('<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6Z"/><path d="M12 3.2v17.6M4 7.6l8 4.4 8-4.4"/>'),
  unity: strokeIcon('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M10 9.2v6.2l5.2-3.1Z"/>'),
  uv: strokeIcon('<path d="M4 8.2 12 4.2l8 4v7.6l-8 4-8-4Z"/><path d="M12 12.2V20M4 8.2l8 4 8-4"/>'),
  figma: strokeIcon('<rect x="3.5" y="4" width="10" height="13" rx="1.4"/><rect x="10.5" y="7" width="10" height="13" rx="1.4"/>'),
  photoshop: strokeIcon('<rect x="3.5" y="5" width="17" height="12" rx="1.6"/><path d="M3.5 15.2 8.2 11l3.2 2.6 2.4-2 6.7 4.6"/><circle cx="8.2" cy="9" r="1.2"/>'),
  chrome: strokeIcon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/><circle cx="6.2" cy="7" r=".7" fill="currentColor" stroke="none"/>'),
  godot: strokeIcon('<circle cx="7" cy="6.5" r="1.6"/><circle cx="7" cy="12" r="1.6"/><circle cx="7" cy="17.5" r="1.6"/><path d="M8.6 6.5H16M8.6 12H18M8.6 17.5H14"/>'),
  node: strokeIcon('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.2 10.2 9.6 12 7.2 13.8M11.4 14.6h5"/>'),
  windows: strokeIcon('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17"/>'),
  notion: strokeIcon('<path d="M7 3.5h8.2L19 7.2V20.5H7z"/><path d="M15 3.8V7.4H19"/><path d="M10 11h6M10 14h6M10 17h4"/>'),
  cloudflare: strokeIcon('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/>'),
  cloudflareDocs: strokeIcon('<path d="M6.5 3.5h8L18.5 8v12.5h-12z"/><path d="M14.2 3.8V8H18"/><path d="M9 12.2h6.5M9 15.2h6.5M9 18.2h4"/>'),
  github: strokeIcon('<circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8.8 8.4 10.6 15.2M15.2 8.4 13.4 15.2"/>'),
  comfyui: strokeIcon('<rect x="3.2" y="8" width="5.2" height="4.2" rx="1"/><rect x="15.6" y="4.5" width="5.2" height="4.2" rx="1"/><rect x="15.6" y="15.3" width="5.2" height="4.2" rx="1"/><path d="M8.4 10.1h7.2M16.4 8.7 10.2 10.1M16.4 15.3 10.2 12.2"/>'),
  proxy: strokeIcon('<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.7" ry="8.5"/><path d="M3.9 9.2h16.2M3.9 14.8h16.2"/>'),
  ffmpeg: strokeIcon('<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M8 6v12M12 6v12M16 6v12M3.5 10h17M3.5 14h17"/>'),
  obsidian: strokeIcon('<path d="M8 6.5h11v13H8z"/><path d="M5 4.5h11"/><path d="M5 4.5v11"/><path d="M11 10.5h5M11 13.5h5M11 16.5h3"/>'),
  gamebot: strokeIcon('<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 12h.01M16 12h.01M10.5 14.5h3"/><path d="M9 7V5.5M15 7V5.5"/>'),
  gamebotMinecraft: strokeIcon('<path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8z"/><path d="M4 8l8 4.5L20 8M12 12.5v8"/>'),
  gamebotCivilization: strokeIcon('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>'),
  gamebotVision: strokeIcon('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>'),
  addComponent: strokeIcon('<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><path d="M17 13.5v7M13.5 17h7"/>')
};

// 功能列表：每项一行、一个管理页。component：状态来自 /components 里同 id 的一项；
// 没有 component 的是纯设置项，列表里的状态由 summary(已保存的设置) 给出。icon：ICONS 里的静态 SVG。
var FEATURES = [
  {
    id: "image", group: "多模态", title: "媒体卡片", icon: ICONS.image,
    desc: "mm_send_image 把本地图片发成 MmCard（Host attachmentId）。",
    intro: "调用 mm_send_image，传入本地 png/jpg/webp/gif/bmp 路径，经 attachments.saveImage 得到 attachmentId，工具卡片渲染 type:mm kind:image。",
    keys: [],
    summary: function () {
      return { text: "mm_send_image · 可用", cls: "ready" };
    }
  },
  {
    id: "office", group: "工作组件", title: "Office", component: "office",
    moduleSource: "bundled", icon: ICONS.office,
    url: "https://github.com/officemcp/officemcp",
    desc: "经 COM 控制本机的 Word / Excel / PowerPoint（OfficeMCP）。",
    intro: "经 COM 控制本机的 Word / Excel / PowerPoint（OfficeMCP），工具名前缀 mcp__officemcp__。",
    keys: ["officeEnabled", "officeRepo", "officeFolder"]
  },
  {
    id: "blender", group: "工作组件", title: "Blender", component: "blender",
    moduleSource: "bundled", icon: ICONS.blender,
    url: "https://github.com/ahujasid/blender-mcp",
    desc: "控制正在打开的 Blender（mcp-for-blender）。",
    intro: "控制正在打开的 Blender（mcp-for-blender），工具名前缀 mcp__blender__。Blender 里需要启用对应插件。",
    keys: ["blenderEnabled", "blenderPackage"]
  },
  {
    id: "unity", group: "工作组件", title: "Unity", component: "unity",
    moduleSource: "bundled", icon: ICONS.unity,
    url: "https://github.com/CoplayDev/unity-mcp",
    desc: "控制 Unity 编辑器（Coplay mcp-for-unity）。",
    intro: "控制 Unity 编辑器（Coplay mcp-for-unity），工具名前缀 mcp__unity__。编辑器需装 MCP for Unity 包并开着工程。",
    keys: ["unityEnabled", "unityPackage"]
  },
  {
    id: "figma", group: "工作组件", title: "Figma", component: "figma",
    moduleSource: "bundled", icon: ICONS.figma,
    url: "https://github.com/southleft/figma-console-mcp",
    desc: "读写 Figma 设计稿（figma-console-mcp）。",
    intro: "经 Figma 桌面版里的 Desktop Bridge 插件读写设计稿（figma-console-mcp，121 个工具：创建 / 修改节点和组件、变量与设计令牌、截图、FigJam、Slides 等），工具名前缀 mcp__figma__。准备：装 Figma 桌面版；启用本组件后，在 Figma 菜单选择「插件 → 开发 → 从清单导入插件…」（英文界面：Plugins → Development → Import plugin from manifest…），选 %USERPROFILE%\\.figma-console-mcp\\plugin\\manifest.json，再在设计文件里运行「Figma Desktop Bridge」。",
    keys: ["figmaEnabled", "figmaMode", "figmaToken", "figmaOfficialUrl", "figmaPackage"]
  },
  {
    id: "photoshop", group: "工作组件", title: "Photoshop", component: "photoshop",
    moduleSource: "bundled", icon: ICONS.photoshop,
    url: "https://github.com/alisaitteke/photoshop-mcp",
    desc: "经 COM 控制本机的 Photoshop（photoshop-mcp）。",
    intro: "经 COM 控制本机的 Adobe Photoshop（photoshop-mcp，125 个工具：文档、图层、选区与蒙版、滤镜、调色、文字、导出、动作、创成式填充等），工具名前缀 mcp__photoshop__。需要本机装有 Photoshop（CS6 / 2012 及以上）并开着；不需要装 Photoshop 插件（只有神经滤镜要另装它的 UXP 插件）。",
    keys: ["photoshopEnabled", "photoshopPath", "photoshopPackage"]
  },
  {
    id: "chrome", group: "工作组件", title: "Chrome", component: "chrome",
    moduleSource: "bundled", icon: ICONS.chrome,
    url: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    desc: "控制本机的 Google Chrome（Chrome DevTools MCP）。",
    intro: "用 Google 官方的 Chrome DevTools MCP 控制本机 Chrome：打开 / 切换标签页、点击输入和填表、上传文件、处理对话框、截图和页面快照、执行 JS、网络请求与控制台、性能追踪与 Lighthouse、设备 / 网络 / 地理位置模拟等，工具名前缀 mcp__chrome__。默认启动一个独立配置的 Chrome，也可以连接你正在用的 Chrome。",
    keys: ["chromeEnabled", "chromeConnect", "chromeBrowserUrl", "chromeChannel", "chromeHeadless", "chromeUserDataDir", "chromeToolset", "chromePackage"]
  },
  {
    id: "godot", group: "工作组件", title: "Godot", component: "godot",
    moduleSource: "bundled", icon: ICONS.godot,
    url: "https://github.com/hi-godot/godot-ai",
    desc: "控制 Godot 编辑器（hi-godot/godot-ai）。",
    intro: "用 godot-ai 控制 Godot 编辑器：场景与节点、脚本（GDScript 校验并热重载）、信号、UI、材质、动画、粒子、相机与环境，运行项目、跑测试、读日志、编辑器截图等（47 个工具），工具名前缀 mcp__godot__。需要 Godot 4.7+。准备：① 点「下载安装」（服务器版本会固定下来，并下载同版本、签名校验过的 Godot 插件）；② 在下面填 Godot 项目目录，点「安装插件到项目」（或按下方说明手动解压同版本的 godot-ai-v4-plugin.zip）；③ 在 Godot 里「项目 → 项目设置 → 插件」启用 Godot AI；④ 打开「启用」。DSH 已经通过本组件连接，不要再在 Godot AI 面板里给 DeepSeek Harness 点 Configure（会多出一份重复的工具）。",
    keys: ["godotEnabled", "godotProject", "godotPackage", "godotHttpPort", "godotWsPort"]
  },
  {
    id: "windows", group: "工作组件", title: "Windows", component: "windows",
    moduleSource: "bundled", icon: ICONS.windows,
    url: "https://github.com/CursorTouch/Windows-MCP",
    desc: "控制本机 Windows 桌面（Windows-MCP）。",
    intro: "控制本机 Windows 桌面（Windows-MCP）：窗口、键鼠、截图、文件系统、注册表、PowerShell 等，工具名前缀 mcp__windows__。默认由本插件以 stdio 拉起；也可改连已在跑的 HTTP 服务（如计划任务 127.0.0.1:18765）。注意：模型可以操作桌面与执行 PowerShell。",
    keys: ["windowsEnabled", "windowsMode", "windowsUrl", "windowsPackage"]
  },
  {
    id: "notion", group: "工作组件", title: "Notion", component: "notion",
    moduleSource: "bundled", icon: ICONS.notion,
    url: "https://developers.notion.com/docs/mcp",
    desc: "官方 Notion MCP（OAuth，经 mcp-remote）。",
    intro: "官方 Notion MCP（OAuth）。DSH HTTP 传输没有浏览器授权，经 mcp-remote stdio 桥；首次连接会弹出 Notion 授权页，token 缓存在 %USERPROFILE%\\.mcp-auth。工具名前缀 mcp__notion__。",
    keys: ["notionEnabled", "notionUrl", "notionPackage"]
  },
  {
    id: "cloudflare", group: "工作组件", title: "Cloudflare", component: "cloudflare",
    moduleSource: "bundled", icon: ICONS.cloudflare,
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    desc: "官方 Cloudflare API MCP（OAuth，经 mcp-remote）。",
    intro: "官方 Cloudflare API MCP（OAuth / Code Mode）。经 mcp-remote 桥；预申请 scope=offline_access，授权页请自行勾选权限。工具名前缀 mcp__cloudflare__（docs / search / execute）。",
    keys: ["cloudflareEnabled", "cloudflareUrl", "cloudflarePackage"]
  },
  {
    id: "cloudflare-docs", group: "工作组件", title: "Cloudflare Docs", component: "cloudflare-docs",
    moduleSource: "bundled", icon: ICONS.cloudflareDocs,
    url: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-catalog/",
    desc: "Cloudflare 文档 MCP（公开，无需登录）。",
    intro: "Cloudflare 文档 MCP（公开 streamable-http，无需登录）。查文档不必等 API 授权。工具名前缀 mcp__cloudflare-docs__。",
    keys: ["cloudflare-docsEnabled", "cloudflare-docsUrl"]
  },
  {
    id: "github", group: "工作组件", title: "GitHub", component: "github",
    moduleSource: "bundled", icon: ICONS.github,
    url: "https://github.com/github/github-mcp-server",
    desc: "官方 GitHub MCP（托管 HTTP + PAT）。",
    intro: "官方 GitHub MCP 托管端点。Token 优先读设置 githubToken，否则读环境变量 GITHUB_MCP_PAT；不要把 token 写进仓库。工具名前缀 mcp__github__。",
    keys: ["githubEnabled", "githubUrl", "githubToken"]
  },
  {
    id: "comfyui", group: "工作组件", title: "ComfyUI", component: "comfyui",
    moduleSource: "bundled", icon: ICONS.comfyui,
    url: "https://github.com/Comfy-Org/comfy-mcp",
    desc: "官方 Comfy MCP（驱动本机 ComfyUI）。",
    intro: "官方 Comfy MCP（comfy-mcp，经 comfy-cli 驱动本机 ComfyUI）。工具名前缀 mcp__comfyui__。ComfyUI 需先开着，或用工具 launch_comfyui。可选填写 COMFY_BIN（comfy.exe）。",
    keys: ["comfyuiEnabled", "comfyuiPackage", "comfyuiBin"]
  },
  {
    id: "ffmpeg", group: "工作组件", title: "FFmpeg", component: "ffmpeg",
    moduleSource: "bundled", icon: ICONS.ffmpeg,
    url: "https://github.com/KyaniteLabs/kinocut",
    desc: "本机媒体转换 / 探针 / 剪辑（Kinocut MCP，封装 FFmpeg）。",
    intro: "用 Kinocut（原 mcp-video）经类型化工具调用本机 FFmpeg：转码、剪辑、合并、字幕、探针、缩略图、质量检查与 Shorts/Reels 再包装等（百余工具，可用 search_tools 发现），工具名前缀 mcp__ffmpeg__。准备：① 本机安装 ffmpeg/ffprobe（winget install ffmpeg，或填「FFmpeg 路径」）；② 点「下载安装」装 Kinocut 到 tools\\ffmpeg；③ 打开「启用」。不会把庞大的 FFmpeg 二进制打进插件仓库。",
    keys: ["ffmpegEnabled", "ffmpegPath", "ffmpegPackage"]
  },
  {
    id: "obsidian", group: "工作组件", title: "Obsidian", component: "obsidian",
    moduleSource: "bundled", icon: ICONS.obsidian,
    url: "https://github.com/cyanheads/obsidian-mcp-server",
    desc: "读写本机 Obsidian 库（经 Local REST API 插件）。",
    intro: "用 obsidian-mcp-server 读写 Obsidian 库：读笔记、列表、搜索、追加/补丁、frontmatter 与标签等（14 个工具），工具名前缀 mcp__obsidian__。准备：① 安装并打开 Obsidian；② 设置 → 社区插件，关闭安全模式后浏览，搜索并安装「Local REST API」，再启用它；③ 在该插件设置里复制 API 密钥，填到下方，并建议开启 Non-encrypted HTTP（默认 http://127.0.0.1:27123）；④ 点「下载安装」；⑤ 打开「启用」。",
    keys: ["obsidianEnabled", "obsidianApiKey", "obsidianBaseUrl", "obsidianEnableCommands", "obsidianPackage"]
  },
  {
    id: "gamebot-minecraft", group: "游戏", title: "Minecraft", component: "gamebot-minecraft",
    moduleSource: "bundled", icon: ICONS.gamebotMinecraft,
    builtin: true,
    desc: "GameBot · Minecraft：NeoForge Minaret / Mineflayer 驱动（观察 / 动作 / 大脑 / 记忆）。每次启动默认关闭。",
    intro: "打开「启用」后自动启动共享 GameBot REST（默认 http://127.0.0.1:8766），并挂载只含Minecraft的 MCP（工具前缀 mcp__gamebot-minecraft__）。仓库自带、已验证，无需下载：直接打开「启用」（首次会自动准备 Python 环境，约半分钟）。下方是该游戏的全部 GameBot 设置，保存后立即下发到 GameBot；REST 地址 / 目录为所有游戏共享。每次应用启动默认关闭。【双脑警告】不要同时让 DSH 桌面大脑与 GameBot 大脑对同一游戏发动作。",
    keys: ["gamebot-minecraftEnabled", "gamebotUrl", "gamebotRoot", "gb_minecraft_driver", "gb_minecraft_NEOFORGE_WS_URL", "gb_minecraft_NEOFORGE_WS_AUTH_USER", "gb_minecraft_NEOFORGE_WS_AUTH_PASS", "gb_minecraft_MC_USERNAME", "gb_minecraft_MC_VERSION", "gb_minecraft_MC_ARCHIVE", "gb_minecraft_MC_CHAT_FORWARD", "gb_minecraft_MC_USE_TOOLS", "gb_minecraft_MC_CHAT_PREFIX", "gb_minecraft_MC_CHAT_COOLDOWN_MS", "gb_minecraft_MC_MODS_DIR", "gb_minecraft_LLM_ENABLED", "gb_minecraft_LLM_PROVIDER", "gb_minecraft_LLM_PROTOCOL", "gb_minecraft_LLM_BASE_URL", "gb_minecraft_LLM_MODEL", "gb_minecraft_LLM_API_KEY", "gb_minecraft_LLM_DECISION_TIMEOUT_S", "gb_minecraft_LLM_MAX_STEPS", "gb_minecraft_LLM_TEMPERATURE", "gb_minecraft_LLM_TOP_P", "gb_minecraft_LLM_MAX_TOKENS", "gb_minecraft_LLM_REASONING_EFFORT", "gb_minecraft_LLM_THINKING_BUDGET", "gb_minecraft_LLM_PERSONA", "gb_minecraft_CHAT_ENABLED", "gb_minecraft_CHAT_PROVIDER", "gb_minecraft_CHAT_PROTOCOL", "gb_minecraft_CHAT_BASE_URL", "gb_minecraft_CHAT_MODEL", "gb_minecraft_CHAT_API_KEY", "gb_minecraft_CHAT_TEMPERATURE", "gb_minecraft_CHAT_TOP_P", "gb_minecraft_CHAT_MAX_TOKENS", "gb_minecraft_CHAT_REASONING_EFFORT", "gb_minecraft_CHAT_THINKING_BUDGET", "gb_minecraft_CHAT_PERSONA", "gb_minecraft_MEMORY_ENABLED", "gb_minecraft_MEMORY_BLOCK_SIZE", "gb_minecraft_DSH_SESSION"]
  },
  {
    id: "gamebot-civilization", group: "游戏", title: "文明 VI", component: "gamebot-civilization",
    moduleSource: "bundled", icon: ICONS.gamebotCivilization,
    builtin: true,
    desc: "GameBot · 文明 VI：经 civ6-mcp + TRIXCompanion 模组陪玩。每次启动默认关闭。",
    intro: "打开「启用」后自动启动共享 GameBot REST（默认 http://127.0.0.1:8766），并挂载只含文明 VI的 MCP（工具前缀 mcp__gamebot-civilization__）。仓库自带、已验证，无需下载：直接打开「启用」（首次会自动准备 Python 环境，约半分钟）。下方是该游戏的全部 GameBot 设置，保存后立即下发到 GameBot；REST 地址 / 目录为所有游戏共享。每次应用启动默认关闭。【双脑警告】不要同时让 DSH 桌面大脑与 GameBot 大脑对同一游戏发动作。",
    keys: ["gamebot-civilizationEnabled", "gamebotUrl", "gamebotRoot", "gb_civilization_CIV6_MCP_PROJECT", "gb_civilization_CIV6_MODS_DIR", "gb_civilization_CIV_POLL_INTERVAL_S", "gb_civilization_CIV_SAFE_AUTO", "gb_civilization_CIV_DSH_SESSION", "gb_civilization_LLM_ENABLED", "gb_civilization_LLM_PROVIDER", "gb_civilization_LLM_PROTOCOL", "gb_civilization_LLM_BASE_URL", "gb_civilization_LLM_MODEL", "gb_civilization_LLM_API_KEY", "gb_civilization_LLM_DECISION_TIMEOUT_S", "gb_civilization_LLM_MAX_STEPS", "gb_civilization_LLM_TEMPERATURE", "gb_civilization_LLM_TOP_P", "gb_civilization_LLM_MAX_TOKENS", "gb_civilization_LLM_REASONING_EFFORT", "gb_civilization_LLM_THINKING_BUDGET", "gb_civilization_LLM_PERSONA", "gb_civilization_CHAT_ENABLED", "gb_civilization_CHAT_PROVIDER", "gb_civilization_CHAT_PROTOCOL", "gb_civilization_CHAT_BASE_URL", "gb_civilization_CHAT_MODEL", "gb_civilization_CHAT_API_KEY", "gb_civilization_CHAT_TEMPERATURE", "gb_civilization_CHAT_TOP_P", "gb_civilization_CHAT_MAX_TOKENS", "gb_civilization_CHAT_REASONING_EFFORT", "gb_civilization_CHAT_THINKING_BUDGET", "gb_civilization_CHAT_PERSONA", "gb_civilization_MEMORY_ENABLED", "gb_civilization_MEMORY_BLOCK_SIZE", "gb_civilization_DSH_SESSION"]
  },
  {
    id: "gamebot-vision", group: "游戏", title: "视觉兜底", component: "gamebot-vision",
    moduleSource: "bundled", icon: ICONS.gamebotVision,
    builtin: true,
    desc: "GameBot · 视觉桌面驱动：只处理启动器、菜单、设置页。每次启动默认关闭。",
    intro: "打开「启用」后自动启动共享 GameBot REST（默认 http://127.0.0.1:8766），并挂载只含视觉兜底的 MCP（工具前缀 mcp__gamebot-vision__）。仓库自带、已验证，无需下载：直接打开「启用」（首次会自动准备 Python 环境，约半分钟）。下方是该游戏的全部 GameBot 设置，保存后立即下发到 GameBot；REST 地址 / 目录为所有游戏共享。每次应用启动默认关闭。【双脑警告】不要同时让 DSH 桌面大脑与 GameBot 大脑对同一游戏发动作。",
    keys: ["gamebot-visionEnabled", "gamebotUrl", "gamebotRoot", "gb_vision_monitor", "gb_vision_max_px", "gb_vision_settle_s", "gb_vision_evidence_dir"]
  },
  {
    id: "session-controls", group: "通用", title: "会话控制", icon: ICONS.session,
    maturity: "experimental",
    desc: "用户消息下「撤回」、助手操作行「重试」、输入框「暂停」=熔断。",
    intro: "通用会话能力（非 MCP）。撤回在用户消息下方的操作行：确认后在当前页收起该回合及之后的内容。重试在助手回复的复制与分支之间：确认后收起原回复并立刻重新生成。暂停只取消当前回合。只打开着的会话会先恢复到内存，再在当前页完成，不用退出重进。",
    warn: "【实验性】此功能尚未开发完毕。启用后使用撤回 / 重试 / 熔断，可能会对对话造成不可逆的破坏。默认关闭；请仅在明确需要时启用。",
    keys: ["sessionControlsEnabled", "sessionCircuitEnabled", "sessionCircuitMaxSameTool", "sessionCircuitMaxSteps", "sessionCircuitMaxReasoningChars"],
    summary: function (v) {
      if (v.sessionControlsEnabled !== true) return { text: "已关闭 · 实验性", cls: "off" };
      var bits = ["实验性"];
      bits.push(v.sessionCircuitEnabled === false ? "自动熔断关" : "自动熔断开");
      bits.push("同工具×" + (v.sessionCircuitMaxSameTool ?? 6));
      bits.push("步数≤" + (v.sessionCircuitMaxSteps ?? 80));
      return { text: bits.join(" · "), cls: "ready" };
    }
  },

  {
    id: "uv", group: "通用", title: "uv", component: "uv", icon: ICONS.uv,
    url: "https://github.com/astral-sh/uv",
    desc: "下载 Python、安装和运行 Python 组件的工具（Office / Blender / Unity / Godot / Windows / ComfyUI / FFmpeg）。",
    intro: "uv 负责下载 Python 并安装 Office / Blender / Unity / Godot / Windows / ComfyUI / FFmpeg；安装这些组件时将自动下载 uv。组件、Python 与缓存均存放在插件数据目录的 tools 中。",
    keys: ["uvPath"]
  },
  {
    id: "node", group: "通用", title: "Node.js", component: "node", icon: ICONS.node,
    url: "https://nodejs.org/",
    desc: "运行和安装 Chrome / Figma / Photoshop / Notion / Cloudflare / Obsidian 等依赖 npm 的组件。",
    intro: "Chrome / Figma / Photoshop / Notion / Cloudflare（mcp-remote 桥）/ Obsidian 依赖 npm。可使用插件托管的 Node.js 或本机 Node.js（20.19+ / 22.12+，含 npm）。查找顺序：插件托管 → 设置路径 → 系统 PATH。",
    keys: ["nodePath", "npmRegistry"]
  },
  {
    id: "proxy", group: "通用", title: "下载代理", icon: ICONS.proxy,
    desc: "下载安装 uv、Python、Node.js 和各组件时使用的 HTTP 代理。",
    intro: "仅用于「下载安装」，不影响组件运行。保存后再安装。",
    keys: ["proxy"],
    summary: function (v) {
      return v.proxy
        ? { text: "已设置", cls: "on", title: v.proxy }
        : { text: "未设置", cls: "off", title: "使用环境变量 HTTPS_PROXY / HTTP_PROXY" };
    }
  },
  {
    id: "add-component", group: "基础工具", title: "添加工作组件", icon: ICONS.addComponent,
    kind: "add-component",
    desc: "生成提示词，让 AI 在 local-components/ 写本地兼容模块；完成后可在管理页提交 PR。",
    intro: "填写要接入的程序名称，复制下方命令粘贴给 AI。AI 按 docs/component-module.md 在 local-components/<id>/ 写本地兼容模块（与仓库自带同接口）；不会下载进 tools/。写好后出现在「本地」分组，可在管理页「提交 PR」贡献到仓库。",
    keys: [],
    summary: function () {
      return { text: "提示词工具", cls: "ready" };
    }
  }
];


// 上游仓库外链：标题旁蓝色网址文字，新标签打开（rel=noopener）。无 url 的功能（媒体卡片 / 下载代理）不渲染。
function extLinkLabel(url) {
  try {
    var u = new URL(url);
    var host = (u.hostname || "").replace(/^www\./, "");
    var path = (u.pathname || "/").replace(/\/+$/, "") || "";
    if (!host) return url;
    if (!path || path === "/") return host;
    var label = host + path;
    if (u.search) label += u.search;
    if (label.length > 42) label = label.slice(0, 39) + "\u2026";
    return label;
  } catch (e) {
    return url.length > 42 ? url.slice(0, 39) + "\u2026" : url;
  }
}
function extLink(f) {
  if (!f || !f.url) return null;
  var a = document.createElement("a");
  a.className = "mm-ext";
  a.href = f.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = "打开上游：" + f.url;
  a.setAttribute("aria-label", "打开上游仓库（新标签）：" + extLinkLabel(f.url));
  a.textContent = extLinkLabel(f.url);
  a.addEventListener("click", function (e) { e.stopPropagation(); });
  a.addEventListener("keydown", function (e) { e.stopPropagation(); });
  return a;
}
function titleName(f, cls) {
  var wrap = el("div", cls || "mm-item-name");
  wrap.append(document.createTextNode(f.title));
  var link = extLink(f);
  if (link) wrap.append(link);
  return wrap;
}

var MODULE_SOURCE_TEXT = { bundled: "已验证", local: "本地" };
var CONTRIBUTE_COMPARE_DEFAULT = "https://github.com/meya-ashuripehya/dsh-work-components/compare";

function sourceChip(src) {
  var kind = src === "local" ? "local" : "bundled";
  var span = el("span", "mm-src " + kind, MODULE_SOURCE_TEXT[kind] || kind);
  span.title = kind === "local"
    ? "用户/AI 写在 local-components/ 的本地兼容组件，可提交 PR"
    : "随 git 仓库分发的已兼容组件";
  return span;
}

function maturityChip(kind) {
  if (kind !== "experimental") return null;
  var span = el("span", "mm-src experimental", "实验性");
  span.title = "尚未开发完毕；启用后可能对对话造成不可逆破坏";
  return span;
}

function titleNameWithSource(f, cls) {
  var wrap = titleName(f, cls);
  if (f.moduleSource === "bundled" || f.moduleSource === "local") wrap.append(sourceChip(f.moduleSource));
  var m = maturityChip(f.maturity);
  if (m) wrap.append(m);
  return wrap;
}


// 应用图标节点：只装 FEATURES 里的静态 SVG 常量；装饰性，读屏跳过。
function iconEl(f) {
  var span = el("span", "mm-ico");
  span.setAttribute("aria-hidden", "true");
  if (f.icon) span.innerHTML = f.icon;
  return span;
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// init 原样透传给 fetch（含可选的 signal，用于中止请求）。
function fetchJson(path, init) {
  return fetch(API + path, Object.assign({ headers: { "content-type": "application/json" } }, init || {}))
    .then(function (r) { return r.json(); });
}

// 基础工具「添加工作组件」：Token 声明 + 作者实测参考（非通用上限）。
var ADD_COMPONENT_TOKEN_WARN =
  "注意：不同的 Coding Agent、不同模型在处理时所用的 Token 量与成本都不同。请确认后再复制。\n\n" +
  "以作者使用 Deepseek Harness 作为 Coding Agent，模型使用 DeepSeek-V41-Flash、思考强度 Low，添加 Docker 组件时，Token 用量信息如下：\n" +
  "· 本轮用量：1,572,371 tok\n" +
  "· 提供方 / 模型：deepseek-official/deepseek-flash\n" +
  "· 缓存命中：98.9%\n" +
  "· 未缓存输入：17,855 tok\n" +
  "· 缓存读取：1,542,144 tok\n" +
  "· 输出：12,372 tok（其中推理 6,349 tok）";

function buildAddComponentPrompt(programName) {
  var name = String(programName || "").trim();
  return [
    "请按下列步骤，为程序「" + name + "」设计并接入 dsh-workbench（本插件仓库：meya-ashuripehya/dsh-work-components，设置页「工作组件」）：",
    "",
    "1. 先确认 / 核实「" + name + "」：它是什么软件、主要运行平台（Windows / macOS / Linux）、是否暴露自动化能力（COM、HTTP API、CLI、官方/社区插件、MCP server 等）。用简短结论说明是否适合做成工作组件。",
    "",
    "2. 搜索可用于「" + name + "」的 MCP server 或其他自动化工具（GitHub / npm / PyPI / 官方文档），列出可选方案并简要对比（能力范围、协议、维护状态、许可证）。**选型优先：功能最全优先**，其次再看维护状态与许可证。",
    "",
    "3. 选定上游后，写成**本地兼容组件**（不要直接改仓库自带清单）。下列约定已内嵌，按此实现即可，**不要**再打开 docs/ 或其他源码文件（省 token）：",
    "",
    "### 落盘位置",
    "- 只创建：`<本地组件目录>/<id>/index.mjs`。本地组件目录 = 插件 `GET /dsh-workbench/api/components` 返回的 `localComponentsDir`（默认 `~/.dsh/data/dsh-work-components/local-components/`；开发检出里可能仍是仓库根下的 `local-components/`）。不要写进插件安装目录。",
    "- `<id>`：小写 kebab，须匹配 `^[a-z][a-z0-9-]*$`；文件夹名、`export const id`、`component.id` 三者必须相同。现有风格如 `office` / `chrome` / `blender`，本地也可用 `demo-local` 这类带连字符的 id。",
    "- **不要**占用已有 bundled id：`office` / `blender` / `unity` / `figma` / `photoshop` / `chrome` / `godot`。",
    "- **不要**把文件写进 `src/components/`（那是仓库自带；合入仓库时才拷过去）。",
    "- 宿主原语统一从 `dsh-work-components/sdk` 导入（勿整份复制；加载进程会把它映射到插件自带的 SDK）：",
    "  - shared：`stdio` / `http` / `npmLaunch` / `installNpmTool` / `OFF` / `NOT_INSTALLED` / `resolveUv` / `resolveUvx` 等",
    "  - connect-lib：`appRunning` / `result` / `noAppFor` / `mcpNotReady` / `callMcpTool` / `toolFailed` 等",
    "  - tools：如 `installVenvTool` / `installOffice`，按需",
    "  - 例：`import { stdio, OFF, appRunning, noAppFor, result } from 'dsh-work-components/sdk'`",
    "",
    "### 必须导出（与 chrome / office 同约定；示例已内嵌）",
    "",
    "**(a) `export const id`** — 字符串，与文件夹名相同。例：`export const id = 'chrome'`。",
    "",
    "**(b) `export const meta`** — `{ id, title, group, url?, serverName, summary }`。",
    "- chrome 例：`{ id: 'chrome', title: 'Chrome', group: '工作组件', url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp', serverName: 'chrome', summary: '控制本机的 Google Chrome（Chrome DevTools MCP）：网页操作、截图快照…' }`。",
    "- office 例：`{ id: 'office', title: 'Office', group: '工作组件', url: 'https://github.com/officemcp/officemcp', serverName: 'officemcp', summary: '经 COM 控制本机的 Word / Excel / PowerPoint（OfficeMCP）。' }`。",
    "- `serverName` 决定工具前缀 `mcp__<serverName>__`，选定后勿改。",
    "- 启用键约定为 `<id>Enabled`（如 `chromeEnabled` / `officeEnabled`）：manager 读取配置键 = id 拼接 Enabled；**新鲜安装 / 缺键时默认关闭**（不自动挂 MCP）。",
    "- **launch 关闭判断**：写 `if (!cfg.<id>Enabled) return OFF`（或 `cfg.<id>Enabled !== true` / `{ ok:false, reason:'已在设置中停用' }`）。仅显式 `true` 才挂载；缺键 / false 都关闭。宿主 `RuntimeSettingsSchema` 会为本地组件补上 `<id>Enabled` 默认 `false`。",
    "",
    "**(c) `export const app`** — `{ name, exe, match }`，供进程探测「已连接」。",
    "- chrome：`{ name: 'Chrome', exe: 'chrome.exe', match: /^(chrome|google chrome( beta| dev| canary)?)$/ }`。",
    "- office：`{ name: 'Office（Word / Excel / PowerPoint 等）', exe: 'WINWORD / EXCEL / POWERPNT', match: /^(winword|excel|powerpnt|visio|msaccess|winproj|outlook|mspub|onenote|wps|et|wpp|microsoft (word|excel|powerpoint))$/ }`。",
    "- `match` 对着 `listProcesses()` 返回的**小写、已去掉 .exe** 的进程名。",
    "",
    "**(d) `export async function probe(ctx)`** — 只读探测，**不要**在探测里拉起目标程序。",
    "- `ctx`：`{ cfg, tools, env, procs }`；函数内 `this` 绑定为 component。",
    "- 高层流程（常见桌面应用）：`const procs = await ctx.procs()` → 若 `!appRunning(procs, app)` 则 `return noAppFor(app)` → `const nr = mcpNotReady(ctx, this); if (nr) return nr` → 再用 TCP / HTTP / `callMcpTool` 确认可达。",
    "- **例外（守护进程 / 远程 / WSL / 无头）**：进程名可能对不上 Desktop，但仍可达时——先 `mcpNotReady` + 工具/端口探测；工具成功即可 `connected`（文案可写「未见 Desktop 进程」）；仅当工具失败且也没有匹配进程时才 `noAppFor`。",
    "- 返回形状：`{ state, detail, via }`；`state` ∈ `connected` | `no-app` | `unreachable` | `mcp-down` | `checking`。",
    "- 助手：`result(state, detail, via)`、`noAppFor(app)`、`toolFailed(r, detail, via)`（均来自 connect-lib）。",
    "- blender 简例：进程在跑后检查插件端口 `tcpOpen('127.0.0.1', 9876)`，通则 `result('connected', '…', 'socket')`，不通则 `result('unreachable', '…', 'socket')`。",
    "- office 简例：进程在跑且 MCP 就绪后 `callMcpTool(ctx.tools, this.serverName, 'RunningApps')`，解析结果后 `result('connected', 'COM 可连接：…', 'tool:RunningApps')`。",
    "",
    "**(e) `export const component` + `export default component`** — 注册给宿主的对象，至少包含：",
    "- `id` / `label` / `url?` / `serverName` / `summary`（与 meta 对齐）。",
    "- `keys: string[]`：变更后需重挂的设置键，通常含 `<id>Enabled`、包名键等。chrome 例：`['chromeEnabled','chromePackage','chromeConnect','chromeBrowserUrl','chromeChannel','chromeHeadless','chromeUserDataDir','chromeToolset','nodePath']`；office 例：`['officeEnabled','officeRepo','officeFolder','uvPath']`。",
    "- `runtime?: 'node'`：npm 包组件设为 `'node'`；缺省按 Python/uv。",
    "- `spec?(cfg)=>string`：包名，如 `(cfg) => cfg.chromePackage || 'chrome-devtools-mcp'` 或 `(cfg) => cfg.blenderPackage || 'mcp-for-blender'`。",
    "- `bin?` / `installArgs?`：按上游需要。",
    "- `installed(cfg)=>boolean`：是否已落到运行时目录 `tools/<id>/`（可用 shared 的 `managedNpmEntry` / `managedEntry` 等）。",
    "- 启动门控：有 `install` 的组件在 `installed(cfg)` 为真且没有进行中的安装任务之前不会启动，启用开关也会被禁用（提示「安装完成后可启动」）。本地组件同样适用。",
    "- `install?(cfg, task, hooks)`：设置页「下载安装」会调它；可委托 `installNpmTool(this, cfg, task, hooks)` 或 `installVenvTool(...)` / 专用安装器。**写好即可，本任务不要执行下载。**",
    "- `launch(cfg)` → LaunchPlan：成功 `{ ok:true, source, config, runtime?, via?, viaUvx? }`；失败 `{ ok:false, reason, missing? }`。关闭时返回 `OFF` 或 `{ ok:false, reason:'已在设置中停用' }`（`!cfg.<id>Enabled` / 缺键 / false 均关闭；仅 `true` 启用）。`config` 一般用 `stdio(serverName, command, args, opts)` 或 `npmLaunch` / `http`。",
    "- 可选：`note(cfg)`、`beforeRemove(log?)`、`installAddon(cfg, project, opts?)`（如 Godot 装插件到项目）。",
    "",
    "### MCP 包落地位置（重要）",
    "- 下载安装的产物只应落在运行时目录 **`tools/<id>/`**（插件数据目录下，默认 `~/.dsh/data/dsh-work-components/tools/`；用 SDK 的 `toolsDir()` 取路径）。",
    "- **只有**用户在设置页点击「下载安装」时，宿主才会调用 `component.install` 写入该目录。",
    "- **本 AI 任务禁止**自动下载 / 解压 / `npm install` / `uv` / 联网装包进 `tools/`；只添加模块 + 安装元数据（`spec` / `installed` / `install` / `launch`），以便设置页稍后下载。",
    "",
    "### 注册表（本地 = drop-in 发现）",
    "- **本地**：启动时 `registry.mjs` 扫描 `<本地组件目录>/*/index.mjs` 并在隔离子进程里动态 `import()`，与 bundled 合并；**不必**编辑 `registry.mjs`。",
    "- 与 bundled **同 id** 时 bundled 优先，本地副本被忽略并 warn。",
    "- **bundled**（本次不要做）：才需要在 `registry.mjs` 加静态 import，并改 `SettingsSchema` / `lib/client.js` 的 FEATURES / ICONS / INPUT_FIELDS。",
    "",
    "### 设置页 UI（本地还要不要手同步）",
    "- 详情页在 `/components` 拉取后，对 `moduleSource === 'local'` **自动**补齐「本地组件」条目（`ensureLocalFeature`）：标题用 `label`、简介用 `summary`、图标用通用「添加」图标。",
    "- 后端暴露后**不必**再改 `FEATURES` / `ICONS` / `INPUT_FIELDS` 也能在列表和详情页露脸（含状态、连接、本地下载安装、卸载）。",
    "- **详情页已有「启用」开关**（与 bundled 相同，安装行右侧 `role=switch`）：键名 `<id>Enabled`，经 settings 持久化；**缺省关闭**（仅显式 `true` 启用，与 launch / manager 一致）。",
    "- AI **可以/应该**为组件增加可配置或必填参数（如 host、package、path、token 占位等），并给出清晰的中文 label / 帮助文案；**优先补上有用参数，而不是省略**。本地阶段：在 `keys` 中声明，并在 `launch()` / `spec()` 里硬编码默认值；每个参数在模块注释与 `meta.summary` / `note` 中说明。若这些参数也需要 UI 字段，在注释中写出拟议的 `SettingsSchema` / `INPUT_FIELDS` 形状（含中文 label / desc），供后续 PR；在此之前详情页**不会**渲染这些 `keys` 输入，只有状态、启用开关、本地下载安装、贡献。",
    "- **未进 schema 的自定义键**（除已由 API 合并保留的本地 `*Enabled` 外）不会进持久化 `cfg`；本地仍按上条在 `spec()` / `launch()` 硬编码默认（如 `cfg.xxxPackage || 'upstream-pkg'`，可选路径 `String(cfg.xxx || '').trim()`）——此时无法在 UI 修改。`keys` + 模块注释 + 拟议 schema 形状保留，进仓库时再补 schema / INPUT_FIELDS。",
    "- 本提示词**不要** commit / push / 开 PR。",
    "",
    "4. 模块就位后，用户可在设置页「本地」分组看到它；用户可重启 DSH 后下载。",
    "",
    "请从第 1 步开始执行，并在关键结论后再改代码。程序名称：" + name + "。"
  ].join("\n");
}
function copyTextToClipboard(text) {
  function fallback() {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
  }
  return Promise.resolve(fallback());
}

function renderSettingsPage() {
  var page = el("div", "mm-page");
  var style = document.createElement("style");
  style.textContent = STYLES;
  page.append(style);

  var inputs = {};
  var statusLines = {}; // 组件 id -> 管理页里的状态行
  var connLines = {}; // 组件 id -> 管理页里的连接行（工作组件 / 游戏）
  var installUis = {}; // 组件 id -> 管理页里的安装按钮 / 日志
  var badges = {}; // 功能 id -> [列表里的状态徽标, 管理页标题旁的状态徽标]
  var rows = {}; // 功能 id -> 列表行
  var details = {}; // 功能 id -> { view, back, save, msg }
  var toggles = {}; // 设置 key -> 「启用」旋钮 { key, btn, msg, saving }
  // 启动门控：组件「启用」key -> 服务端给出的 launchBlocked（null = 可启动）。读到 /components 之前组件旋钮保持禁用。
  var launchGate = {};
  var gateMissing = {}; // 组件「启用」key -> 门控原因是「未安装」（旋钮显示为关闭）；重新安装期间保持原显示
  var actions = {}; // 组件 id -> 字段旁的动作按钮 { key, btn, msg, path, busy, ready }（如 Godot「安装插件到项目」）
  var currentView = null; // 当前打开的管理页（功能 id）；null 为列表。只记在本页实例里。
  var lastValue = null; // 最近一次从宿主读到 / 保存后的完整设置
  var byComponent = {};
  FEATURES.forEach(function (f) { if (f.component) byComponent[f.component] = f; });
  var localGroupEl = null; // 「本地兼容」分组标题（动态）
  var localListEl = null;  // 本地组件列表容器
  var compareUrlCached = CONTRIBUTE_COMPARE_DEFAULT;

  // ── 列表（首页）──
  var listView = el("div", "mm-view mm-home");
  listView.append(el("h3", undefined, "工作组件（dsh-workbench）"));
  listView.append(el("p", "mm-sub", "点击一项进入它的管理页：开关、配置、运行状态和下载安装。保存后只重新挂载改动过的组件。"));
  var sub = el("p", "mm-sub", "正在读取设置…");
  listView.append(sub);
  page.append(listView);

  var lastGroup = null;
  var list = null;
  FEATURES.forEach(function (f) {
    if (f.group !== lastGroup) {
      lastGroup = f.group;
      listView.append(el("div", "mm-group", f.group));
      list = el("div", "mm-list");
      list.setAttribute("role", "list");
      listView.append(list);
    }
    var item = el("div", "mm-item");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.setAttribute("data-feature", f.id);
    var main = el("div", "mm-item-main");
    main.append(titleNameWithSource(f, "mm-item-name"), el("div", "mm-item-desc", f.desc));
    var badge = el("span", "mm-badge off", "读取中…");
    var chev = el("span", "mm-chev", "›");
    chev.setAttribute("aria-hidden", "true");
    item.append(iconEl(f), main, badge, chev);
    item.addEventListener("click", function () { openDetail(f.id); });
    item.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        openDetail(f.id);
      }
    });
    rows[f.id] = item;
    badges[f.id] = [badge];
    list.append(item);
  });


  function openCompareUrl(url) {
    var u = url || compareUrlCached || CONTRIBUTE_COMPARE_DEFAULT;
    try { window.open(u, "_blank", "noopener,noreferrer"); } catch (e) { /* ignore */ }
  }

  function buildContributePanel(f) {
    var box = el("div", "mm-pr");
    box.setAttribute("data-contribute", f.component || f.id);
    box.append(el("h4", undefined, "贡献到仓库"));
    box.append(el("p", undefined, "安全默认：复制 PR 清单与命令到剪贴板，并打开 GitHub compare。不会自动 commit / push / force-push；只有你在本机确认后才应手动跑 git/gh。"));
    var row = el("div", "mm-pr-row");
    var copyBtn = el("button", "mm-btn", "提交 PR（复制清单）");
    copyBtn.type = "button";
    var openBtn = el("button", "mm-btn mm-ghost", "贡献到仓库（Compare）");
    openBtn.type = "button";
    var msg = el("span", "mm-msg");
    row.append(copyBtn, openBtn, msg);
    var pre = el("pre");
    pre.hidden = true;
    box.append(row, pre);
    var lastInfo = null;
    function fillPre(text) {
      pre.textContent = text || "";
      pre.hidden = !text;
    }
    copyBtn.addEventListener("click", function () {
      if (disposed) return;
      copyBtn.disabled = true;
      msg.textContent = "生成清单…";
      msg.className = "mm-msg";
      pageFetch("/components/" + encodeURIComponent(f.component || f.id) + "/contribute").then(function (d) {
        if (disposed) return;
        if (!d || !d.ok) throw new Error((d && d.error) || "无法生成贡献说明");
        lastInfo = d;
        if (d.compareUrl) compareUrlCached = d.compareUrl;
        fillPre(d.checklist || "");
        return copyTextToClipboard(d.checklist || "");
      }).then(function (ok) {
        if (disposed) return;
        msg.textContent = ok ? "已复制清单（含命令模板）" : "复制失败，请从下方全文手动复制";
        msg.className = ok ? "mm-msg ok" : "mm-msg err";
      }).catch(function (e) {
        if (disposed || isAbort(e)) return;
        msg.textContent = e.message || String(e);
        msg.className = "mm-msg err";
      }).finally(function () {
        if (disposed) return;
        copyBtn.disabled = false;
      });
    });
    openBtn.addEventListener("click", function () {
      if (disposed) return;
      var url = (lastInfo && lastInfo.compareUrl) || compareUrlCached || CONTRIBUTE_COMPARE_DEFAULT;
      // 二次确认：仅打开浏览器，不执行 git
      scConfirm("打开 GitHub Compare 页面？", {
        title: "打开 GitHub Compare 页面",
        body: "仅在浏览器中打开以下页面，不会在本机执行 git push 或 gh pr create。\n" + url,
        okText: "打开页面",
        cancelText: "不打开"
      }).then(function (ok) {
        if (!ok || disposed) return;
        openCompareUrl(url);
        msg.textContent = "已尝试打开浏览器";
        msg.className = "mm-msg ok";
      });
    });
    return box;
  }

  function ensureLocalGroup() {
    if (localListEl) return localListEl;
    localGroupEl = el("div", "mm-group", "本地兼容");
    localGroupEl.title = "来自 local-components/ 的用户本地模块（可提交 PR）";
    localListEl = el("div", "mm-list");
    localListEl.setAttribute("role", "list");
    // 插在「工作组件」之后、「通用」之前：找到第一个 group===通用 的行，插到其 group 标题前
    var general = null;
    FEATURES.forEach(function (f) {
      if (!general && f.group === "通用" && rows[f.id]) general = rows[f.id].parentNode && rows[f.id].parentNode.previousSibling;
    });
    // fallback：追加在列表视图末尾（返回按钮区域之前）
    var anchorNode = null;
    FEATURES.some(function (f) {
      if (f.group === "通用" && rows[f.id]) {
        // group title is previous sibling of the list containing the row
        var list = rows[f.id].parentNode;
        anchorNode = list && list.previousSibling; // mm-group 通用
        return true;
      }
      return false;
    });
    if (anchorNode && anchorNode.parentNode === listView) {
      listView.insertBefore(localGroupEl, anchorNode);
      listView.insertBefore(localListEl, anchorNode);
    } else {
      listView.append(localGroupEl, localListEl);
    }
    return localListEl;
  }

  function buildLocalDetail(f) {
    var view = el("div", "mm-view mm-detail");
    view.hidden = true;
    view.setAttribute("data-feature", f.id);
    view.setAttribute("role", "region");
    view.setAttribute("aria-label", f.title);
    var head = el("div", "mm-dhead");
    var back = el("button", "mm-btn mm-ghost mm-back", "‹ 返回");
    back.type = "button";
    back.title = "返回功能列表（Esc）";
    back.addEventListener("click", showList);
    var hbadge = el("span", "mm-badge off", "读取中…");
    var title = el("h3");
    title.append(iconEl(f), el("span", "mm-dtitle", f.title));
    var _ext = extLink(f);
    if (_ext) title.append(_ext);
    title.append(sourceChip("local"));
    head.append(back, title, hbadge);
    badges[f.id] = badges[f.id] || [];
    badges[f.id].push(hbadge);
    view.append(head, buildIntro(f));
    statusLines[f.component] = el("div", "mm-status off", "状态读取中…");
    view.append(statusLines[f.component]);
    var cl = connLines[f.component] = el("div", "mm-conn");
    cl.hidden = true;
    cl.setAttribute("aria-live", "polite");
    view.append(cl);
    var ui = buildInstallUi(f.component);
    installUis[f.component] = ui;
    // Enable switch: same as bundled work components — right side of install row; persist via settings <id>Enabled.
    var enabledField = ensureLocalEnabledField(f.component);
    if (!f.keys || !f.keys.length) f.keys = [enabledField.key];
    var tg = buildToggle(enabledField);
    ui.row.insertBefore(tg.wrap, ui.state);
    view.append(ui.row, tg.note, ui.cnote, ui.details);
    // /components often arrives after /settings: sync switch from lastValue (default OFF) and unlock.
    if (lastValue) {
      var _hasEn = Object.prototype.hasOwnProperty.call(lastValue, enabledField.key);
      setSwitch(enabledField.key, _hasEn ? !!lastValue[enabledField.key] : true);
      applyToggle(enabledField.key);
    }
    view.append(buildContributePanel(f));
    var foot = el("div", "mm-row");
    var msg = el("span", "mm-msg");
    foot.append(msg);
    view.append(foot);
    details[f.id] = { view: view, back: back, save: null, msg: msg };
    page.append(view);
  }

  function ensureLocalFeature(c) {
    if (!c || c.kind === "prerequisite") return;
    if (c.moduleSource !== "local") return;
    if (byComponent[c.id]) return;
    var f = {
      id: c.id,
      group: "本地兼容",
      title: c.label || c.id,
      component: c.id,
      moduleSource: "local",
      icon: ICONS.addComponent,
      url: c.url || null,
      desc: c.summary || "本地兼容组件（local-components/" + c.id + "）",
      intro: (c.summary || "") + " 来源：本地目录 local-components/" + c.id + "/。可用下方「贡献到仓库」生成 PR 清单。",
      keys: [c.id + "Enabled"]
    };
    ensureLocalEnabledField(c.id);
    FEATURES.push(f);
    byComponent[c.id] = f;
    var list = ensureLocalGroup();
    var item = el("div", "mm-item");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.setAttribute("data-feature", f.id);
    var main = el("div", "mm-item-main");
    main.append(titleNameWithSource(f, "mm-item-name"), el("div", "mm-item-desc", f.desc));
    var badge = el("span", "mm-badge off", "读取中…");
    var chev = el("span", "mm-chev", "›");
    chev.setAttribute("aria-hidden", "true");
    item.append(iconEl(f), main, badge, chev);
    item.addEventListener("click", function () { openDetail(f.id); });
    item.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        openDetail(f.id);
      }
    });
    rows[f.id] = item;
    badges[f.id] = [badge];
    list.append(item);
    buildLocalDetail(f);
  }

  function syncLocalFromComponents(components, meta) {
    if (meta && meta.contributeCompareUrl) compareUrlCached = meta.contributeCompareUrl;
    (components || []).forEach(ensureLocalFeature);
  }


  // ── 各功能的管理页（一次建好，切换时只改 hidden；轮询不管在哪一页都更新这里）──
  FEATURES.forEach(function (f) {
    var view = el("div", "mm-view mm-detail");
    view.hidden = true;
    view.setAttribute("data-feature", f.id);
    view.setAttribute("role", "region");
    view.setAttribute("aria-label", f.title);
    var head = el("div", "mm-dhead");
    var back = el("button", "mm-btn mm-ghost mm-back", "‹ 返回");
    back.type = "button";
    back.title = "返回功能列表（Esc）";
    back.addEventListener("click", showList);
    var hbadge = el("span", "mm-badge off", "读取中…");
    var title = el("h3");
    title.append(iconEl(f), el("span", "mm-dtitle", f.title));
    var _ext = extLink(f);
    if (_ext) title.append(_ext);
    if (f.moduleSource === "bundled" || f.moduleSource === "local") title.append(sourceChip(f.moduleSource));
    var _mat = maturityChip(f.maturity);
    if (_mat) title.append(_mat);
    head.append(back, title, hbadge);
    badges[f.id].push(hbadge);
    view.append(head, buildIntro(f));
    if (f.warn) {
      var fwarn = el("div", "mm-warn", f.warn);
      fwarn.setAttribute("role", "note");
      view.append(fwarn);
    }
    // 基础工具「添加工作组件」：警告 + 程序名称 + 复制命令（无设置字段 / 保存）
    if (f.kind === "add-component") {
      var warn = el("div", "mm-warn", ADD_COMPONENT_TOKEN_WARN);
      warn.setAttribute("role", "note");
      var nameField = el("div", "mm-field");
      var nameLab = el("label", undefined, "程序名称");
      nameLab.setAttribute("for", "mm-add-component-name");
      var nameDesc = el("div", "mm-desc", "要接入的软件名，例如 Blender、Notion、After Effects。");
      var nameInput = el("input", "mm-input");
      nameInput.type = "text";
      nameInput.id = "mm-add-component-name";
      nameInput.placeholder = "例如 Notion";
      nameInput.autocomplete = "off";
      nameField.append(nameLab, nameDesc, nameInput);
      var crow = el("div", "mm-copy-row");
      var copyBtn = el("button", "mm-btn", "复制命令");
      copyBtn.type = "button";
      copyBtn.disabled = true;
      var cmsg = el("span", "mm-msg");
      crow.append(copyBtn, cmsg);
      view.append(warn, nameField, crow);
      function syncCopyEnabled() {
        if (disposed) return;
        copyBtn.disabled = !String(nameInput.value || "").trim();
      }
      nameInput.addEventListener("input", syncCopyEnabled);
      nameInput.addEventListener("change", syncCopyEnabled);
      copyBtn.addEventListener("click", function () {
        if (disposed) return;
        var name = String(nameInput.value || "").trim();
        if (!name) {
          cmsg.textContent = "请先填写程序名称";
          cmsg.className = "mm-msg err";
          copyBtn.disabled = true;
          return;
        }
        copyBtn.disabled = true;
        cmsg.textContent = "复制中…";
        cmsg.className = "mm-msg";
        copyTextToClipboard(buildAddComponentPrompt(name)).then(function (ok) {
          if (disposed) return;
          if (ok) {
            cmsg.textContent = "已复制到剪贴板";
            cmsg.className = "mm-msg ok";
          } else {
            cmsg.textContent = "复制失败，请手动全选提示词";
            cmsg.className = "mm-msg err";
          }
        }).finally(function () {
          if (disposed) return;
          syncCopyEnabled();
        });
      });
      details[f.id] = { view: view, back: back, save: null, msg: cmsg };
      page.append(view);
      return;
    }
    var ui = null;
    if (f.component) {
      statusLines[f.component] = el("div", "mm-status off", "状态读取中…");
      view.append(statusLines[f.component]);
      if (f.group === "工作组件" || f.group === "游戏") {
        var cl = connLines[f.component] = el("div", "mm-conn");
        cl.hidden = true;
        cl.setAttribute("aria-live", "polite");
        view.append(cl);
      }
      // 仓库自带的已验证组件（builtin）没有「下载安装」：环境由组件自己准备。
      if (!f.builtin) {
        ui = installUis[f.component] = buildInstallUi(f.component);
        view.append(ui.row);
      }
    }
    // 「启用」旋钮：放进安装按钮那一行（安装步骤之前，靠右）；说明文字放在这一行下面。
    f.keys.forEach(function (k) {
      if (FIELD_BY_KEY[k].type !== "switch") return;
      var tg = buildToggle(FIELD_BY_KEY[k]);
      if (ui) ui.row.insertBefore(tg.wrap, ui.state);
      else {
        var trow = el("div", "mm-install");
        trow.append(tg.wrap);
        view.append(trow);
      }
      view.append(tg.note);
    });
    if (ui) view.append(ui.cnote, ui.details);
    f.keys.forEach(function (k) { if (FIELD_BY_KEY[k].type !== "switch") view.append(buildField(FIELD_BY_KEY[k])); });
    var srow = el("div", "mm-row");
    var save = el("button", "mm-btn", "保存");
    save.type = "button";
    save.disabled = true; // 设置读到之前不能保存，免得用空值覆盖
    var msg = el("span", "mm-msg");
    srow.append(save, msg);
    view.append(srow);
    details[f.id] = { view: view, back: back, save: save, msg: msg };
    save.addEventListener("click", function () { saveFeature(f); });
    page.append(view);
  });

  function buildIntro(f) {
    return el("p", "mm-sub", f.intro || "");
  }

  // 「启用」旋钮：设置读到之前禁用；拨动后立即保存（见 toggleSetting）。
  function buildToggle(f) {
    var wrap = el("div", "mm-toggle");
    var msg = el("span", "mm-tmsg");
    msg.setAttribute("aria-live", "polite");
    var btn = el("button", "mm-switch");
    btn.type = "button";
    btn.id = "mm-sw-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-checked", "false");
    btn.disabled = true;
    btn.title = f.desc;
    var label = el("label", undefined, f.label);
    label.htmlFor = btn.id;
    var note = el("div", "mm-note", f.desc);
    note.id = btn.id + "-note";
    btn.setAttribute("aria-describedby", note.id);
    wrap.append(msg, label, btn);
    // stored：设置里保存的值；旋钮显示的状态由 applyToggle 按 stored 与启动门控决定。
    var t = { key: f.key, btn: btn, msg: msg, wrap: wrap, desc: f.desc || "", saving: false, hinted: false, stored: false };
    toggles[f.key] = t;
    btn.addEventListener("click", function () { toggleSetting(t); });
    return { wrap: wrap, note: note };
  }
  function setSwitch(k, on) {
    var t = toggles[k];
    if (!t || t.saving) return; // 正在保存的旋钮由保存结果决定
    t.stored = !!on;
    applyToggle(k);
  }

  // 组件的「启用」旋钮（key 为 <组件 id>Enabled）受启动门控约束；其他开关（如会话控制）不受影响。
  function isComponentToggle(k) {
    return /Enabled$/.test(k) && !!byComponent[k.slice(0, -7)];
  }
  // 按设置读取状态、保存状态和启动门控刷新旋钮：未安装 / 正在安装时旋钮显示为关闭且不可操作，并提示「安装完成后可启动」。
  // 设置里保存的「已启用」（如从旧版本迁移来的）不会让未安装的组件启动；安装完成后按保存的设置启动。
  function applyToggle(k) {
    var t = toggles[k];
    if (!t) return;
    var gated = isComponentToggle(k);
    var known = !gated || Object.prototype.hasOwnProperty.call(launchGate, k);
    var reason = gated && known ? launchGate[k] || null : null;
    var blocked = !!reason;
    var on = !!t.stored && (t.saving || !(blocked && gateMissing[k]));
    t.btn.setAttribute("aria-checked", on ? "true" : "false");
    var disabled = !lastValue || t.saving || !known || blocked;
    t.btn.disabled = disabled;
    t.btn.setAttribute("aria-disabled", disabled ? "true" : "false");
    var tip = reason || t.desc;
    t.btn.title = tip;
    if (t.wrap) t.wrap.title = reason ? tip : "";
    if (t.saving) return;
    if (blocked && (t.hinted || t.msg.className.indexOf("err") < 0)) {
      t.msg.textContent = "安装完成后可启动";
      t.msg.className = "mm-tmsg";
      t.hinted = true;
    } else if (t.hinted) {
      t.msg.textContent = "";
      t.hinted = false;
    }
  }

  function buildField(f) {
    var wrap = el("div", "mm-field");
    var label = el("label", undefined, f.label);
    var input;
    if (f.type === "select") {
      input = el("select", "mm-input");
      // 选项可以是字符串（值即文字），也可以是 { value, label }。
      f.options.forEach(function (o) {
        var value = typeof o === "string" ? o : o.value;
        var opt = el("option", undefined, typeof o === "string" ? o : o.label);
        opt.value = value;
        input.append(opt);
      });
    } else if (f.type === "textarea") {
      input = el("textarea", "mm-input");
      input.rows = 4;
      input.spellcheck = false;
    } else {
      input = el("input", "mm-input");
      input.type = f.type;
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
      if (f.type === "password") {
        // 令牌类：不让浏览器记住 / 自动填充，也不做拼写检查。
        input.autocomplete = "new-password";
        input.spellcheck = false;
        input.setAttribute("data-secret", "true");
        // 宿主 GET 只返回占位值（已保存的密钥不下发）；聚焦时整体选中，键入即替换，原样保存则保持不变。
        input.addEventListener("focus", function () {
          if (input.value === "__dsh_secret_saved__") input.select();
        });
      }
    }
    if (f.placeholder) input.placeholder = f.placeholder;
    input.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    label.htmlFor = input.id;
    inputs[f.key] = input;
    wrap.append(label, input);
    if (f.action) wrap.append(buildAction(f));
    wrap.append(el("span", "mm-desc", f.desc));
    return wrap;
  }

  // 字段旁的动作按钮：组件装好之前禁用（renderInstall 里更新）；点了用输入框当前的值调用接口，成功后顺手保存这个字段。
  function buildAction(f) {
    var row = el("div", "mm-row mm-action");
    var btn = el("button", "mm-btn mm-ghost", f.action.label);
    btn.type = "button";
    btn.disabled = true;
    btn.title = "安装完成后可用";
    var msg = el("span", "mm-amsg");
    msg.setAttribute("aria-live", "polite");
    row.append(btn, msg);
    var a = actions[f.action.component] = { key: f.key, btn: btn, msg: msg, path: f.action.path, busy: false, ready: false };
    btn.addEventListener("click", function () { runAction(a); });
    return row;
  }
  function runAction(a) {
    if (disposed || a.busy || a.btn.disabled) return;
    var value = inputs[a.key].value.trim();
    function say(text, cls) {
      a.msg.textContent = text;
      a.msg.className = "mm-amsg" + (cls ? " " + cls : "");
    }
    if (!value) {
      say("请填写" + FIELD_BY_KEY[a.key].label, "err");
      inputs[a.key].focus();
      return;
    }
    a.busy = true;
    a.btn.disabled = true;
    say("正在安装（首次需下载插件包）…");
    var body = {};
    body.project = value;
    pageFetch(a.path, { method: "POST", body: JSON.stringify(body) }).then(function (d) {
      if (disposed) return;
      if (!d || !d.ok) throw new Error((d && d.error) || "安装失败");
      say(d.message || "已完成", "ok");
      // 记住这次用的路径（只改这一个字段）。
      if (lastValue && lastValue[a.key] !== value) {
        return postSettings(function (patch) { patch[a.key] = value; return patch; }).then(function () {}, function () {});
      }
    }).catch(function (e) {
      if (disposed || isAbort(e)) return;
      say(e.message, "err");
    }).finally(function () {
      if (disposed) return;
      a.busy = false;
      a.btn.disabled = !a.ready;
    });
  }

  // ── 页内导航（不改 location，避免干扰宿主路由）──
  function openDetail(id) {
    if (disposed || !details[id]) return;
    if (currentView && currentView !== id) details[currentView].view.hidden = true;
    listView.hidden = true;
    details[id].view.hidden = false;
    currentView = id;
    details[id].back.focus();
  }
  function showList() {
    if (disposed || !currentView) return;
    var id = currentView;
    details[id].view.hidden = true;
    listView.hidden = false;
    currentView = null;
    rows[id].focus();
  }
  // Esc 只在焦点位于本页内时生效；管理页里处理掉，免得宿主把整个设置窗口关掉。
  function onKeydown(e) {
    if (e.key !== "Escape" && e.key !== "Esc") return;
    if (!currentView) return;
    e.preventDefault();
    e.stopPropagation();
    showList();
  }
  page.addEventListener("keydown", onKeydown);

  function setBadge(id, b) {
    (badges[id] || []).forEach(function (node) {
      node.className = "mm-badge " + (b.cls || "off");
      node.textContent = b.text;
      node.title = b.title || "";
    });
  }
  // 列表按运行态排序：已连接 > 已启动 > 安装中/可用 > 未启动类 > 未安装 > 出错
  var FEATURE_ORDER = {};
  FEATURES.forEach(function (f, i) { FEATURE_ORDER[f.id] = i; });
  function statusRank(cls) {
    switch (cls) {
      case "connected": return 0;
      case "on": return 1;
      case "busy": return 2;
      case "ready": return 3;
      case "checking": return 4;
      case "off": return 5;
      case "missing": return 6;
      case "error": return 7;
      default: return 5;
    }
  }
  function badgeClsOfItem(item) {
    var b = item && item.querySelector && item.querySelector(".mm-badge");
    if (!b || !b.className) return "off";
    var m = String(b.className).match(/\bmm-badge\s+(\S+)/);
    return (m && m[1]) || "off";
  }
  function sortFeatureLists() {
    if (!listView) return;
    var lists = listView.querySelectorAll(".mm-list");
    for (var li = 0; li < lists.length; li++) {
      var list = lists[li];
      var items = Array.prototype.filter.call(list.children, function (n) { return n.classList && n.classList.contains("mm-item"); });
      if (items.length < 2) continue;
      items.sort(function (a, b) {
        var ra = statusRank(badgeClsOfItem(a));
        var rb = statusRank(badgeClsOfItem(b));
        if (ra !== rb) return ra - rb;
        var ia = FEATURE_ORDER[a.getAttribute("data-feature")] ;
        var ib = FEATURE_ORDER[b.getAttribute("data-feature")] ;
        if (ia == null) ia = 9999;
        if (ib == null) ib = 9999;
        return ia - ib;
      });
      for (var i = 0; i < items.length; i++) list.appendChild(items[i]);
    }
  }
  function updateSummaries() {
    if (!lastValue) return;
    FEATURES.forEach(function (f) { if (f.summary) setBadge(f.id, f.summary(lastValue)); });
    sortFeatureLists();
  }

  function fill(value, keys) {
    var list = keys || INPUT_FIELDS.map(function (f) { return f.key; });
    // Full fill also refreshes dynamic local *Enabled toggles (not in INPUT_FIELDS).
    if (!keys) {
      Object.keys(toggles).forEach(function (k) {
        if (list.indexOf(k) < 0) list = list.concat([k]);
      });
    }
    list.forEach(function (k) {
      var f = FIELD_BY_KEY[k];
      if (!f) return;
      var has = value && Object.prototype.hasOwnProperty.call(value, k);
      if (f.type === "switch") {
        // Fresh install: all capability *Enabled switches default OFF.
        // sessionCircuitEnabled stays ON as a sub-option (only active when sessionControlsEnabled).
        var defOn = k === "sessionCircuitEnabled";
        setSwitch(k, has ? !!value[k] : defOn);
      }
      else {
        var v = value && value[k];
        inputs[k].value = v === undefined || v === null ? "" : String(v);
      }
    });
  }
  var STATUS_TEXT = { connected: "已连接", on: "已启动", off: "未启动", error: "出错", missing: "未安装", ready: "可用" };
  var CONN_TEXT = { connected: "已连接", "no-app": "程序未运行", unreachable: "未连接", "mcp-down": "未连接", checking: "正在检查连接" };
  var WATCH_MS = 5000; // 有组件在探测连接时的状态刷新间隔（安装期间仍是 1.5 秒）
  var disposed = false;
  var pollTimer = null;
  var pollMs = 0; // 当前轮询间隔：500（安装中）/ WATCH_MS（探测连接）
  var settleTimer = null; // 安装结束后延迟 2 秒补刷一次状态的一次性定时器
  var wasActive = false;
  var statusInFlight = false; // /components 请求进行中，定时器不再叠加新请求
  var refreshAgain = false; // 请求进行中时有手动刷新，回来后再补刷一次
  var failCount = 0; // 连续读取状态失败次数
  var pollPaused = false; // 因连续失败暂停了自动刷新
  var MAX_FAILS = 3;
  var controllers = new Set(); // 本页进行中的请求，卸载时统一中止

  function abortError() {
    var e = new Error("已中止");
    e.name = "AbortError";
    return e;
  }
  function isAbort(e) {
    return !!e && e.name === "AbortError";
  }
  // 本页发出的请求都走这里：登记 AbortController，卸载时统一中止；卸载后不再发请求。
  function pageFetch(path, init) {
    if (disposed) return Promise.reject(abortError());
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var opts = Object.assign({}, init || {});
    if (ctrl) {
      controllers.add(ctrl);
      opts.signal = ctrl.signal;
    }
    function done() { if (ctrl) controllers.delete(ctrl); }
    return fetchJson(path, opts).then(function (d) { done(); return d; }, function (e) { done(); throw e; });
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    pollMs = 0;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    wasActive = false;
  }

  function buildInstallUi(id) {
    var row = el("div", "mm-install");
    var install = el("button", "mm-btn", "下载安装");
    var remove = el("button", "mm-btn mm-ghost", "卸载");
    // 下载 / 安装进行中或排队中时显示：取消后删除该组件已下载的工具文件。
    var cancel = el("button", "mm-btn mm-ghost", "取消下载");
    var state = el("span", "mm-istate");
    install.type = "button";
    remove.type = "button";
    cancel.type = "button";
    remove.style.display = "none";
    cancel.style.display = "none";
    row.append(install, cancel, remove, state);
    var details = el("details", "mm-log");
    var summary = el("summary");
    var logLabel = el("span", "mm-log-label", "安装日志");
    var live = el("span", "mm-log-live");
    live.hidden = true;
    var liveText = el("span", "mm-log-live-text");
    var liveSheen = el("span", "mm-log-live-sheen");
    liveSheen.setAttribute("aria-hidden", "true");
    live.append(liveText, liveSheen);
    summary.append(logLabel, live);
    var pre = el("pre");
    details.append(summary, pre);
    details.style.display = "none";
    var cnote = el("div", "mm-cnote");
    cnote.hidden = true;
    install.addEventListener("click", function () {
      install.disabled = true;
      // 安装开始即锁住启用开关；以服务端下一次 /components 返回的 launchBlocked 为准。
      if (toggles[id + "Enabled"] && launchGate[id + "Enabled"] !== undefined) {
        launchGate[id + "Enabled"] = "正在安装：安装完成后可启动";
        applyToggle(id + "Enabled");
      }
      state.className = "mm-istate queued";
      state.textContent = "正在提交…";
      pageFetch("/components/" + id + "/install", { method: "POST", body: "{}" }).then(function (d) {
        if (disposed) return;
        if (!d || !d.ok) throw new Error((d && d.error) || "无法开始安装");
        details.style.display = "";
        details.open = true;
      }).catch(function (e) {
        if (disposed || isAbort(e)) return;
        state.className = "mm-istate error";
        state.textContent = e.message;
      }).finally(function () {
        refreshStatus();
      });
    });
    cancel.addEventListener("click", function () {
      var shared = id === "uv" || id === "node";
      var body = shared
        ? "将停止此次下载，并删除已下载的文件。"
        : "将停止此次下载，并删除「" + id + "」已下载的工具文件。共享的 uv、Node.js、Python 和缓存将保留。";
      scConfirm("取消下载「" + id + "」？", { title: "取消下载", body: body, okText: "取消下载", cancelText: "继续下载" }).then(function (ok) {
      if (!ok || disposed) return;
      cancel.disabled = true;
      state.className = "mm-istate queued";
      state.textContent = "正在取消";
      pageFetch("/components/" + id + "/cancel", { method: "POST", body: "{}" }).then(function (d) {
        if (disposed) return;
        if (!d || !d.ok) throw new Error((d && d.error) || "无法取消下载");
      }).catch(function (e) {
        if (disposed || isAbort(e)) return;
        cancel.disabled = false;
        state.className = "mm-istate error";
        state.textContent = e.message;
      }).finally(function () {
        refreshStatus();
      });
      });
    });
    remove.addEventListener("click", function () {
      var shared = id === "uv" || id === "node";
      var body = shared
        ? "将删除插件托管的「" + id + "」。使用它的组件将停止运行，需要时将重新下载。"
        : "将删除「" + id + "」在插件工具目录中的安装。共享的 Python、Node.js 和缓存将保留。";
      scConfirm("卸载「" + id + "」？", { title: "卸载「" + id + "」", body: body, okText: "卸载", cancelText: "保留" }).then(function (ok) {
      if (!ok || disposed) return;
      remove.disabled = true;
      install.disabled = true;
      state.className = "mm-istate queued";
      state.textContent = "正在卸载…";
      pageFetch("/components/" + id + "/uninstall", { method: "POST", body: "{}" }).then(function (d) {
        if (disposed) return;
        if (!d || !d.ok) throw new Error((d && d.error) || "卸载失败");
      }).catch(function (e) {
        if (disposed || isAbort(e)) return;
        state.className = "mm-istate error";
        state.textContent = e.message;
      }).finally(function () {
        if (disposed) return;
        remove.disabled = false;
        refreshStatus();
      });
      });
    });
    return { row: row, install: install, remove: remove, cancel: cancel, state: state, details: details, pre: pre, live: live, liveText: liveText, liveSheen: liveSheen, cnote: cnote };
  }

  function elapsed(job) {
    if (!job.startedAt) return "";
    var s = Math.max(0, Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000));
    return s >= 60 ? Math.floor(s / 60) + " 分 " + (s % 60) + " 秒" : s + " 秒";
  }

  // 状态行文字：「<状态>：<说明>」；说明开头已带同一状态标签时不再重复（避免「未安装：未安装：…」）。
  function statusText(c) {
    var label = STATUS_TEXT[c.status] || c.status;
    var d = String(c.detail || "");
    var m;
    while ((m = d.match(/^\s*([^：:]{1,8})\s*[：:]\s*/)) && m[1] === label) d = d.slice(m[0].length);
    return d ? label + "：" + d : label;
  }

  // 列表行 / 管理页标题旁的状态徽标：安装进行中优先，其次是运行状态。
  function componentBadge(c) {
    var job = c.install || {};
    if (job.cancelling) return { text: "正在取消", cls: "busy", title: "正在取消下载并删除已下载的文件" };
    if (job.state === "installing") return { text: "安装中" + (job.startedAt ? " " + elapsed(job) : ""), cls: "busy", title: job.step || "" };
    if (job.state === "queued") return { text: "排队中", cls: "busy", title: "等待其他安装完成" };
    var cn = c.connection;
    var title = cn && cn.detail ? (CONN_TEXT[cn.state] || cn.state) + "：" + cn.detail : statusText(c);
    return { text: STATUS_TEXT[c.status] || c.status, cls: c.status, title: title };
  }

  // 管理页的连接行：只在组件已启动（带 connection）时显示。
  function renderConn(c) {
    var line = connLines[c.id];
    if (!line) return;
    var cn = c.connection;
    if (!cn) {
      line.hidden = true;
      line.textContent = "";
      line.className = "mm-conn";
      return;
    }
    line.hidden = false;
    line.className = "mm-conn " + cn.state;
    var label = CONN_TEXT[cn.state] || cn.state;
    line.textContent = cn.state === "checking" || !cn.detail || cn.detail === label ? label + "…" : label + "：" + cn.detail;
    line.title = cn.checkedAt ? "检查于 " + new Date(cn.checkedAt).toLocaleTimeString() + (cn.via ? "（" + cn.via + "）" : "") : "";
  }

  function renderInstall(c) {
    if (c && c.kind === "component") {
      // 服务端门控：需要安装的组件在安装完成前 launchBlocked 非空；builtin（GameBot）恒为 null。
      launchGate[c.id + "Enabled"] = c.launchBlocked || null;
      gateMissing[c.id + "Enabled"] = !!c.launchBlocked && !c.installed;
      applyToggle(c.id + "Enabled");
    }
    var ui = installUis[c.id];
    if (!ui) return;
    var job = c.install || { state: "idle", log: [] };
    var busy = job.state === "installing" || job.state === "queued";
    ui.install.textContent = c.installed ? "重新安装" : "下载安装";
    ui.install.title = c.installed ? "重新下载最新版本并覆盖当前安装" : "下载并安装此组件";
    ui.install.disabled = busy;
    ui.remove.style.display = c.installed && !busy ? "" : "none";
    ui.cancel.style.display = busy ? "" : "none";
    ui.cancel.disabled = !!job.cancelling;
    ui.cancel.title = job.state === "queued" ? "移出安装队列并删除未完成的文件" : "停止下载并删除该组件已下载的工具文件";
    var text;
    if (job.cancelling) text = "正在取消";
    else if (job.state === "installing") text = (job.step || "正在安装") + "（" + elapsed(job) + "）";
    else if (job.state === "queued") text = "排队中：等待其他安装完成";
    else if (job.state === "error") text = "安装失败：" + (job.error || "");
    else if (job.state === "done") text = "安装完成（用时 " + elapsed(job) + "）";
    else text = c.installed ? "已安装" : (job.step || "未安装");
    ui.state.className = "mm-istate " + job.state;
    ui.state.textContent = text;
    // 组件说明（如 Godot：装的是哪个版本、项目里的插件要装哪个版本）
    ui.cnote.textContent = c.note || "";
    ui.cnote.hidden = !c.note;
    var a = actions[c.id];
    if (a) {
      a.ready = !!c.installed && !busy;
      if (!a.busy) a.btn.disabled = !a.ready;
      a.btn.title = a.ready ? "将与服务器同版本的插件安装到上方填写的项目" : busy ? "正在安装，请在安装完成后重试" : "安装完成后可用";
    }
    var log = (job.log || []).join("\n");
    // 控制台最后一行 / 下载进度：在「安装日志」标题右侧，不进日志正文。结束后清空（状态行保留最终结果）。
    var liveLine = busy ? (job.live || "") : "";
    if (log || liveLine) ui.details.style.display = "";
    if (ui.pre.textContent !== log) {
      var stick = ui.pre.scrollTop + ui.pre.clientHeight >= ui.pre.scrollHeight - 8;
      ui.pre.textContent = log;
      if (stick) ui.pre.scrollTop = ui.pre.scrollHeight;
    }
    // 已下载的前段是淡蓝流光，未下载的后段是白色；百分比未知时整行流光。两层同文，裁切上层，文字不重排。
    var pct = job.percent;
    var known = typeof pct === "number" && isFinite(pct);
    var clip = known ? "inset(0 " + Math.max(0, Math.min(100, 100 - pct)) + "% 0 0)" : "";
    ui.live.hidden = !liveLine;
    if (ui.liveText.textContent !== liveLine) {
      ui.liveText.textContent = liveLine;
      ui.liveSheen.textContent = liveLine;
    }
    if (ui.live.title !== liveLine) ui.live.title = liveLine;
    if (ui.liveSheen.style.clipPath !== clip) {
      ui.liveSheen.style.clipPath = clip;
      ui.liveSheen.style.webkitClipPath = clip;
    }
  }

  // active：有安装在进行（500ms 一刷，让标题行的控制台进度跟上）；watch：有已启动的组件在探测连接（WATCH_MS 一刷）。
  // 只用一个定时器，间隔变了就换一个。
  function setPolling(active, watch) {
    if (disposed) return;
    var ms = active ? 500 : watch ? WATCH_MS : 0;
    if (pollTimer && pollMs !== ms) { clearInterval(pollTimer); pollTimer = null; pollMs = 0; }
    if (ms && !pollTimer) { pollTimer = setInterval(function () { refreshStatus(true); }, ms); pollMs = ms; }
    // 安装刚结束时组件还在重新挂载，稍后再刷一次状态。
    if (wasActive && !active) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(function () {
        settleTimer = null;
        refreshStatus();
      }, 2000);
    }
    wasActive = active;
  }

  // 唯一的状态刷新管线：同时更新列表徽标和各管理页。
  // fromTimer：由轮询定时器触发；手动操作（保存、安装、卸载）不传。
  function refreshStatus(fromTimer) {
    if (disposed) return;
    if (statusInFlight) {
      // 上一次请求还没回来：定时器直接跳过，手动刷新等它回来后补刷一次。
      if (fromTimer !== true) refreshAgain = true;
      return;
    }
    statusInFlight = true;
    function settle() {
      statusInFlight = false;
      if (refreshAgain && !disposed) {
        refreshAgain = false;
        refreshStatus();
      }
    }
    pageFetch("/components").then(function (d) {
      if (disposed) return;
      if (!d || !d.ok) throw new Error((d && d.error) || "读取失败");
      failCount = 0;
      pollPaused = false;
      var active = false;
      var watch = false;
      syncLocalFromComponents(d.components, d);
      d.components.forEach(function (c) {
        if (c.install && (c.install.state === "installing" || c.install.state === "queued")) active = true;
        if (c.connection) watch = true;
        renderInstall(c);
        renderConn(c);
        if (byComponent[c.id]) setBadge(byComponent[c.id].id, componentBadge(c));
        var line = statusLines[c.id];
        if (!line) return;
        line.className = "mm-status " + c.status;
        line.textContent = statusText(c);
        line.title = c.command || "";
      });
      sortFeatureLists();
      setPolling(active, watch);
      settle();
    }).catch(function (e) {
      if (disposed) return;
      if (isAbort(e)) { settle(); return; }
      failCount++;
      // 轮询中连续失败 MAX_FAILS 次就暂停自动刷新；手动操作成功后会重新开始。
      if (failCount >= MAX_FAILS && pollTimer) {
        stopPolling();
        pollPaused = true;
      }
      var text = "无法读取组件状态：" + e.message + (pollPaused ? "（已暂停自动刷新，稍后再试或点保存刷新）" : "");
      Object.keys(statusLines).forEach(function (id) {
        statusLines[id].className = "mm-status error";
        statusLines[id].textContent = text;
        if (byComponent[id]) setBadge(byComponent[id].id, { text: "读取失败", cls: "error", title: text });
      });
      settle();
    });
  }

  pageFetch("/settings").then(function (d) {
    if (disposed) return;
    if (!d || !d.ok) throw new Error((d && d.error) || "读取失败");
    lastValue = d.value || {};
    fill(lastValue);
    if (typeof lastValue.sessionControlsEnabled === "boolean") {
      setScEnabled(lastValue.sessionControlsEnabled === true);
    }
    updateSummaries();
    FEATURES.forEach(function (f) { if (details[f.id].save) details[f.id].save.disabled = false; });
    Object.keys(toggles).forEach(applyToggle);
    refreshStatus();
    sub.textContent = d.persisted
      ? "设置已持久化（DSH 设置服务或用户数据目录 ~/.dsh/data/dsh-work-components/settings.json），修改后立即生效。"
      : "当前无法持久化设置，修改只在本次运行内有效。";
  }).catch(function (e) {
    if (disposed || isAbort(e)) return;
    sub.textContent = "无法连接插件宿主接口：" + e.message;
    sub.className = "mm-msg err";
    FEATURES.forEach(function (f) {
      if (f.summary) setBadge(f.id, { text: "读取失败", cls: "error", title: e.message });
      if (details[f.id].save && details[f.id].msg) {
        details[f.id].msg.textContent = "设置读取失败，暂时不能保存";
        details[f.id].msg.className = "mm-msg err";
      }
    });
  });

  // 唯一的保存管线：请求排队依次发出，每次都以「轮到它时」最近读到的完整设置为底、只换上调用方的字段，
  // 所以旋钮和「保存」前后脚点也不会互相覆盖。成功后更新 lastValue、列表徽标并刷新一次状态。
  var saveQueue = Promise.resolve();
  function postSettings(change) {
    var run = saveQueue.then(function () {
      if (disposed) throw abortError();
      return pageFetch("/settings", { method: "POST", body: JSON.stringify(change(Object.assign({}, lastValue || {}))) });
    }).then(function (d) {
      if (disposed) throw abortError();
      if (!d || !d.ok) throw new Error((d && d.error) || "保存失败");
      lastValue = d.value || lastValue;
      // Immediately show/hide retract·retry·pause without waiting for the 15s poll.
      if (lastValue && typeof lastValue.sessionControlsEnabled === "boolean") {
        setScEnabled(lastValue.sessionControlsEnabled === true);
      }
      updateSummaries();
      refreshStatus();
      return lastValue;
    });
    saveQueue = run.catch(function () {});
    return run;
  }

  // 某个管理页的「保存」：以最近读到的完整设置为底，只换上本页的字段，
  // 其他功能的设置原样带回（不会被清空，也不会带上别的页里没保存的改动）。
  // 「启用」不在这里：它由旋钮单独保存，这里沿用已保存的值（即旋钮当前状态）。
  function saveFeature(f) {
    var ui = details[f.id];
    function say(text, isErr) {
      ui.msg.textContent = text;
      ui.msg.className = isErr ? "mm-msg err" : "mm-msg";
    }
    var values = {};
    f.keys.forEach(function (k) {
      var fd = FIELD_BY_KEY[k];
      if (fd.type === "switch") return;
      var raw = inputs[k].value;
      values[k] = fd.type === "number" ? Number(raw) : fd.bool ? raw === "true" : raw;
    });
    ui.save.disabled = true;
    say("保存中…");
    postSettings(function (patch) { return Object.assign(patch, values); }).then(function () {
      fill(lastValue, f.keys);
      say("已保存");
    }).catch(function (e) {
      if (disposed || isAbort(e)) return;
      say(e.message, true);
    }).finally(function () {
      if (disposed) return;
      ui.save.disabled = false;
    });
  }

  // 拨动「启用」旋钮：先显示新状态并禁用旋钮，只把这一项改掉后保存；失败时回到已保存的状态并提示。
  function toggleSetting(t) {
    if (disposed || t.saving || t.btn.disabled || !lastValue) return;
    var next = !t.stored;
    if (isComponentToggle(t.key) && launchGate[t.key] !== null) { applyToggle(t.key); return; }
    if (next && t.key === "sessionControlsEnabled" && !t.confirmed) {
      if (t.confirming) return;
      t.confirming = true;
      scConfirm("启用会话控制？", {
        title: "警告：会话控制为实验性功能",
        body: "会话控制为实验性功能，尚未开发完毕。\n使用此功能可能会对对话造成不可逆的破坏。\n仍要启用吗？",
        okText: "仍要启用",
        cancelText: "暂不启用"
      }).then(function (ok) {
        t.confirming = false;
        if (!ok || disposed) return;
        t.confirmed = true;
        try { toggleSetting(t); } finally { t.confirmed = false; }
      });
      return;
    }
    function say(text, isErr) {
      t.msg.textContent = text;
      t.msg.className = isErr ? "mm-tmsg err" : "mm-tmsg";
    }
    t.stored = next;
    t.btn.setAttribute("aria-checked", next ? "true" : "false");
    t.btn.setAttribute("aria-busy", "true");
    t.btn.disabled = true;
    t.saving = true;
    t.hinted = false;
    say("保存中…");
    postSettings(function (patch) { patch[t.key] = next; return patch; }).then(function (v) {
      t.saving = false;
      setSwitch(t.key, !!v[t.key]);
      say(v[t.key] ? "已启用" : "已停用");
    }).catch(function (e) {
      if (disposed || isAbort(e)) return;
      t.saving = false;
      setSwitch(t.key, !!(lastValue || {})[t.key]);
      say("未保存：" + e.message, true);
    }).finally(function () {
      if (disposed) return;
      t.saving = false;
      t.btn.removeAttribute("aria-busy");
      applyToggle(t.key);
    });
  }

  page.__mmDispose = function () {
    disposed = true;
    stopPolling();
    page.removeEventListener("keydown", onKeydown);
    // 中止所有进行中的请求；回调里见到 disposed / AbortError 会直接返回，不再写 DOM。
    controllers.forEach(function (c) { c.abort(); });
    controllers.clear();
  };
  return page;
}

// settings.section 的第二个参数是 React 组件；把手写 DOM 页面挂进去。
function SettingsPage() {
  var ref = React.useRef(null);
  React.useEffect(function () {
    var node = renderSettingsPage();
    if (ref.current) ref.current.appendChild(node);
    return function () {
      if (node.__mmDispose) node.__mmDispose();
      node.remove();
    };
  }, []);
  return h("div", { ref: ref });
}

/**
 * MmBlock UI shape (toolview; from presentationMeta.mm — not model content):
 *   { type:'mm', kind:'image'|'video'|'webpage'|'document',
 *     status:'pending'|'ready'|'error'|'canceled',
 *     progress?, title?, caption?, error?,
 *     asset?: { attachment }, source? }
 * Prefer meta.mm; tolerate content type:'mm' from older sessions; synthesize from type:'image'.
 */

// ── multimodal (MmBlock) tool cards ──
function blockText(block) {
  var content = block && Array.isArray(block.content) ? block.content : [];
  return content.filter(function (b) { return b && b.type === "text"; })
    .map(function (b) { return b.text; }).join("\n");
}

function mmBlocksFromMeta(meta) {
  if (!meta || typeof meta !== "object") return [];
  if (meta.mm && meta.mm.type === "mm") return [meta.mm];
  if (Array.isArray(meta.mms)) {
    return meta.mms.filter(function (b) { return b && b.type === "mm"; });
  }
  return [];
}

function mmBlocksFromContent(content) {
  var list = Array.isArray(content) ? content : [];
  // Older sessions may still have type:'mm' in content (broke DeepSeek Messages); show in UI only.
  var mms = list.filter(function (b) { return b && b.type === "mm"; });
  if (mms.length) return mms;
  // Official attachment path: type:'image' → synthetic MmBlock (kind image / ready)
  return list.filter(function (b) { return b && b.type === "image" && b.attachment; })
    .map(function (b) {
      return {
        type: "mm",
        kind: "image",
        status: "ready",
        title: (b.attachment && b.attachment.name) || undefined,
        asset: { attachment: b.attachment }
      };
    });
}

/** Enrich mm title/caption from call args / meta when the image-only path omitted them. */
function enrichMmBlocks(mms, block, args) {
  var meta = (block && block.meta) || {};
  var a = args || {};
  return (mms || []).map(function (mm) {
    var title = mm.title || meta.title || a.title || a.path || undefined;
    var caption = mm.caption || meta.caption || a.caption || undefined;
    if (title === mm.title && caption === mm.caption) return mm;
    var next = {};
    for (var k in mm) if (Object.prototype.hasOwnProperty.call(mm, k)) next[k] = mm[k];
    if (title !== undefined) next.title = title;
    if (caption !== undefined) next.caption = caption;
    return next;
  });
}

function mmKindIcon(kind) {
  if (kind === "video") return "🎬";
  if (kind === "webpage") return "🌐";
  if (kind === "document") return "📄";
  return "🖼";
}

function mmKindLabel(kind) {
  if (kind === "video") return "视频";
  if (kind === "webpage") return "网页";
  if (kind === "document") return "文档";
  return "图片";
}

function mmStatusLabel(status) {
  if (status === "pending") return "生成中";
  if (status === "error") return "失败";
  if (status === "canceled") return "已取消";
  return "";
}

var MM_SHELL_STYLE = {
  border: "1px solid var(--theme-border,#333)",
  borderRadius: 10,
  padding: "10px 12px",
  margin: "4px 0",
  fontSize: 12,
  background: "var(--theme-bg-secondary,transparent)"
};

var MM_SKELETON_STYLE = {
  width: 160,
  height: 120,
  borderRadius: 8,
  background: "linear-gradient(90deg, rgba(127,127,127,.12) 25%, rgba(127,127,127,.22) 50%, rgba(127,127,127,.12) 75%)",
  backgroundSize: "200% 100%"
};

function MmAttachmentImage(props) {
  var st = React.useState(null);
  var url = st[0];
  var setUrl = st[1];
  var es = React.useState(false);
  var failed = es[0];
  var setFailed = es[1];
  React.useEffect(function () {
    var alive = true;
    if (!props.loadImage || !props.attachment) return undefined;
    props.loadImage(props.attachment).then(function (u) { if (alive) setUrl(u); }, function () { if (alive) setFailed(true); });
    return function () { alive = false; };
  }, [props.attachment, props.loadImage]);
  if (failed) return h("div", { style: { fontSize: 12, color: "#e55" } }, "图片加载失败");
  if (!url) return h("div", { style: MM_SKELETON_STYLE, title: "加载中…" });
  return h("img", {
    src: url,
    alt: props.alt || (props.attachment && props.attachment.name) || "image",
    style: { maxWidth: 320, maxHeight: 320, borderRadius: 8, display: "block" }
  });
}

function MmProgressBar(props) {
  var p = props.progress;
  if (p == null || !(typeof p === "number") || isNaN(p)) return null;
  var pct = p <= 1 ? Math.round(p * 100) : Math.round(Math.max(0, Math.min(100, p)));
  return h("div", { style: { marginTop: 8 } },
    h("div", {
      style: {
        height: 4, borderRadius: 2, overflow: "hidden",
        background: "rgba(127,127,127,.2)"
      }
    }, h("div", {
      style: {
        height: "100%", width: pct + "%",
        background: "var(--theme-accent,#4a9eff)",
        transition: "width .2s ease"
      }
    })),
    h("div", { style: { marginTop: 4, fontSize: 11, color: "var(--theme-text-secondary,#888)" } }, pct + "%")
  );
}

function MmImageBody(props) {
  var mm = props.mm;
  var status = mm.status || "ready";
  if (status === "pending") {
    return h("div", null,
      h("div", { style: MM_SKELETON_STYLE }),
      h(MmProgressBar, { progress: mm.progress }),
      h("div", { style: { marginTop: 6, color: "var(--theme-text-secondary,#888)" } }, "生成中…")
    );
  }
  if (status === "error") {
    return h("div", { style: { color: "#e55" } }, mm.error || "生成失败");
  }
  if (status === "canceled") {
    return h("div", { style: { color: "var(--theme-text-secondary,#888)" } }, "已取消");
  }
  var att = mm.asset && mm.asset.attachment;
  if (!att) {
    return h("div", { style: { color: "var(--theme-text-secondary,#888)" } }, "无图片资源");
  }
  return h(MmAttachmentImage, {
    attachment: att,
    loadImage: props.loadImage,
    alt: mm.title || (att && att.name) || "image"
  });
}

/** Placeholder bodies for kinds not yet wired (video / webpage / document). */
function MmStubBody(props) {
  var mm = props.mm;
  var kind = mm.kind || "document";
  var status = mm.status || "ready";
  var label = mmKindLabel(kind);
  if (status === "pending") {
    return h("div", null,
      h("div", { style: Object.assign({}, MM_SKELETON_STYLE, { width: "100%", maxWidth: 280, height: 72 }) }),
      h(MmProgressBar, { progress: mm.progress }),
      h("div", { style: { marginTop: 6, color: "var(--theme-text-secondary,#888)" } }, label + "生成中…（占位）")
    );
  }
  if (status === "error") {
    return h("div", { style: { color: "#e55" } }, mm.error || (label + "失败"));
  }
  if (status === "canceled") {
    return h("div", { style: { color: "var(--theme-text-secondary,#888)" } }, "已取消");
  }
  var src = (mm.source && (mm.source.url || mm.source.href)) || (mm.asset && mm.asset.url) || "";
  return h("div", {
    style: {
      padding: "14px 12px", borderRadius: 8,
      background: "rgba(127,127,127,.1)",
      color: "var(--theme-text-secondary,#888)"
    }
  },
    h("div", { style: { fontWeight: 600, marginBottom: 4, color: "var(--theme-text,#ddd)" } }, label + "卡片（占位）"),
    src ? h("div", { style: { wordBreak: "break-all", fontSize: 11 } }, String(src)) : null,
    h("div", { style: { marginTop: 4, fontSize: 11 } }, "后续接入真实 " + kind + " 预览")
  );
}

function MmCard(props) {
  var mm = props.mm || {};
  var kind = mm.kind || "image";
  var status = mm.status || "ready";
  var statusLbl = mmStatusLabel(status);
  var title = mm.title || "";
  var body = kind === "image"
    ? h(MmImageBody, { mm: mm, loadImage: props.loadImage })
    : h(MmStubBody, { mm: mm });
  return h("div", { style: MM_SHELL_STYLE },
    h("div", {
      style: {
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
        fontWeight: 600
      }
    },
      h("span", null, mmKindIcon(kind)),
      h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        title || mmKindLabel(kind)),
      statusLbl
        ? h("span", {
            style: {
              fontSize: 11, fontWeight: 500, padding: "1px 6px", borderRadius: 999,
              color: status === "error" ? "#e55" : "var(--theme-text-secondary,#888)",
              background: "rgba(127,127,127,.12)"
            }
          }, statusLbl)
        : null
    ),
    body,
    mm.caption
      ? h("div", { style: { marginTop: 8, color: "var(--theme-text-secondary,#888)", fontSize: 11 } }, mm.caption)
      : null
  );
}

/**
 * Parse tool-call argsRaw / block.args for title/path enrichment.
 */
function mmArgsFromBlockOrRaw(block, argsRaw) {
  var args = (block && (block.args || block.input)) || null;
  if (args && typeof args === "object") return args;
  if (typeof argsRaw === "string" && argsRaw) {
    try {
      var parsed = JSON.parse(argsRaw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
  }
  return {};
}

/**
 * Multimodal toolview row for mm_send_image.
 * Running: pending/sending card only. Settled: compact one-liner (full MmCard lives on turnTail).
 */
function MmToolRow(props) {
  var block = props.block;
  var settled = !!(block && block.kind === "tool-result");
  var call = settled ? (block.call || null) : null;
  var toolName = (call && call.name)
    || (block && (block.toolName || block.name || block.tool))
    || "mm_send_image";
  var args = mmArgsFromBlockOrRaw(block, call && call.argsRaw);
  var label = args.title || args.path || "";
  if (label) label = String(label);
  if (settled) {
    var err = block.isError === true;
    var status = err ? "失败" : "已发送";
    return h("div", {
      style: {
        margin: "2px 0",
        fontSize: 12,
        color: err ? "#e55" : "var(--theme-text-secondary,#888)"
      },
      "data-tool": "mm_send_image",
      "data-state": err ? "error" : "ok"
    }, toolName + " · " + status + (label ? " · " + label : ""));
  }
  // Preparing / running: pending card only (no settled gallery here).
  var pendingTitle = label || undefined;
  return h("div", {
    style: { margin: "4px 0" },
    "data-tool": "mm_send_image",
    "data-state": "running"
  },
    h("div", {
      style: { fontWeight: 600, marginBottom: 4, fontSize: 12, color: "var(--theme-text-secondary,#888)" }
    }, toolName + (label ? " · " + label : "") + " · 发送中"),
    h(MmCard, {
      mm: {
        type: "mm",
        kind: "image",
        status: "pending",
        title: pendingTitle
      },
      loadImage: props.loadImage
    })
  );
}

/** Append-origin surface events only (same filter as Host deliverables / schedule). */
function mmIsAppendSurfaceEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.type !== "tool/call" && event.type !== "tool/result") return false;
  return event.surfaceOp === undefined || event.surfaceOp === "append";
}

/**
 * Collect settled mm_send_image cards for one Turn into turn data `mmCards`.
 * Prefers presentationMeta.mm, then content type:mm / type:image (legacy).
 * Publishes no Chat view Node — turnTail reads owner.turn.data.get("mmCards").
 */
function mmEntryFromResult(match, call) {
  if (!match || !match.event || match.event.type !== "tool/result") return null;
  var message = match.event.data && match.event.data.message;
  if (!message || message.isError === true) return null;
  var meta = match.event.data.meta;
  var content = message.content;
  var mms = mmBlocksFromMeta(meta);
  if (!mms.length) mms = mmBlocksFromContent(content);
  var args = mmArgsFromBlockOrRaw(null, call && call.argsRaw);
  mms = enrichMmBlocks(mms, { meta: meta }, args);
  if (!mms.length) return null;
  return {
    seq: match.event.seq,
    callId: String(message.source && message.source.callId || ""),
    mms: mms
  };
}

function mmCardsForClosing(data, seq) {
  var bound = seq == null ? Number.POSITIVE_INFINITY : seq;
  var list = (data && data.cards) || [];
  return list.filter(function (c) { return c && typeof c.seq === "number" && c.seq <= bound; });
}

function selectMmCards(owner) {
  if (!owner || !owner.turn || !owner.turn.data) return null;
  var endSeq = owner.turn.end && typeof owner.turn.end.seq === "number"
    ? owner.turn.end.seq
    : owner.seq;
  var cards = mmCardsForClosing(owner.turn.data.get("mmCards"), endSeq);
  return cards.length === 0 ? null : cards;
}

var mmCardsDefinition = {
  kind: "mmCards",
  match: function (event) {
    if (event.type === "turn/start") {
      return { id: String(event.data.turn), role: "start" };
    }
    if (event.type === "tool/call" && mmIsAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: "update" };
    }
    if (event.type === "tool/result" && mmIsAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: "update" };
    }
    return null;
  },
  start: function (_context, match) {
    if (match.event.type !== "turn/start") throw new Error("mmCards start requires turn/start");
    return {
      turn: match.event.data.turn,
      calls: new Map(),
      cards: []
    };
  },
  update: function (context, match) {
    if (match.event.type === "tool/call") {
      if (match.event.data.name !== "mm_send_image") return context.state;
      var calls = new Map(context.state.calls);
      calls.set(String(match.event.data.callId), {
        name: match.event.data.name,
        argsRaw: match.event.data.arguments,
        time: match.event.time
      });
      return { turn: context.state.turn, calls: calls, cards: context.state.cards };
    }
    if (match.event.type !== "tool/result") return context.state;
    var call = context.state.calls.get(String(match.event.data.message.source.callId));
    if (!call || call.name !== "mm_send_image") return context.state;
    var entry = mmEntryFromResult(match, call);
    if (!entry) return context.state;
    return {
      turn: context.state.turn,
      calls: context.state.calls,
      cards: context.state.cards.concat([entry])
    };
  },
  buildLocationData: function (context, scope, previous) {
    if (scope !== "turn" || context.state === undefined) return null;
    if (
      previous
      && previous.kind === "turn"
      && previous.turn === context.state.turn
      && previous.key === "mmCards"
      && previous.value.cards === context.state.cards
    ) return previous;
    return {
      kind: "turn",
      turn: context.state.turn,
      key: "mmCards",
      value: { cards: context.state.cards }
    };
  }
};

/**
 * Completed-turn artifact: full MmCards after tools/thinking fold.
 * loadImage is injected from uiConversation.imageUrl(sessionId, attachment).
 */
function MmTurnTail(props) {
  var matched = selectMmCards(props);
  if (!matched) return null;
  var loadImage = props.loadImage;
  var nodes = [];
  matched.forEach(function (entry) {
    (entry.mms || []).forEach(function (mm, i) {
      var key = (mm.asset && mm.asset.attachment && mm.asset.attachment.attachmentId)
        || (entry.callId + "-" + i);
      nodes.push(h(MmCard, {
        key: key,
        mm: mm,
        loadImage: loadImage
      }));
    });
  });
  if (!nodes.length) return null;
  return h("div", {
    style: { display: "flex", flexDirection: "column", gap: 8, margin: "4px 0" },
    "data-mm-turn-tail": true
  }, nodes);
}

var inject = ["slots", "sessions", "uiConversation"];

/**
 * 会话控制（Harness 0.2.0-rc.2）：
 * 官方用户气泡没有 extraActions。撤回用 portal 放进用户消息自己的操作行。
 * 重试只挂 conversation.chat.assistant-actions（复制与分支之间），确认后就地替换原回复。
 * 暂停=熔断挂在 conversation.input.right（随时可点，只取消，不截断）。
 * sessionId 由 session-scope slot 自动注入。
 */

var SC_CSS_TAG = "dsh-workbench/session-controls.css";
var SC_CSS = [
  ".dsw-sc-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));",
  "color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;background:transparent;border:none;border-radius:var(--dsw-radius-sm,6px);",
  "justify-content:center;align-items:center;padding:6px;display:inline-flex;flex:none}",
  ".dsw-sc-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}",
  ".dsw-sc-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#bbb)}",
  ".dsw-sc-action:disabled{cursor:default;opacity:.4}",
  ".dsw-sc-action[data-busy]{opacity:.55}",
  ".dsw-sc-pause{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));",
  "color:var(--dsw-alias-label-secondary,#bbb);cursor:pointer;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));",
  "border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex;flex:none}",
  ".dsw-sc-pause svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}",
  ".dsw-sc-pause:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,#ddd)}",
  ".dsw-sc-pause:disabled{cursor:default;opacity:.4}",
  ".dsw-sc-modal{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;",
  "padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;font-family:inherit}",
  ".dsw-sc-modal-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}",
  ".dsw-sc-modal-mask::after{content:'';position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);",
  "animation:dsw-sc-modal-enter var(--ds-transition-duration,.16s) var(--ds-ease-in-out,ease)}",
  ".dsw-sc-modal-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;",
  "width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel,12px);",
  "background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);",
  "animation:dsw-sc-modal-enter var(--ds-transition-duration,.16s) var(--ds-ease-in-out,ease)}",
  ".dsw-sc-modal-dialog:focus{outline:none}",
  "@keyframes dsw-sc-modal-enter{from{opacity:0}to{opacity:1}}",
  "@media (prefers-reduced-motion:reduce){.dsw-sc-modal-mask::after,.dsw-sc-modal-dialog{animation:none}}",
  ".dsw-sc-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}",
  ".dsw-sc-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}",
  ".dsw-sc-modal-body{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);white-space:pre-line;overflow-wrap:anywhere}",
  ".dsw-sc-modal-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;",
  "border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:0}",
  ".dsw-sc-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsw-sc-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}",
  ".dsw-sc-modal-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;",
  "padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font:inherit;font-size:14px;line-height:22px}",
  ".dsw-sc-modal-btn-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}",
  ".dsw-sc-modal-btn-outline:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".dsw-sc-modal-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
  ".dsw-sc-modal-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}",
  ".dsw-sc-replaced{display:none !important}",
  "body[data-we-wallpaper] [data-sidebar-right-panel]:not([data-sidebar-right-open]),",
  "body[data-we-sidebar-glass] [data-sidebar-right-panel]:not([data-sidebar-right-open]),",
  "body[data-ds-dark-theme][data-we-sidebar-glass] [data-sidebar-right-panel]:not([data-sidebar-right-open]){",
  "background:none !important;background-color:transparent !important;background-image:none !important;",
  "-webkit-backdrop-filter:none !important;backdrop-filter:none !important;box-shadow:none !important}"
].join("");

var scEnabled = false;
var scEnabledListeners = new Set();
function setScEnabled(next) {
  var v = next === true;
  if (scEnabled === v) return;
  scEnabled = v;
  scEnabledListeners.forEach(function (fn) { try { fn(); } catch (_) {} });
}
function useScEnabled() {
  return React.useSyncExternalStore(
    function (fn) { scEnabledListeners.add(fn); return function () { scEnabledListeners.delete(fn); }; },
    function () { return scEnabled; },
    function () { return scEnabled; }
  );
}
function refreshScEnabled() {
  return fetch(API + "/settings").then(function (r) { return r.json(); }).then(function (j) {
    // API shape is { ok, persisted, value: { sessionControlsEnabled, ... } }
    var v = j && j.value && typeof j.value === "object" ? j.value : j;
    if (v && typeof v === "object") setScEnabled(v.sessionControlsEnabled === true);
  }).catch(function () {});
}

function iconUndo() {
  // 撤回：左向 U 形撤回箭头（非圆圈），与重试区分
  return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true },
    h("path", {
      d: "M5.2 4.2H9.5a3.8 3.8 0 0 1 0 7.6H4.8",
      fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round"
    }),
    h("path", {
      d: "M7.4 1.8 4.2 4.2 7.4 6.6",
      fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round"
    })
  );
}
function iconRetry() {
  // 重试：闭环刷新圆箭头（顺时针），与撤回的开口 U 形对比
  return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true },
    h("path", {
      d: "M13.25 8a5.25 5.25 0 1 1-1.55-3.7",
      fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round"
    }),
    h("path", {
      d: "M13.4 2.2v3.6H9.8",
      fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round"
    })
  );
}
function iconStop() {
  return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true },
    h("rect", { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: "currentColor" })
  );
}

function chatOf(props) {
  if (typeof props.useChat === "function") return props.useChat(function (c) { return c; });
  if (typeof props.useSession === "function") {
    return props.useSession(function (s) { return s && s.chat; });
  }
  return null;
}

/** Resolve assistant finalNode.seq (any seq in the turn works for retract/regenerate APIs). */
function assistantSeqForMessage(chat, messageId) {
  if (!messageId || !chat) return null;
  var found = null;
  function consider(finalNode) {
    if (found != null || !finalNode || finalNode.messageId !== messageId) return;
    if (Number.isSafeInteger(finalNode.seq)) found = finalNode.seq;
  }
  function visit(node) {
    if (!node || found != null) return;
    var data = node.data || {};
    consider(data.closing && data.closing.finalNode);
    consider(data.finalNode);
  }
  if (chat.timeline && chat.timeline.turns && typeof chat.timeline.turns.forEach === "function") {
    chat.timeline.turns.forEach(function (turn) {
      if (found != null) return;
      var tail = turn && turn.data && typeof turn.data.get === "function" ? turn.data.get("turn-tail") : null;
      consider(tail && tail.closing && tail.closing.finalNode);
    });
  }
  if (found == null && chat.nodes && typeof chat.nodes.forEach === "function") chat.nodes.forEach(visit);
  if (found == null && chat.order && chat.nodes) {
    for (var i = 0; i < chat.order.length; i++) {
      try { visit(chat.nodes.get(chat.order[i])); } catch (_) {}
      if (found != null) break;
    }
  }
  return found;
}

async function scPost(path, body) {
  var r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  var j = null;
  try { j = await r.json(); } catch (_) { j = null; }
  if (!j) throw new Error("empty response");
  if (j.ok === false && j.error) throw new Error(j.error);
  return j;
}

var REGENERATE_CARRIER = "已丢弃此前的回答，准备重新生成。";
var REGENERATE_KIND = "dsw-regenerate";
var scHideNotes = [];
var scHideEpoch = 0;
var scHideListeners = new Set();
function bumpScHide() {
  scHideEpoch += 1;
  scHideListeners.forEach(function (fn) { try { fn(); } catch (_) {} });
}
function useScHideEpoch() {
  return React.useSyncExternalStore(
    function (fn) { scHideListeners.add(fn); return function () { scHideListeners.delete(fn); }; },
    function () { return scHideEpoch; },
    function () { return 0; }
  );
}
function noteLiveReplace(sessionId, j) {
  if (!sessionId || !j || j.applied !== "live") return;
  var messageId = j.prompt && j.prompt.messageId ? String(j.prompt.messageId) : "";
  var hasRange = Number.isSafeInteger(j.hideFrom) && Number.isSafeInteger(j.hideUntil);
  if (!hasRange && !messageId) return;
  scHideNotes.push({
    sessionId: String(sessionId),
    from: hasRange ? j.hideFrom : null,
    until: hasRange ? j.hideUntil : null,
    exclusive: j.hideFromExclusive !== false,
    messageId: messageId
  });
  if (scHideNotes.length > 80) scHideNotes.splice(0, scHideNotes.length - 80);
  bumpScHide();
}
function eventOfEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.event && typeof entry.event === "object" && entry.event.type) return entry.event;
  if (entry.type && Number.isSafeInteger(entry.seq)) return entry;
  return null;
}
function carrierText(ev) {
  var parts = ev && ev.data && ev.data.content;
  if (!Array.isArray(parts)) return "";
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] && parts[i].type === "text") out.push(String(parts[i].text || ""));
  }
  return out.join("\n").trim();
}
function replaceBounds(ev) {
  var op = ev && ev.surfaceOp;
  if (!op || typeof op !== "object" || op.op !== "replace") return null;
  if (!Number.isSafeInteger(op.startSeq) || !Number.isSafeInteger(op.endSeq) || !Number.isSafeInteger(ev.seq)) return null;
  return op;
}
function rangesFromEvents(entries) {
  var events = [];
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    var item = eventOfEntry(list[i]);
    if (item) events.push(item);
  }
  var ranges = [];
  var ids = [];
  var seqs = [];
  for (var n = 0; n < events.length; n++) {
    var ev = events[n];
    var source = ev.data && ev.data.source;
    if (ev.type === "user/message" && source && source.kind === REGENERATE_KIND) {
      if (ev.data.id) ids.push(String(ev.data.id));
      if (Number.isSafeInteger(ev.seq)) seqs.push(ev.seq);
    }
    // A system/message replace only shadows the system prompt, but its own seq
    // is much later. Hiding through that seq would cover every earlier turn.
    if (ev.type !== "user/message") continue;
    var op = replaceBounds(ev);
    if (!op) continue;
    if (carrierText(ev) === REGENERATE_CARRIER) {
      var boundary = -1;
      for (var j = 0; j < n; j++) {
        var prev = events[j];
        if (!prev || prev.surfaceOp !== "append" || !Number.isSafeInteger(prev.seq)) continue;
        if (prev.seq < op.startSeq && prev.seq > boundary) boundary = prev.seq;
      }
      ranges.push({
        after: boundary >= 0 ? boundary : op.startSeq - 0.5,
        until: ev.seq,
        keepBoundary: boundary >= 0
      });
    } else {
      ranges.push({ after: op.startSeq - 0.5, until: ev.seq, keepBoundary: false });
    }
  }
  return { ranges: ranges, ids: ids, seqs: seqs };
}
function rangesForSession(sessionId, entries) {
  var plan = rangesFromEvents(entries);
  var id = String(sessionId);
  for (var i = 0; i < scHideNotes.length; i++) {
    var note = scHideNotes[i];
    if (note.sessionId !== id) continue;
    if (note.messageId) plan.ids.push(note.messageId);
    if (note.from == null || note.until == null) continue;
    plan.ranges.push({
      after: note.exclusive ? note.from : note.from - 0.5,
      until: note.until,
      keepBoundary: !!note.exclusive
    });
  }
  return plan;
}
function eachChatNode(chat, visit) {
  if (chat && chat.order && chat.nodes && typeof chat.nodes.get === "function") {
    for (var i = 0; i < chat.order.length; i++) visit(chat.nodes.get(chat.order[i]));
    return;
  }
  if (chat && chat.nodes && typeof chat.nodes.values === "function") {
    var values = chat.nodes.values();
    if (values && typeof values.forEach === "function") values.forEach(visit);
    return;
  }
  if (chat && chat.nodes && typeof chat.nodes.forEach === "function") chat.nodes.forEach(visit);
}
function nodeAnchor(node) {
  if (!node) return null;
  if (typeof node.anchorSeq === "number" && Number.isFinite(node.anchorSeq)) return node.anchorSeq;
  var data = node.data || {};
  if (Number.isSafeInteger(data.seq)) return data.seq;
  return null;
}
function nodeMessageId(node) {
  if (!node) return "";
  var data = node.data || {};
  if (data.id != null && data.id !== "") return String(data.id);
  if (data.messageId != null && data.messageId !== "") return String(data.messageId);
  if (node.id != null && node.id !== "") return String(node.id);
  return "";
}
function nodeHidden(node, plan) {
  if (!node) return false;
  var data = node.data || {};
  var source = data.source || (data.message && data.message.source);
  if (source && source.kind === REGENERATE_KIND) return true;
  var id = nodeMessageId(node);
  if (id && plan.ids && plan.ids.indexOf(id) >= 0) return true;
  var seq = nodeAnchor(node);
  if (seq != null && plan.seqs && plan.seqs.indexOf(seq) >= 0) return true;
  if (seq == null) return false;
  for (var i = 0; i < plan.ranges.length; i++) {
    var range = plan.ranges[i];
    if (!(seq > range.after && seq < range.until)) continue;
    if (range.keepBoundary && node.kind === "user" && seq <= range.after + 0.001) return false;
    return true;
  }
  return false;
}
function nodeTurnId(node) {
  if (!node) return "";
  var data = node.data || {};
  if (data.turn != null && data.turn !== "") return String(data.turn);
  var location = node.location;
  if (location && (location.kind === "turn" || location.kind === "step")) {
    var turn = location.turn;
    if (turn && turn.turn != null && turn.turn !== "") return String(turn.turn);
  }
  return "";
}
function applyReplacedHide(chat, plan) {
  if (typeof document === "undefined") return;
  if (!chat) {
    var stuck = document.querySelectorAll(".dsw-sc-replaced");
    for (var n = 0; n < stuck.length; n++) stuck[n].classList.remove("dsw-sc-replaced");
    return;
  }
  var known = new Set();
  var hidden = new Set();
  // Turns whose process chrome (「已搜索代码」「执行了命令」「已调用工具」) must leave with the retract.
  var hiddenTurns = new Set();
  eachChatNode(chat, function (node) {
    if (!node || node.key == null) return;
    var key = String(node.key);
    known.add(key);
    if (!nodeHidden(node, plan)) return;
    hidden.add(key);
    if (node.kind === "turn-process" || node.kind === "tool-call" || node.kind === "tool-result" || node.kind === "assistant-step") {
      var turnId = nodeTurnId(node);
      if (turnId) hiddenTurns.add(turnId);
    }
  });
  var flows = document.querySelectorAll("[data-chat-node-key]");
  for (var i = 0; i < flows.length; i++) {
    var el = flows[i];
    var key = el.getAttribute("data-chat-node-key");
    if (!known.has(key)) continue;
    if (hidden.has(key)) el.classList.add("dsw-sc-replaced");
    else el.classList.remove("dsw-sc-replaced");
  }
  // Collapsed step-process groups render under data-chat-group-key / data-step-process,
  // not data-chat-node-key. Surface replace only shadows message nodes, so these stubs
  // stayed after retract. Hide when the turn was retracted or every known member is gone.
  var groups = document.querySelectorAll("[data-step-process], [data-chat-group-key]");
  for (var g = 0; g < groups.length; g++) {
    var group = groups[g];
    var turnAttr = group.getAttribute("data-chat-turn");
    var hideGroup = turnAttr != null && hiddenTurns.has(String(turnAttr));
    if (!hideGroup) {
      var members = group.querySelectorAll("[data-chat-node-key]");
      var anyKnown = false;
      var anyShown = false;
      for (var m = 0; m < members.length; m++) {
        var mk = members[m].getAttribute("data-chat-node-key");
        if (!known.has(mk)) continue;
        anyKnown = true;
        if (!hidden.has(mk)) { anyShown = true; break; }
      }
      hideGroup = anyKnown && !anyShown;
    }
    if (hideGroup) group.classList.add("dsw-sc-replaced");
    else group.classList.remove("dsw-sc-replaced");
  }
}
function sessionEventEntries(sessions, sessionId) {
  try {
    var binding = sessions && typeof sessions.binding === "function" ? sessions.binding(sessionId) : null;
    var source = binding && binding.session && binding.session.eventSource;
    var snap = source && typeof source.getSnapshot === "function" ? source.getSnapshot() : null;
    return {
      entries: snap && snap.entries ? snap.entries : [],
      source: source || null
    };
  } catch (_) {
    return { entries: [], source: null };
  }
}

function chatMaxSeq(chat) {
  var max = -1;
  eachChatNode(chat, function (node) {
    var seq = nodeAnchor(node);
    if (seq != null && seq > max) max = seq;
  });
  return max;
}

/** The open window still lists seqs past the marker, so it is showing a longer log than the one just written. */
function pageAheadOfCut(chat, j) {
  var until = j && Number(j.hideUntil);
  return Number.isFinite(until) && chatMaxSeq(chat) > until;
}

async function settleSession(sessions, sessionId) {
  try {
    var binding = sessions && typeof sessions.binding === "function" ? sessions.binding(sessionId) : null;
    var session = binding && binding.session;
    if (session && typeof session.resync === "function") {
      await session.resync();
      return true;
    }
  } catch (_) {}
  return false;
}

function listUserAnchors(chat) {
  var out = [];
  function visit(node) {
    if (!node || node.kind !== "user" || node.key == null) return;
    var seq = node.data && Number.isSafeInteger(node.data.seq) ? node.data.seq : node.anchorSeq;
    if (!Number.isSafeInteger(seq)) return;
    out.push({ key: String(node.key), seq: seq });
  }
  if (chat && chat.order && chat.nodes && typeof chat.nodes.get === "function") {
    for (var i = 0; i < chat.order.length; i++) visit(chat.nodes.get(chat.order[i]));
  } else if (chat && chat.nodes && typeof chat.nodes.values === "function") {
    var values = chat.nodes.values();
    if (values && typeof values.forEach === "function") values.forEach(visit);
  } else if (chat && chat.nodes && typeof chat.nodes.forEach === "function") {
    chat.nodes.forEach(visit);
  }
  out.sort(function (a, b) { return a.seq - b.seq; });
  return out;
}

function cssAttr(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

var RETRACT_ICON_HTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5.2 4.2H9.5a3.8 3.8 0 0 1 0 7.6H4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><path d="M7.4 1.8 4.2 4.2 7.4 6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

function userActionHost(key) {
  var flow = document.querySelector('[data-chat-flow-kind="user"][data-chat-node-key="' + cssAttr(key) + '"]')
    || document.querySelector('[data-chat-node-key="' + cssAttr(key) + '"]');
  if (!flow) return null;
  return flow.querySelector('[data-clock="start"]');
}

var SC_CLOSE_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.2 3.2l7.6 7.6M10.8 3.2L3.2 10.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/**
 * 页面内确认，版式对齐官方 Modal（遮罩、卡片、取消/确定），替代 window.confirm / alert。
 * options：{ title, body（可多行）, okText, cancelText, alert（只有确认按钮） }。
 */
function scConfirm(message, options) {
  options = options || {};
  return new Promise(function (resolve) {
    if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="' + SC_CSS_TAG + '"]')) {
      var styleEl = document.createElement("style");
      styleEl.dataset.plugin = "dsh-workbench";
      styleEl.dataset.pluginCss = SC_CSS_TAG;
      styleEl.textContent = SC_CSS;
      document.head.appendChild(styleEl);
    }
    var restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    var root = document.createElement("div");
    root.className = "dsw-sc-modal";
    root.setAttribute("role", "presentation");
    var mask = document.createElement("div");
    mask.className = "dsw-sc-modal-mask";
    mask.setAttribute("aria-hidden", "true");
    var dialog = document.createElement("div");
    dialog.className = "dsw-sc-modal-dialog";
    dialog.tabIndex = -1;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "dsw-sc-confirm-title");
    var header = document.createElement("div");
    header.className = "dsw-sc-modal-header";
    var title = document.createElement("h2");
    title.className = "dsw-sc-modal-title";
    title.id = "dsw-sc-confirm-title";
    title.textContent = options.title || message;
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dsw-sc-modal-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.innerHTML = SC_CLOSE_ICON;
    header.appendChild(title);
    header.appendChild(closeBtn);
    var footer = document.createElement("div");
    footer.className = "dsw-sc-modal-footer";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "dsw-sc-modal-btn dsw-sc-modal-btn-outline";
    cancelBtn.textContent = options.cancelText || "取消";
    var okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "dsw-sc-modal-btn dsw-sc-modal-btn-primary";
    okBtn.textContent = options.okText || "确定";
    if (!options.alert) footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);
    dialog.appendChild(header);
    if (options.body) {
      var body = document.createElement("p");
      body.className = "dsw-sc-modal-body";
      body.textContent = options.body;
      dialog.appendChild(body);
    }
    dialog.appendChild(footer);
    root.appendChild(mask);
    root.appendChild(dialog);
    var settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      if (root.parentNode) root.parentNode.removeChild(root);
      resolve(ok);
      if (restore && restore.isConnected) restore.focus();
    }
    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
        return;
      }
      if (ev.key !== "Tab") return;
      var items = options.alert ? [closeBtn, okBtn] : [closeBtn, cancelBtn, okBtn];
      var i = items.indexOf(document.activeElement);
      ev.preventDefault();
      if (i < 0) {
        (ev.shiftKey ? okBtn : closeBtn).focus();
        return;
      }
      items[(i + (ev.shiftKey ? items.length - 1 : 1)) % items.length].focus();
    }
    mask.addEventListener("click", function () { finish(false); });
    closeBtn.addEventListener("click", function () { finish(false); });
    cancelBtn.addEventListener("click", function () { finish(false); });
    okBtn.addEventListener("click", function () { finish(true); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    okBtn.focus();
  });
}

/** 页面内提示（替代 window.alert），只有「确定」按钮。 */
function scAlert(title, body) {
  return scConfirm(title, { title: title, body: body || "", okText: "确定", alert: true });
}

/** 撤回：直接挂进用户消息下方已有的操作行。官方 nodes 没有 forEach，且 React 会清掉 portal。 */
function UserRetractHost(props) {
  var enabled = useScEnabled();
  var chat = chatOf(props);
  var sessionId = props.sessionId;
  var sessions = props._sessions;
  var signature = enabled && sessionId ? listUserAnchors(chat).map(function (row) { return row.key + "\0" + row.seq; }).join("\n") : "";

  React.useLayoutEffect(function () {
    var owned = [];
    function removeOwned() {
      for (var i = 0; i < owned.length; i++) {
        if (owned[i].parentNode) owned[i].parentNode.removeChild(owned[i]);
      }
      owned = [];
    }
    if (!signature || !sessionId) {
      removeOwned();
      return;
    }
    var rows = signature.split("\n").map(function (line) {
      var cut = line.indexOf("\0");
      return { key: line.slice(0, cut), seq: Number(line.slice(cut + 1)) };
    });
    function ensure(host, seq) {
      var btn = host.querySelector(':scope > [data-dsw-retract="' + seq + '"]');
      if (btn) return;
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dsw-sc-action";
      btn.dataset.dswRetract = String(seq);
      btn.title = "撤回：收起本回合及之后的内容";
      btn.setAttribute("aria-label", "撤回");
      btn.innerHTML = RETRACT_ICON_HTML;
      btn.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (btn.disabled || btn.dataset.confirming) return;
        btn.dataset.confirming = "1";
        scConfirm("确定撤回该回合及之后的内容？", { okText: "撤回", cancelText: "取消" }).then(function (ok) {
          delete btn.dataset.confirming;
          if (!ok) return;
          if (btn.isConnected) {
            btn.disabled = true;
            btn.setAttribute("data-busy", "");
          }
          return scPost("/session/retract", { sessionId: sessionId, userMessageSeq: seq });
        }).then(function (j) {
          if (!j || !btn.isConnected) return;
          btn.disabled = false;
          btn.removeAttribute("data-busy");
          noteLiveReplace(sessionId, j);
          if (j.applied === "live" && !pageAheadOfCut(chat, j)) return;
          return settleSession(sessions, sessionId).then(function (refreshed) {
            if (!refreshed && j.hint) {
              scAlert("需要刷新会话", j.hint);
            }
          });
        }).catch(function (e) {
          if (btn.isConnected) {
            btn.disabled = false;
            btn.removeAttribute("data-busy");
          }
          scAlert("操作失败", String(e && e.message || e));
        });
      });
      host.appendChild(btn);
      owned.push(btn);
    }
    var alive = true;
    function scan() {
      if (!alive) return;
      for (var i = 0; i < rows.length; i++) {
        var host = userActionHost(rows[i].key);
        if (host) ensure(host, rows[i].seq);
      }
    }
    scan();
    var root = document.querySelector("[data-conversation-scroll]") || document.body;
    var obs = new MutationObserver(scan);
    obs.observe(root, { childList: true, subtree: true });
    return function () {
      alive = false;
      obs.disconnect();
      removeOwned();
    };
  }, [signature, sessionId, sessions]);

  return null;
}

/** 确认重试/撤回后，按替换标记收起原输出，新回复留在页面上。 */
function ReplacedOutputHost(props) {
  var enabled = useScEnabled();
  var epoch = useScHideEpoch();
  var chat = chatOf(props);
  var sessionId = props.sessionId;
  var sessions = props._sessions;
  var signature = "";
  if (enabled && sessionId) {
    var parts = [];
    eachChatNode(chat, function (node) {
      if (!node || node.key == null) return;
      parts.push(String(node.key) + ":" + String(node.anchorSeq == null ? "" : node.anchorSeq) + ":" + String(node.kind || ""));
    });
    signature = parts.join("\n") + "\0" + epoch;
  }

  React.useLayoutEffect(function () {
    if (!signature || !sessionId) {
      applyReplacedHide(null, { ranges: [], ids: [] });
      return;
    }
    var alive = true;
    var scheduled = false;
    function apply() {
      if (!alive) return;
      var read = sessionEventEntries(sessions, sessionId);
      applyReplacedHide(chat, rangesForSession(sessionId, read.entries));
    }
    function schedule() {
      if (scheduled || !alive) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        apply();
      });
    }
    apply();
    var unsub = function () {};
    var read = sessionEventEntries(sessions, sessionId);
    if (read.source && typeof read.source.subscribe === "function") {
      try {
        var off = read.source.subscribe(schedule);
        if (typeof off === "function") unsub = off;
      } catch (_) {}
    }
    var root = document.querySelector("[data-conversation-scroll]") || document.body;
    var obs = new MutationObserver(schedule);
    obs.observe(root, { childList: true, subtree: true });
    return function () {
      alive = false;
      try { unsub(); } catch (_) {}
      obs.disconnect();
    };
  }, [signature, sessionId, sessions]);

  return null;
}

/** 重试，只出现在复制与分支之间。 */
function AssistantSessionActions(props) {
  var enabled = useScEnabled();
  var busyState = React.useState(false);
  var busy = busyState[0], setBusy = busyState[1];
  var pendingRef = React.useRef(false);
  var sessions = props._sessions;
  var chat = chatOf(props);
  if (!enabled || props.messageId == null) return null;
  var seq = assistantSeqForMessage(chat, props.messageId);
  var sessionId = props.sessionId;
  if (!sessionId) return null;

  function run(path, confirmMsg, confirmOptions) {
    if (busy || pendingRef.current) return;
    pendingRef.current = true;
    scConfirm(confirmMsg, confirmOptions).then(function (ok) {
      pendingRef.current = false;
      if (!ok) return;
      setBusy(true);
      var body = { sessionId: sessionId };
      if (Number.isSafeInteger(seq)) body.userMessageSeq = seq;
      if (props.messageId != null) body.messageId = props.messageId;
      scPost(path, body).then(function (j) {
        noteLiveReplace(sessionId, j);
        if (pageAheadOfCut(chat, j)) {
          return settleSession(sessions, sessionId).then(function () { setBusy(false); });
        }
        if (j && j.applied === "live") {
          if (j.prompt && j.prompt.ok === false && j.prompt.error) throw new Error(j.prompt.error);
          setBusy(false);
          return;
        }
        return settleSession(sessions, sessionId).then(function (refreshed) {
          setBusy(false);
          if (!refreshed && j && j.needReload && j.hint) {
            scAlert("需要刷新会话", j.hint);
          }
        });
      }).catch(function (e) {
        setBusy(false);
        scAlert("操作失败", String(e && e.message || e));
      });
    });
  }

  return h("button", {
      type: "button",
      className: "dsw-sc-action",
      title: "重试：收起这条回复并立刻重新生成",
      "aria-label": "重试",
      disabled: busy,
      "data-busy": busy || undefined,
      onClick: function () {
        run("/session/regenerate", "确定重试？", { okText: "重试", cancelText: "取消" });
      }
    }, iconRetry());
}

function ComposerPauseFuse(props) {
  var enabled = useScEnabled();
  var busyState = React.useState(false);
  var busy = busyState[0], setBusy = busyState[1];
  var sessionId = props.sessionId;
  if (!enabled || !sessionId) return null;

  return h("button", {
    type: "button",
    className: "dsw-sc-pause",
    title: "暂停 / 熔断：随时取消当前回合（含思考中，不依赖生成态）",
    "aria-label": "暂停",
    disabled: busy,
    onClick: function () {
      if (busy) return;
      setBusy(true);
      scPost("/session/cancel", { sessionId: sessionId, reason: "手动熔断（暂停）" }).then(function (j) {
        setBusy(false);
        if (j && j.ok === false) {
          scAlert("熔断失败", j.error || j.message || "");
        }
      }).catch(function (e) {
        setBusy(false);
        scAlert("熔断失败", String(e && e.message || e));
      });
    }
  }, iconStop());
}

function apply(ctx) {
  ctx.effect(function () {
    return ctx.slots.inject("settings.section", function () {
      return ctx.slots.register({
        name: "settings.section",
        id: "dsh-workbench",
        order: 60,
        label: function () { return "工作组件"; }
      }, SettingsPage);
    });
  }, "dsh-workbench: settings page");

  // Running toolview: pending/sending only. Settled gallery → conversation.chat.turnTail.
  ctx.slots.inject("tool.call.toolview", function () {
    var offSend = ctx.slots.register({ name: "tool.call.toolview", key: "mm_send_image" }, MmToolRow);
    return function () { if (offSend) offSend(); };
  });

  try {
    ctx.uiConversation.events.register(mmCardsDefinition);
  } catch (_) { /* uiConversation unavailable */ }

  ctx.effect(function () {
    return ctx.slots.inject("conversation.chat.turnTail", function () {
      return ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: "dsh-workbench-mm-cards",
        order: 25,
        inject: function (sessionId) {
          var ui = null;
          try { ui = ctx.uiConversation; } catch (_) { ui = null; }
          if (!ui || typeof ui.imageUrl !== "function") return {};
          return {
            loadImage: Object.assign(
              function (attachment) { return ui.imageUrl(sessionId, attachment); },
              {
                peek: typeof ui.peekImageUrl === "function"
                  ? function (attachment) { return ui.peekImageUrl(sessionId, attachment); }
                  : function () { return undefined; }
              }
            )
          };
        }
      }, MmTurnTail);
    });
  }, "dsh-workbench: mm cards turnTail");

  ctx.effect(function () {
    var styleEl = null;
    if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="' + SC_CSS_TAG + '"]')) {
      styleEl = document.createElement("style");
      styleEl.dataset.plugin = "dsh-workbench";
      styleEl.dataset.pluginCss = SC_CSS_TAG;
      styleEl.textContent = SC_CSS;
      document.head.appendChild(styleEl);
    }
    refreshScEnabled();
    var poll = window.setInterval(refreshScEnabled, 15000);
    return function () {
      window.clearInterval(poll);
      if (styleEl) styleEl.remove();
    };
  }, "dsh-workbench: session-controls styles");

  var sessions = null;
  try { sessions = ctx.get("sessions"); } catch (_) { sessions = null; }

  ctx.effect(function () {
    return ctx.slots.inject("conversation.chat.assistant-actions", function () {
      return ctx.slots.register({
        name: "conversation.chat.assistant-actions",
        id: "dsh-workbench-session-actions",
        order: 20,
        inject: function () { return { _sessions: sessions }; }
      }, AssistantSessionActions);
    });
  }, "dsh-workbench: assistant retract+retry");

  ctx.effect(function () {
    return ctx.slots.inject("conversation.input.right", function () {
      return ctx.slots.register({
        name: "conversation.input.right",
        id: "dsh-workbench-user-retract",
        order: 6,
        inject: function () { return { _sessions: sessions }; }
      }, UserRetractHost);
    });
  }, "dsh-workbench: user-message retract");

  ctx.effect(function () {
    return ctx.slots.inject("conversation.input.right", function () {
      return ctx.slots.register({
        name: "conversation.input.right",
        id: "dsh-workbench-replaced-output",
        order: 7,
        inject: function () { return { _sessions: sessions }; }
      }, ReplacedOutputHost);
    });
  }, "dsh-workbench: replaced output");

  ctx.effect(function () {
    return ctx.slots.inject("conversation.input.right", function () {
      return ctx.slots.register({
        name: "conversation.input.right",
        id: "dsh-workbench-pause-fuse",
        order: 5
      }, ComposerPauseFuse);
    });
  }, "dsh-workbench: composer pause=fuse");
}

exports.inject = inject;
exports.apply = apply;
exports.name = "dsh-workbench-client";
		return module.exports;
	}
});
