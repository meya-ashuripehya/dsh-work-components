window.__ModuleLoader__.load({
	id: "dsh-work-components",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
/**
 * dsh-workbench — 客户端半边（手写，无需构建）。
 *  1. settings.section「工作组件」设置页：首页是功能列表（按「多模态 / 工作组件 / 通道 / 游戏 / 通用 / 基础工具」分组，每行显示实时状态），
 *     点击一行进入该功能的管理页（运行状态、下载安装 + 启用旋钮、安装日志、配置），「‹ 返回」或 Esc 回到列表。
 *     列表上方的搜索框按名称 / 描述 / 分组名即时筛选（空格分隔的多个词须同时命中，不区分大小写），命中文字高亮；
 *     只给行和分组加 mm-search-out 类隐藏，不移除节点、不改设置、不拨开关；Esc 清空搜索。
 *     「启用」旋钮和安装按钮在同一行靠右，拨动立即保存（只改这一项）。列表行和管理页标题前带通用线条图标（内置 SVG，不用第三方标志）。
 *     组件状态：未安装 / 未启动 / 已启动（MCP 服务器已挂载）/ 已连接（对应程序在运行且 MCP 够得着它，绿色实心徽标）/ 出错；
 *     管理页状态行下面的连接行给出探测细节（程序未运行 / 未连接的原因）。有组件在探测连接时每 5 秒刷新一次状态。
 *     工作组件：Office / Blender / Unity / Godot（Python，uv 安装）、Figma / Photoshop / Chrome（npm，Node.js 安装）。
 *     组件可带安装行下面的说明（/components 里的 note，如 Godot 要装哪个版本的插件）和字段旁的动作按钮
 *     （Godot「安装插件到项目」：POST /dsh-workbench/api/components/godot/addon { project }，成功后记住项目路径）。
 *     「通道」：Telegram（仓库自带、默认关闭；设置全部在卡片里，不另开通道设置页）。可再加机器人，每个机器人单独的令牌、预设和 DSH 会话。状态：未启动 / 正在连接 / 已连接 / 未连接 / 出错，
 *     连接行显示实时说明或最近一条错误（已脱敏，不含会话内容）。机器人令牌保存到宿主凭据引用，GET 只回传占位值。
 *     「通用」：桌面控制、会话控制、网关核验、聊天室心跳、笔记、余额查询、uv、Node.js、下载代理（共享工具，与各工作组件并列成行，不埋在基础工具脚注里）。
 *     「基础工具」：添加工作组件——填写程序名称，复制给 AI 的接入提示词（只加可下载列表，不装进 tools/）。
 *     读写 /dsh-workbench/api/settings，状态来自 /dsh-workbench/api/components，
 *     「下载安装」调用 POST /dsh-workbench/api/components/<id>/install，安装期间轮询状态（不论当前在哪一页）。
 *  2. 多模态 MmCard：`mm_send_image`、`mm_send_file`、`map_card`、`route` 与 `calendar_show`。卡片宽度随内容收缩，不占满整行。同一回合里连续的同类型卡片弧形堆叠，点右侧露出部分翻到下一张。
 *     `mm_send_file` 按扩展名预览：图片、视频、音频直接播放；PDF、Markdown、Word、Excel、PowerPoint 显示抽出的正文。预览字节来自 /dsh-workbench/api/file-preview/<id>。
 *     日历面板同时用在聊天卡片和设置页「日历」。
 *     设置页「聊天室」：房间下拉（自绘）、对话记录经 /chatroom/rooms/<id>/events 流式显示、发送 / 继续一轮 / 停止；弹窗沿用 dsw-sc-modal。
 *     设置页「笔记」：三级树（类型 › 类别 › 笔记），浏览、查看、编辑、删除；弹窗沿用 dsw-sc-modal，下拉为自绘控件。
 *     运行中 `tool.call.toolview` 只显示 pending/sending；settled 后完整卡片挂在
 *     `conversation.chat.turnTail`（与 deliverables 同属 Host 产物表面），过程折叠后仍可见。
 *     数据经 ConversationNodeDefinition 写入 turn data `mmCards`（presentationMeta.mm / image 合成）；
 *     model 历史仍只含 text+image，不得含 type:mm。loadImage 经 inject uiConversation.imageUrl。
 * 所有网络请求都是同源 fetch 到宿主，插件前端不直连外部资源（CSP）。
 */
var React = require("react");
var h = React.createElement;
var createPortal = React.createPortal;
var ReactDOMClient = null;
try { ReactDOMClient = require("react-dom/client"); } catch (_) { ReactDOMClient = null; }
if (typeof createPortal !== "function") {
  try { createPortal = require("react-dom").createPortal; } catch (_) { createPortal = null; }
}

var API = "/dsh-workbench/api";

var STYLES = [
  ".mc-ag{display:flex;flex-direction:column;gap:6px}",
  ".mc-ag-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".mc-ag-title{flex:1;min-width:0;font-size:12px;color:var(--mm-muted)}",
  ".mc-ag-list{display:flex;flex-direction:column;gap:6px}",
  ".mc-ag-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 10px;border:1px solid var(--mm-border);border-radius:8px}",
  ".mc-ag-row.off{opacity:.6}",
  ".mc-ag-row.removed{opacity:.5;border-style:dashed}",
  ".mc-ag-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
  ".mc-ag-name{font-size:13px;font-weight:600}",
  ".mc-ag-sub{font-size:11px;color:var(--mm-muted);white-space:normal;overflow-wrap:anywhere}",
  ".mc-ag-sub.warn{color:var(--mm-warn)}",
  ".mc-ag-row .mm-btn{padding:2px 8px;font-size:12px}",
  ".mc-ag-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--mm-muted)}",
  ".mc-ag-dot.ok{background:#3a3}",
  ".mc-ag-dot.warn{background:#e55}",
  ".mc-ag-empty{font-size:12px;color:var(--mm-muted)}",
  ".mm-alias{display:flex;flex-direction:column;gap:8px}",
  ".mm-alias-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".mm-alias-toolbar label{font-weight:600;font-size:12px;margin:0}",
  ".mm-alias-toolbar .mm-select{min-width:140px;flex:0 0 auto}",
  ".mm-alias-count{flex:1;min-width:0;font-size:12px;color:var(--mm-muted)}",
  ".mm-alias-table{width:100%;border-collapse:collapse;font-size:12px}",
  ".mm-alias-table th,.mm-alias-table td{padding:6px 8px;border:1px solid var(--mm-border);text-align:left;vertical-align:middle}",
  ".mm-alias-table th{font-weight:600;background:var(--mm-input);color:var(--mm-muted);white-space:nowrap}",
  ".mm-alias-table input.mm-input,.mm-alias-table select.mm-input{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:5px 8px}",
  ".mm-alias-table .mm-btn{padding:2px 8px;font-size:12px;white-space:nowrap}",
  ".mm-alias-empty{font-size:12px;color:var(--mm-muted);padding:8px 0}",
  ".mm-alias-actions{display:flex;gap:4px;flex-wrap:wrap}",
  ".mm-page{font-size:13px;line-height:1.6;padding:14px 16px;max-width:640px;color:var(--mm-fg);--mm-fg:var(--dsw-alias-label-primary,var(--theme-text,CanvasText));--mm-muted:var(--dsw-alias-label-secondary,var(--theme-text-secondary,GrayText));--mm-border:var(--dsw-alias-border-l2,var(--theme-border,color-mix(in srgb,var(--mm-fg) 22%,transparent)));--mm-input:var(--dsw-alias-bg-layer-1,var(--theme-input-bg,color-mix(in srgb,var(--mm-fg) 6%,transparent)));--mm-accent:var(--dsw-alias-brand-primary,var(--theme-accent,#4a9eff));--mm-on-accent:var(--dsw-alias-label-primary-foreground,#fff);--mm-code-bg:var(--dsw-alias-markdown-code-block,var(--mm-input));--mm-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));--mm-live-fg:#000;--mm-warn:var(--dsw-alias-state-warn-label,#b45309);--mm-warn-border:#c9842a;--mm-sheen:#3d6f9e;--mm-sheen-hot:#9cc8f0}",
  "body[data-ds-dark-theme] .mm-page{--mm-live-fg:var(--dsw-alias-label-primary,#f9fafb);--mm-warn:#e0a84a;--mm-sheen:#8fb3d6;--mm-sheen-hot:#e7f3ff}",
  ".mm-page [hidden]{display:none!important}",
  ".mm-page h3{margin:0 0 4px;font-size:14px}",
  ".mm-page .mm-sub{color:var(--mm-muted);font-size:12px;margin:0 0 14px}",
  ".mm-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}",
  ".mm-field label{font-weight:600;font-size:12px}",
  ".mm-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
  ".mm-field-head .mm-btn{padding:2px 10px;font-size:11px}",
  ".mm-field-actions{display:flex;gap:8px;margin-top:2px}",
  ".mm-field-actions .mm-btn{padding:3px 10px;font-size:11px}",
  ".mm-field .mm-desc{color:var(--mm-muted);font-size:11px}",
  ".mm-input{background:var(--mm-input);color:var(--mm-fg);border:1px solid var(--mm-border);border-radius:6px;padding:6px 8px;font-size:12px;color-scheme:light}",
  "body[data-ds-dark-theme] .mm-input{color-scheme:dark}",
  // 原生 <option> 弹出层在 Electron/Windows 上常忽略页面 CSS；选项样式仅作兜底，设置页下拉改用自定义 mm-select。
  "select.mm-input option,select.mm-input optgroup{background:var(--dsw-alias-bg-layer-2,var(--mm-input));color:var(--dsw-alias-label-primary,var(--mm-fg))}",
  ".mm-select{position:relative;width:100%}",
  ".mm-select-trigger{width:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;cursor:pointer;font:inherit;font-size:12px;line-height:1.4}",
  ".mm-select-trigger:focus-visible{outline:2px solid var(--mm-accent);outline-offset:1px}",
  ".mm-select-trigger::after{content:'\\25BE';flex:none;color:var(--mm-muted);font-size:11px;line-height:1}",
  ".mm-select[data-open=true] .mm-select-trigger::after{content:'\\25B4'}",
  ".mm-select-menu{position:absolute;z-index:80;left:0;right:0;top:calc(100% + 4px);max-height:240px;overflow:auto;padding:4px;border:1px solid var(--mm-border);border-radius:6px;background:var(--dsw-alias-bg-layer-2,var(--mm-input));color:var(--dsw-alias-label-primary,var(--mm-fg));box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.22))}",
  ".mm-select-menu[hidden]{display:none!important}",
  ".mm-select-option{display:block;width:100%;box-sizing:border-box;margin:0;padding:6px 8px;border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}",
  ".mm-select-option:hover,.mm-select-option:focus-visible{background:var(--mm-hover);outline:none}",
  ".mm-select-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-active,var(--mm-hover));font-weight:600}",
  // 下拉弹层必须不透明：bg-layer-2 在深色 / 毛玻璃主题下是半透明的，叠在不透明底色上，避免选项与下方字段重叠。设置页 mm-select 与笔记 nt-sel 共用。
  ".mm-select-menu,.nt-sel-menu{--mm-pop-base:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-0,var(--theme-bg,Canvas)));background:linear-gradient(var(--dsw-alias-bg-layer-2,transparent),var(--dsw-alias-bg-layer-2,transparent)),var(--mm-pop-base);background-color:var(--mm-pop-base);color-scheme:inherit;z-index:1000;box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.28));-webkit-backdrop-filter:none;backdrop-filter:none}",
  ".mm-select[data-open=true],.nt-sel[data-open=true]{z-index:1000}",
  ".mm-row{display:flex;gap:8px;align-items:center;margin-top:6px}",
  ".mm-btn{background:var(--mm-accent);color:var(--mm-on-accent);border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px}",
  ".mm-btn:disabled{opacity:.45;cursor:not-allowed}",
  ".mm-msg{font-size:12px;color:var(--mm-muted)}",
  ".mm-msg.err{color:#e55}",
  ".mm-section{margin:18px 0 6px;padding-top:12px;border-top:1px solid var(--mm-border);font-weight:600;font-size:13px}",
  ".mm-status{font-size:12px;margin:-4px 0 12px;word-break:break-all}",
  ".mm-status.on{color:#3a3}",
  ".mm-status.error{color:#e55}",
  ".mm-status.off{color:var(--mm-muted)}",
  ".mm-status.missing{color:#d93}",
  ".mm-status.ready{color:#3a3}",
  ".mm-status.connected{color:#2da44e;font-weight:600}",
  ".mm-status.connecting{color:var(--mm-accent)}",
  ".mm-status.disconnected{color:#d93}",
  // 连接行（管理页状态行下面）：已连接 / 程序未运行 / 未连接 / 正在检查
  ".mm-conn{position:relative;font-size:12px;margin:-8px 0 12px;padding-left:14px;word-break:break-all;color:var(--mm-muted)}",
  ".mm-conn::before{content:\"\";position:absolute;left:1px;top:.55em;width:7px;height:7px;border-radius:50%;background:currentColor}",
  ".mm-conn.connected{color:#2da44e}",
  ".mm-conn.no-app,.mm-conn.unreachable{color:#d93}",
  ".mm-conn.mcp-down{color:#e55}",
  ".mm-conn.connecting{color:var(--mm-accent)}",
  ".mm-conn.disconnected{color:#d93}",
  ".mm-install{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:-6px 0 8px}",
  ".mm-install .mm-istate{flex-basis:100%}", // 安装步骤单独一行，按钮行不挤
  ".mm-btn.mm-ghost{background:transparent;color:var(--mm-fg);border:1px solid var(--mm-border)}",
  ".mm-btn.mm-ghost:hover:not(:disabled){background:var(--mm-hover)}",
  ".mm-istate{font-size:12px;color:var(--mm-muted);word-break:break-all}",
  ".mm-istate.installing,.mm-istate.queued{color:var(--mm-accent)}",
  ".mm-istate.done{color:#3a3}",
  ".mm-istate.error{color:#e55}",
  ".mm-log{margin:0 0 12px;font-size:12px}",
  ".mm-log summary{cursor:pointer;color:var(--mm-muted);display:flex;align-items:baseline;gap:10px;list-style:none}",
  ".mm-log summary::-webkit-details-marker{display:none}",
  ".mm-log summary::marker{content:none}",
  ".mm-log-label{flex:none}",
  ".mm-log-label::before{content:'\\25B8\\00a0';font-size:10px}",
  ".mm-log[open] .mm-log-label::before{content:'\\25BE\\00a0'}",
  // 实时行：靠右，过长省略。两层叠字：底层整行白色（未下载），上层同样的字用淡蓝流光，按百分比从左裁切（已下载）。百分比未知时上层铺满。
  ".mm-log-live{position:relative;flex:0 1 auto;margin-left:auto;min-width:0;max-width:100%;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;font-weight:400;line-height:1.4;color:var(--mm-live-fg)}",
  ".mm-log-live[hidden]{display:none}",
  ".mm-log-live-text,.mm-log-live-sheen{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}",
  ".mm-log-live-sheen{position:absolute;left:0;top:0;width:100%;height:100%;color:var(--mm-sheen);pointer-events:none;background-image:linear-gradient(100deg,var(--mm-sheen) 0%,var(--mm-sheen) 38%,var(--mm-sheen-hot) 50%,var(--mm-sheen) 62%,var(--mm-sheen) 100%);background-size:250% 100%;background-repeat:no-repeat;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:mm-live-sheen 2.4s linear infinite}",
  "@keyframes mm-live-sheen{from{background-position:100% 0}to{background-position:0% 0}}",
  "@media (prefers-reduced-motion:reduce){.mm-log-live-sheen{animation:none;background-image:none;-webkit-text-fill-color:currentColor;color:var(--mm-sheen)}}",
  ".mm-log pre{max-height:180px;overflow:auto;margin:4px 0 0;padding:6px 8px;border-radius:6px;background:var(--mm-code-bg);color:var(--mm-fg);border:1px solid var(--mm-border);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all}",
  // 功能列表（首页）
  ".mm-group{margin:16px 0 6px;font-size:12px;font-weight:600;color:var(--mm-muted)}",
  ".mm-list{border:1px solid var(--mm-border);border-radius:8px;overflow:hidden}",
  // 首页搜索：筛选只加类隐藏，不移除节点；命中文字用淡色强调底
  ".mm-page .mm-search-out{display:none!important}",
  ".mm-search{margin:4px 0 0}",
  ".mm-search .mm-input{display:block;width:100%;box-sizing:border-box;padding:7px 10px;font-size:13px}",
  ".mm-search .mm-input:focus-visible{outline:2px solid var(--mm-accent);outline-offset:1px}",
  ".mm-search-empty{margin:16px 0 6px;padding:18px 12px;border:1px dashed var(--mm-border);border-radius:8px;text-align:center;font-size:12px;color:var(--mm-muted)}",
  ".mm-hl{background:color-mix(in srgb,var(--mm-accent) 30%,transparent);color:inherit;border-radius:2px;padding:0}",
  ".mm-item{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;outline:none;user-select:none}",
  ".mm-item+.mm-item{border-top:1px solid var(--mm-border)}",
  ".mm-item:hover{background:var(--mm-hover)}",
  ".mm-item:focus-visible{box-shadow:inset 0 0 0 2px var(--mm-accent)}",
  ".mm-item-main{flex:1;min-width:0}",
  ".mm-item-name{font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:6px;min-width:0}",
  ".mm-item-desc{color:var(--mm-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".mm-chev{flex:none;color:var(--mm-muted);font-size:18px;line-height:1}",
  ".mm-badge{flex:none;font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;border:1px solid currentColor;white-space:nowrap;color:var(--mm-muted)}",
  ".mm-badge.on,.mm-badge.ready{color:#3a3}",
  ".mm-badge.connected{color:#fff;background:#2da44e;border-color:#2da44e;font-weight:600}",
  ".mm-badge.error{color:#e55}",
  ".mm-badge.missing{color:#d93}",
  ".mm-badge.busy{color:var(--mm-accent)}",
  ".mm-badge.connecting{color:var(--mm-accent)}",
  ".mm-badge.disconnected{color:#d93}",
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
  ".mm-tmsg{font-size:12px;color:var(--mm-muted);word-break:break-all}",
  ".mm-tmsg.err{color:#e55}",
  ".mm-tmsg:empty{display:none}",
  ".mm-switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;margin:0;padding:0;border:1px solid var(--mm-border);border-radius:10px;background:rgba(127,127,127,.32);cursor:pointer;transition:background-color .15s,border-color .15s}",
  ".mm-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.4);transition:transform .15s}",
  ".mm-switch[aria-checked=true]{background:var(--mm-accent);border-color:var(--mm-accent)}",
  ".mm-switch[aria-checked=true]::after{transform:translateX(16px)}",
  ".mm-switch:focus-visible{outline:2px solid var(--mm-accent);outline-offset:2px}",
  ".mm-switch:disabled{opacity:.45;cursor:not-allowed}",
  ".mm-switch[aria-busy=true]{cursor:progress}",
  ".mm-note{color:var(--mm-muted);font-size:11px;margin:-2px 0 10px}",
  // 组件说明（安装行下面，如 Godot 插件版本）与字段旁的动作按钮（安装插件到项目）
  ".mm-cnote{font-size:11px;line-height:1.55;margin:-2px 0 12px;padding:6px 9px;border:1px solid var(--mm-border);border-radius:6px;color:var(--mm-muted);word-break:break-all}",
  ".mm-action{flex-wrap:wrap;margin:2px 0 0}",
  ".mm-amsg{flex:1;min-width:0;font-size:12px;color:var(--mm-muted);word-break:break-all}",
  ".mm-amsg.ok{color:#3a3}",
  ".mm-amsg.err{color:#e55}",
  ".mm-amsg:empty{display:none}",
  ".mm-warn{font-size:12px;line-height:1.55;margin:0 0 14px;padding:8px 10px;border-radius:6px;border:1px solid var(--mm-warn-border);background:rgba(201,132,42,.12);color:var(--mm-warn);word-break:break-word;white-space:pre-line}",
  ".mm-msg.ok{color:#3a3}",
  ".mm-src{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid var(--mm-border);color:var(--mm-muted);white-space:nowrap}",
  ".mm-src.bundled{color:#6a9;border-color:#6a9}",
  ".mm-src.local{color:#c9842a;border-color:#c9842a}",
  ".mm-src.experimental{color:var(--mm-muted,#888);border-color:var(--mm-border,#999);background:rgba(127,127,127,.12)}",
  ".mm-item-name .mm-src{margin-left:2px}",
  ".mm-dhead .mm-src{margin-left:4px}",
  ".mm-pr{margin:12px 0;padding:10px;border:1px solid var(--mm-border);border-radius:8px;background:rgba(127,127,127,.06)}",
  ".mm-pr h4{margin:0 0 6px;font-size:12px}",
  ".mm-pr p{margin:0 0 8px;font-size:12px;color:var(--mm-muted);line-height:1.55}",
  ".mm-pr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".mm-pr pre{margin:8px 0 0;max-height:160px;overflow:auto;padding:6px 8px;border-radius:6px;background:var(--mm-code-bg);color:var(--mm-fg);border:1px solid var(--mm-border);font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all}",
  ".mm-copy-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px}"
].join("\n");

// 设置项（按 key 引用）。type "switch" 是管理页里安装按钮行右侧的「启用」旋钮，拨动即保存，不进下方字段区。
var INPUT_FIELDS = [
  { key: "mapEnabled", label: "启用", type: "switch", desc: "启用后提供地理编码、地点检索、地点详情、路线规划、天气预报、静态地图卡片与可点击的路线图。路线图点开后进入高德导航；分享链接可通过 Telegram 发送或复制到系统浏览器打开。不会写入高德账号收藏夹。关闭后这些工具从会话中卸下。默认关闭。" },
  { key: "gaodeApiKey", label: "高德 Key", type: "password", placeholder: "Web 服务 Key", desc: "高德开放平台的 Web 服务 Key。只保存在这里，不读取环境变量。未填写时即使打开启用也不会挂工具。" },
  { key: "gptImageEnabled", label: "启用", type: "switch", desc: "启用后向会话提供 image_generate（文生图）与 image_edit（图片编辑）两个工具，调用 OpenAI 兼容的 Images API。生成的图片只写入插件数据目录 images/<日期>/。每次出图由服务商计费。关闭后工具从会话中卸下，已生成的图片仍保留。默认关闭。" },
  { key: "gptImageApiKey", label: "API Key", type: "password", placeholder: "sk-…", desc: "生图服务的 API Key。只保存在本插件设置中，不读取环境变量；设置接口只返回掩码，不以明文返回。未填写时即使打开「启用」也不会挂载工具。" },
  { key: "gptImageBaseUrl", label: "Base URL", type: "text", placeholder: "https://api.openai.com/v1", desc: "OpenAI 兼容接口地址，通常以 /v1 结尾。留空时使用 https://api.openai.com/v1。" },
  { key: "gptImageModel", label: "模型", type: "text", placeholder: "gpt-image-2", desc: "生图模型名称，默认 gpt-image-2。可改为服务商提供的其它兼容模型。" },
  { key: "gptImageSize", label: "默认尺寸", type: "select", options: [{ value: "auto", label: "自动" }, { value: "1024x1024", label: "1024×1024（方形）" }, { value: "1536x1024", label: "1536×1024（横向）" }, { value: "1024x1536", label: "1024×1536（纵向）" }], desc: "模型未指定尺寸时使用的默认值。" },
  { key: "gptImageQuality", label: "默认质量", type: "select", options: [{ value: "auto", label: "自动" }, { value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" }], desc: "模型未指定质量时使用的默认值。质量越高，费用越高、耗时越长。" },
  { key: "gptImageTimeoutSec", label: "请求超时（秒）", type: "number", min: 30, max: 900, desc: "单次生图请求的超时时间，30 至 900 秒，默认 300。" },
  { key: "videoEnabled", label: "启用", type: "switch", desc: "启用后经 Google Gemini 观看视频：聊天室中的每个视频（本机上传、Telegram 群发送，以及消息中的 YouTube / 哔哩哔哩链接）都会在后台生成带时间戳的中文内容描述，显示在「视频 · 内容描述」卡片里并提供给所有成员，成员还可调用 watch_video 就某一段提问；原生 Gemini 成员可开启「视频输入」直接观看。会话中另提供 describe_video 与 watch_video 两个工具。关闭后上述功能全部停用，工具从会话中卸下，已保存的视频与描述保留。默认开启。" },
  { key: "videoCredentialSource", label: "凭据来源", type: "select", options: [{ value: "apiKey", label: "Gemini API Key" }, { value: "serviceAccount", label: "Google Cloud 服务账号 JSON" }], desc: "选择用哪种凭据访问 Gemini。API Key 走 Google AI Studio（支持 Files API 上传大视频）；服务账号 JSON 走 Vertex AI：≤20 MB 内联，更大需在下方填写 Cloud Storage 桶。默认 API Key。" },
  { key: "videoGeminiKey", label: "Gemini API 密钥", type: "password", placeholder: "AIza…", desc: "视频理解专用的 Google Gemini API 密钥，可在 Google AI Studio 创建。只保存在本插件设置中，不沿用聊天室转写密钥或成员凭据，不读取环境变量；界面只显示末四位掩码。凭据来源为服务账号时忽略。未填写时状态显示「未配置密钥」，视频不会被观看。" },
  { key: "videoServiceAccountFile", label: "服务账号文件", type: "text", readOnly: true, placeholder: "未上传", desc: "服务账号 JSON 在数据目录下的相对路径。通过下方「选择 JSON 文件」上传；界面只显示文件名与 client_email、project_id，不回传私钥。" },
  { key: "videoVertexLocation", label: "Vertex 区域", type: "text", placeholder: "us-central1", desc: "凭据来源为服务账号时，Vertex AI 的区域 ID，默认 us-central1。" },
  { key: "videoBucket", label: "Cloud Storage 桶", type: "text", placeholder: "my-project-video-bucket", desc: "服务账号模式下大视频（超过 20 MB）上传到此桶，请求中以 gs:// 引用。留空则只支持 20 MB 以内。不会自动创建桶；可点「检查存储桶」验证读写删权限。" },
  { key: "videoBucketPrefix", label: "桶内路径前缀", type: "text", placeholder: "dsh-video", desc: "对象路径前缀，默认 dsh-video。只允许小写字母、数字和连字符。" },
  { key: "videoMaxHeight", label: "下载清晰度上限（px）", type: "text", placeholder: "480", desc: "服务账号模式用 yt-dlp 下载哔哩哔哩时的最大高度（像素），默认 480。API Key 模式忽略。" },
  { key: "videoBaseUrl", label: "Base URL", type: "text", placeholder: "https://generativelanguage.googleapis.com", desc: "Gemini API 的访问地址。留空时使用 Google AI Studio 默认地址 https://generativelanguage.googleapis.com；也可填写兼容的代理或网关地址（须以 http:// 或 https:// 开头，末尾斜杠会被去掉，格式无效时使用默认地址）。密钥只放在请求头中发送。" },
  { key: "videoModel", label: "模型", type: "text", placeholder: "gemini-3.8-flash", desc: "视频理解模型，默认 gemini-3.8-flash（Gemini API generateContent）。访问 Gemini 时沿用聊天室的 Telegram 代理设置。" },
  { key: "videoYoutube", label: "YouTube 链接", type: "switch", desc: "处理消息或工具参数中的 YouTube 公开链接：直接交给 Gemini 观看，不下载。私享或受限视频无法观看。默认开启。" },
  { key: "videoBilibili", label: "哔哩哔哩链接", type: "switch", desc: "处理哔哩哔哩链接：需要 yt-dlp（本插件不附带，可在下方点击「下载 yt-dlp」从官方 GitHub 发布页下载），下载到插件数据目录后按普通视频处理，单个不超过 25 MB；未检测到 yt-dlp 或下载失败时会给出原因。默认开启。" },
  { key: "videoYtdlpPath", label: "yt-dlp 路径", type: "text", placeholder: "C:\\Tools\\yt-dlp.exe", desc: "可选。填写后优先使用该程序；留空时先找 PATH，再用「下载 yt-dlp」下载到插件数据目录 bin 文件夹的副本。" },
  { key: "mapBypassProxy", label: "绕过代理", type: "switch", desc: "开启后，高德请求使用独立的直连，不附带下载代理或环境变量中的 HTTP 代理，直接连接 restapi.amap.com。默认开启。关闭后沿用当前进程的代理设置。" },
  { key: "calendarEnabled", label: "启用", type: "switch", desc: "启用后提供公历、农历、节气、中国法定节假日、日程和天气预报。默认开启。关闭后这些工具从会话中卸下，已保存的日程仍留在数据目录。" },
  { key: "notesEnabled", label: "启用", type: "switch", desc: "启用后，智能体可以通过笔记工具浏览、检索、新建、修改和删除笔记，把任务中总结出的要点与知识库中没有的新知识沉淀下来，供后续任务复用。默认关闭。关闭后工具从会话中卸下，已保存的笔记仍保留在数据目录。" },
{ key: "preCompactionHistoryEnabled", label: "启用", type: "switch", desc: "启用后，智能体可调用 search_pre_compaction 检索官方压缩（/compact 或自动压力压缩）后被 compact-checkpoint 遮蔽的原始回合。会话日志仍保留全文，模型可见面只剩摘要；本工具只读、仅当前会话。默认开启。关闭后卸下工具。" },
  { key: "companionCompactionEnabled", label: "启用陪伴向压缩指令", type: "switch", desc: "启用后，官方压缩（/compact 或自动压力压缩）调用 LLM 时，用陪伴向检查点结构覆盖官方编码助手压缩指令。默认开启。关闭后恢复官方指令。与「压缩前历史」工具相互独立：原始日志与 search_pre_compaction 仍可用。" },
  { key: "companionCompactionInstruction", label: "自定义压缩指令", type: "textarea", placeholder: "留空=内置中文陪伴检查点", desc: "可选。填写后整段替换内置陪伴压缩指令；留空使用内置中文结构（关系与人物、情绪与氛围等）。勿放入密钥或隐私令牌。" },
  { key: "stickersEnabled", label: "启用", type: "switch", desc: "启用后向会话提供 sticker_search / sticker_save / sticker_send。在本页管理表情包与标签；发送时按普通图片出站（桌面卡片 / QQ / Telegram）。默认开启。关闭后工具卸下，已保存的表情包仍保留在数据目录 stickers/。" },
  { key: "stickersDefaultPackId", label: "默认包 ID", type: "text", placeholder: "留空=「默认」包", desc: "导入或 sticker_save 未指定包时写入的包 id。留空则使用名为「默认」的包。" },
  { key: "crossSessionMemoryEnabled", label: "启用", type: "switch", desc: "启用跨会话记忆工具 cross_session_list / cross_session_search，并在 QQ/Telegram 入站时注入短 [person-memory] 称呼摘要。默认开启。关闭后卸下工具并停止摘要。" },
  { key: "crossSessionOwnerTelegramIds", label: "OwnerLink · Telegram ID", type: "text", placeholder: "留空=默认 6153059771", desc: "记忆圈所有者的 Telegram 数字用户 ID，逗号或空格分隔。留空使用内置 Shiro 默认。" },
  { key: "crossSessionOwnerQqOpenIds", label: "OwnerLink · QQ OpenID", type: "text", placeholder: "留空=默认 B4C6…", desc: "记忆圈所有者的 QQ OpenID，逗号或空格分隔。留空使用内置 Shiro 默认。" },
  { key: "crossSessionPresets", label: "共享预设", type: "text", placeholder: "lingsnow", desc: "可互查历史的智能体预设 ID。留空默认 lingsnow。" },
  { key: "crossSessionShareGroups", label: "包含群会话", type: "switch", desc: "开启后，记忆圈内的群聊会话也可被 list/search。默认开启。" },
  { key: "crossSessionAliases", label: "称呼别名", type: "aliastable", desc: "按通道类型管理用户/群 ID → 显示称呼。上方选择通道后，在表格中添加、编辑或删除映射。优先于从聊天记录提取的名字；QQ 官方 API 常无昵称时请在此填写。保存后仍以兼容的文本行写入设置。" },
  { key: "balanceEnabled", label: "启用", type: "switch", desc: "启用后按下方各服务商的设置查询余额或已用金额。默认关闭。每个服务商使用在此单独保存的密钥，不读取 DSH「设置 › 模型」中的密钥；只请求官方查询接口。" },
  { key: "balanceAiTool", label: "AI 查询工具", type: "switch", desc: "开启后（默认开启），在余额查询启用期间向会话提供 balance_query 工具，AI 可查询已启用服务商的余额或已用金额；工具只返回金额与币种，不含密钥。在 Telegram 中仅授权用户可用。" },
  { key: "balanceAutoRefreshMin", label: "自动刷新", type: "select", options: [{ value: "0", label: "关闭" }, { value: "10", label: "每 10 分钟" }, { value: "30", label: "每 30 分钟" }, { value: "60", label: "每 60 分钟" }], desc: "按所选间隔在后台重新查询全部已启用且已保存密钥的服务商。关闭时只在打开本页点击「刷新」或 AI 调用工具时查询。" },
  { key: "balanceLowThreshold", label: "低余额提示阈值", type: "number", min: 0, desc: "某服务商的余额低于该数值（按该服务商自身的币种比较）时，在本页醒目显示并弹出提示。0 为不提示。已用金额不参与比较。" },
  { key: "boardsEnabled", label: "启用", type: "switch", desc: "启用后，当前会话里的 AI 可以用棋类工具打开中国象棋、国际象棋、五子棋或围棋，并在对话右侧看棋盘。默认关闭。关闭后工具卸下，当前棋局结束，已下载的棋盘项目仍留在数据目录。" },
  { key: "boardsHintMs", label: "辅助引擎分析时长（毫秒）", type: "number", min: 100, max: 10000, desc: "每次给 AI 提示时引擎搜索的时长，默认 1000。时长越长提示越准，但每步等待越久。只在下载了辅助引擎时生效。" },
  { key: "boardsPlayerName", label: "用户名", type: "text", placeholder: "留空则为 user", desc: "显示在棋盘你这一侧。留空或只有空白时按 user。你落子后发给 AI 的句子是「用户名下在了…,现在是你的回合」。" },
  { key: "cardsEnabled", label: "启用", type: "switch", desc: "启用后，当前会话里的 AI 可以用牌类工具打开二十一点、勒杜克、限注德州、UNO 或斗地主，并在对话右侧看牌桌。默认关闭。关闭后工具卸下，当前牌桌收起，已下载的规则源和各会话存档仍留在数据目录。" },
  { key: "cardsUnoPlayers", label: "UNO 人数", type: "number", min: 2, max: 10, desc: "UNO 人数（含您本人），可设 2 至 10 人，默认 4 人。其余座位由插件内置的对手补齐。仅对新开的牌局生效；已有存档按存档中的人数续局。" },
  { key: "cardsPlayerName", label: "用户名", type: "text", placeholder: "留空则为 user", desc: "显示在牌桌上你这一侧。留空或只有空白时按 user。你出牌后发给 AI 的句子会带上这个名字。" },
  { key: "calendarCity", label: "天气城市", type: "text", placeholder: "例如 成都", desc: "留空则日历不请求天气。填写城市名后向 Open-Meteo 查询它能提供的全部预报天数，不使用高德 Key。请求沿用当前进程的代理，不走地图的「绕过代理」。未填写时历法和日程仍然可用。" },
  { key: "chatroomEnabled", label: "启用", type: "switch", desc: "启用后可在下方新建房间，与各 AI 成员协作讨论。默认关闭。关闭时停止进行中的发言，并停止接收 Telegram 群消息；已有记录仍保留在数据目录 chatroom/。房间成员从「席位管理」的席位池中挑选。" },
  { key: "chatroomUserName", label: "您的名字", type: "text", placeholder: "留空则显示为「用户」", desc: "各成员在对话稿中看到的您的名字。" },
  { key: "chatroomDefaultMain", label: "主答", type: "seatmain", desc: "从席位池中选择主答成员，无默认值。加入第一位席位时自动设为该席位；该席位被删除后清空。未选择时不可保存。消息中 @ 某位成员时，由该成员担任本任务的主答。" },
  { key: "chatroomTurnBudget", label: "每任务回合上限", type: "number", min: 1, max: 100, desc: "每个任务所有 AI 合计的发言回合数，默认 10。成员看不到该上限；用尽后暂停并提示您，回复「批准 +N」（或「批准」，追加 3 个回合）即可继续。" },
  { key: "chatroomGameAiStreak", label: "连续 AI 步数上限", type: "number", min: 0, max: 10000, desc: "同一局棋牌中，连续由 AI 行动达到该步数时自动暂停。界面与绑定群会提示，所有者回复「继续」恢复，回复「停止」立即暂停且不结束对局。0 表示不限制。默认 60。对局行动不占用讨论回合。" },
  { key: "chatroomMaxHistory", label: "上下文窗口（条）", type: "number", min: 0, max: 200, desc: "提示词中保留的最近可见消息条数（滚动摘要窗口）。压缩后更早的消息对 AI 隐藏，仍可在界面查看。0 为不限制窗口。默认 24。" },
  { key: "chatroomContextTokenThreshold", label: "自动压缩阈值（tokens）", type: "number", min: 10000, max: 2000000, desc: "估计某成员本次请求（系统提示、房间规则、工具定义与消息）达到该 token 数时自动滚动摘要；模型上下文窗口已知时，取其 75% 与该值中的较小者。中文约每字 1 token，其他文字约 4 个字符 1 token。默认 150000。未选择摘要模型时不自动压缩。" },
  { key: "chatroomSummarizerProvider", label: "摘要模型", type: "summaryroute", modelKey: "chatroomSummarizerModel", desc: "滚动摘要所用的独立小模型。列表与成员相同，仅包含 DSH「设置 › 模型」中已填写 API Key 的服务商；调用经 DSH 完成，密钥由 DSH 保管。选择「不启用」时不自动压缩。" },
  { key: "chatroomSummarizerModel", label: "摘要模型 id", type: "text", hidden: true, desc: "由上方「摘要模型」一并保存。" },
  { key: "chatroomMaxOutputTokens", label: "单次输出上限（tokens）", type: "number", min: 0, max: 32000, placeholder: "0 或不填 = 不设上限", desc: "每次发言的最大输出 token 数。填 0 或不填表示不设上限（不向服务商发送上限，仅受该模型自身输出上限约束）。设置正数时，提供工具的步骤至少按 4096 计，以免工具调用因截断被丢弃；截断时房间中会显示提示。" },
  { key: "chatroomOwnerTelegramId", label: "所有者 Telegram 用户 ID", type: "text", placeholder: "例：123456789", desc: "只有该用户（或本机桌面端）可以「批准 +N」追加回合，以及回复「执行」运行 Cursor 任务。留空时，Telegram 上的这些所有者操作一律拒绝；本机桌面端仍视为所有者。" },
  { key: "chatroomTelegramProxy", label: "机器人代理", type: "text", placeholder: "http://127.0.0.1:7890", desc: "聊天室机器人访问 Telegram Bot API 的 HTTP 代理。留空时沿用「通道 › Telegram」的代理设置。" },
  { key: "chatroomCursorAgentPath", label: "cursor-agent 路径", type: "text", placeholder: "留空则自动查找（PATH / 常见安装位置）", desc: "headless 模式运行的 cursor-agent 命令完整路径。留空时自动在 PATH 和常见安装位置查找；找不到时，执行任务会提示「未找到 cursor-agent」。" },
  { key: "chatroomCursorRepo", label: "Cursor 默认仓库", type: "text", placeholder: "例：D:\\projects\\my-app", desc: "任务书未指定目录时，Cursor 在此目录中运行。" },
  { key: "chatroomCursorTimeoutSec", label: "Cursor 超时（秒）", type: "number", min: 60, max: 14400, desc: "单次 Cursor 任务的超时时间，超时后结束整个进程树。默认 1800。" },
  { key: "chatroomHeartbeatEnabled", label: "心跳", type: "switch", desc: "回合正常结束（完成或结束本轮）后，经 DSH 宿主日程向所选会话投递一次提醒。默认关闭。新一轮发言开始时取消待投递提醒；相对延迟不可修改，刷新时删除后重建。" },
  { key: "chatroomHeartbeatIntervalMin", label: "心跳间隔（分钟）", type: "number", min: 1, max: 1440, desc: "回合结束后等待该分钟数再向目标会话投递。默认 30。" },
  { key: "chatroomHeartbeatSessionId", label: "心跳目标会话", type: "hbsession", desc: "须选择普通智能体会话（勿选标题为「聊天室：…」的房间会话）。选项来自本机会话元数据中的可读标题（名称/标题），并合并当前已加载会话；列表项显示「标题（编号）」。" },
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
  { key: "desktopEnabled", label: "启用", type: "switch", desc: "仅 Windows。按控件操作键鼠和截图。插件自带，打开即可，无需下载。模型可以操作与本进程相同完整性的窗口。不含文件、注册表和 PowerShell。" },
  { key: "desktopDock", label: "右侧停靠", type: "switch", desc: "开启后，本窗口以最小宽度停靠于屏幕右侧，当前操作的窗口自动铺满左侧。关闭后恢复各窗口原有位置。" },
  { key: "notionEnabled", label: "启用", type: "switch", desc: "首次连接会弹出 Notion 授权页；token 缓存在 %USERPROFILE%\\.mcp-auth。" },
  { key: "notionUrl", label: "远程地址", type: "text", desc: "默认 https://mcp.notion.com/mcp。" },
  { key: "notionPackage", label: "npm 包名（桥）", type: "text", desc: "默认 mcp-remote。已有 %USERPROFILE%\\.dsh\\mcp-remote 时可直接用，不必再装。" },
  { key: "gmailEnabled", label: "启用", type: "switch", desc: "需要填写 Gmail 地址和该地址的应用专用密码。send_message 会直接发信。" },
  { key: "gmailAddress", label: "Gmail 地址", type: "text", placeholder: "例：name@gmail.com", desc: "必填。要连接的 Gmail 地址。" },
  { key: "gmailAppPassword", label: "应用专用密码", type: "password", placeholder: "16 位应用专用密码", desc: "必填。在 Google 账号的「应用专用密码」页面生成的 16 位密码，不是 Gmail 登录密码。" },
  { key: "cloudflareEnabled", label: "启用", type: "switch", desc: "首次连接会弹出 Cloudflare 授权页；插件只预申请 offline_access，请在同意页勾选权限。" },
  { key: "cloudflareUrl", label: "远程地址", type: "text", desc: "默认 https://mcp.cloudflare.com/mcp。" },
  { key: "cloudflarePackage", label: "npm 包名（桥）", type: "text", desc: "默认 mcp-remote。" },
  { key: "cloudflare-docsEnabled", label: "启用", type: "switch", desc: "公开文档 MCP，无需登录。" },
  { key: "cloudflare-docsUrl", label: "远程地址", type: "text", desc: "默认 https://docs.mcp.cloudflare.com/mcp。" },
  { key: "githubEnabled", label: "启用", type: "switch", desc: "需要 GitHub PAT（设置或环境变量 GITHUB_MCP_PAT）。" },
  { key: "githubUrl", label: "托管端点", type: "text", desc: "默认 https://api.githubcopilot.com/mcp/。" },
  { key: "githubToken", label: "GitHub PAT", type: "password", placeholder: "ghp_… / github_pat_…", desc: "优先用这里的 token；留空时读用户环境变量 GITHUB_MCP_PAT。不要提交到 git。" },
  { key: "termalinEnabled", label: "启用", type: "switch", desc: "默认关闭。Termalin 工具会在服务器上执行命令，只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "termalinMode", label: "模式", type: "select", options: [{ value: "local", label: "本机（termalin-mcp）" }, { value: "hosted", label: "托管（API 密钥）" }], desc: "本机：运行 Termalin 应用自带的 termalin-mcp，所有套餐可用，需应用保持运行。托管：连接 termal.in，需 Pro 或试用，只能访问已注册 Connector 的服务器。OAuth 方式不支持。" },
  { key: "termalinCommand", label: "termalin-mcp 路径", type: "text", placeholder: "%LOCALAPPDATA%\\…\\termalin-mcp.exe", desc: "本机模式使用。路径见 Termalin「Settings → Security → Agent Access (MCP) → Connect an assistant」；留空时自动探测常见位置和 PATH。" },
  { key: "termalinUrl", label: "托管端点", type: "text", desc: "托管模式使用。默认 https://termal.in/api/v1/mcp。OAuth 端点 https://termal.in/mcp 不支持。" },
  { key: "termalinApiKey", label: "API 密钥", type: "password", placeholder: "tk_live_…", desc: "托管模式使用。在 termal.in/account →「API keys & MCP」创建。只保存在本机设置中，界面只显示掩码。" },
  { key: "fusionEnabled", label: "启用", type: "switch", desc: "默认关闭。连接 Fusion 内置的官方 MCP Server。只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "fusionUrl", label: "服务器地址", type: "text", placeholder: "http://127.0.0.1:27182/mcp", desc: "在 Fusion「Preferences → General → API」勾选 Fusion MCP Server 并点「Apply」，端口以那里显示的为准。服务器没有只读模式：fusion_mcp_read 只读，fusion_mcp_execute / fusion_mcp_update 会改动设计。" },
  { key: "freecadEnabled", label: "启用", type: "switch", desc: "默认关闭。需在 FreeCAD 中安装 MCP Addon 并点「Start RPC Server」。只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "freecadCommand", label: "启动命令", type: "text", placeholder: "uvx freecad-mcp", desc: "stdio 启动命令，默认 uvx freecad-mcp（首次运行从 PyPI 下载）。" },
  { key: "freecadHost", label: "FreeCAD 主机", type: "text", placeholder: "localhost", desc: "本机保持 localhost。连接其他电脑时需在 Addon 中开启 Remote Connections 并设置认证令牌。" },
  { key: "freecadTextOnly", label: "仅文字反馈", type: "switch", desc: "不附截图，减少上下文占用（--only-text-feedback）。" },
  { key: "freecadToken", label: "认证令牌", type: "password", desc: "可选。与 Addon「Set Auth Token」一致；只保存在本机设置中，界面只显示掩码。" },
  { key: "matlabEnabled", label: "启用", type: "switch", desc: "默认关闭。MATLAB MCP Server 只能按 MathWorks 软件许可协议与 MATLAB 一起使用，不得多人共用。只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "matlabServerPath", label: "服务器路径", type: "text", placeholder: "C:\\Tools\\matlab-mcp-server-windows-x64.exe", desc: "从 GitHub Releases 下载的 matlab-mcp-server 可执行文件；留空时在 PATH 中查找。" },
  { key: "matlabRoot", label: "MATLAB 目录", type: "text", placeholder: "C:\\Program Files\\MATLAB\\R2026a", desc: "可选（--matlab-root，不含 bin）；留空时用 PATH 中的 MATLAB。「连接现有会话」模式下不使用。" },
  { key: "matlabWorkFolder", label: "工作文件夹", type: "text", desc: "可选（--initial-working-folder）。「连接现有会话」模式下不使用。" },
  { key: "matlabDisplayMode", label: "显示方式", type: "select", options: [{value: "desktop", label: "显示 MATLAB 桌面"},{value: "nodesktop", label: "不显示桌面"}], desc: "--matlab-display-mode。" },
  { key: "matlabSessionMode", label: "会话模式", type: "select", options: [{value: "auto", label: "自动（优先连接现有会话）"},{value: "new", label: "总是新建"},{value: "existing", label: "连接现有会话"}], desc: "连接现有会话需先运行 matlab-mcp-server --setup-matlab，并在 MATLAB 中执行 shareMATLABSession()（R2023a 起）。" },
  { key: "matlabTelemetry", label: "匿名数据收集", type: "switch", desc: "默认关闭（传 --disable-telemetry=true）。打开后允许向 MathWorks 发送匿名使用数据。" },
  { key: "espidfEnabled", label: "启用", type: "switch", desc: "默认关闭。需要 EIM v0.8.1+ 安装的 ESP-IDF v6.0+（安装时启用 mcp 功能）。只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "espidfCommand", label: "启动命令", type: "text", placeholder: "eim run \"idf.py mcp-server\"", desc: "默认经 EIM 激活环境；也可填已激活环境中的 idf.py 完整命令。" },
  { key: "espidfProjectDir", label: "项目目录", type: "text", placeholder: "D:\\esp\\my-project", desc: "必填。含 ESP-IDF 项目 CMakeLists.txt 的文件夹，作为 IDF_MCP_WORKSPACE_FOLDER 传给服务器。" },
  { key: "serialEnabled", label: "启用", type: "switch", desc: "默认关闭。串口 MCP 可列出串口、收发数据、控制 DTR / RTS，写入会作用于真实设备。只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "serialCommand", label: "启动命令", type: "text", placeholder: "uvx --from serial-mcp-server serial_mcp", desc: "stdio 启动命令；首次运行从 PyPI 下载。" },
  { key: "serialPlugins", label: "插件", type: "text", placeholder: "留空为禁用", desc: "SERIAL_MCP_PLUGINS：留空为禁用；all 或逗号分隔的插件名。插件会运行任意 Python 代码。" },
  { key: "rhinoEnabled", label: "启用", type: "switch", desc: "默认关闭。只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "rhinoSource", label: "来源", type: "select", options: [{value: "official", label: "官方 Rhino MCP Platform"},{value: "community", label: "社区 rhinomcp"}], desc: "官方：Rhino 8 运行 PackageManager 安装 Rhino-MCP-Platform，MCPConnect 显示路由命令。社区：安装 rhinomcp 插件，Rhino 中运行 mcpstart。" },
  { key: "rhinoCommand", label: "启动命令", type: "text", placeholder: "rhino-mcp-router --default-version 8", desc: "可选。留空时官方用 rhino-mcp-router，社区用 uvx rhinomcp；路由不在 PATH 时填入 MCPConnect 打印的完整命令。" },
  { key: "rhinoVersion", label: "Rhino 版本", type: "select", options: [{value: "8", label: "Rhino 8"},{value: "9", label: "Rhino 9 WIP / BETA"}], desc: "官方路由的 --default-version（未填写启动命令时生效）。" },
  { key: "rhinoPort", label: "端口（社区）", type: "text", placeholder: "1999", desc: "社区 rhinomcp 连接 Rhino 插件的 TCP 端口。" },
  { key: "rhinoScripts", label: "允许执行脚本（社区）", type: "switch", desc: "关闭时禁用 run_command、RhinoScript-Python 与 C# 执行。" },
  { key: "altiumEnabled", label: "启用", type: "switch", desc: "默认关闭。实验性项目，部分工具可能使 Altium 脚本引擎崩溃，使用前请备份工程。只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "altiumCommand", label: "启动命令", type: "text", placeholder: "eda-agent", desc: "stdio 启动命令；不在 PATH 时用 python -m eda_agent。" },
  { key: "altiumToolset", label: "工具集", type: "select", options: [{value: "minimal", label: "精简（tool_catalog / tool_invoke）"},{value: "full", label: "完整（约 450 个工具）"}], desc: "精简模式只公开 2 个入口工具，其余工具按需查找后调用，避免会话上下文膨胀。" },
  { key: "altiumDashboard", label: "网页仪表盘", type: "switch", desc: "打开后 eda-agent 同时启动 127.0.0.1:8766 的设计审阅仪表盘。" },
  { key: "altiumUiAutomation", label: "界面自动化", type: "switch", desc: "允许模拟键盘鼠标操作 Altium 的菜单和对话框（会抢占焦点）。关闭时只保留读取。" },
  { key: "kicadEnabled", label: "启用", type: "switch", desc: "默认关闭。启动用户自己安装的 KiCad MCP Pro（社区项目，插件不内置其代码）。KiCad 工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。" },
  { key: "kicadCommand", label: "启动命令", type: "text", placeholder: "uvx kicad-mcp-pro", desc: "stdio 启动命令。默认 uvx kicad-mcp-pro，首次运行会从 PyPI 下载；带空格的路径请用双引号括起。" },
  { key: "kicadProjectDir", label: "项目目录", type: "text", placeholder: "D:\\KiCad\\my-board", desc: "可选。作为 KICAD_MCP_PROJECT_DIR 传给服务器；留空时可用工具 kicad_set_project 选择。" },
  { key: "kicadProfile", label: "工具配置", type: "select", options: [{ value: "default", label: "default（只读审阅，约 24 个工具）" }, { value: "pcb_only", label: "pcb_only（仅 PCB）" }, { value: "build", label: "build（受控编辑，配合 write）" }, { value: "release", label: "release（生产交付，配合 manufacturing）" }, { value: "expert", label: "expert（完整目录）" }, { value: "full", label: "full（完整目录，兼容旧名）" }], desc: "KICAD_MCP_PROFILE：决定服务器公开哪些工具。" },
  { key: "kicadMode", label: "操作模式", type: "select", options: [{ value: "readonly", label: "只读（readonly）" }, { value: "write", label: "可写（write）" }, { value: "manufacturing", label: "生产（manufacturing）" }], desc: "KICAD_MCP_OPERATING_MODE：风险档位，默认只读。可写与生产模式会修改工程文件或生成生产文件。" },
  { key: "comfyuiEnabled", label: "启用", type: "switch", desc: "ComfyUI 没开时仍可挂载 MCP（可用工具 launch_comfyui）；本机 8188 开着时状态会注明。" },
  { key: "comfyuiPackage", label: "pip 包名", type: "text", desc: "默认 comfy-mcp。改了包名后需要重新「下载安装」；未安装时用系统 uv tool 或 uvx。" },
  { key: "comfyuiBin", label: "comfy.exe 路径", type: "text", placeholder: "%USERPROFILE%\\…\\uv\\tools\\comfy-cli\\Scripts\\comfy.exe", desc: "可选。作为 COMFY_BIN 传给服务器；留空时用环境变量 COMFY_BIN。" },
    { key: "ffmpegEnabled", label: "启用", type: "switch", desc: "需要本机已安装 ffmpeg / ffprobe（PATH 或下方路径）。未装 FFmpeg 时服务器无法可靠工作；关掉不影响其他功能。" },
  { key: "ffmpegPath", label: "FFmpeg 路径", type: "text", placeholder: "C:\\ffmpeg\\bin\\ffmpeg.exe", desc: "可选。本机 ffmpeg 可执行文件完整路径；留空时从 PATH 查找。填写后启动 MCP 时会把该目录前置到 PATH（便于找到同目录的 ffprobe）。" },
  { key: "ffmpegPackage", label: "pip 包名", type: "text", desc: "默认 kinocut（入口命令 kino，原 mcp-video）。改了包名后需要重新「下载安装」；未安装时用 uvx 临时运行。" },
  { key: "deepslateEnabled", label: "启用", type: "switch", desc: "默认关闭。启用后启动本机 deepslate-mcp，把 Minecraft 结构文件渲染为 PNG 预览。只读渲染，聊天室所有成员均可使用。" },
  { key: "deepslatePath", label: "deepslate-mcp 目录", type: "text", placeholder: "例如 D:\\src\\deepslate-mcp", desc: "本机检出目录的绝对路径（git clone https://github.com/Philogag/deepslate-mcp），需先在该目录执行 npm install 与 npm run build。也可点击「安装」，把本机已有的检出目录复制到插件的 tools\\deepslate（原目录保留）；此项留空时自动使用该副本。插件不从网络下载上游代码。" },
  { key: "deepslateJarPath", label: "client.jar 路径", type: "text", placeholder: "可选", desc: "可选。本机 Minecraft client.jar；留空时上游首次运行会从 Mojang 下载并缓存在本机。插件不打包 Mojang 资源。" },
  { key: "deepslateCacheDir", label: "材质缓存目录", type: "text", placeholder: "可选", desc: "可选。留空使用上游默认目录 ~/.cache/deepslate-mcp。" },
  { key: "obsidianEnabled", label: "启用", type: "switch", desc: "需要 Obsidian 开着，并启用社区插件 Local REST API。没开时工具会提示未连接，不影响其他功能。" },
  { key: "obsidianApiKey", label: "API 密钥", type: "password", placeholder: "在 Local REST API 插件设置里复制", desc: "必填。Obsidian → 设置 → 社区插件 → Local REST API 中的 API key（Bearer Token）。" },
  { key: "obsidianBaseUrl", label: "API 地址", type: "text", desc: "默认 http://127.0.0.1:27123（需在插件里开启 Non-encrypted HTTP）。HTTPS 默认端口可用 https://127.0.0.1:27124（自签证书由服务器侧跳过校验）。" },
  { key: "obsidianEnableCommands", label: "允许执行命令面板", type: "switch", desc: "对应 OBSIDIAN_ENABLE_COMMANDS。打开后 MCP 可列出并执行 Obsidian 命令（可能含破坏性操作），默认关闭。" },
  { key: "obsidianPackage", label: "npm 包名", type: "text", desc: "默认 obsidian-mcp-server（可带版本）。改了包名后需要重新「下载安装」；未安装时用 npx 临时运行。" },
  { key: "reaEnabled", label: "启用", type: "switch", desc: "默认关闭。启用后以 stdio 挂载 rea-agents mcp（工具前缀 mcp__rea__）。静态分析无需外部程序；原生二进制需本机 Ghidra / Hopper / IDA。" },
  { key: "reaPackage", label: "npm 包名", type: "text", desc: "默认 rea-agents@6.4.0（可带版本）。改了包名后需要重新「下载安装」；未安装时用 npx 临时运行。" },
  { key: "reaGhidraInstallDir", label: "Ghidra 安装目录", type: "text", placeholder: "例如 C:\\ghidra_12.1", desc: "原生二进制分析所需（Ghidra 12.1.x）；留空则不启用 Ghidra。Windows 支持为实验性（只读）。" },
  { key: "reaJavaHome", label: "JDK 目录", type: "text", placeholder: "可选", desc: "Ghidra 所需的 64 位 JDK 21+；java/javac 已在 PATH 时可留空。" },
  { key: "reaProvider", label: "原生分析引擎", type: "text", placeholder: "ghidra / hopper / ida", desc: "多个引擎可用时指定其一：ghidra / hopper / ida；留空自动选择。" },
  { key: "gamebot-minecraftEnabled", label: "启用", type: "switch", desc: "实验性。打开后自动启动共享 GameBot REST body，并挂载只含 Minecraft 的 MCP（工具前缀 mcp__gamebot-minecraft__）。所有游戏共用一个 body，全部关闭才停止。每次应用/会话启动默认关闭。注意：勿与 DSH 桌面大脑同时对同一游戏发动作（双脑）。" },
  { key: "gamebot-civilizationEnabled", label: "启用", type: "switch", desc: "实验性。打开后自动启动共享 GameBot REST body，并挂载只含 文明 VI 的 MCP（工具前缀 mcp__gamebot-civilization__）。所有游戏共用一个 body，全部关闭才停止。每次应用/会话启动默认关闭。注意：勿与 DSH 桌面大脑同时对同一游戏发动作（双脑）。" },
  { key: "gamebot-visionEnabled", label: "启用", type: "switch", desc: "实验性。打开后自动启动共享 GameBot REST body，并挂载只含 视觉 的 MCP（工具前缀 mcp__gamebot-vision__）。所有游戏共用一个 body，全部关闭才停止。每次应用/会话启动默认关闭。注意：勿与 DSH 桌面大脑同时对同一游戏发动作（双脑）。" },
  { key: "gamebotUrl", label: "GameBot REST 地址", type: "text", placeholder: "http://127.0.0.1:8766", desc: "GameBot FastAPI 根地址（探测 /health，工具走 /v1/...）。可跨重启记住。默认 http://127.0.0.1:8766。" },
  /* <gamebot-fields> generated by scripts/gen-gamebot-fields.mjs */
  {"key":"gb_minecraft_driver","label":"驱动","type":"select","options":[{"value":"minaret","label":"minaret（NeoForge 模组 WebSocket）"}],"placeholder":"minaret","desc":"Mineflayer 驱动需要的 Node 桥不随插件提供，已隐藏。 GameBot 配置键 driver。"},
  {"key":"gb_minecraft_NEOFORGE_WS_URL","label":"NeoForge WS 地址","type":"text","placeholder":"ws://127.0.0.1:8765","desc":"GameBot 配置键 NEOFORGE_WS_URL。"},
  {"key":"gb_minecraft_NEOFORGE_WS_AUTH_USER","label":"NeoForge WS 用户","type":"text","desc":"GameBot 配置键 NEOFORGE_WS_AUTH_USER。"},
  {"key":"gb_minecraft_NEOFORGE_WS_AUTH_PASS","label":"NeoForge WS 密码","type":"password","placeholder":"（已保存则留空不变）","desc":"GameBot 配置键 NEOFORGE_WS_AUTH_PASS。"},
  {"key":"gb_minecraft_MC_AGENTS","label":"Minecraft AI（旧）","type":"mcagents","hidden":true,"desc":"已由席位管理 + 绑定聊天室的成员列表取代，仅用于把旧行的 profileId / 名称迁入席位池。 GameBot 配置键 MC_AGENTS。"},
  {"key":"gb_minecraft_MC_CHATROOM","label":"绑定聊天室","type":"mcroom","desc":"选择 Minecraft 使用的聊天室。进世界的 NPC = 该房间成员（席位池中的有序席位，仅已启用且 id 合法者）。席位在「席位管理」中维护，房间名册在「聊天室」中从席位池挑选。保存本卡或启用 Minecraft 时：未绑定或房间已不存在则自动新建房间「Minecraft」；旧 Minecraft AI 表中尚未出现在席位池的行会迁入池中。 GameBot 配置键 MC_CHATROOM。"},
  {"key":"gb_minecraft_MC_USERNAME","label":"机器人用户名（旧）","type":"text","hidden":true,"placeholder":"Player","desc":"已由「Minecraft AI」的名称取代，仅用于迁移；下发时取第一个已启用 AI 的名称。 GameBot 配置键 MC_USERNAME。"},
  {"key":"gb_minecraft_MC_MEMBER_IDS","label":"成员 NPC（旧）","type":"text","hidden":true,"desc":"已由「Minecraft AI」取代，仅用于迁移；下发时由已启用的 AI 编码生成。 GameBot 配置键 MC_MEMBER_IDS。"},
  {"key":"gb_minecraft_MC_VERSION","label":"MC 版本","type":"text","placeholder":"1.21.1","desc":"GameBot 配置键 MC_VERSION。"},
  {"key":"gb_minecraft_MC_ARCHIVE","label":"存档 / 档案名","type":"text","desc":"GameBot 配置键 MC_ARCHIVE。"},
  {"key":"gb_minecraft_MC_CHAT_FORWARD","label":"转发游戏聊天","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"1","desc":"GameBot 配置键 MC_CHAT_FORWARD。"},
  {"key":"gb_minecraft_MC_USE_TOOLS","label":"允许工具动作","type":"select","options":[{"value":"1","label":"开"},{"value":"0","label":"关"}],"placeholder":"1","desc":"GameBot 配置键 MC_USE_TOOLS。"},
  {"key":"gb_minecraft_MC_CHAT_PREFIX","label":"聊天触发前缀","type":"text","desc":"留空 = 所有聊天都处理。 GameBot 配置键 MC_CHAT_PREFIX。"},
  {"key":"gb_minecraft_MC_CHAT_COOLDOWN_MS","label":"聊天冷却（毫秒）","type":"text","placeholder":"3000","desc":"GameBot 配置键 MC_CHAT_COOLDOWN_MS。"},
  {"key":"gb_minecraft_MC_MODS_DIR","label":"mods 目录","type":"text","desc":"NeoForge 1.21.1 的 mods 文件夹（填游戏 / 实例目录也行，会自动找到其中的 mods）。「打包下载」用包内自带的 Minaret 源码在本机构建 jar 并放进这里：旧版先备份再替换；需要已装 JDK（17+，推荐 21）并能联网（下载 Gradle 与 NeoForge，走「通用 → 下载代理」）。构建好的 jar 路径会显示在按钮旁。装完重启 Minecraft。 GameBot 配置键 MC_MODS_DIR。","action":{"component":"gamebot-minecraft","path":"/components/gamebot-minecraft/addon","label":"打包下载并安装 Minaret 模组","busy":"正在构建 Minaret（首次需下载 Gradle 与 NeoForge，可能要几分钟）…","ready":"把包内自带的 Minaret 源码在本机构建成 jar，并放进上方 mods 目录","need":"请先填写 mods 目录"}},
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

  { key: "telegramEnabled", label: "启用", type: "switch", desc: "打开后经 Telegram Bot API 长轮询接收各机器人的私聊和已允许的群聊，并把回复（含工具结果图片）发回 Telegram。默认关闭。每个机器人的令牌、预设和模型在下方表格中单独设置。同一令牌只能有一处在轮询：若独立插件 dsh-telegram-temp 仍在加载，本通道不会启动。" },
  { key: "telegramProxy", label: "网络代理", type: "text", placeholder: "http://127.0.0.1:7890", desc: "可选。访问 api.telegram.org 时使用的 HTTP 代理；留空时沿用宿主与环境变量（HTTPS_PROXY / HTTP_PROXY）的代理设置。" },
  { key: "telegramOwnerId", label: "所有者用户 ID", type: "text", placeholder: "例如 123456789", desc: "所有者的 Telegram 数字用户 ID（可向 @userinfobot 查询）。填写后启动时按本卡片写入私聊与群聊策略；留空则不改已保存的策略，下方群聊设置也不会写入。" },
  { key: "telegramAllowFrom", label: "允许的其他用户 ID", type: "text", placeholder: "以逗号或空格分隔", desc: "除所有者外允许私聊机器人的 Telegram 数字用户 ID。仅在填写了所有者用户 ID 时生效。群内发言人设为「仅白名单」时，同一份名单也用于群。" },
  { key: "telegramGroupPolicy", label: "群聊", type: "select", options: [
    { value: "disabled", label: "关闭（不接收任何群消息）" },
    { value: "allowlist", label: "指定群（只接收下方群 ID）" },
    { value: "open", label: "所有群（机器人所在的每个群）" }
  ], desc: "默认关闭。机器人不能自己进群，需要群成员把它加进去。Telegram 默认隐私模式只推送 @、回复和命令；要收到普通群消息，在 @BotFather 对该机器人发送 /setprivacy 并选择 Disable。修改后需重新打开「启用」（或重启 DSH）才会按新策略连接。" },
  { key: "telegramGroupIds", label: "群 ID", type: "textarea", placeholder: "每行一个，例如 -1001234567890", desc: "仅「指定群」时使用。群 ID 为负数，超级群以 -100 开头。多个用逗号、空格或换行分隔。把群里的一条消息转发给 @userinfobot 或 @getidsbot 即可查到。留空表示当前没有任何群被允许。" },
  { key: "telegramGroupRequireMention", label: "群内需要 @ 唤醒", type: "switch", desc: "可选。关闭时，允许的群里每条普通消息都会唤醒会话。开启时，只有 @ 机器人、回复它，或 /命令@机器人 才会唤醒。默认关闭。隐私模式未关闭时，Telegram 仍不会把未 @ 的消息推过来。" },
  { key: "telegramGroupSenderPolicy", label: "群内发言人", type: "select", options: [
    { value: "open", label: "所有人（允许的群里任何成员）" },
    { value: "allowlist", label: "仅白名单（所有者与上方允许的用户）" }
  ], desc: "谁可以在已允许的群里触发机器人。仍受「群内需要 @」约束。群里的斜杠指令始终只有所有者能用。" },
  { key: "telegramAuthorizedIds", label: "授权用户 ID", type: "text", placeholder: "留空时使用所有者用户 ID", desc: "只有这些 Telegram 数字用户 ID 发出的消息所触发的回合，才能使用会更改电脑的工具（命令、文件读写、桌面控制、MCP 工具、子智能体等）；其他人只能使用联网搜索、网页读取等不触及本机的工具。按消息发送者判定，不受消息文字、转发或引用影响。留空时使用所有者用户 ID；两者都空时任何人都不能使用。" },
  { key: "telegramChannelRoutes", label: "通道级预设覆盖", type: "text", placeholder: "例如 telegram:预设ID", desc: "按通道覆盖默认预设，形如 telegram:预设ID（routing.overrides.channel）。留空不覆盖。各机器人的私聊和群聊预设在下方表格中分别设置，优先于这里。" },
  { key: "telegramRoutingMode", label: "路由模式", type: "select", options: [
    { value: "conversation", label: "按会话（默认）" },
    { value: "channel", label: "按通道" },
    { value: "account", label: "按账号" },
    { value: "global", label: "全局默认" }
  ], desc: "选择智能体预设时的匹配粒度（routing.mode）。" },
  { key: "telegramIncludeMetadataPrefix", label: "元数据前缀", type: "select", bool: true, options: [
    { value: "true", label: "开启：入站消息前附加通道元数据（默认）" },
    { value: "false", label: "关闭" }
  ], desc: "includeMetadataPrefix。开启后入站正文前会附带通道 / 会话等元数据，便于智能体识别来源。" },
  { key: "telegramFormat", label: "出站格式", type: "select", options: [
    { value: "html", label: "HTML（默认）" },
    { value: "auto", label: "自动" },
    { value: "rich-markdown", label: "富 Markdown" },
    { value: "markdown-v2", label: "Markdown V2" },
    { value: "plain", label: "纯文本" }
  ], desc: "发往 Telegram 的正文格式（formatting.mode）。" },
  { key: "telegramSendReasoning", label: "发送思考过程", type: "select", bool: true, options: [
    { value: "false", label: "关闭（默认）" },
    { value: "true", label: "开启：以可展开引用块发送思考过程" }
  ], desc: "开启后，每个步骤的思考内容会放在可展开的引用块中发送（默认关闭，避免刷屏）。" },
  { key: "telegramShowToolCalls", label: "显示工具调用", type: "select", bool: true, options: [
    { value: "true", label: "开启：在折叠块中显示工具名称与状态（默认）" },
    { value: "false", label: "关闭" }
  ], desc: "每个工具一行摘要（名称 · 进行中 / 完成 / 失败）；不发送参数与结果正文。" },
  { key: "telegramReasoningMaxChars", label: "思考长度上限", type: "number", min: 200, max: 8000, placeholder: "1500", desc: "思考过程保留的最大字符数；超出时保留末尾。默认 1500。" },
  { key: "telegramStreamMode", label: "流式方式", type: "select", options: [
    { value: "auto", label: "自动（编辑同一条，避免双气泡）" },
    { value: "draft", label: "草稿预览（私聊 ephemeral，结束再发正式消息）" },
    { value: "edit", label: "强制编辑" }
  ], desc: "自动与强制编辑：始终编辑同一条消息（一条气泡）。强制草稿：私聊用 ephemeral 预览，结束时再 sendMessage；空草稿会显示 Thinking…，且延迟的草稿更新会在正式消息上方再冒出气泡，故默认不用草稿。" },
  { key: "telegramInboundPreempt", label: "新消息插队", type: "select", bool: true, options: [
    { value: "true", label: "开启：新消息中止正在进行的回合并优先处理（默认）" },
    { value: "false", label: "关闭：按顺序排队处理" }
  ], desc: "与 dsh-telegram-temp 的 inboundPreempt 相同。" },
  { key: "telegramDebugTrace", label: "排查日志", type: "switch", desc: "打开后把入站更新、准入结果与建会话阶段写到 ~/.dsh/dsh-channels/telegram-inbound.log，便于排查群聊收不到消息等问题。默认关闭；排查完请关闭。" },
  { key: "telegramTokenRef", label: "凭据引用名", type: "text", placeholder: "TELEGRAM_BOT_TOKEN", desc: "高级。机器人令牌在宿主凭据中的引用名（仅字母、数字、下划线），默认 TELEGRAM_BOT_TOKEN。修改后需重新填写令牌，或确认该引用已有值。" },
  { key: "qqEnabled", label: "启用", type: "switch", desc: "打开后经 QQ 开放平台官方机器人 OpenAPI 接收 C2C 私聊和已允许的群聊，并把回复发回 QQ。默认关闭。需在 q.qq.com 创建机器人；群消息默认需 @；身份为 OpenID 而非 QQ 号。会话键 qq:main 与既有 DSH 绑定兼容。" },
  { key: "qqAppId", label: "AppID", type: "text", placeholder: "QQ 开放平台机器人 AppId", desc: "非机密。填写开放平台应用的 AppId。" },
  { key: "qqAppSecret", label: "AppSecret", type: "password", desc: "QQ 机器人 AppSecret；保存时写入宿主凭据引用（默认 QQBOT_APP_SECRET），不写入本插件设置。已保存时显示为掩码。" },
  { key: "qqOwnerOpenId", label: "所有者 OpenID", type: "text", placeholder: "例如 B4C6E62A…", desc: "所有者的 QQ OpenID。填写后启动时按本卡片写入私聊与群聊策略；留空则不改已保存的策略（可保留旧 QQ 会话绑定所用的策略）。" },
  { key: "qqAllowFrom", label: "允许的其他用户 OpenID", type: "text", placeholder: "以逗号或空格分隔", desc: "除所有者外允许私聊的 QQ OpenID。仅在填写了所有者 OpenID 时生效。平台 C2C 通常仅机器人创建者可用。" },
  { key: "qqGroupPolicy", label: "群聊", type: "select", options: [
    { value: "disabled", label: "关闭（不接收任何群消息）" },
    { value: "allowlist", label: "指定群（只接收下方群 OpenID）" },
    { value: "open", label: "所有群（机器人所在的每个群）" }
  ], desc: "默认关闭。群身份为官方 group_openid，不是传统 QQ 群号。" },
  { key: "qqGroupIds", label: "群 OpenID", type: "textarea", placeholder: "每行一个 group_openid", desc: "仅「指定群」时使用。填写官方 API 的 group_openid（不是传统 QQ 群号），逗号、空格或换行分隔。" },
  { key: "qqGroupRequireMention", label: "群内需要 @ 唤醒", type: "switch", desc: "官方网关默认推送 AT 事件；默认开启。关闭时仍受平台是否下发非 @ 群消息限制。" },
  { key: "qqAuthorizedIds", label: "授权用户 OpenID", type: "text", placeholder: "留空时使用所有者 OpenID", desc: "只有这些 OpenID 触发的回合可以使用会更改电脑的工具。留空时使用所有者 OpenID；两者都空时任何人都不能使用。" },
  { key: "qqPreset", label: "私聊预设", type: "text", placeholder: "留空沿用全局默认", desc: "账号 main 的私聊预设 ID。" },
  { key: "qqChannelRoutes", label: "通道级预设覆盖", type: "text", placeholder: "例如 qq:预设ID", desc: "按通道覆盖默认预设，形如 qq:预设ID（routing.overrides.channel）。留空不覆盖。" },
  { key: "qqRoutingMode", label: "路由模式", type: "select", options: [
    { value: "conversation", label: "按会话（默认）" },
    { value: "channel", label: "按通道" },
    { value: "account", label: "按账号" },
    { value: "global", label: "全局默认" }
  ], desc: "选择智能体预设时的匹配粒度（routing.mode）。" },
  { key: "qqIncludeMetadataPrefix", label: "元数据前缀", type: "select", bool: true, options: [
    { value: "true", label: "开启：入站消息前附加通道元数据（默认）" },
    { value: "false", label: "关闭" }
  ], desc: "includeMetadataPrefix。" },
  { key: "qqMarkdownSupport", label: "Markdown", type: "select", bool: true, options: [
    { value: "false", label: "关闭（默认）" },
    { value: "true", label: "开启：适配器 markdownSupport" }
  ], desc: "对应 @wsz987/channel-qq 的 markdownSupport。" },
  { key: "qqStreamEnabled", label: "私聊流式", type: "select", bool: true, options: [
    { value: "true", label: "开启：C2C 原生流式（默认）" },
    { value: "false", label: "关闭：一律缓冲一次发送" }
  ], desc: "私聊 C2C 可原生流式；群聊仍缓冲一次发送。" },
  { key: "qqDebugTrace", label: "排查日志", type: "switch", desc: "打开后写排查日志到 ~/.dsh/dsh-channels/qq-inbound.log。默认关闭。" },
  { key: "qqAppSecretRef", label: "凭据引用名", type: "text", placeholder: "QQBOT_APP_SECRET", desc: "高级。AppSecret 在宿主凭据中的引用名（仅字母、数字、下划线），默认 QQBOT_APP_SECRET。" },
  { key: "proxy", label: "下载代理", type: "text", desc: "下载安装时使用的 HTTP 代理（uv、Python、Node.js、npm 都走它），例如 http://127.0.0.1:7890；留空时使用环境变量 HTTPS_PROXY / HTTP_PROXY。保存后再安装。" }
];
var FIELD_BY_KEY = {};
var SECRET_SAVED = "__dsh_secret_saved__"; // 宿主 GET 中「已保存的密钥」的占位值（与 src/index.mjs SECRET_MASK 一致）
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
  trust: strokeIcon('<path d="M12 3.5l7 2.6v5.4c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6.1z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>'),
  session: strokeIcon('<path d="M5 4.5h14v15H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  image: strokeIcon('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.8" r="1.7"/><path d="M20.5 15.6l-4.8-4.8L6.2 19.5"/>'),
  map: strokeIcon('<path d="M12 21s6-5.2 6-10a6 6 0 0 0-12 0c0 4.8 6 10 6 10z"/><circle cx="12" cy="11" r="2.2"/>'),
  chatroom: strokeIcon('<path d="M4 5.5h11a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"/><path d="M16 9h4a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-1.5v3L15 17.5h-4a1 1 0 0 1-1-1V14"/>'),
  balance: strokeIcon('<rect x="3.5" y="6" width="17" height="13" rx="2"/><path d="M3.5 9.5h17M15.5 14h2"/><path d="M6 6l9-2.5 1 2.5"/>'),
  notes: strokeIcon('<path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20z"/><path d="M15 3.5V8h4M9 12h7M9 15.5h7M9 9h3"/>'),
  stickers: strokeIcon('<rect x="5" y="5" width="8" height="8" rx="1.5"/><rect x="11" y="11" width="8" height="8" rx="1.5"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/>'),
  imageGen: strokeIcon('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M20.5 15.6l-4.8-4.8L6.2 19.5"/><path d="M9 6.8v4M7 8.8h4"/>'),
  video: strokeIcon('<rect x="3.5" y="6" width="12.5" height="12" rx="2"/><path d="M16 10.4l4.5-2.6v8.4L16 13.6"/><path d="M8.2 9.6v4.8l3.8-2.4z"/>'),
  calendar: strokeIcon('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9.5h16M8 3.5v3M16 3.5v3"/>'),
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
  desktop: strokeIcon('<rect x="3.5" y="4.5" width="17" height="11" rx="1.5"/><path d="M9 19.5h6M12 15.5v4"/><path d="M8.2 8.2l3.2 6.2 1.3-2.4 2.6-.4z"/>'),
  notion: strokeIcon('<path d="M7 3.5h8.2L19 7.2V20.5H7z"/><path d="M15 3.8V7.4H19"/><path d="M10 11h6M10 14h6M10 17h4"/>'),
  gmail: strokeIcon('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4.2 7.2 12 12.2l7.8-5"/>'),
  cloudflare: strokeIcon('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/>'),
  cloudflareDocs: strokeIcon('<path d="M6.5 3.5h8L18.5 8v12.5h-12z"/><path d="M14.2 3.8V8H18"/><path d="M9 12.2h6.5M9 15.2h6.5M9 18.2h4"/>'),
  github: strokeIcon('<circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8.8 8.4 10.6 15.2M15.2 8.4 13.4 15.2"/>'),
  termalin: strokeIcon('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 10l3 2.5L7 15M12.5 15.5H17"/>'),
  fusion: strokeIcon('<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
  freecad: strokeIcon('<path d="M5 19 19 5"/><rect x="3.5" y="3.5" width="7" height="7" rx="1"/><circle cx="16.5" cy="16.5" r="4"/>'),
  matlab: strokeIcon('<path d="M3 17c3-1 5-9 8-9s4 6 6 6 3-3 4-5"/><path d="M3 20h18"/>'),
  espidf: strokeIcon('<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3"/><circle cx="12" cy="12" r="1.6"/>'),
  serial: strokeIcon('<path d="M4 8h16v8H4z"/><circle cx="8" cy="12" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="16" cy="12" r=".9"/><path d="M8 16v3M16 16v3"/>'),
  rhino: strokeIcon('<path d="M4 17c2-6 6-10 13-11-1 3-1 6 2 8-4 1-7 3-9 5"/><path d="M4 17h6"/>'),
  altium: strokeIcon('<path d="M12 3 3 20h18z"/><path d="M8 13h8M10 9.5h4"/>'),
  kicad: strokeIcon('<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 6V3M15 6V3M9 21v-3M15 21v-3M6 9H3M6 15H3M21 9h-3M21 15h-3"/>'),
  comfyui: strokeIcon('<rect x="3.2" y="8" width="5.2" height="4.2" rx="1"/><rect x="15.6" y="4.5" width="5.2" height="4.2" rx="1"/><rect x="15.6" y="15.3" width="5.2" height="4.2" rx="1"/><path d="M8.4 10.1h7.2M16.4 8.7 10.2 10.1M16.4 15.3 10.2 12.2"/>'),
  proxy: strokeIcon('<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.7" ry="8.5"/><path d="M3.9 9.2h16.2M3.9 14.8h16.2"/>'),
  ffmpeg: strokeIcon('<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M8 6v12M12 6v12M16 6v12M3.5 10h17M3.5 14h17"/>'),
  obsidian: strokeIcon('<path d="M8 6.5h11v13H8z"/><path d="M5 4.5h11"/><path d="M5 4.5v11"/><path d="M11 10.5h5M11 13.5h5M11 16.5h3"/>'),
  rea: strokeIcon('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7 9h4M7 12h6M7 15h3"/><path d="M14.5 8.5l4 3.5-4 3.5z"/>'),
  gamebot: strokeIcon('<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 12h.01M16 12h.01M10.5 14.5h3"/><path d="M9 7V5.5M15 7V5.5"/>'),
  gamebotMinecraft: strokeIcon('<path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8z"/><path d="M4 8l8 4.5L20 8M12 12.5v8"/>'),
  gamebotCivilization: strokeIcon('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>'),
  gamebotVision: strokeIcon('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>'),
  boards: strokeIcon('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>'),
  cards: strokeIcon('<rect x="7" y="3.5" width="10" height="14" rx="1.2"/><rect x="4" y="6.5" width="10" height="14" rx="1.2"/><path d="M7.2 11.5h3.6M7.2 14.2h3.6"/>'),
  channel: strokeIcon('<path d="M4.5 5.5h15v10h-8.2L7 19.2v-3.7H4.5z"/><path d="M8 9.2h8M8 12.2h5"/>'),
  addComponent: strokeIcon('<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><path d="M17 13.5v7M13.5 17h7"/>')
};

// 功能列表：每项一行、一个管理页。component：状态来自 /components 里同 id 的一项；
// 没有 component 的是纯设置项，列表里的状态由 summary(已保存的设置) 给出。icon：ICONS 里的静态 SVG。
var FEATURES = [
  {
    id: "image", group: "多模态", title: "媒体卡片", icon: ICONS.image,
    desc: "mm_send_image 发图片卡片。mm_send_file 按文件类型在同一套卡片里预览，并在 Telegram 以文档发出。",
    intro: "调用 mm_send_image，传入本地 png/jpg/webp/gif/bmp 路径，经 attachments.saveImage 得到 attachmentId，工具卡片渲染 type:mm kind:image。调用 mm_send_file 传入其它本地文件（上限 50MB）：图片、视频、音频直接看；PDF、Markdown、Word、Excel、PowerPoint 在卡片里显示正文。群聊里只有授权用户能发送文件。",
    keys: [],
    summary: function () {
      return { text: "mm_send_image / mm_send_file · 可用", cls: "ready" };
    }
  },
  {
    id: "map", group: "多模态", title: "地图", icon: ICONS.map,
    desc: "地点检索、路线规划、天气预报与静态地图。路线可发至手机打开，不写入收藏夹。",
    intro: "启用并保存高德 Web 服务 Key 后，注册地理编码、地点检索、地点详情、路线规划、天气预报、静态地图卡片与可点击的路线图。路线图点开后进入高德导航页。可将分享链接通过 Telegram 发送，或复制到手机系统浏览器打开；该链接适用于 iOS 与 Android。导航深链（amapuri）供 Android 与 HarmonyOS 直接打开。上述方式均不写入高德账号收藏夹。Key 只保存在本页设置中，不读取环境变量。坐标采用 GCJ-02。",
    keys: ["mapEnabled", "gaodeApiKey", "mapBypassProxy"],
    summary: function (v) {
      if (!v || v.mapEnabled !== true) return { text: "未启用", cls: "off" };
      if (!v.gaodeApiKey) return { text: "未配置 Key", cls: "disconnected" };
      return { text: "已启用", cls: "on" };
    }
  },
  {
    id: "gpt-image", group: "多模态", title: "GPT Image 2 生图", icon: ICONS.imageGen,
    desc: "image_generate 文生图、image_edit 图片编辑，调用 OpenAI 兼容 Images API，图片保存在插件数据目录。",
    intro: "启用并保存 API Key 后，向会话注册 image_generate（POST {Base URL}/images/generations）与 image_edit（POST {Base URL}/images/edits，可传入 1 至 16 张本地图片及可选蒙版）。生成的 PNG 保存在插件数据目录 images/<日期>/，并以图片形式显示在对话中，同时返回文件路径。除写入该目录外，不改动电脑上的其它内容。每次出图由服务商计费。「测试连接」仅请求 GET {Base URL}/models，不产生出图费用。在 Telegram 中，这两个工具仅限授权用户使用。API Key 只保存在本页设置中，不读取环境变量。",
    keys: ["gptImageEnabled", "gptImageApiKey", "gptImageBaseUrl", "gptImageModel", "gptImageSize", "gptImageQuality", "gptImageTimeoutSec"],
    summary: function (v) {
      if (!v || v.gptImageEnabled !== true) return { text: "未启用", cls: "off" };
      if (!v.gptImageApiKey) return { text: "未配置 API Key", cls: "disconnected" };
      return { text: "已启用", cls: "on" };
    }
  },
  {
    id: "video", group: "多模态", title: "视频理解", icon: ICONS.video,
    desc: "经 Google Gemini 观看视频：聊天室自动描述、watch_video、视频输入，以及会话工具 describe_video / watch_video。",
    intro: "默认开启。聊天室中的每个视频（本机上传、Telegram 群发送，以及消息中的 YouTube / 哔哩哔哩链接）都会在后台由 Gemini 观看，生成带时间戳的中文内容描述，显示在消息的「视频 · 内容描述」卡片中并提供给所有成员；成员可调用 watch_video 就某一时间段提问；原生 Gemini 成员可在成员设置中开启「视频输入」，直接收到最新消息中的视频。会话中另提供 describe_video（整体描述）与 watch_video（按问题与时间段观看）两个工具，可传入本机视频路径或链接；在 Telegram 中这两个工具仅限主人使用。使用本组件单独配置的 Gemini API 密钥（状态中只显示来源与末四位），不会显示或写入日志。哔哩哔哩链接需要 yt-dlp，可点击「下载 yt-dlp」从官方 GitHub 发布页下载（校验 sha256），也可使用 PATH 中或自行指定的程序。每次观看由 Google 按用量计费。关闭后上述功能全部停用。",
    keys: ["videoEnabled", "videoCredentialSource", "videoGeminiKey", "videoServiceAccountFile", "videoVertexLocation", "videoBucket", "videoBucketPrefix", "videoMaxHeight", "videoBaseUrl", "videoModel", "videoYoutube", "videoBilibili", "videoYtdlpPath"],
    summary: function (v) {
      if (v && v.videoEnabled === false) return { text: "未启用", cls: "off" };
      return { text: "已启用", cls: "on" };
    }
  },
  {
    id: "calendar", group: "多模态", title: "日历", icon: ICONS.calendar,
    desc: "公历、农历、节气、法定节假日、日程和天气预报。",
    intro: "默认开启。日历按上海时区计算今天。法定节假日、调休、农历和节气在本地计算，不抓网页。日程保存在插件数据目录，可在下方月历中查看和编辑，对话里调用 calendar_show 也会发出同一块月历。填写天气城市后，向 Open-Meteo 查询预报，每种天气在月历里用一枚动态小图标表示，不使用高德 Key；留空时历法和日程仍然可用。发到 Telegram 时，同一份月历会另成一条消息，天气用对应的表情。",
    keys: ["calendarEnabled", "calendarCity"],
    summary: function (v) {
      if (v && v.calendarEnabled === false) return { text: "未启用", cls: "off" };
      if (v && v.calendarCity) return { text: "已启用", cls: "on" };
      return { text: "已启用", cls: "ready" };
    }
  },
  {
    id: "stickers", group: "多模态", title: "表情包", icon: ICONS.stickers,
    desc: "管理本地表情包；AI 可用 sticker_search / sticker_save / sticker_send。",
    intro: "默认开启。在本页新建包、导入 png/jpg/webp/gif、编辑标签与别名。智能体可用 sticker_search 检索，sticker_save 从本机路径（或本会话最近入站图）入库，sticker_send 按普通图片发到当前会话（桌面 MmCard；QQ/Telegram 通道为 photo）。search/send 对通道非授权用户开放；save 仅授权用户。不会把远程 URL 写入库。关闭后工具卸下，已保存文件仍在数据目录 stickers/。",
    keys: ["stickersEnabled", "stickersDefaultPackId"],
    summary: function (v) {
      if (v && v.stickersEnabled === false) return { text: "未启用", cls: "off" };
      return { text: "已启用", cls: "on" };
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
    id: "gmail", group: "工作组件", title: "Gmail", component: "gmail",
    moduleSource: "bundled", icon: ICONS.gmail,
    builtin: true,
    url: "https://support.google.com/accounts/answer/185833",
    desc: "个人 Gmail。沿用已保存的应用专用密码，读信和发信。",
    intro: "插件自带，不用下载，也不用 Google Cloud，走 IMAP/SMTP。需要填写 Gmail 地址和应用专用密码。工具名前缀 mcp__gmail__：list_messages 列收件箱，read_message 读正文，send_message 会直接把信发出去。",
    keys: ["gmailEnabled", "gmailAddress", "gmailAppPassword"]
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
    id: "termalin", group: "工作组件", title: "Termalin", component: "termalin",
    moduleSource: "bundled", icon: ICONS.termalin,
    url: "https://termal.in/mcp",
    desc: "Termalin SSH 客户端的 MCP（本机或托管）。",
    intro: "Termalin 的 MCP 服务器：本机模式运行应用自带的 termalin-mcp，托管模式用 API 密钥连接 https://termal.in/api/v1/mcp。工具会在服务器上执行命令，只有所有者发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__termalin__。",
    keys: ["termalinEnabled", "termalinMode", "termalinCommand", "termalinUrl", "termalinApiKey"]
  },
  {
    id: "fusion", group: "工作组件", title: "Autodesk Fusion", component: "fusion",
    moduleSource: "bundled", icon: ICONS.fusion,
    url: "https://help.autodesk.com/view/ADSKMCP/ENU/",
    desc: "Fusion 内置的官方 MCP Server（本机 HTTP）。",
    intro: "Autodesk Fusion 内置的官方 Fusion MCP Server，本机 streamable-http，默认 http://127.0.0.1:27182/mcp。插件不安装任何东西。全部工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__fusion__。",
    keys: ["fusionEnabled", "fusionUrl"]
  },
  {
    id: "freecad", group: "工作组件", title: "FreeCAD", component: "freecad",
    moduleSource: "bundled", icon: ICONS.freecad,
    url: "https://github.com/neka-nat/freecad-mcp",
    desc: "FreeCAD MCP（社区，MIT）。",
    intro: "社区 FreeCAD MCP（neka-nat/freecad-mcp，MIT）：FreeCAD 中的 MCP Addon 提供 RPC 服务器，插件只启动用户的 uvx freecad-mcp。全部工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__freecad__。",
    keys: ["freecadEnabled", "freecadCommand", "freecadHost", "freecadTextOnly", "freecadToken"]
  },
  {
    id: "matlab", group: "工作组件", title: "MATLAB", component: "matlab",
    moduleSource: "bundled", icon: ICONS.matlab,
    url: "https://github.com/matlab/matlab-mcp-server",
    desc: "MathWorks 官方 MATLAB MCP Server。",
    intro: "MathWorks 官方 MATLAB MCP Server（stdio）。插件只启动用户下载的可执行文件；只能按 MathWorks 许可与 MATLAB 一起使用。全部工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__matlab__。",
    keys: ["matlabEnabled", "matlabServerPath", "matlabRoot", "matlabWorkFolder", "matlabDisplayMode", "matlabSessionMode", "matlabTelemetry"]
  },
  {
    id: "espidf", group: "工作组件", title: "ESP-IDF", component: "espidf",
    moduleSource: "bundled", icon: ICONS.espidf,
    url: "https://developer.espressif.com/blog/2026/04/esp-idf-tools-mcp-server/",
    desc: "ESP-IDF Tools 本地 MCP（v6.0+）。",
    intro: "ESP-IDF v6.0+ 内置的 Tools 本地 MCP（idf.py mcp-server）：设置目标、编译、烧录、清理，并可读取项目状态与串口列表。全部工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__espidf__。",
    keys: ["espidfEnabled", "espidfCommand", "espidfProjectDir"]
  },
  {
    id: "serial", group: "工作组件", title: "串口", component: "serial",
    moduleSource: "bundled", icon: ICONS.serial,
    url: "https://github.com/es617/serial-mcp-server",
    desc: "串口 MCP（社区，MIT）。",
    intro: "社区串口 MCP（es617/serial-mcp-server，MIT，pyserial）。工具名分隔符固定为下划线；插件与追踪默认关闭。全部工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__serial__。",
    keys: ["serialEnabled", "serialCommand", "serialPlugins"]
  },
  {
    id: "rhino", group: "工作组件", title: "Rhino", component: "rhino",
    moduleSource: "bundled", icon: ICONS.rhino,
    url: "https://github.com/mcneel/RhinoAI",
    desc: "Rhino MCP（官方或社区）。",
    intro: "默认使用 McNeel 官方 Rhino MCP Platform（rhino-mcp-router，Rhino 8），也可切换到社区 rhinomcp（uvx，TCP 1999）。全部工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__rhino__。",
    keys: ["rhinoEnabled", "rhinoSource", "rhinoCommand", "rhinoVersion", "rhinoPort", "rhinoScripts"]
  },
  {
    id: "altium", group: "工作组件", title: "Altium Designer", component: "altium",
    moduleSource: "bundled", icon: ICONS.altium,
    url: "https://github.com/salitronic/eda-agent",
    desc: "eda-agent（社区，Apache-2.0）。",
    intro: "社区 eda-agent（Apache-2.0）驱动正在运行的 Altium Designer。约 450 个工具，默认精简工具集只公开 tool_catalog / tool_invoke。全部工具只有所有者（本机桌面端或所有者的 Telegram）发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__altium__。",
    keys: ["altiumEnabled", "altiumCommand", "altiumToolset", "altiumDashboard", "altiumUiAutomation"]
  },
  {
    id: "kicad", group: "工作组件", title: "KiCad", component: "kicad",
    moduleSource: "bundled", icon: ICONS.kicad,
    url: "https://github.com/oaslananka/kicad-mcp-pro",
    desc: "KiCad MCP Pro（社区，原理图 / PCB / ERC / DRC）。",
    intro: "社区服务器 KiCad MCP Pro，经 stdio 启动用户自己安装的副本（默认 uvx kicad-mcp-pro），插件不内置其代码。默认只读；所有 KiCad 工具都只有所有者发起的任务可以使用。连接状态和已挂载的工具数量显示在下方连接行。工具名前缀 mcp__kicad__。",
    keys: ["kicadEnabled", "kicadCommand", "kicadProjectDir", "kicadProfile", "kicadMode"]
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
    id: "deepslate", group: "工作组件", title: "DeepSlate", component: "deepslate",
    moduleSource: "bundled", icon: ICONS.obsidian,
    url: "https://github.com/Philogag/deepslate-mcp",
    desc: "Minecraft 结构渲染（.nbt / .schem / .litematic → PNG）。",
    intro: "启动本机 deepslate-mcp 检出目录（MIT，渲染引擎 misode/deepslate），提供 render_structure、render_blocks、inspect_structure、render_item 四个工具，工具名前缀 mcp__deepslate__。准备：① git clone 上游仓库并在目录内执行 npm install 与 npm run build；② 在下方填写目录，或点击「安装」把本机已有的检出目录复制到插件的 tools\\deepslate（原目录保留）；③ 打开「启用」。材质来自您本机的 client.jar 或上游首次运行时从 Mojang 下载，插件不打包 Mojang 资源。聊天室中所有成员均可使用，渲染尺寸上限 1600 像素。",
    keys: ["deepslateEnabled", "deepslatePath", "deepslateJarPath", "deepslateCacheDir", "nodePath"]
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
    id: "rea", group: "工作组件", title: "REA 逆向分析", component: "rea",
    moduleSource: "bundled", icon: ICONS.rea,
    url: "https://github.com/morluto/rea",
    desc: "逆向工程 MCP（JS / Electron / ASAR、.NET、网站、Android；原生需 Ghidra/Hopper/IDA）。",
    intro: "用 rea-agents（morluto/rea）以 stdio 挂载逆向分析 MCP，工具前缀 mcp__rea__。准备：① 点「下载安装」装 rea-agents@6.4.0 到 tools\\rea（需 Node.js ^22.19 / ^24.11 / >=26）；② 做原生二进制分析时填写 Ghidra 安装目录与可选 JDK 目录，或本机已装 Hopper/IDA；③ 打开「启用」。不会运行 rea setup，也不改其他智能体配置。Windows 上 Ghidra 为实验性只读。",
    keys: ["reaEnabled", "reaPackage", "reaGhidraInstallDir", "reaJavaHome", "reaProvider", "nodePath", "npmRegistry"]
  },
  {
    id: "telegram", group: "通道", title: "Telegram", component: "telegram",
    moduleSource: "bundled", icon: ICONS.channel,
    builtin: true,
    url: "https://core.telegram.org/bots/api",
    desc: "经 Telegram Bot API 把机器人私聊和已允许的群聊接到 DSH 会话（文字、图片、工具结果图片）。默认关闭。",
    intro: "仓库自带、已验证，无需下载。各机器人地位相同：在下方表格中选择一行，再编辑该机器人的令牌、预设和模型。账号 main 对应现有会话，不能删除或改标识。已绑定的会话要在该机器人的私聊里发送 /new 才会换预设和模型。同一令牌只能有一处在轮询。群聊策略对所有机器人相同。聊天室已绑定的群不会由本通道回复。",
    keys: ["telegramEnabled", "telegramProxy", "telegramOwnerId", "telegramAllowFrom", "telegramGroupPolicy", "telegramGroupIds", "telegramGroupRequireMention", "telegramGroupSenderPolicy", "telegramAuthorizedIds", "telegramChannelRoutes", "telegramRoutingMode", "telegramIncludeMetadataPrefix", "telegramFormat", "telegramSendReasoning", "telegramShowToolCalls", "telegramReasoningMaxChars", "telegramStreamMode", "telegramInboundPreempt", "telegramDebugTrace", "telegramTokenRef"]
  },
  {
    id: "qq", group: "通道", title: "QQ", component: "qq",
    moduleSource: "bundled", icon: ICONS.channel,
    builtin: true,
    url: "https://q.qq.com/qqbot/openclaw/",
    desc: "经 QQ 开放平台官方机器人 OpenAPI 把 C2C 私聊和已允许的群聊接到 DSH 会话。默认关闭。会话键 qq:main 可复用既有绑定。",
    intro: "仓库自带。需在 QQ 开放平台创建机器人并填写 AppId / AppSecret。群身份为 group_openid；群消息默认需 @。留空所有者 OpenID 可保留 ~/.dsh/dsh-channels 里旧 QQ 访问策略与会话绑定。",
    keys: ["qqEnabled", "qqAppId", "qqAppSecret", "qqOwnerOpenId", "qqAllowFrom", "qqGroupPolicy", "qqGroupIds", "qqGroupRequireMention", "qqAuthorizedIds", "qqPreset", "qqChannelRoutes", "qqRoutingMode", "qqIncludeMetadataPrefix", "qqMarkdownSupport", "qqStreamEnabled", "qqDebugTrace", "qqAppSecretRef"]
  },

  {
    id: "gamebot-minecraft", group: "游戏", title: "Minecraft", component: "gamebot-minecraft",
    moduleSource: "bundled", icon: ICONS.gamebotMinecraft,
    builtin: true,
    hidden: true, // 暂不在设置页显示；去掉 hidden 即可恢复
    maturity: "experimental",
    warn: "【开发中功能】游戏分组组件尚未完全验证。默认关闭；启用后会启动共享 GameBot 并驱动对应游戏，请仅在明确需要时使用。勿与 DSH 桌面大脑同时对同一游戏发动作。",
    desc: "GameBot · Minecraft：NeoForge Minaret / Mineflayer 驱动（观察 / 动作 / 大脑 / 记忆）。实验性；每次启动默认关闭。",
    intro: "打开「启用」后自动启动共享 GameBot REST（默认 http://127.0.0.1:8766），并挂载只含Minecraft的 MCP（工具前缀 mcp__gamebot-minecraft__）。仓库自带（实验性），无需下载：直接打开「启用」（首次会自动准备 Python 环境，约半分钟）。下方是该游戏的全部 GameBot 设置，保存后立即下发到 GameBot；REST 地址 / 目录为所有游戏共享。每次应用启动默认关闭。【双脑警告】不要同时让 DSH 桌面大脑与 GameBot 大脑对同一游戏发动作。",
    keys: ["gamebot-minecraftEnabled", "gamebotUrl", "gamebotRoot", "gb_minecraft_driver", "gb_minecraft_NEOFORGE_WS_URL", "gb_minecraft_NEOFORGE_WS_AUTH_USER", "gb_minecraft_NEOFORGE_WS_AUTH_PASS", "gb_minecraft_MC_AGENTS", "gb_minecraft_MC_CHATROOM", "gb_minecraft_MC_USERNAME", "gb_minecraft_MC_MEMBER_IDS", "gb_minecraft_MC_VERSION", "gb_minecraft_MC_ARCHIVE", "gb_minecraft_MC_CHAT_FORWARD", "gb_minecraft_MC_USE_TOOLS", "gb_minecraft_MC_CHAT_PREFIX", "gb_minecraft_MC_CHAT_COOLDOWN_MS", "gb_minecraft_MC_MODS_DIR"]
  },
  {
    id: "gamebot-civilization", group: "游戏", title: "文明 VI", component: "gamebot-civilization",
    moduleSource: "bundled", icon: ICONS.gamebotCivilization,
    builtin: true,
    hidden: true, // 暂不在设置页显示；去掉 hidden 即可恢复
    maturity: "experimental",
    warn: "【开发中功能】游戏分组组件尚未完全验证。默认关闭；启用后会启动共享 GameBot 并驱动对应游戏，请仅在明确需要时使用。勿与 DSH 桌面大脑同时对同一游戏发动作。",
    desc: "GameBot · 文明 VI：经 civ6-mcp + TRIXCompanion 模组陪玩。实验性；每次启动默认关闭。",
    intro: "打开「启用」后自动启动共享 GameBot REST（默认 http://127.0.0.1:8766），并挂载只含文明 VI的 MCP（工具前缀 mcp__gamebot-civilization__）。仓库自带（实验性），无需下载：直接打开「启用」（首次会自动准备 Python 环境，约半分钟）。下方是该游戏的全部 GameBot 设置，保存后立即下发到 GameBot；REST 地址 / 目录为所有游戏共享。每次应用启动默认关闭。【双脑警告】不要同时让 DSH 桌面大脑与 GameBot 大脑对同一游戏发动作。",
    keys: ["gamebot-civilizationEnabled", "gamebotUrl", "gamebotRoot", "gb_civilization_CIV6_MCP_PROJECT", "gb_civilization_CIV6_MODS_DIR", "gb_civilization_CIV_POLL_INTERVAL_S", "gb_civilization_CIV_SAFE_AUTO", "gb_civilization_CIV_DSH_SESSION", "gb_civilization_LLM_ENABLED", "gb_civilization_LLM_PROVIDER", "gb_civilization_LLM_PROTOCOL", "gb_civilization_LLM_BASE_URL", "gb_civilization_LLM_MODEL", "gb_civilization_LLM_API_KEY", "gb_civilization_LLM_DECISION_TIMEOUT_S", "gb_civilization_LLM_MAX_STEPS", "gb_civilization_LLM_TEMPERATURE", "gb_civilization_LLM_TOP_P", "gb_civilization_LLM_MAX_TOKENS", "gb_civilization_LLM_REASONING_EFFORT", "gb_civilization_LLM_THINKING_BUDGET", "gb_civilization_LLM_PERSONA", "gb_civilization_CHAT_ENABLED", "gb_civilization_CHAT_PROVIDER", "gb_civilization_CHAT_PROTOCOL", "gb_civilization_CHAT_BASE_URL", "gb_civilization_CHAT_MODEL", "gb_civilization_CHAT_API_KEY", "gb_civilization_CHAT_TEMPERATURE", "gb_civilization_CHAT_TOP_P", "gb_civilization_CHAT_MAX_TOKENS", "gb_civilization_CHAT_REASONING_EFFORT", "gb_civilization_CHAT_THINKING_BUDGET", "gb_civilization_CHAT_PERSONA", "gb_civilization_MEMORY_ENABLED", "gb_civilization_MEMORY_BLOCK_SIZE", "gb_civilization_DSH_SESSION"]
  },
  {
    id: "gamebot-vision", group: "游戏", title: "视觉", component: "gamebot-vision",
    moduleSource: "bundled", icon: ICONS.gamebotVision,
    builtin: true,
    hidden: true, // 暂不在设置页显示；去掉 hidden 即可恢复
    maturity: "experimental",
    warn: "【开发中功能】游戏分组组件尚未完全验证。默认关闭；启用后会启动共享 GameBot 并驱动对应游戏，请仅在明确需要时使用。勿与 DSH 桌面大脑同时对同一游戏发动作。",
    desc: "GameBot · 视觉桌面驱动：只处理启动器、菜单、设置页。实验性；每次启动默认关闭。",
    intro: "打开「启用」后自动启动共享 GameBot REST（默认 http://127.0.0.1:8766），并挂载只含视觉的 MCP（工具前缀 mcp__gamebot-vision__）。仓库自带（实验性），无需下载：直接打开「启用」（首次会自动准备 Python 环境，约半分钟）。下方是该游戏的全部 GameBot 设置，保存后立即下发到 GameBot；REST 地址 / 目录为所有游戏共享。每次应用启动默认关闭。【双脑警告】不要同时让 DSH 桌面大脑与 GameBot 大脑对同一游戏发动作。",
    keys: ["gamebot-visionEnabled", "gamebotUrl", "gamebotRoot", "gb_vision_monitor", "gb_vision_max_px", "gb_vision_settle_s", "gb_vision_evidence_dir"]
  },
  {
    id: "boards", group: "游戏", title: "棋类", icon: ICONS.boards,
    desc: "中国象棋、国际象棋、五子棋、围棋。由当前会话里的 AI 应着。",
    intro: "默认关闭。启用后注册 board_open、board_look、board_play、board_close、board_reset、board_hint。棋盘下载后可另行下载辅助引擎（中国象棋 Pikafish、国际象棋 Stockfish、五子棋 Rapfi、围棋 KataGo），装了之后 AI 每次走棋前会收到前三名候选着法与胜率，board_hint 可随时请求分析。每种棋按房间或会话分开保存，写在数据目录 boards/saves/by-key/；没有房间的旧存档只会在下一次无房间开局时收养一次。在聊天室中打开本功能并启用聊天室后，所有者可以为双方指定座位：AI 成员立即入座，人类回复「入座」后生效。每位 AI 只能走自己这一方。游戏行动不计入讨论回合。连续 AI 步数达到设置中的上限时对局暂停，所有者回复「继续」恢复，回复「停止」则暂停而不结束对局。非聊天室的桌面会话与 Telegram 对话仍是一名人类对一名 AI。你落子后，非房间会话的输入框会写入「用户名下在了…,现在是你的回合」；房间里的落子写成系统事件。用户名留空时按 user。棋盘项目克隆到数据目录，许可证不是 MIT 的不会装载。关闭启用只卸下工具，已下载的目录保留。",
    keys: ["boardsEnabled", "boardsPlayerName", "boardsHintMs"],
    summary: function (v) {
      if (!v || v.boardsEnabled !== true) return { text: "未启用", cls: "off" };
      var name = String(v.boardsPlayerName || "").trim();
      return { text: "已启用 · " + (name || "user"), cls: "on" };
    }
  },
  {
    id: "cards", group: "游戏", title: "牌类", icon: ICONS.cards,
    desc: "二十一点、勒杜克、限注德州、UNO、斗地主。由当前会话里的 AI 应着，没有上游对手。",
    intro: "默认关闭。启用后注册 card_open、card_look、card_play、card_close、card_reset。一份 RLCard（MIT）在设置页下载钉死版本后，每种牌再按自己的规则片段校验，不随本插件分发。可打二十一点、勒杜克扑克、限注德州扑克、UNO（2 至 10 人）和斗地主。无限注德州没有做。存档按游戏和房间、桌面会话或 Telegram 聊天分开，写在数据目录 cards/saves/，不保存暗牌。在聊天室中打开本功能并启用聊天室后，所有者按座位开局：UNO 2 至 10 人，勒杜克与限注德州 2 人，斗地主 3 人且座位 0 为地主。中转站牌局不开放二十一点，也不自动代打。AI 只能出自己的牌。人类回复「入座」后生效。暗牌不进入群消息，也不进入其他成员的上下文；本机座位在聊天室停靠窗的「牌桌」页看到自己的手牌。Telegram 座位需先私聊接收机器人并发送 /start，手牌发到该私聊。一个房间同时只开一桌棋或一桌牌。非聊天室仍是一名人类对一名 AI，你出牌后输入框会写入带用户名的那句话。用户名留空时按 user。关闭启用只卸下工具并收起牌桌，已下载的目录和各会话存档保留。",
    keys: ["cardsEnabled", "cardsPlayerName", "cardsUnoPlayers"],
    summary: function (v) {
      if (!v || v.cardsEnabled !== true) return { text: "未启用", cls: "off" };
      var name = String(v.cardsPlayerName || "").trim();
      return { text: "已启用 · " + (name || "user"), cls: "on" };
    }
  },
  {
    id: "desktop", group: "通用", title: "桌面控制", component: "desktop",
    moduleSource: "bundled", icon: ICONS.desktop,
    builtin: true,
    desc: "按控件操作本机桌面（键鼠、截图）。插件自带，无需下载。",
    intro: "仓库自带，无需下载。打开「启用」即可按控件操作本机 Windows 桌面：列出窗口、读取控件树、调用控件、输入、按键、点击和截图，工具名前缀 mcp__desktop__。优先走 UI Automation；Chromium / Electron 输入框发给内容子窗口。找不到该子窗口时退回前台确认后的键入。点击前会确认前台，确认失败不发鼠标。滚动优先走控件的滚动条；Chromium 内容子窗口发滚轮消息；其余在前台确认后发送滚轮。点击和滚动时屏幕上有虚拟光标和动作动画。光标不在场时从屏幕外飞入，会停留约十秒，鼠标停在光标上会显示插件名。点击和滚轮不会把系统光标留在落点。一次输入较多文字时，文字在一行里快速滚过。输入和按键会在落点右下方弹出按下的键。不含文件、注册表和 PowerShell（那些在 Windows 组件）。",
    keys: ["desktopEnabled", "desktopDock"]
  },
  {
    id: "session-controls", group: "通用", title: "会话控制", icon: ICONS.session,
    maturity: "experimental",
    maturityTitle: "尚未开发完毕；启用后可能对对话造成不可逆破坏",
    desc: "用户消息下「撤回」、助手操作行「重试」、输入框「暂停」=熔断。",
    intro: "通用会话能力（非 MCP）。撤回在用户消息下方的操作行：确认后在当前页收起该回合及之后的内容。重试在助手回复的复制与分支之间：确认后收起原回复并立刻重新生成。暂停只取消当前回合。只打开着的会话会先恢复到内存，再在当前页完成，不用退出重进。",
    warn: "【开发中功能】此功能尚未开发完毕。启用后使用撤回 / 重试 / 熔断，可能会对对话造成不可逆的破坏。默认关闭；请仅在明确需要时启用。",
    keys: ["sessionControlsEnabled", "sessionCircuitEnabled", "sessionCircuitMaxSameTool", "sessionCircuitMaxSteps", "sessionCircuitMaxReasoningChars"],
    summary: function (v) {
      if (v.sessionControlsEnabled !== true) return { text: "已关闭 · 开发中功能", cls: "off" };
      var bits = ["开发中功能"];
      bits.push(v.sessionCircuitEnabled === false ? "自动熔断关" : "自动熔断开");
      bits.push("同工具×" + (v.sessionCircuitMaxSameTool ?? 6));
      bits.push("步数≤" + (v.sessionCircuitMaxSteps ?? 80));
      return { text: bits.join(" · "), cls: "ready" };
    }
  },

  {
    id: "gateway-trust", group: "通用", title: "网关核验", icon: ICONS.trust,
    desc: "核对中转网关的回包模型、流式、Token 计数、中文完整性与缓存。",
    intro: "在聊天输入栏「识图」旁打开「核验」后，该会话此后每一轮回复都会被核对：回包 model 字段与请求是否一致、是否整包后伪流式、输出 Token 是否虚报、中文是否出现替换符或乱码、缓存命中量是否可信。结果显示在回复下方「用量」右侧，悬停或点击查看。开关按会话保存，只读采集，不修改请求与回复。判定规则来自 llm-gateway-bench（MIT），本插件不内置其代码；请在下方「下载安装」，文件保存在插件数据目录 tools/llm-gateway-bench。未下载时输入栏不显示「核验」开关；下载完成后开关自动出现，无需重启 DSH。",
    keys: [],
    summary: function () {
      var st = trustBenchKnown;
      if (st == null) return { text: "使用下载安装的副本", cls: "ready" };
      return st ? { text: "已下载", cls: "on" } : { text: "未下载", cls: "off" };
    }
  },
  {
    id: "chatroom-heartbeat", group: "通用", title: "聊天室心跳", icon: ICONS.chatroom,
    desc: "回合结束后，经 DSH 宿主日程向所选普通智能体会话投递提醒。",
    intro: "默认关闭。聊天室某一回合正常结束（完成或结束本轮）后，按下方间隔经 DSH 宿主日程向所选目标会话投递一次提醒。目标须为普通智能体会话，勿选标题为「聊天室：…」的房间会话。新一轮发言开始时取消待投递提醒；相对延迟不可修改，刷新时删除后重建。本项位于「通用」分组，可独立配置，无需打开实验性「聊天室」卡片。",
    keys: ["chatroomHeartbeatEnabled", "chatroomHeartbeatIntervalMin", "chatroomHeartbeatSessionId"],
    summary: function (v) {
      if (!v || v.chatroomHeartbeatEnabled !== true) return { text: "未启用", cls: "off" };
      var min = Number(v.chatroomHeartbeatIntervalMin);
      if (!Number.isFinite(min) || min < 1) min = 30;
      var sid = String(v.chatroomHeartbeatSessionId || "").trim();
      if (!sid) return { text: "已启用 · 未选目标会话", cls: "ready" };
      return { text: "已启用 · 间隔 " + min + " 分钟", cls: "on" };
    }
  },
  {
    id: "seats", group: "通用", title: "席位管理", icon: ICONS.chatroom,
    hidden: true, experimental: true, maturity: "experimental", maturityTitle: "开发中功能，尚未完全验证，暂不在设置页显示。",
    desc: "多 AI 房间共用的席位池：每个席位绑定智能体预设、显示名与跨会话记忆开关。",
    intro: "席位是一等配置：智能体预设 + 该人格在多 AI 房间中的显示与选项。聊天室房间从本池挑选有序成员；Minecraft 选择一个聊天室后使用该房间的同一份成员名单。可在此新增、编辑、删除、排序席位。「跨会话记忆」开关会写入席位配置，供后续记忆系统使用，本页不实现记忆写入。",
    keys: [],
    summary: function (v) {
      var n = (Array.isArray(v.chatroomSeats) ? v.chatroomSeats : []).length;
      return { text: n ? n + " 个席位" : "尚未添加席位", cls: n ? "on" : "off" };
    }
  },
  {
    id: "chatroom", group: "通用", title: "聊天室", icon: ICONS.chatroom,
    // 实验性，暂不在设置页显示：去掉 hidden 即可恢复卡片与面板。
    hidden: true, experimental: true, maturity: "experimental", maturityTitle: "开发中功能，尚未完全验证，暂不在设置页显示。",
    desc: "多个 AI 成员与您在同一房间协作讨论，可接入 Telegram 群并交由 Cursor 实施。",
    intro: "默认关闭。房间是唯一的记录来源：您、各 AI 与工具输出都写入房间，再转发到绑定的 Telegram 群（每个 AI 经自己的机器人发言）。每个房间的成员是席位池中的有序名单，请先在「席位管理」中创建席位，再在本页为房间挑选成员。不同房间可以有不同的席位组合。每条新消息是一个任务：由设置中的主答成员主答，@ 某位成员则由其主答；之后其余成员依次决定是否补充（可静默跳过），也可以交棒给更合适的成员。每个任务合计 10 个 AI 回合（成员看不到该上限），用尽后暂停并提示您，回复「批准 +N」或「批准」即可继续，这条回复不会进入聊天记录。进行中的棋局或牌局改按座位轮流，不占用这 10 个回合。连续 AI 行动达到下方步数上限时自动暂停，界面和绑定群提示后，由您回复「继续」恢复；回复「停止」只暂停对局，不结束它。这两条回复不会进入 AI 可见的记录。成员也可以在确有需要时切换主答或领队（每条消息各最多 2 次），每次变更都会在房间和 Telegram 群中通知。各 AI 只负责规划与讨论；全员同意后由领队起草 Cursor 任务书，您回复「执行」后才会在本机运行 cursor-agent。房间会话的右侧停靠窗有「记录」和「牌桌」两页。",
    keys: ["chatroomEnabled", "chatroomUserName", "chatroomDefaultMain", "chatroomTurnBudget", "chatroomGameAiStreak", "chatroomMaxHistory", "chatroomContextTokenThreshold", "chatroomSummarizerProvider", "chatroomSummarizerModel", "chatroomMaxOutputTokens", "chatroomOwnerTelegramId", "chatroomTelegramProxy", "chatroomCursorAgentPath", "chatroomCursorRepo", "chatroomCursorTimeoutSec"],
    summary: function (v) {
      if (!v || v.chatroomEnabled !== true) return { text: "未启用", cls: "off" };
      return { text: "已启用", cls: "on" };
    }
  },
  {
    id: "notes", group: "通用", title: "笔记", icon: ICONS.notes,
    desc: "智能体自行总结的要点与新知识，按类型、类别、笔记三级整理。",
    intro: "默认关闭。启用后，智能体在任务中总结出的要点、经验以及知识库中没有的新知识，可通过笔记工具按「类型 › 类别 › 笔记」三级保存，并在后续任务中浏览或检索复用。笔记只在智能体调用工具时读取，不会自动加入每轮对话。删除仍有笔记的类别时，智能体须先征得确认。笔记保存在插件数据目录的 notes/notes.json，可在下方查看和编辑。",
    keys: ["notesEnabled"],
    summary: function (v) {
      if (!v || v.notesEnabled !== true) return { text: "未启用", cls: "off" };
      return { text: "已启用", cls: "on" };
    }
  },
  {
    id: "pre-compaction-history", group: "通用", title: "压缩前历史", icon: ICONS.notes,
    desc: "官方压缩后，用工具检索被摘要遮蔽的原始会话回合。",
    intro: "默认开启。DSH 官方压缩（手动 /compact 或上下文压力自动压缩）会把一段表面历史替换成 compact-checkpoint 摘要，模型之后只能看到摘要；但会话的追加日志仍保留被遮蔽的原始 user/assistant/tool 事件。启用后向会话提供只读工具 search_pre_compaction：可按关键词检索原文、按角色/序号过滤，或先 listCheckpoints 查看各次压缩范围。仅当前会话；与聊天室的 search_history（房间 messages.jsonl）无关。关闭后卸下工具。",
    keys: ["preCompactionHistoryEnabled"],
    summary: function (v) {
      if (v && v.preCompactionHistoryEnabled === false) return { text: "未启用", cls: "off" };
      return { text: "已启用 · search_pre_compaction", cls: "on" };
    }
  },
  {
    id: "companion-compaction", group: "通用", title: "陪伴压缩指令", icon: ICONS.notes,
    desc: "官方压缩时用陪伴向检查点覆盖编码助手指令。",
    intro: "默认开启。官方 @deepseek-ai/dsh-compaction-basic 会把冻结的英文「编码助手」压缩指令作为最后一条用户消息发给摘要模型；本开关在运行时包装 llm.stream，仅在 purpose=compaction 时把该指令换成内置中文陪伴检查点（关系、情绪、话题、偏好、承诺、事实、当前状态、接下来）。可选在下方填写自定义指令。不改 Program Files；与「压缩前历史」独立——会话原文与 search_pre_compaction 仍然可用。关闭后立即恢复官方指令。",
    keys: ["companionCompactionEnabled", "companionCompactionInstruction"],
    summary: function (v) {
      if (v && v.companionCompactionEnabled === false) return { text: "未启用", cls: "off" };
      var custom = v && String(v.companionCompactionInstruction || "").trim();
      return { text: custom ? "已启用 · 自定义指令" : "已启用 · 陪伴压缩指令", cls: "on" };
    }
  },
  {
    id: "cross-session-memory", group: "通道", title: "跨会话记忆", icon: ICONS.notes,
    desc: "QQ ↔ Telegram 记忆圈：按需 list/search；入站短称呼摘要；ID→显示名别名。",
    intro: "默认开启。智能体可用 cross_session_list / cross_session_search 按需查看同一记忆圈（OwnerLink + 预设）下其他通道会话的历史，不会静默灌入全文。通道入站时会注入一行短 [person-memory] 摘要（含称呼，若有）。在下方「称呼别名」表格中按通道类型管理用户/群 ID 的显示名（优先于聊天记录提取）；QQ 常无昵称时请手动填写。OwnerLink 默认对应 Shiro 的 TG/QQ，可改。",
    keys: ["crossSessionMemoryEnabled", "crossSessionOwnerTelegramIds", "crossSessionOwnerQqOpenIds", "crossSessionPresets", "crossSessionShareGroups", "crossSessionAliases"],
    summary: function (v) {
      if (!v || v.crossSessionMemoryEnabled === false) return { text: "未启用", cls: "off" };
      var n = String(v.crossSessionAliases || "").split(/\r?\n/).filter(function (l) { return l.trim() && l.trim().charAt(0) !== "#"; }).length;
      return { text: n ? ("已启用 · " + n + " 条别名") : "已启用", cls: "on" };
    }
  },
  {
    id: "balance", group: "通用", title: "余额查询", icon: ICONS.balance,
    desc: "查询各 AI 服务商的账户余额或已用金额，只使用官方查询接口，每个服务商单独设置密钥。",
    intro: "默认关闭。打开「启用」后，在下方为需要的服务商分别打开开关并保存密钥：DeepSeek、xAI（管理密钥与团队 ID）、OpenRouter、Moonshot（Kimi）、硅基流动、阿里云（AccessKey）可查询余额；OpenAI 与 Anthropic 没有公开的余额接口，改为用各自的 Admin Key 查询本月或近 30 天的已用金额。Google Gemini 与智谱没有官方查询接口，只提供控制台链接。密钥只保存在本插件设置中，保存后不再显示，也不会出现在日志或工具结果里。结果缓存约 60 秒，可点「刷新」立即查询，或设置自动刷新。开启「AI 查询工具」后，AI 可调用 balance_query 查询。",
    keys: ["balanceEnabled", "balanceAiTool", "balanceAutoRefreshMin", "balanceLowThreshold"],
    summary: function (v) {
      if (!v || v.balanceEnabled !== true) return { text: "未启用", cls: "off" };
      var n = ["Deepseek", "Xai", "Openrouter", "Moonshot", "Siliconflow", "Openai", "Anthropic", "Aliyun"].filter(function (k) { return v["balance" + k + "Enabled"] === true; }).length;
      return { text: "已启用 · " + n + " 个服务商", cls: n ? "on" : "ready" };
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
    intro: "填写要接入的程序名称，复制下方命令粘贴给 AI。AI 按 docs/component-module.md 在 local-components/<id>/ 写本地兼容模块（与仓库自带同接口）；不会下载进 tools/。写好后出现在「工作组件」分组（徽标「本地」），可在管理页「提交 PR」贡献到仓库。",
    keys: [],
    summary: function () {
      return { text: "提示词工具", cls: "ready" };
    }
  }
];
// 标记为 hidden 的功能（目前：实验性的席位管理与聊天室）在列表中默认不显示；/settings 返回 showExperimental
// （本机环境变量 DSH_WORK_SHOW_EXPERIMENTAL=1 或插件数据目录下的 show-experimental 文件）时才显示。
// 条目仍留在 FEATURES 中以便详情页输入框被创建（避免 fill 写未渲染字段），列表项以 hidden 隐藏。


// <mm-search-helpers> 设置页首页搜索的纯函数（不碰 DOM；src/components/settings-search.test.mjs 从源码截取本段执行）
// 统一折叠：转小写；NFKC 不改变长度时再做（全角字母数字转半角），保证高亮下标与原文一一对应。
function mmSearchFold(s) {
  var t = String(s == null ? "" : s).toLowerCase();
  if (typeof t.normalize === "function") {
    var n = t.normalize("NFKC");
    if (n.length === t.length) t = n;
  }
  return t;
}
// 搜索词：按空白（含全角空格）切分、去重；空串表示不筛选。
function mmSearchTerms(query) {
  var out = [];
  mmSearchFold(query).split(/\s+/).forEach(function (w) { if (w && out.indexOf(w) < 0) out.push(w); });
  return out;
}
// 一项是否命中：每个词都要出现在「名称 / 描述 / 分组名」之一（多词为「且」）。不看卡片里的设置字段。
function mmSearchMatches(item, terms) {
  if (!terms || !terms.length) return true;
  var hay = [item && item.title, item && item.desc, item && item.group].map(mmSearchFold).join("\n");
  for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
  return true;
}
// items：[{ title, desc, group, hidden }]（hidden = 本来就不显示的行，如未开启的实验性功能，永不计入）。
// 返回 { active, terms, matched: [逐项是否显示], groups: { 分组名: 是否有可见项 }, count: 可见项数 }。
// 分组名命中所有词时，该组每一项都命中（分组名是匹配文本的一部分）。
function mmSearchFilter(items, query) {
  var terms = mmSearchTerms(query);
  var matched = [];
  var groups = {};
  var count = 0;
  (items || []).forEach(function (it) {
    var g = String((it && it.group) || "");
    if (!Object.prototype.hasOwnProperty.call(groups, g)) groups[g] = false;
    var ok = !(it && it.hidden) && mmSearchMatches(it, terms);
    matched.push(ok);
    if (ok) { groups[g] = true; count++; }
  });
  return { active: terms.length > 0, terms: terms, matched: matched, groups: groups, count: count };
}
// 高亮区间：text 中所有词出现处的 [起, 止)，排序并合并重叠 / 相邻区间。折叠后长度变化（罕见字符）时不高亮。
function mmSearchRanges(text, terms) {
  var src = String(text == null ? "" : text);
  var folded = mmSearchFold(src);
  if (!terms || !terms.length || folded.length !== src.length) return [];
  var ranges = [];
  terms.forEach(function (t) {
    if (!t) return;
    var from = 0;
    var i;
    while ((i = folded.indexOf(t, from)) >= 0) { ranges.push([i, i + t.length]); from = i + t.length; }
  });
  ranges.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  var merged = [];
  ranges.forEach(function (r) {
    var last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) { if (r[1] > last[1]) last[1] = r[1]; } else merged.push([r[0], r[1]]);
  });
  return merged;
}
// </mm-search-helpers>

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

var MODULE_SOURCE_TEXT = { bundled: "", local: "本地" }; // bundled 不再显示「已验证」标签
var CONTRIBUTE_COMPARE_DEFAULT = "https://github.com/meya-ashuripehya/dsh-work-components/compare";

function sourceChip(src) {
  var kind = src === "local" ? "local" : "bundled";
  var label = Object.prototype.hasOwnProperty.call(MODULE_SOURCE_TEXT, kind) ? MODULE_SOURCE_TEXT[kind] : kind;
  if (!label) return null;
  var span = el("span", "mm-src " + kind, label);
  span.title = kind === "local"
    ? "用户/AI 写在 local-components/ 的本地兼容组件，可提交 PR"
    : "随 git 仓库分发的已兼容组件";
  return span;
}

function maturityChip(kind, title) {
  if (kind !== "experimental") return null;
  var span = el("span", "mm-src experimental", "开发中功能");
  span.title = title || "开发中功能，尚未完全验证；请谨慎启用";
  return span;
}

function titleNameWithSource(f, cls) {
  var wrap = titleName(f, cls);
  if (f.moduleSource === "local") { var _sc = sourceChip(f.moduleSource); if (_sc) wrap.append(_sc); }
  var m = maturityChip(f.maturity, f.maturityTitle);
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

function calendarJson(path, init) {
  return fetchJson(path, init).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "日历请求失败");
    return body;
  });
}

function loadCalendarMonth(month) {
  var query = month ? ("?month=" + encodeURIComponent(month)) : "";
  return calendarJson("/calendar" + query).then(function (body) { return body.calendar; });
}

function saveCalendarEvent(event) {
  var id = event && event.id;
  var path = id ? ("/calendar/events/" + encodeURIComponent(id)) : "/calendar/events";
  var payload = {
    title: (event && event.title) || "",
    date: (event && event.date) || "",
    endDate: (event && event.endDate) || "",
    time: (event && event.time) || "",
    endTime: (event && event.endTime) || "",
    note: (event && event.note) || ""
  };
  return calendarJson(path, { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
}

function deleteCalendarEvent(id) {
  return calendarJson("/calendar/events/" + encodeURIComponent(id), { method: "DELETE" });
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
  "· 输出：12,372 tok（其中推理 6,349 tok）\n\n" +
  "没有官方 MCP 的程序可能会使任务变得更加困难，AI 可能会考虑其他来源和方式来增加组件，这可能导致更多用量：\n" +
  "以作者使用 Deepseek Harness 作为 Coding Agent，模型使用 DeepSeek-V41-Flash、思考强度 High，添加 Cursor 组件时，Token 用量信息如下：\n" +
  "· 本轮用量：6,501,132 tok\n" +
  "· 提供方 / 模型：deepseek-account/deepseek-flash\n" +
  "· 缓存命中：97.6%\n" +
  "· 未缓存输入：156,850 tok\n" +
  "· 缓存读取：6,310,272 tok\n" +
  "· 缓存写入：0 tok\n" +
  "· 输出：34,010 tok";

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
  var calendarRoots = [];
  var toggles = {}; // 设置 key -> 「启用」旋钮 { key, btn, msg, saving }
  // 启动门控：组件「启用」key -> 服务端给出的 launchBlocked（null = 可启动）。读到 /components 之前组件旋钮保持禁用。
  var launchGate = {};
  var gateMissing = {}; // 组件「启用」key -> 门控原因是「未安装」（旋钮显示为关闭）；重新安装期间保持原显示
  var actions = {}; // 组件 id -> 字段旁的动作按钮 { key, btn, msg, path, busy, ready }（如 Godot「安装插件到项目」）
  var currentView = null; // 当前打开的管理页（功能 id）；null 为列表。只记在本页实例里。
  var lastValue = null; // 最近一次从宿主读到 / 保存后的完整设置
  // 未授权私聊在设置页 / 通知里获授权后，服务端已改写「允许的其他用户 ID」：同步到已读设置与输入框，
  // 避免之后保存任一页时用旧值把刚授权的 ID 覆盖掉。
  function syncTelegramAllowFrom(v) {
    if (typeof v !== "string" || disposed) return;
    if (lastValue && lastValue.telegramAllowFrom === v) return;
    var input = inputs.telegramAllowFrom;
    var stale = !lastValue || !input || input.value === String(lastValue.telegramAllowFrom == null ? "" : lastValue.telegramAllowFrom);
    if (lastValue) lastValue.telegramAllowFrom = v;
    if (input && stale) input.value = v;
  }
  function onTelegramDmEvent(e) { var d = e && e.detail; if (d && typeof d.allowFrom === "string") syncTelegramAllowFrom(d.allowFrom); }
  try { window.addEventListener(TGDM_EVENT, onTelegramDmEvent); } catch (_) { /* ignore */ }
  function syncQQAllowFrom(v) {
    if (typeof v !== "string" || disposed) return;
    if (lastValue && lastValue.qqAllowFrom === v) return;
    var input = inputs.qqAllowFrom;
    var stale = !lastValue || !input || input.value === String(lastValue.qqAllowFrom == null ? "" : lastValue.qqAllowFrom);
    if (lastValue) lastValue.qqAllowFrom = v;
    if (input && stale) input.value = v;
  }
  function syncQQGroupAllow(patch) {
    if (!patch || typeof patch !== "object" || disposed) return;
    if (typeof patch.groupIds === "string") {
      var ids = patch.groupIds;
      if (!(lastValue && lastValue.qqGroupIds === ids)) {
        var input = inputs.qqGroupIds;
        var stale = !lastValue || !input || input.value === String(lastValue.qqGroupIds == null ? "" : lastValue.qqGroupIds);
        if (lastValue) lastValue.qqGroupIds = ids;
        if (input && stale) input.value = ids;
      }
    }
    if (typeof patch.groupPolicy === "string") {
      var pol = patch.groupPolicy;
      if (!(lastValue && lastValue.qqGroupPolicy === pol)) {
        var sel = inputs.qqGroupPolicy;
        var stalePol = !lastValue || !sel || sel.value === String(lastValue.qqGroupPolicy == null ? "" : lastValue.qqGroupPolicy);
        if (lastValue) lastValue.qqGroupPolicy = pol;
        if (sel && stalePol) sel.value = pol;
      }
    }
  }
  function onQQPendingEvent(e) {
    var d = e && e.detail;
    if (!d) return;
    if (typeof d.allowFrom === "string") syncQQAllowFrom(d.allowFrom);
    if (typeof d.groupIds === "string" || typeof d.groupPolicy === "string") syncQQGroupAllow({ groupIds: d.groupIds, groupPolicy: d.groupPolicy });
  }
  try { window.addEventListener(QQPD_EVENT, onQQPendingEvent); } catch (_) { /* ignore */ }
  function onRoomConfigEvent(e) {
    var d = e && e.detail;
    if (d && typeof d === "object" && lastValue) {
      Object.assign(lastValue, d);
      if (typeof seatMainRefresh === "function" && ("chatroomDefaultMain" in d || "chatroomSeats" in d)) {
        try { seatMainRefresh(lastValue.chatroomDefaultMain); } catch (_) {}
      }
      if ("chatroomSeats" in d) { try { updateSummaries(); } catch (_) {} }
    }
  }
  try { window.addEventListener(ROOMCFG_EVENT, onRoomConfigEvent); } catch (_) { /* ignore */ }
  var byComponent = {};
  FEATURES.forEach(function (f) { if (f.component) byComponent[f.component] = f; });
  var localListEl = null;  // 工作组件列表容器（本地组件追加到同一列表）
  var compareUrlCached = CONTRIBUTE_COMPARE_DEFAULT;

  // ── 列表（首页）──
  var listView = el("div", "mm-view mm-home");
  listView.append(el("h3", undefined, "工作组件（dsh-workbench）"));
  listView.append(el("p", "mm-sub", "点击一项进入它的管理页：开关、配置、运行状态和下载安装。保存后只重新挂载改动过的组件。"));
  var updateRow = el("div", "mm-pr-row");
  updateRow.style.margin = "4px 0 10px";
  var updateBtn = el("button", "mm-btn mm-ghost", "检查更新");
  updateBtn.type = "button";
  updateBtn.title = "检查工作组件插件是否有新版本";
  var updateMsg = el("span", "mm-msg");
  updateMsg.setAttribute("aria-live", "polite");
  updateRow.append(updateBtn, updateMsg);
  listView.append(updateRow);
  var sub = el("p", "mm-sub", "正在读取设置…");
  listView.append(sub);

  // ── 首页搜索：按名称 / 描述 / 分组名即时筛选。只给行、分组标题和列表加 mm-search-out 类隐藏：
  // 不移除节点、不改设置、不拨开关；管理页（含未保存的输入）不受影响。──
  var searchBox = el("div", "mm-search");
  var searchInput = el("input", "mm-input");
  searchInput.type = "text";
  searchInput.placeholder = "搜索组件名称、描述或分组";
  searchInput.setAttribute("aria-label", "搜索组件名称、描述或分组");
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchBox.append(searchInput);
  var searchEmpty = el("div", "mm-search-empty", "没有匹配的组件");
  searchEmpty.setAttribute("role", "status");
  searchEmpty.hidden = true;
  listView.append(searchBox, searchEmpty);
  var searchComposing = false; // 中文输入法组字期间不筛选，选词后再筛
  searchInput.addEventListener("compositionstart", function () { searchComposing = true; });
  searchInput.addEventListener("compositionend", function () { searchComposing = false; applySearch(); });
  searchInput.addEventListener("input", function (e) {
    if (searchComposing || (e && e.isComposing)) return;
    applySearch();
  });
  searchInput.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" && e.key !== "Esc") return;
    if (searchComposing || e.isComposing) return; // 组字时的 Esc 交给输入法
    if (!searchInput.value) return;
    e.preventDefault();
    e.stopPropagation(); // 只清空搜索，不让宿主关掉设置窗口
    searchInput.value = "";
    applySearch();
  });
  // 把 text 写进 node，命中区间包成 <mark class="mm-hl">；区间没变时不动 DOM。
  function searchHighlight(node, text, terms) {
    if (!node) return;
    var ranges = mmSearchRanges(text, terms);
    var sig = JSON.stringify(ranges);
    if (node._mmHlSig === sig) return;
    node._mmHlSig = sig;
    node.textContent = "";
    var pos = 0;
    ranges.forEach(function (r) {
      if (r[0] > pos) node.append(document.createTextNode(text.slice(pos, r[0])));
      node.append(el("mark", "mm-hl", text.slice(r[0], r[1])));
      pos = r[1];
    });
    if (pos < text.length) node.append(document.createTextNode(text.slice(pos)));
  }
  // 行里的名称 / 描述节点。名称是 titleName 里的首个文本节点，第一次搜索时换成同文字的 span（外链、徽标不动）。
  function searchRowTargets(item, f) {
    if (item._mmSearch) return item._mmSearch;
    var nameWrap = item.querySelector(".mm-item-name");
    var nameNode = null;
    if (nameWrap && nameWrap.firstChild && nameWrap.firstChild.nodeType === 3 && nameWrap.firstChild.nodeValue === f.title) {
      nameNode = el("span", "mm-item-title", f.title);
      nameWrap.replaceChild(nameNode, nameWrap.firstChild);
    }
    var descNode = item.querySelector(".mm-item-desc");
    if (descNode && descNode.textContent !== String(f.desc == null ? "" : f.desc)) descNode = null;
    item._mmSearch = { name: nameNode, desc: descNode };
    return item._mmSearch;
  }
  function applySearch() {
    if (!searchInput) return;
    var featById = {};
    FEATURES.forEach(function (f) { featById[f.id] = f; });
    var lists = Array.prototype.slice.call(listView.querySelectorAll(".mm-list"));
    var entries = [];
    var items = [];
    lists.forEach(function (list, li) {
      var head = list.previousElementSibling;
      if (!head || !head.classList || !head.classList.contains("mm-group")) head = null;
      var groupName = head ? head.textContent : "";
      Array.prototype.forEach.call(list.children, function (item) {
        if (!item.classList || !item.classList.contains("mm-item")) return;
        var f = featById[item.getAttribute("data-feature")];
        if (!f) return;
        entries.push({ item: item, f: f, li: li });
        items.push({ title: f.title, desc: f.desc, group: f.group || groupName, hidden: item.hidden === true });
      });
    });
    var res = mmSearchFilter(items, searchInput.value);
    var listHas = lists.map(function () { return false; });
    entries.forEach(function (e, i) {
      var show = !res.active || res.matched[i];
      if (show) listHas[e.li] = true;
      e.item.classList.toggle("mm-search-out", !show);
      if (res.active || e.item._mmSearch) {
        var t = searchRowTargets(e.item, e.f);
        searchHighlight(t.name, String(e.f.title == null ? "" : e.f.title), res.active ? res.terms : []);
        searchHighlight(t.desc, String(e.f.desc == null ? "" : e.f.desc), res.active ? res.terms : []);
      }
    });
    lists.forEach(function (list, li) {
      var out = res.active && !listHas[li];
      list.classList.toggle("mm-search-out", out);
      var head = list.previousElementSibling;
      if (head && head.classList && head.classList.contains("mm-group")) head.classList.toggle("mm-search-out", out);
    });
    searchEmpty.hidden = !(res.active && res.count === 0);
  }
  page.append(listView);

  var hiddenItems = [];
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
    if (f.hidden === true) { item.hidden = true; hiddenItems.push(item); }
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
    // 本地组件并入「工作组件」同一列表，不再单独建「本地兼容」分组
    FEATURES.some(function (f) {
      if (f.group === "工作组件" && rows[f.id] && rows[f.id].parentNode) {
        localListEl = rows[f.id].parentNode;
        return true;
      }
      return false;
    });
    if (!localListEl) {
      // fallback：在「通用」之前建「工作组件」分组
      var anchorNode = null;
      FEATURES.some(function (f) {
        if (f.group === "通用" && rows[f.id]) {
          var list = rows[f.id].parentNode;
          anchorNode = list && list.previousSibling;
          return true;
        }
        return false;
      });
      var groupEl = el("div", "mm-group", "工作组件");
      localListEl = el("div", "mm-list");
      localListEl.setAttribute("role", "list");
      if (anchorNode && anchorNode.parentNode === listView) {
        listView.insertBefore(groupEl, anchorNode);
        listView.insertBefore(localListEl, anchorNode);
      } else {
        listView.append(groupEl, localListEl);
      }
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
    var _scLocal = sourceChip("local"); if (_scLocal) title.append(_scLocal);
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
      group: "工作组件",
      title: c.label || c.id,
      component: c.id,
      moduleSource: "local",
      icon: ICONS.addComponent,
      url: c.url || null,
      desc: c.summary || "本地组件（local-components/" + c.id + "）",
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
    applySearch();
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
    if (f.moduleSource === "local") { var _sc2 = sourceChip(f.moduleSource); if (_sc2) title.append(_sc2); }
    var _mat = maturityChip(f.maturity, f.maturityTitle);
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
      if (f.group === "工作组件" || f.group === "游戏" || f.group === "通道" || f.id === "desktop") {
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
    f.keys.forEach(function (k) { if (FIELD_BY_KEY[k].type !== "switch" && !FIELD_BY_KEY[k].hidden) view.append(buildField(FIELD_BY_KEY[k])); });
    var srow = el("div", "mm-row");
    var save = el("button", "mm-btn", "保存");
    save.type = "button";
    save.disabled = true; // 设置读到之前不能保存，免得用空值覆盖
    var msg = el("span", "mm-msg");
    srow.append(save, msg);
    view.append(srow);
    if (f.id === "calendar") {
      var calendarHost = el("div");
      calendarHost.style.marginTop = "12px";
      view.append(calendarHost);
      if (ReactDOMClient && typeof ReactDOMClient.createRoot === "function") {
        var calendarRoot = ReactDOMClient.createRoot(calendarHost);
        calendarRoot.render(h(MmCalendarPanel, {
          loadMonth: loadCalendarMonth,
          saveEvent: saveCalendarEvent,
          deleteEvent: deleteCalendarEvent
        }));
        calendarRoots.push(calendarRoot);
      } else {
        calendarHost.textContent = "当前页面不能挂载日历面板。";
      }
    }
    if (f.id === "gpt-image") {
      var giRow = el("div", "mm-row");
      var giBtn = el("button", "mm-btn", "测试连接");
      giBtn.type = "button";
      var giMsg = el("span", "mm-msg", "未连接");
      giMsg.setAttribute("aria-live", "polite");
      giRow.append(giBtn, giMsg);
      var giNote = el("div", "mm-note", "测试连接使用已保存的设置，仅请求 GET {Base URL}/models，不产生出图费用。修改设置后请先保存再测试。");
      view.append(giRow, giNote);
      giBtn.addEventListener("click", function () {
        giBtn.disabled = true;
        giMsg.textContent = "正在连接…";
        giMsg.className = "mm-msg";
        fetchJson("/gpt-image/test", { method: "POST", body: "{}" }).then(function (j) {
          if (j && j.ok) {
            var text = "已连接：" + j.host + "，可用模型 " + j.modelCount + " 个";
            if (j.modelListed === false) text += "；模型列表中未找到「" + j.model + "」，请核对模型名称";
            giMsg.textContent = text + "。";
            giMsg.className = j.modelListed === false ? "mm-msg" : "mm-msg ok";
          } else {
            giMsg.textContent = (j && j.error) || "未连接";
            giMsg.className = "mm-msg err";
          }
        }).catch(function (e) {
          giMsg.textContent = "连接失败：" + ((e && e.message) || e);
          giMsg.className = "mm-msg err";
        }).finally(function () { giBtn.disabled = false; });
      });
    }
    if (f.id === "video") {
      var vdRow = el("div", "mm-row");
      var vdBtn = el("button", "mm-btn mm-ghost", "刷新状态");
      vdBtn.type = "button";
      var ytBtn = el("button", "mm-btn mm-ghost", "下载 yt-dlp");
      ytBtn.type = "button";
      var vdMsg = el("span", "mm-msg", "正在读取状态…");
      vdMsg.setAttribute("aria-live", "polite");
      vdMsg.style.overflowWrap = "anywhere";
      vdRow.style.flexWrap = "wrap";
      var saFileInput = el("input");
      saFileInput.type = "file";
      saFileInput.accept = ".json";
      saFileInput.style.display = "none";
      var saUploadBtn = el("button", "mm-btn mm-ghost", "选择 JSON 文件");
      saUploadBtn.type = "button";
      var saRemoveBtn = el("button", "mm-btn mm-ghost", "移除服务账号");
      saRemoveBtn.type = "button";
      var saMsg = el("span", "mm-msg");
      saMsg.setAttribute("aria-live", "polite");
      var saRow = el("div", "mm-row");
      saRow.style.flexWrap = "wrap";
      saRow.append(saMsg, saFileInput);
      var bucketChkBtn = el("button", "mm-btn mm-ghost", "检查存储桶");
      bucketChkBtn.type = "button";
      var bucketMsg = el("span", "mm-msg");
      bucketMsg.setAttribute("aria-live", "polite");
      bucketMsg.style.overflowWrap = "anywhere";
      var bucketRow = el("div", "mm-row");
      bucketRow.style.flexWrap = "wrap";
      bucketRow.append(bucketMsg);
      // 「选择 JSON 文件」「移除服务账号」挪到「服务账号文件」标签同一行右侧；「检查存储桶」挪到「存储桶」那一行的右侧。
      (function () {
        // 按 data-mm-key 找字段容器：开关与输入框的 DOM 结构不同，且渲染顺序可能晚于本区块，
        // 所以找不到时下一帧重试（最多 20 次），别让按钮凭空消失。
        var findField = function (key) {
          var root = view.closest ? (view.closest(".mm-page") || document) : document;
          return root.querySelector('[data-mm-key="' + key + '"]');
        };
        var place = function (key, nodes, kind) {
          var attempt = function (tries) {
            var field = findField(key);
            if (!field) {
              if (tries > 0) return setTimeout(function () { attempt(tries - 1); }, 16);
              // 实在找不到就放到本区块末尾，至少不丢按钮。
              var box = el("div", "mm-field-actions");
              nodes.forEach(function (n) { box.append(n); });
              vdRow.append(box);
              return;
            }
            if (kind === "head") {
              var head = field.querySelector(".mm-field-head") || field;
              var box = el("span", "mm-field-head-actions");
              nodes.forEach(function (n) { box.append(n); });
              head.append(box);
              return;
            }
            var row = el("div", "mm-field-actions");
            nodes.forEach(function (n) { row.append(n); });
            field.append(row);
          };
          attempt(20);
        };
        var moveInto = function (key, nodes) { place(key, nodes, "head"); return true; };
        var appendToField = function (key, nodes) { place(key, nodes, "field"); return true; };
        moveInto("videoServiceAccountFile", [saUploadBtn, saRemoveBtn]);
        moveInto("videoBucket", [bucketChkBtn]);
        // 「下载 yt-dlp」放到「哔哩哔哩」开关与说明下面。
        appendToField("videoBilibili", [ytBtn]);
      })();
      vdRow.append(vdBtn, saRow, bucketRow, vdMsg);
      var vdList = el("div", "mm-note");
      vdList.style.whiteSpace = "pre-wrap";
      vdList.style.overflowWrap = "anywhere";
      view.append(vdRow, vdList);
      var ytPoll = null;
      var ytSrc = { setting: "设置中的路径", path: "PATH", downloaded: "插件下载的副本" };
      // 下载进度走等待层（video-ytdlp:main，全局去重），结束时给一条通知。
      var ytSync = function (y) {
        var job = y && y.job;
        var w = mmWaitHandleOf("video-ytdlp", "main");
        if (job && job.state === "running") {
          var p = job.progress == null ? "indeterminate" : (Number(job.progress) || 0);
          if (!w) w = mmWaitShow("正在下载 yt-dlp", "video-ytdlp", "main", { progress: p });
          if (w) { try { if (job.step) w.setText("yt-dlp：" + job.step); w.setProgress(p); } catch (e) {} }
          return true;
        }
        if (w) {
          mmWaitClear("video-ytdlp", "main");
          if (job && job.state === "done") mmToast("yt-dlp 已下载并通过 sha256 校验" + (y.installed && y.installed.version ? "（" + y.installed.version + "）" : ""), "ok");
          else if (job && job.state === "error") mmToast("yt-dlp 下载失败：" + (job.error || "未知错误"), "err");
        }
        return false;
      };
      var vdLoad = function (quiet) {
        if (!quiet) vdBtn.disabled = true;
        fetchJson("/video/status").then(function (j) {
          if (!j || j.ok === false) throw new Error((j && j.error) || "读取失败");
          var st = j.settings || {};
          var k = j.key || {};
          var y = j.ytdlp || {};
          // 密钥输入框占位文字同步显示来源掩码（已配置 ••••xxxx）；正在输入新值或点过「清除」时不动。
          var vkIn = inputs.videoGeminiKey;
          if (vkIn && FIELD_BY_KEY.videoGeminiKey && vkIn.value === "" && vkIn.getAttribute("data-saved") !== "clear") setSecretInput(vkIn, FIELD_BY_KEY.videoGeminiKey, !!k.ready, k.ready ? (k.tail || "") : "");
          vdMsg.textContent = j.detail || (j.status === "on" ? "已启用" : "未启用");
          vdMsg.className = "mm-msg" + (j.status === "on" ? (k.ready ? " ok" : "") : j.status === "error" ? " err" : "");
          var lines = [];
          if (k.credentialSource === "serviceAccount") {
            lines.push("凭据来源：Google Cloud 服务账号" + (k.ready ? "（" + (k.clientEmail || "") + "，项目 " + (k.projectId || "") + "，文件 " + (k.file || st.serviceAccountFile || "credentials/video-sa.json") + "）" : "（" + (k.problem || "未配置") + "）"));
          } else {
            lines.push("凭据来源：Gemini API Key · " + (k.ready ? "已配置（" + (k.tail || "••••") + "）" : "未配置密钥。请在上方填写；本组件不沿用聊天室转写密钥或成员凭据。"));
          }
          if (st.credentialSource === "serviceAccount") {
            lines.push("Vertex 区域：" + (st.vertexLocation || "us-central1"));
            lines.push("存储桶：" + (st.videoBucket ? st.videoBucket + "（前缀 " + (st.videoBucketPrefix || "dsh-video") + "）" : "未配置（仅支持 20 MB 以内）"));
            lines.push("服务账号下载清晰度上限：" + (st.videoMaxHeight || "480") + " px");
          }
          lines.push("会话工具：" + (j.mounted ? "describe_video、watch_video 已挂载" : "未挂载"));
          lines.push("YouTube 链接：" + (st.youtube === false ? "已关闭" : "已开启"));
          var ytLine = y.version ? "yt-dlp：" + y.version + "（" + (ytSrc[y.source] || y.source || "PATH") + "）" : "yt-dlp：未检测到";
          if (y.customPath && y.version && y.source !== "setting") ytLine += "；设置中的路径无法运行，已改用" + (ytSrc[y.source] || y.source);
          lines.push(ytLine);
          lines.push("已下载的副本：" + (y.installed ? y.installed.version + "（数据目录 bin 文件夹，来自官方 GitHub 发布页，已校验 sha256）" : "无"));
          lines.push("哔哩哔哩链接：" + (st.bilibili === false ? "已关闭" : y.version ? "已开启" : "不可用：未检测到 yt-dlp。可点击「下载 yt-dlp」，或自行安装并加入 PATH 后点击「刷新状态」。"));
          lines.push("查找顺序：设置中的路径 → PATH → 插件下载的副本。");
          lines.push("模型：" + (st.model || "gemini-3.8-flash"));
          lines.push("Base URL：" + (st.baseUrl || "https://generativelanguage.googleapis.com") + (st.baseUrl && st.baseUrl !== "https://generativelanguage.googleapis.com" ? "（自定义）" : "（默认，Google AI Studio）"));
          vdList.textContent = lines.join("\n");
          var running = ytSync(y);
          ytBtn.textContent = running ? "正在下载…" : y.installed ? "更新 / 重新下载 yt-dlp" : "下载 yt-dlp";
          ytBtn.disabled = running || y.downloadable === false;
          if (running && !ytPoll) {
            ytPoll = setInterval(function () {
              if (!view.isConnected) { clearInterval(ytPoll); ytPoll = null; mmWaitClear("video-ytdlp", "main"); return; }
              vdLoad(true);
            }, 800);
          } else if (!running && ytPoll) { clearInterval(ytPoll); ytPoll = null; }
        }).catch(function (e) {
          vdMsg.textContent = "读取失败：" + ((e && e.message) || e);
          vdMsg.className = "mm-msg err";
        }).finally(function () { vdBtn.disabled = false; });
      };
      (afterSave || (afterSave = {})).video = function () { vdLoad(true); };
      saUploadBtn.addEventListener("click", function () { saFileInput.click(); });
      saFileInput.addEventListener("change", function () {
        var file = saFileInput.files && saFileInput.files[0];
        saFileInput.value = "";
        if (!file) return;
        saUploadBtn.disabled = true;
        saMsg.textContent = "正在上传…";
        saMsg.className = "mm-msg";
        var reader = new FileReader();
        reader.onload = function () {
          fetchJson("/video/credential", { method: "POST", body: JSON.stringify({ json: reader.result }) }).then(function (body) {
            if (!body || body.ok === false) throw new Error((body && body.error) || "上传失败");
            saMsg.textContent = "已保存 " + (body.file || "") + "（" + (body.email || "") + "）";
            saMsg.className = "mm-msg ok";
            var saIn = inputs.videoServiceAccountFile;
            if (saIn) saIn.value = body.file || "";
            vdLoad(true);
          }).catch(function (e) {
            saMsg.textContent = (e && e.message) || String(e);
            saMsg.className = "mm-msg err";
          }).finally(function () { saUploadBtn.disabled = false; });
        };
        reader.onerror = function () { saMsg.textContent = "读取文件失败"; saMsg.className = "mm-msg err"; saUploadBtn.disabled = false; };
        reader.readAsText(file);
      });
      saRemoveBtn.addEventListener("click", function () {
        saRemoveBtn.disabled = true;
        fetchJson("/video/credential", { method: "DELETE" }).then(function (body) {
          if (!body || body.ok === false) throw new Error((body && body.error) || "移除失败");
          var saIn = inputs.videoServiceAccountFile;
          if (saIn) saIn.value = "";
          saMsg.textContent = "已移除服务账号文件";
          saMsg.className = "mm-msg ok";
          vdLoad(true);
        }).catch(function (e) {
          saMsg.textContent = (e && e.message) || String(e);
          saMsg.className = "mm-msg err";
        }).finally(function () { saRemoveBtn.disabled = false; });
      });
      vdBtn.addEventListener("click", function () { vdLoad(false); });
      bucketChkBtn.addEventListener("click", function () {
        bucketChkBtn.disabled = true;
        bucketMsg.textContent = "正在检查…";
        bucketMsg.className = "mm-msg";
        fetchJson("/video/bucket/check", { method: "POST", body: "{}" }).then(function (body) {
          if (!body || body.ok === false) {
            var steps = body && body.steps;
            var parts = [];
            if (steps) {
              parts.push("列桶：" + (steps.bucket && steps.bucket.detail || ""));
              parts.push("写入探针：" + (steps.write && steps.write.detail || ""));
              parts.push("删除探针：" + (steps.delete && steps.delete.detail || ""));
            }
            bucketMsg.textContent = (body && body.error) || parts.join("；") || "检查未通过";
            if (body && body.hint) bucketMsg.textContent += "。" + body.hint;
            if (body && body.suggest) bucketMsg.textContent += " 建议：" + body.suggest;
            bucketMsg.className = "mm-msg err";
            return;
          }
          bucketMsg.textContent = "存储桶检查通过（列桶、写入探针、删除探针均成功）。";
          bucketMsg.className = "mm-msg ok";
        }).catch(function (e) {
          bucketMsg.textContent = (e && e.message) || String(e);
          bucketMsg.className = "mm-msg err";
        }).finally(function () { bucketChkBtn.disabled = false; });
      });
      ytBtn.addEventListener("click", function () {
        ytBtn.disabled = true;
        fetchJson("/video/ytdlp/download", { method: "POST", body: "{}" }).then(function (body) {
          if (!body || body.ok === false) throw new Error((body && body.error) || "下载失败");
          vdLoad(true);
        }).catch(function (e) {
          ytBtn.disabled = false;
          mmToast("yt-dlp 下载失败：" + ((e && e.message) || e), "err");
        });
      });
      vdLoad(false);
    }
    if (f.id === "balance") {
      var balanceHost = el("div");
      view.append(balanceHost);
      try { buildBalancePanel(balanceHost); } catch (e) { balanceHost.textContent = "余额查询面板加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "notes") {
      var notesHost = el("div");
      view.append(notesHost);
      try { buildNotesPanel(notesHost); } catch (e) { notesHost.textContent = "笔记面板加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "stickers") {
      var stickersHost = el("div");
      view.append(stickersHost);
      try { buildStickersPanel(stickersHost); } catch (e) { stickersHost.textContent = "表情包面板加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "seats") {
      var seatsHost = el("div");
      view.append(seatsHost);
      try { buildSeatsPanel(seatsHost); } catch (e) { seatsHost.textContent = "席位管理加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "chatroom") {
      var chatroomHost = el("div");
      view.append(chatroomHost);
      try { buildChatroomPanel(chatroomHost); } catch (e) { chatroomHost.textContent = "聊天室面板加载失败：" + ((e && e.message) || e); }
      var chatroomToolsHost = el("div");
      view.append(chatroomToolsHost);
      try { buildChatroomToolsPanel(chatroomToolsHost); } catch (e) { chatroomToolsHost.textContent = "工具设置加载失败：" + ((e && e.message) || e); }
      var chatroomAttachHost = el("div");
      view.append(chatroomAttachHost);
      try { buildChatroomAttachPanel(chatroomAttachHost); } catch (e) { chatroomAttachHost.textContent = "附件设置加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "boards") {
      var boardsHost = el("div");
      view.append(boardsHost);
      try { buildBoardsPanel(boardsHost); } catch (e) { boardsHost.textContent = "棋类下载状态加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "gateway-trust") {
      var trustHost = el("div");
      view.append(trustHost);
      try { buildTrustBenchPanel(trustHost); } catch (e) { trustHost.textContent = "llm-gateway-bench 安装状态加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "cards") {
      var cardsHost = el("div");
      view.append(cardsHost);
      try { buildCardsPanel(cardsHost); } catch (e) { cardsHost.textContent = "牌类下载状态加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "telegram") {
      var tgBotsHost = el("div");
      view.append(tgBotsHost);
      try { buildTelegramBotsPanel(tgBotsHost); } catch (e) { tgBotsHost.textContent = "机器人列表加载失败：" + ((e && e.message) || e); }
      var tgDmHost = el("div");
      view.append(tgDmHost);
      try { buildTelegramDmPanel(tgDmHost, syncTelegramAllowFrom); } catch (e) { tgDmHost.textContent = "未授权私聊名单加载失败：" + ((e && e.message) || e); }
    }
    if (f.id === "qq") {
      var qqPendingHost = el("div");
      view.append(qqPendingHost);
      try { buildQQPendingPanel(qqPendingHost, { onAllowFrom: syncQQAllowFrom, onGroupAllow: syncQQGroupAllow }); } catch (e) { qqPendingHost.textContent = "未授权私聊/群聊名单加载失败：" + ((e && e.message) || e); }
    }
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
    wrap.setAttribute("data-mm-key", f.key);
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

  // 自定义下拉：原生 <select> 弹出层在 Electron 暗色主题下常白底浅字（option 样式被忽略）；用宿主 --dsw-alias-* token 自绘菜单。
  function buildThemedSelect(f) {
    var root = el("div", "mm-select");
    var trigger = el("button", "mm-input mm-select-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    var labelSpan = el("span");
    trigger.append(labelSpan);
    var menu = el("div", "mm-select-menu");
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    var entries = [];
    var current = "";

    function labelOf(v) {
      for (var i = 0; i < entries.length; i++) if (entries[i].value === v) return entries[i].label;
      return v;
    }
    function sync() {
      labelSpan.textContent = labelOf(current) || (f.placeholder || "");
      for (var i = 0; i < entries.length; i++) {
        entries[i].el.setAttribute("aria-selected", entries[i].value === current ? "true" : "false");
      }
    }
    function close() {
      if (menu.hidden) return;
      menu.hidden = true;
      root.removeAttribute("data-open");
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    }
    function onDoc(e) {
      if (!root.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); }
    }
    function open() {
      if (!menu.hidden) return;
      menu.hidden = false;
      root.setAttribute("data-open", "true");
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
      var sel = menu.querySelector('[aria-selected="true"]') || menu.querySelector(".mm-select-option");
      if (sel) try { sel.focus(); } catch (_) {}
    }
    function setValue(v) {
      current = v === undefined || v === null ? "" : String(v);
      sync();
    }

    function addOption(o) {
      var value = typeof o === "string" ? o : o.value;
      var lab = typeof o === "string" ? o : o.label;
      var item = el("button", "mm-select-option", lab);
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("data-value", String(value));
      item.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        setValue(value);
        close();
        trigger.focus();
        root.dispatchEvent(new Event("change", { bubbles: true }));
      });
      menu.append(item);
      entries.push({ value: String(value), label: lab, el: item });
    }
    (f.options || []).forEach(addOption);
    if (entries.length) setValue(entries[0].value);
    else sync();
    // 动态选项（如 DSH 智能体预设）：替换菜单，保留当前值；当前值不在列表里时仍显示原值。
    root.setOptions = function (opts) {
      menu.textContent = "";
      entries = [];
      (opts || []).forEach(addOption);
      sync();
    };

    trigger.addEventListener("click", function (e) {
      e.preventDefault();
      if (menu.hidden) open(); else close();
    });
    trigger.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });

    Object.defineProperty(root, "value", {
      get: function () { return current; },
      set: function (v) { setValue(v); },
      configurable: true,
    });
    // buildField 会给 input.id / label.htmlFor：接到触发按钮上
    Object.defineProperty(root, "id", {
      get: function () { return trigger.id; },
      set: function (v) { trigger.id = v; },
      configurable: true,
    });
    root.focus = function () { trigger.focus(); };
    root.blur = function () { trigger.blur(); };
    root.append(trigger, menu);
    return root;
  }

  // Minecraft AI 表（gb_minecraft_MC_AGENTS，JSON 字符串）：样式与操作仿照聊天室成员列表，编辑结果随本卡「保存」写入。
  // 编码规则、旧设置迁移、导入与软删除与 src/components/gamebot/agents.mjs 相同（浏览器脚本无法 import，修改时请同步两处）。
  function buildMcAgentsField(f) {
    var CODE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var label = el("label", undefined, f.label);
    var box = el("div", "mc-ag");
    var head = el("div", "mc-ag-head");
    var count = el("span", "mc-ag-title");
    var impBtn = el("button", "mm-btn mm-ghost", "从聊天室导入");
    impBtn.type = "button";
    var addBtn = el("button", "mm-btn mm-ghost", "添加 AI");
    addBtn.type = "button";
    head.append(count, impBtn, addBtn);
    var note = el("span", "mc-ag-sub");
    note.hidden = true;
    var listEl = el("div", "mc-ag-list");
    box.append(head, note, listEl);
    var rows = [];
    var migrated = false;
    function str(v) { return v == null ? "" : String(v); }
    function codeError(code, taken) {
      var c = str(code);
      if (!c.trim()) return "编码不能为空。";
      if (c.length > 32) return "编码长度不能超过 32 个字符。";
      if (!CODE_RE.test(c)) return "编码只能包含小写字母、数字和连字符（-），且须以小写字母或数字开头。";
      if ((taken || []).indexOf(c) >= 0) return "编码「" + c + "」已存在，请使用其他编码。";
      return "";
    }
    function nameWidth(name) {
      var s = String(name || "");
      var width = 0;
      for (var i = 0; i < s.length;) {
        var cp = s.codePointAt(i);
        width += cp > 255 ? 2 : 1;
        i += cp > 65535 ? 2 : 1;
      }
      return width;
    }
    function named(row, name) {
      row.name = name;
      if (nameWidth(name) > 12) row.nameOverLimit = true;
      return row;
    }
    function norm(r) {
      if (!r || typeof r !== "object") return null;
      var code = str(r.code != null ? r.code : r.agent_id).trim();
      if (codeError(code)) return null;
      var profileId = str(r.profileId).trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId)) profileId = "";
      return named({ code: code, enabled: r.enabled !== false, removed: r.removed === true, provider: str(r.provider), model: str(r.model), preset: str(r.preset), reasoningEffort: str(r.reasoningEffort), persona: profileId ? "" : str(r.persona), profileId: profileId }, str(r.name).trim() || code);
    }
    function seats() {
      return lastValue && Array.isArray(lastValue.chatroomSeats) ? lastValue.chatroomSeats.filter(function (s) { return s && typeof s === "object"; }) : [];
    }
    function fromSeat(s) {
      return norm({ code: str(s && s.id).trim(), name: s && s.name, enabled: true, provider: s && s.provider, model: s && s.model, preset: s && s.preset, reasoningEffort: s && s.reasoningEffort, persona: "", profileId: "" });
    }
    function pushUnique(out, r) { if (r && !out.some(function (x) { return x.code === r.code; })) out.push(r); }
    function migrate() {
      var v = lastValue || {};
      var list = seats();
      var ids = str(v.gb_minecraft_MC_MEMBER_IDS).split(/[,，\s]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
      var picked = ids.length
        ? ids.map(function (id) { return list.filter(function (s) { return str(s.id).trim() === id; })[0] || { id: id }; })
        : list.filter(function (s) { return s.enabled !== false; });
      var out = [];
      picked.forEach(function (s) { pushUnique(out, fromSeat(s)); });
      var legacyName = str(v.gb_minecraft_MC_USERNAME).trim();
      if (out.length === 1 && legacyName && legacyName !== "Player") {
        out[0].name = legacyName;
        if (nameWidth(legacyName) > 12) out[0].nameOverLimit = true;
        else delete out[0].nameOverLimit;
      }
      return out;
    }
    function parse(text) {
      var raw = str(text).trim();
      if (!raw) return null;
      var list;
      try { list = JSON.parse(raw); } catch (e) { return []; }
      var out = [];
      (Array.isArray(list) ? list : []).forEach(function (x) { pushUnique(out, norm(x)); });
      return out;
    }
    function changed() { render(); }
    function btn(text, title, fn, disabled) {
      var x = el("button", "mm-btn mm-ghost", text);
      x.type = "button";
      x.title = title;
      x.setAttribute("aria-label", title);
      x.disabled = !!disabled;
      x.addEventListener("click", fn);
      return x;
    }
    function render() {
      listEl.textContent = "";
      var active = rows.filter(function (a) { return a.enabled && !a.removed; }).length;
      count.textContent = "共 " + rows.length + " 个 AI，已启用 " + active + " 个";
      note.hidden = !migrated;
      note.textContent = "以下列表由旧设置（成员 NPC / 机器人用户名）自动生成，点击「保存」后写入。";
      if (!rows.length) {
        listEl.append(el("div", "mc-ag-empty", "尚未添加 Minecraft AI。请点击「添加 AI」，或「从聊天室导入」已有成员。"));
        return;
      }
      var seatIds = seats().map(function (s) { return str(s.id); });
      rows.forEach(function (a, i) {
        var row = el("div", "mc-ag-row" + (a.removed ? " removed" : a.enabled ? "" : " off"));
        var dot = el("span", "mc-ag-dot" + (a.removed || !a.enabled ? "" : seatIds.indexOf(a.code) < 0 ? " warn" : " ok"));
        var main = el("div", "mc-ag-main");
        main.append(el("span", "mc-ag-name", a.name + "（" + a.code + "）"));
        var sub = [(a.provider || "未选择服务商") + " · " + (a.model || "未选择模型")];
        if (a.preset) sub.push("预设：" + a.preset);
        if (a.reasoningEffort) sub.push("推理：" + a.reasoningEffort);
        if (a.profileId) sub.push("档案：" + a.profileId);
        else if (a.persona) sub.push("有附加人设");
        sub.push(a.removed ? "已移除（已下线）" : a.enabled ? "已启用" : "已停用");
        main.append(el("span", "mc-ag-sub", sub.join(" · ")));
        if (!a.removed && seatIds.indexOf(a.code) < 0) main.append(el("span", "mc-ag-sub warn", "编码与聊天室成员 id 均不一致，该 AI 无法对应到聊天室成员，不会连接。"));
        if (!a.removed && (a.nameOverLimit || nameWidth(a.name) > 12)) main.append(el("span", "mc-ag-sub warn", "名称超过 12 个显示宽度（一个汉字算 2），请改短。"));
        row.append(dot, main);
        if (a.removed) {
          row.append(btn("恢复", "恢复 " + a.name, function () { rows[i].removed = false; changed(); }));
        } else {
          row.append(
            btn("↑", "上移 " + a.name, function () { var t = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t; changed(); }, i === 0),
            btn("↓", "下移 " + a.name, function () { var t = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = t; changed(); }, i === rows.length - 1),
            btn(a.enabled ? "停用" : "启用", (a.enabled ? "停用 " : "启用 ") + a.name, function () { rows[i].enabled = !rows[i].enabled; changed(); }),
            btn("编辑", "编辑 " + a.name, function () { edit(i); }),
            btn("删除", "删除 " + a.name, function () { remove(i); }));
        }
        listEl.append(row);
      });
    }
    function remove(i) {
      var a = rows[i];
      notesDialog({
        title: "删除 Minecraft AI", okText: "删除",
        view: "确定删除 Minecraft AI「" + a.name + "」（编码 " + a.code + "）吗？删除后该 AI 将标记为已移除并下线，其信息仍会保留，可随时恢复。点击本卡「保存」后生效。",
        onSubmit: function () { a.removed = true; changed(); return Promise.resolve(); }
      });
    }
    function edit(i) {
      var editing = i === undefined ? null : rows[i];
      loadModelChooser(editing && editing.provider, editing && editing.model).then(function (r) {
        return fetchJson("/gamebot/minecraft/profiles").then(function (body) {
          r.profiles = (body && body.profiles) || [];
          return r;
        }, function () { r.profiles = []; return r; });
      }).then(function (r) {
        var cat = r[0].llm || { providers: [] };
        var pre = r[1] || { presets: [] };
        var curEffort = editing ? editing.reasoningEffort || "" : "";
        var effortOpts = effortSelectOptions(r[2], curEffort);
        var routes = modelRouteOptions(cat, editing);
        if (!routes.length) {
          notesDialog({
            title: "暂无可用模型", alert: true, okText: "知道了",
            view: cat.available === false ? "DSH 的服务商服务当前不可用，无法读取模型列表。请确认 DSH 已正常启动后重试。" : "DSH 中尚未启用任何服务商。请先在 DSH「设置 › 模型」中添加服务商并填写 API Key，然后再添加 AI。",
            onSubmit: function () { return Promise.resolve(); }
          });
          return;
        }
        var cur = editing && editing.provider ? editing.provider + "\u0000" + editing.model : "";
        var presetOpts = [{ value: "", label: "不使用预设" }].concat((pre.presets || []).map(function (p) { return { value: p.id, label: dshPresetLabel(p, pre.defaultId) }; }));
        var curPreset = editing ? editing.preset || "" : "";
        if (curPreset && !presetOpts.some(function (o) { return o.value === curPreset; })) presetOpts.push({ value: curPreset, label: curPreset + "（当前不可用）" });
        var fields = [];
        if (!editing) {
          var taken = rows.map(function (x) { return x.code; });
          var seatOptions = seats().filter(function (s) {
            return s.enabled !== false && CODE_RE.test(str(s.id)) && taken.indexOf(str(s.id)) < 0;
          }).map(function (s) {
            return { value: str(s.id), label: (s.name || s.id) + "（" + s.id + "）" };
          });
          if (!seatOptions.length) {
            notesDialog({
              title: "没有可绑定的席位", alert: true, okText: "知道了",
              view: "请先在聊天室启用一个席位。编码从已启用席位里选择，不能手写。",
              onSubmit: function () { return Promise.resolve(); }
            });
            return;
          }
          fields.push({ key: "code", label: "席位", type: "select", options: seatOptions, value: seatOptions[0].value, hint: "编码与所选席位 id 相同，只读。保存后不可修改。" });
        }
        fields.push(
          { key: "name", label: "名称", value: editing ? editing.name : "", placeholder: "游戏内 NPC 的名字", hint: "最多 12 个显示宽度，一个汉字算 2。允许与其他 AI 重名。留空则使用编码。" },
          { key: "route", label: "服务商与模型", type: "select", options: routes, value: cur || routes[0].value, hint: "列表来自 DSH「设置 › 模型」中已启用的服务商。" },
          { key: "preset", label: "智能体预设", type: "select", options: presetOpts, value: curPreset, hint: "可选。只采用预设中的人设。" },
          { key: "effort", label: "推理强度", type: "select", options: effortOpts, value: curEffort, hint: "选项取自所选模型。更换模型后，请保存并重新打开编辑以选择新模型的推理强度。" },
          { key: "enabled", label: "状态", type: "select", options: [{ value: "true", label: "启用" }, { value: "false", label: "停用" }], value: editing && !editing.enabled ? "false" : "true" },
          { key: "profileId", label: "个人档案", type: "select", options: (function () {
            var opts = [{ value: "", label: "不使用档案（沿用上面的服务商）" }, { value: "__new__", label: "用当前服务商，从「MC 角色」模板复制一份个人档案" }];
            (r.profiles || []).forEach(function (p) { opts.push({ value: p.id, label: (p.name || p.id) + "（" + p.id + "）" }); });
            var cur = editing ? editing.profileId || "" : "";
            if (cur && !opts.some(function (o) { return o.value === cur; })) opts.push({ value: cur, label: cur + "（当前不可用）" });
            return opts;
          })(), value: editing ? editing.profileId || "" : "", hint: "只保存档案 id。人设和密钥留在档案库，不写进 Minecraft 设置。出厂模板要先复制成个人档案。" }
        );
        notesDialog({
          title: editing ? "编辑 Minecraft AI（编码 " + editing.code + "，不可修改）" : "添加 Minecraft AI",
          okText: editing ? "确定" : "添加",
          fields: fields,
          onSubmit: function (v) {
            var parts = str(v.route).split("\u0000");
            if (!parts[0] || !parts[1]) return Promise.reject(new Error("请选择服务商与模型。"));
            var code = editing ? editing.code : str(v.code).trim();
            var display = str(v.name).trim() || code;
            if (nameWidth(display) > 12) return Promise.reject(new Error("名称最多 12 个显示宽度（一个汉字算 2）。"));
            if (!editing) {
              var err = codeError(code, rows.map(function (x) { return x.code; }));
              if (err) return Promise.reject(new Error(err));
            }
            var routeChanged = !editing || editing.provider !== parts[0] || editing.model !== parts[1];
            var chosen = str(v.profileId);
            function store(profileId) {
              var next = norm({ code: code, name: v.name, enabled: v.enabled !== "false", removed: false, provider: parts[0], model: parts[1], preset: v.preset || "", reasoningEffort: routeChanged ? "" : (v.effort || ""), persona: "", profileId: profileId || "" });
              if (editing) rows[i] = next; else rows.push(next);
              changed();
              return Promise.resolve();
            }
            if (chosen === "__new__") {
              return fetchJson("/gamebot/minecraft/profiles", { method: "POST", body: JSON.stringify({ templateId: "profile_mc", name: display, provider: parts[0], model: parts[1] }) }).then(function (body) {
                if (!body || !body.profile || !body.profile.id) return Promise.reject(new Error((body && body.error) || "建立档案失败"));
                return store(body.profile.id);
              });
            }
            return store(chosen);
          }
        });
      }).catch(function (e) { mmToast("读取 DSH 服务商失败：" + ((e && e.message) || e), "err"); });
    }
    function applyImport(ids, overwrite) {
      var res = { added: 0, overwritten: 0 };
      var list = seats();
      ids.forEach(function (id) {
        var s = list.filter(function (x) { return str(x.id) === id; })[0];
        var row = s && fromSeat(s);
        if (!row) return;
        var at = -1;
        rows.forEach(function (x, k) { if (x.code === row.code) at = k; });
        if (at < 0) { rows.push(row); res.added++; return; }
        if (!overwrite) return;
        row.enabled = rows[at].enabled;
        rows[at] = row;
        res.overwritten++;
      });
      return res;
    }
    function importSeats() {
      var list = seats();
      if (!list.length) {
        notesDialog({ title: "从聊天室导入", alert: true, okText: "知道了", view: "聊天室中还没有成员，无法导入。", onSubmit: function () { return Promise.resolve(); } });
        return;
      }
      var codes = rows.map(function (x) { return x.code; });
      var options = list.map(function (s) {
        var id = str(s.id);
        var bad = !CODE_RE.test(id);
        return { value: id, disabled: bad, label: (s.name || id) + "（" + id + "）" + (bad ? " · 成员 id 不符合编码规则，无法导入" : codes.indexOf(id) >= 0 ? " · 编码已存在" : "") };
      });
      notesDialog({
        title: "从聊天室导入", okText: "导入",
        fields: [{ key: "ids", label: "选择要导入的聊天室成员", type: "checks", options: options, hint: "将复制成员的名称、服务商与模型、智能体预设、推理强度和附加人设，编码取成员 id。导入不会修改聊天室成员本身的设置。" }],
        onSubmit: function (v) {
          if (!v.ids || !v.ids.length) return Promise.reject(new Error("请至少选择一位成员。"));
          return Promise.resolve(v);
        }
      }).then(function (v) {
        if (!v || !v.ids) return;
        var conflicts = v.ids.filter(function (id) { return codes.indexOf(id) >= 0; });
        var done = function (overwrite) {
          var r = applyImport(v.ids, overwrite);
          changed();
          mmToast("已导入 " + r.added + " 个" + (r.overwritten ? "，覆盖 " + r.overwritten + " 个" : "") + "。点击「保存」后生效。", "ok");
        };
        if (!conflicts.length) { done(false); return; }
        notesDialog({
          title: "编码已存在", okText: "覆盖", cancelText: "跳过",
          view: "以下编码已存在：" + conflicts.join("、") + "。是否用聊天室成员的配置覆盖这些 AI？选择「跳过」则只导入其余成员。",
          onSubmit: function () { return Promise.resolve(true); }
        }).then(function (ok) { done(ok === true); });
      });
    }
    addBtn.addEventListener("click", function () { edit(); });
    impBtn.addEventListener("click", importSeats);
    Object.defineProperty(box, "value", {
      get: function () { return migrated && !rows.length ? "" : JSON.stringify(rows); },
      set: function (v) {
        var parsed = parse(v);
        migrated = parsed === null;
        rows = parsed === null ? migrate() : parsed;
        render();
      },
      configurable: true,
    });
    box.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    inputs[f.key] = box;
    render();
    wrap.append(label, box, el("span", "mm-desc", f.desc));
    return wrap;
  }

  // 「绑定聊天室」（gb_minecraft_MC_CHATROOM）：下拉列出现有房间（GET /gamebot/minecraft/room，与聊天室共用房间存储）。
  // NPC = 该房间 memberSeatIds 在席位池中解析出的已启用席位。同步在保存本卡或启用 Minecraft 时运行。
  // 聊天室摘要模型：与成员相同的「服务商 · 模型」下拉（modelRouteOptions），首项「不启用」。
  // 仍保存为 chatroomSummarizerProvider / chatroomSummarizerModel 两个键：两个 inputs 条目都指向同一个下拉。
  function buildSummaryRouteField(f) {
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var label = el("label", undefined, f.label);
    var NONE = { value: "", label: "不启用" };
    var select = buildThemedSelect({ key: f.key, type: "select", options: [NONE] });
    select.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    label.htmlFor = select.id;
    var status = el("span", "mm-desc");
    status.setAttribute("aria-live", "polite");
    var cur = { provider: "", model: "" };
    var opts = [NONE];
    function apply() {
      var v = cur.provider && cur.model ? cur.provider + "\u0000" + cur.model : "";
      var list = opts;
      if (v && !list.some(function (o) { return o.value === v; })) list = list.concat([{ value: v, label: cur.provider + " · " + cur.model + "（当前不可用）" }]);
      select.setOptions(list);
      select.value = v;
      syncStatus();
    }
    function syncStatus() {
      var v = String(select.value || "");
      status.textContent = v ? "已启用自动压缩。" : "自动压缩未启用：请选择摘要模型";
    }
    function part(i) { var v = String(select.value || ""); return v ? (v.split("\u0000")[i] || "") : ""; }
    inputs[f.key] = { get value() { return part(0); }, set value(x) { cur.provider = String(x || ""); apply(); } };
    inputs[f.modelKey] = { get value() { return part(1); }, set value(x) { cur.model = String(x || ""); apply(); } };
    select.addEventListener("change", syncStatus);
    select.addEventListener("click", function () { setTimeout(syncStatus, 0); });
    loadModelChooser("", "").then(function (r) {
      var cat = (r && r[0] && r[0].llm) || { providers: [] };
      opts = [NONE].concat(modelRouteOptions(cat, null));
      if (opts.length === 1) status.textContent = cat.available === false ? "DSH 的服务商服务当前不可用，无法读取模型列表。" : "DSH 中尚无已配置密钥的服务商，请先在 DSH「设置 › 模型」中添加。";
      var keep = cur.provider || cur.model ? null : String(select.value || "");
      apply();
      if (keep) select.value = keep;
      if (opts.length > 1) syncStatus();
    }).catch(function (e) { status.textContent = "读取模型列表失败：" + ((e && e.message) || e); });
    var head = el("div", "mm-field-head");
    head.append(label);
    wrap.append(head, select, status, el("span", "mm-desc", f.desc));
    syncStatus();
    return wrap;
  }

  var mcRoomRefresh = null;
  function buildMcRoomField(f) {
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var label = el("label", undefined, f.label);
    var input = buildThemedSelect({ key: f.key, type: "select", options: [{ value: "", label: "未绑定（自动新建）" }] });
    input.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    label.htmlFor = input.id;
    inputs[f.key] = input;
    var status = el("span", "mc-ag-sub");
    status.setAttribute("aria-live", "polite");
    function timeText(ms) { try { return new Date(ms).toLocaleString("zh-CN", { hour12: false }); } catch (e) { return ""; } }
    function describe(b) {
      var rooms = (b && b.rooms) || [];
      var bound = String((b && b.bound) || "");
      var room = rooms.filter(function (r) { return r.id === bound; })[0];
      var parts = [];
      parts.push(bound ? (room ? "已绑定房间「" + room.title + "」。" : "所绑定的房间已不存在，下次同步时将自动新建。") : "尚未绑定。保存本卡或启用 Minecraft 时将自动新建房间「Minecraft」。");
      var last = b && b.last;
      if (last && last.ok === false) parts.push(last.error || "同步聊天室失败。");
      else if (last) {
        var s = "最近一次同步（" + timeText(last.at) + "）：";
        var bits = [];
        if (last.lost) bits.push("原绑定房间已不存在");
        if (last.created) bits.push("新建房间「" + last.roomTitle + "」");
        if ((last.imported || []).length) bits.push("将 " + last.imported.length + " 个旧 Minecraft AI 迁入席位池");
        if (Array.isArray(last.memberIds)) bits.push("绑定房间现有 " + last.memberIds.length + " 个席位");
        s += (bits.length ? bits.join("，") : "已与席位池对齐") + "。";
        if ((last.invalid || []).length) s += "以下成员的 id 不符合编码规则，未导入：" + last.invalid.map(function (x) { return (x.name ? x.name + "（" + x.id + "）" : x.id); }).join("、") + "。";
        if ((last.skipped || []).length) s += "以下 AI 因成员数量已达上限未能加入：" + last.skipped.join("、") + "。";
        parts.push(s);
      }
      return parts.join(" ");
    }
    function refresh() {
      return fetchJson("/gamebot/minecraft/room").then(function (b) {
        if (!b || b.ok === false) throw new Error((b && b.error) || "读取房间列表失败");
        var cur = input.value;
        var opts = [{ value: "", label: "未绑定（自动新建）" }].concat((b.rooms || []).map(function (r) { return { value: r.id, label: r.title + "（" + r.id + "）" }; }));
        if (cur && !opts.some(function (o) { return o.value === cur; })) opts.push({ value: cur, label: cur + "（房间不存在）" });
        input.setOptions(opts);
        input.value = cur;
        status.textContent = describe(b);
      }).catch(function (e) { status.textContent = "读取房间列表失败：" + ((e && e.message) || e); });
    }
    mcRoomRefresh = refresh;
    refresh();
    wrap.append(label, input, status, el("span", "mm-desc", f.desc));
    return wrap;
  }

  var seatMainRefresh = null;
  function buildSeatMainField(f) {
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var label = el("label", undefined, f.label);
    var EMPTY = { value: "", label: "请选择主答成员" };
    var select = buildThemedSelect({ key: f.key, type: "select", options: [EMPTY] });
    select.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    label.htmlFor = select.id;
    inputs[f.key] = select;
    var hint = el("span", "mm-desc");
    hint.setAttribute("aria-live", "polite");
    function norm(v) { return String(v || "").trim().toLowerCase().replace(/[\s_-]+/g, ""); }
    function seatsFromCfg() {
      var list = (lastValue && Array.isArray(lastValue.chatroomSeats)) ? lastValue.chatroomSeats : [];
      return list.filter(function (x) { return x && x.id; });
    }
    function resolveValue(seats, cur) {
      var want = norm(cur);
      if (!want) return "";
      var hit = seats.filter(function (x) {
        return norm(x.id) === want || norm(x.name) === want || (x.aliases || []).some(function (a) { return norm(a) === want; });
      })[0];
      return hit ? hit.id : "";
    }
    function refresh(cur) {
      var seats = seatsFromCfg();
      var value = resolveValue(seats, cur != null ? cur : select.value);
      var opts = [EMPTY].concat(seats.map(function (x) {
        return { value: x.id, label: (x.name || x.id) + (x.enabled === false ? "（未启用）" : "") };
      }));
      if (value && !opts.some(function (o) { return o.value === value; })) opts.push({ value: value, label: value + "（成员已不存在）" });
      select.setOptions(opts);
      select.value = value;
      hint.textContent = seats.length ? (value ? "已选择主答成员。" : "请选择主答成员后再保存。") : "尚无席位：请先在「席位管理」中添加席位；加入第一位席位后将自动设为主答。";
    }
    seatMainRefresh = function (v) { refresh(v); };
    refresh(lastValue && lastValue[f.key]);
    try {
      fetchJson("/chatroom").then(function (b) {
        if (!b || !Array.isArray(b.seats)) return;
        if (lastValue) lastValue.chatroomSeats = b.seats;
        refresh((lastValue && lastValue[f.key]) != null ? lastValue[f.key] : (b.defaultMain || ""));
      }).catch(function () { /* ignore */ });
    } catch (_) { /* ignore */ }
    wrap.append(label, select, hint, el("span", "mm-desc", f.desc));
    return wrap;
  }

  var hbSessionRefresh = null;
  function buildHeartbeatSessionField(f) {
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var label = el("label", undefined, f.label);
    var EMPTY = { value: "", label: "请选择目标会话" };
    var select = buildThemedSelect({ key: f.key, type: "select", options: [EMPTY] });
    select.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    label.htmlFor = select.id;
    inputs[f.key] = select;
    var status = el("span", "mm-desc");
    status.setAttribute("aria-live", "polite");
    status.textContent = "正在加载目标会话列表…";
    function isChatroomTitle(t) {
      return String(t || "").trim().indexOf("聊天室：") === 0;
    }
    function optionLabel(s) {
      var id = String(s.id || "");
      var title = String(s.title || "").trim();
      if (title && title !== id) return title + "（" + id + "）";
      return id ? ("（无标题）" + id) : "（无标题）";
    }
    function refresh(cur) {
      var want = cur != null ? String(cur || "").trim() : String(select.value || "").trim();
      status.textContent = "正在加载目标会话列表…";
      return fetchJson("/chatroom/heartbeat").then(function (b) {
        if (!b || b.ok === false) throw new Error((b && b.error) || "读取会话列表失败");
        var raw = Array.isArray(b.sessions) ? b.sessions : [];
        var usable = raw.filter(function (s) { return s && s.id && !isChatroomTitle(s.title) && !(s.chatroom === true); });
        var opts = [EMPTY].concat(usable.map(function (s) { return { value: String(s.id), label: optionLabel(s) }; }));
        if (want && !opts.some(function (o) { return o.value === want; })) {
          var hit = raw.filter(function (s) { return s && String(s.id) === want; })[0];
          var lab = hit ? optionLabel(hit) : want;
          if (hit && (hit.chatroom === true || isChatroomTitle(hit.title))) lab += "（聊天室房间会话，请改选）";
          else lab += "（当前不在列表中）";
          opts.push({ value: want, label: lab });
        }
        select.setOptions(opts);
        select.value = want;
        var parts = [];
        if (!usable.length) parts.push("当前无可用的普通智能体会话。请确认本机已有带可读标题的会话后，重新打开本设置页。");
        else parts.push("共 " + usable.length + " 个可选普通智能体会话。");
        if (want) {
          var ok = usable.some(function (s) { return String(s.id) === want; });
          parts.push(ok ? "已选择目标会话。" : "当前所选会话不在可选列表中，或为聊天室房间会话；请改选。");
        } else {
          parts.push("启用心跳前请选择目标会话。");
        }
        var pending = b.pending;
        if (pending && pending.id) {
          parts.push("待投递提醒编号：" + pending.id + "（约 " + Math.round((pending.after_seconds || 0) / 60) + " 分钟后）。");
        }
        status.textContent = parts.join(" ");
      }).catch(function (e) {
        status.textContent = "读取目标会话列表失败：" + ((e && e.message) || e);
      });
    }
    hbSessionRefresh = function (v) { return refresh(v); };
    refresh(lastValue && lastValue[f.key]);
    wrap.append(label, select, status, el("span", "mm-desc", f.desc));
    return wrap;
  }

  // 称呼别名表（crossSessionAliases）：通道类型选择器 + 表格；序列化为与 person-profile.parseAliasMap 兼容的行文本。
  function buildAliasTableField(f) {
    var CHANNELS = [
      { value: "telegram", label: "Telegram" },
      { value: "qq", label: "QQ" },
    ];
    var KIND_OPTS = [
      { value: "", label: "自动" },
      { value: "dm", label: "人" },
      { value: "group", label: "群" },
    ];
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var label = el("label", undefined, f.label);
    var box = el("div", "mm-alias");
    var toolbar = el("div", "mm-alias-toolbar");
    var chLabel = el("label", undefined, "通道类型");
    var channelSel = buildThemedSelect({
      key: f.key + "_channel",
      type: "select",
      options: CHANNELS,
      placeholder: "选择通道",
    });
    var count = el("span", "mm-alias-count");
    var addBtn = el("button", "mm-btn mm-ghost", "添加");
    addBtn.type = "button";
    addBtn.title = "为当前通道添加一条别名";
    toolbar.append(chLabel, channelSel, count, addBtn);
    var tableWrap = el("div");
    box.append(toolbar, tableWrap);

    var rows = [];
    var channel = CHANNELS[0].value;

    function str(v) { return v == null ? "" : String(v); }
    function asText(v) { return str(v).trim(); }
    function normKind(t) {
      var x = asText(t).toLowerCase();
      if (x === "person" || x === "private" || x === "c2c") return "dm";
      if (x === "supergroup" || x === "channel") return "group";
      if (x === "dm" || x === "group") return x;
      return "";
    }
    function parseAliasText(raw) {
      var text = str(raw).trim();
      if (!text) return [];
      var out = [];
      function pushRow(row) {
        if (!row || typeof row !== "object") return;
        var ch = asText(row.channel).toLowerCase();
        var peerId = asText(row.peerId || row.conversationId || row.id);
        var name = asText(row.name || row.displayName || row.alias);
        if (!ch || !peerId || !name) return;
        out.push({ channel: ch, peerId: peerId, conversationType: normKind(row.conversationType || row.personGroup || ""), name: name });
      }
      if (text.charAt(0) === "[" || text.charAt(0) === "{") {
        try {
          var parsed = JSON.parse(text);
          if (Array.isArray(parsed)) { parsed.forEach(pushRow); return out; }
          if (parsed && typeof parsed === "object") {
            if (Array.isArray(parsed.aliases)) { parsed.aliases.forEach(pushRow); return out; }
            Object.keys(parsed).forEach(function (k) {
              if (k === "aliases") return;
              var name = asText(parsed[k]);
              if (!name) return;
              var m = /^([a-z0-9_-]+):(.+)$/i.exec(asText(k));
              if (m) out.push({ channel: m[1].toLowerCase(), peerId: m[2], conversationType: "", name: name });
            });
            return out;
          }
        } catch (e) { /* fall through */ }
      }
      text.split(/\r?\n/).forEach(function (line) {
        var s = line.trim();
        if (!s || s.charAt(0) === "#" || s.indexOf("//") === 0) return;
        if (s.charAt(0) === "{") {
          try { pushRow(JSON.parse(s)); } catch (e) {}
          return;
        }
        var eq = /^([a-z0-9_-]+):([^=\s]+)\s*=\s*(.+)$/i.exec(s);
        if (eq) {
          out.push({ channel: eq[1].toLowerCase(), peerId: eq[2], conversationType: "", name: asText(eq[3]) });
          return;
        }
        var parts = s.split(/[\s,，\t]+/).filter(Boolean);
        if (parts.length >= 3) {
          var ch = parts[0].toLowerCase();
          var peerId = parts[1];
          var nameParts = parts.slice(2);
          var conversationType = "";
          var last = (nameParts[nameParts.length - 1] || "").toLowerCase();
          if (last === "dm" || last === "group" || last === "person" || last === "private" || last === "c2c") {
            conversationType = normKind(last);
            nameParts = nameParts.slice(0, -1);
          }
          var name = nameParts.join(" ").trim();
          if (name) out.push({ channel: ch, peerId: peerId, conversationType: conversationType, name: name });
        }
      });
      return out.filter(function (r) { return r.name; });
    }
    function formatAliasText(list) {
      return (list || []).map(function (r) {
        var kind = r.conversationType ? (" " + r.conversationType) : "";
        return r.channel + " " + r.peerId + " " + r.name + kind;
      }).join("\n");
    }
    function syncCount() {
      var n = rows.filter(function (r) { return r.channel === channel; }).length;
      var total = rows.length;
      count.textContent = n ? ("本通道 " + n + " 条" + (total !== n ? "（全部 " + total + " 条）" : "")) : (total ? ("本通道暂无 · 全部 " + total + " 条") : "暂无别名");
    }
    function updateRowFromDom(tr, row) {
      var peerIn = tr.querySelector("[data-alias-peer]");
      var nameIn = tr.querySelector("[data-alias-name]");
      var kindIn = tr.querySelector("[data-alias-kind]");
      if (peerIn) row.peerId = asText(peerIn.value);
      if (nameIn) row.name = asText(nameIn.value);
      if (kindIn) row.conversationType = normKind(kindIn.value);
    }
    function flushVisibleInputs() {
      var trs = tableWrap.querySelectorAll("tr[data-alias-idx]");
      for (var i = 0; i < trs.length; i++) {
        var idx = Number(trs[i].getAttribute("data-alias-idx"));
        if (!isNaN(idx) && rows[idx]) updateRowFromDom(trs[i], rows[idx]);
      }
    }
    function render() {
      flushVisibleInputs();
      tableWrap.textContent = "";
      syncCount();
      var idxs = [];
      rows.forEach(function (r, i) { if (r.channel === channel) idxs.push(i); });
      if (!idxs.length) {
        tableWrap.append(el("div", "mm-alias-empty", "当前通道暂无别名。点击「添加」新建一条。"));
        return;
      }
      var table = el("table", "mm-alias-table");
      var thead = el("thead");
      var hr = el("tr");
      ["用户/群 ID", "称呼", "类型", "操作"].forEach(function (t) { hr.append(el("th", undefined, t)); });
      thead.append(hr);
      var tbody = el("tbody");
      idxs.forEach(function (idx) {
        var r = rows[idx];
        var tr = el("tr");
        tr.setAttribute("data-alias-idx", String(idx));
        var peerTd = el("td");
        var peerIn = el("input", "mm-input");
        peerIn.type = "text";
        peerIn.setAttribute("data-alias-peer", "1");
        peerIn.placeholder = channel === "qq" ? "QQ OpenID" : "用户或群 ID";
        peerIn.value = r.peerId || "";
        peerIn.spellcheck = false;
        peerIn.addEventListener("change", function () { r.peerId = asText(peerIn.value); });
        peerTd.append(peerIn);
        var nameTd = el("td");
        var nameIn = el("input", "mm-input");
        nameIn.type = "text";
        nameIn.setAttribute("data-alias-name", "1");
        nameIn.placeholder = "显示称呼";
        nameIn.value = r.name || "";
        nameIn.addEventListener("change", function () { r.name = asText(nameIn.value); });
        nameTd.append(nameIn);
        var kindTd = el("td");
        var kindIn = el("select", "mm-input");
        kindIn.setAttribute("data-alias-kind", "1");
        KIND_OPTS.forEach(function (o) {
          var opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === (r.conversationType || "")) opt.selected = true;
          kindIn.append(opt);
        });
        kindIn.addEventListener("change", function () { r.conversationType = normKind(kindIn.value); });
        kindTd.append(kindIn);
        var actTd = el("td");
        var acts = el("div", "mm-alias-actions");
        var del = el("button", "mm-btn mm-ghost", "删除");
        del.type = "button";
        del.title = "删除此别名";
        del.addEventListener("click", function () {
          flushVisibleInputs();
          rows.splice(idx, 1);
          render();
        });
        acts.append(del);
        actTd.append(acts);
        tr.append(peerTd, nameTd, kindTd, actTd);
        tbody.append(tr);
      });
      table.append(thead, tbody);
      tableWrap.append(table);
    }

    function setChannel(next) {
      flushVisibleInputs();
      channel = asText(next).toLowerCase() || CHANNELS[0].value;
      try { channelSel.value = channel; } catch (e) {}
      render();
    }
    channelSel.value = channel;
    channelSel.addEventListener("change", function () { setChannel(channelSel.value); });
    channelSel.addEventListener("input", function () { setChannel(channelSel.value); });
    addBtn.addEventListener("click", function () {
      flushVisibleInputs();
      rows.push({ channel: channel, peerId: "", conversationType: "", name: "" });
      render();
      var last = tableWrap.querySelector("tr[data-alias-idx]:last-child input[data-alias-peer]");
      if (last) last.focus();
    });

    Object.defineProperty(box, "value", {
      get: function () {
        flushVisibleInputs();
        var clean = rows.filter(function (r) {
          return asText(r.channel) && asText(r.peerId) && asText(r.name);
        }).map(function (r) {
          return {
            channel: asText(r.channel).toLowerCase(),
            peerId: asText(r.peerId),
            conversationType: normKind(r.conversationType),
            name: asText(r.name),
          };
        });
        return formatAliasText(clean);
      },
      set: function (v) {
        rows = parseAliasText(v);
        if (!CHANNELS.some(function (c) { return c.value === channel; })) channel = CHANNELS[0].value;
        try { channelSel.value = channel; } catch (e) {}
        render();
      },
      configurable: true,
    });
    box.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    label.htmlFor = box.id;
    inputs[f.key] = box;
    render();
    wrap.append(label, box, el("span", "mm-desc", f.desc));
    return wrap;
  }

  function buildField(f) {
    if (f.type === "mcagents") return buildMcAgentsField(f);
    if (f.type === "mcroom") return buildMcRoomField(f);
    if (f.type === "summaryroute") return buildSummaryRouteField(f);
    if (f.type === "seatmain") return buildSeatMainField(f);
    if (f.type === "hbsession") return buildHeartbeatSessionField(f);
    if (f.type === "aliastable") return buildAliasTableField(f);
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var label = el("label", undefined, f.label);
    var input;
    if (f.type === "select") {
      input = buildThemedSelect(f);
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
        // 宿主 GET 只返回占位值（已保存的密钥不下发）。与「余额查询」一致：已保存时输入框留空，占位文字写「已配置」
        // （组件状态给出掩码末四位时写「已配置 ••••xxxx」），输入新值即替换，留空保存则保持不变；「清除」删除已保存的值。
        input.addEventListener("focus", function () {
          if (input.value === SECRET_SAVED) input.select();
        });
      }
    }
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.readOnly) input.readOnly = true;
    var secretClear = null;
    if (f.type === "password") {
      secretClear = el("button", "mm-btn mm-ghost mm-secret-clear", "清除");
      secretClear.type = "button";
      secretClear.style.alignSelf = "flex-start";
      secretClear.style.display = "none";
      secretClear.title = "保存后删除已保存的" + f.label;
      secretClear.addEventListener("click", function () {
        input.value = "";
        input.setAttribute("data-saved", "clear");
        secretClear.style.display = "none";
        input.placeholder = "将清除已保存的" + f.label + "（点「保存」后生效）";
      });
      input._secretClear = secretClear;
    }
    input.id = "mm-f-" + f.key + "-" + Math.random().toString(36).slice(2, 8);
    label.htmlFor = input.id;
    inputs[f.key] = input;
    var head = el("div", "mm-field-head");
    head.append(label);
    if (f.headExtra) head.append(f.headExtra);
    wrap.append(head, input);
    if (secretClear) wrap.append(secretClear);
    if (f.presets) dshPresetOptions(f.presets).then(function (opts) { if (opts && input.setOptions) input.setOptions(opts); });
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
    var a = actions[f.action.component] = { key: f.key, btn: btn, msg: msg, path: f.action.path, busy: false, ready: false, busyText: f.action.busy, readyTitle: f.action.ready, needText: f.action.need };
    btn.addEventListener("click", function () { runAction(a); });
    return row;
  }
  function runAction(a) {
    if (disposed || a.busy || a.btn.disabled) return;
    var value = (FIELD_BY_KEY[a.key] && FIELD_BY_KEY[a.key].type === "password" ? secretValue(inputs[a.key]) : inputs[a.key].value).trim();
    function say(text, cls) {
      a.msg.textContent = text;
      a.msg.className = "mm-amsg" + (cls ? " " + cls : "");
    }
    if (!value) {
      say(a.needText || ("请填写" + FIELD_BY_KEY[a.key].label), "err");
      inputs[a.key].focus();
      return;
    }
    a.busy = true;
    a.btn.disabled = true;
    say(a.busyText || "正在安装（首次需下载插件包）…");
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
      case "connecting": return 2;
      case "ready": return 3;
      case "checking": return 4;
      case "off": return 5;
      case "disconnected": return 5;
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

  // 密钥输入框的显示状态：saved = 宿主已有保存的值。tail（如 ••••0wLg）由组件状态提供，可选。
  function setSecretInput(input, f, saved, tail) {
    if (tail !== undefined) input.setAttribute("data-tail", tail || "");
    var t = input.getAttribute("data-tail") || "";
    if (saved) {
      input.value = "";
      input.setAttribute("data-saved", "1");
      input.placeholder = "已配置" + (t ? " " + t : "（不显示）") + "；输入新值可替换";
      if (input._secretClear) input._secretClear.style.display = "";
    } else {
      input.setAttribute("data-saved", "");
      input.placeholder = f.placeholder || "";
      if (input._secretClear) input._secretClear.style.display = "none";
    }
  }
  // 密钥输入框要提交的值：留空且已保存 → 保持（宿主收到占位值不改动）；点过「清除」→ 空串。
  function secretValue(input) {
    var raw = input.value;
    if (raw === "" && input.getAttribute("data-saved") === "1") return SECRET_SAVED;
    return raw;
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
        // 隐藏功能（如聊天室）的字段仍在 INPUT_FIELDS 里，但页面上没有输入框。
        // 跳过即可：这些值留在 lastValue，保存其它页时不会被清掉。
        var input = inputs[k];
        if (!input) return;
        var v = value && value[k];
        if (f.type === "password") { setSecretInput(input, f, v === SECRET_SAVED); if (v !== SECRET_SAVED) input.value = v === undefined || v === null ? "" : String(v); return; }
        if (f.type === "seatmain") { if (typeof seatMainRefresh === "function") seatMainRefresh(v); else input.value = v === undefined || v === null ? "" : String(v); return; }
        if (f.type === "hbsession") { if (typeof hbSessionRefresh === "function") hbSessionRefresh(v); else input.value = v === undefined || v === null ? "" : String(v); return; }
        input.value = v === undefined || v === null ? "" : String(v);
      }
    });
  }
  var STATUS_TEXT = { connected: "已连接", on: "已启动", off: "未启动", error: "出错", missing: "未安装", ready: "可用", connecting: "正在连接", disconnected: "未连接" };
  var CONN_TEXT = { connected: "已连接", "no-app": "程序未运行", unreachable: "未连接", "mcp-down": "未连接", checking: "正在检查连接", connecting: "正在连接", disconnected: "未连接" };
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
  var prevInstallState = {}; // id -> install.state（用于完成/失败通知；首帧不提示）
  var prevConnState = {}; // id -> 连接状态（用于连接通知；首帧不提示）
  var connToastAt = {}; // id -> 上次连接类通知时间（防抖）
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

  // 连接/等待通知见模块级 maybeToastConn / mmWaitShow（DSH 启动即挂载）。
  // 设置页仍写入同一 mmPrevConnState，避免与后台观察重复弹窗。
  var prevConnState = mmPrevConnState;
  var connToastAt = mmConnToastAt;

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
    var prevInst = prevInstallState[c.id];
    if (prevInst !== undefined && prevInst !== job.state) {
      if (job.state === "done") mmToast((c.label || c.id) + " 安装完成", "ok");
      else if (job.state === "error") {
        var err = String(job.error || "未知错误");
        if (err.length > 120) err = err.slice(0, 117) + "…";
        mmToast((c.label || c.id) + " 安装失败：" + err, "err");
      }
    }
    prevInstallState[c.id] = job.state;
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
    // 安装/排队进度走等待层（install:<id>），结束即关闭；结果另发普通通知。
    if (busy) {
      var iw = mmWaitHandleOf("install", c.id) || mmWaitShow((c.label || c.id) + " 正在安装", "install", c.id);
      try { if (iw) iw.setText((c.label || c.id) + "：" + text); } catch (e) {}
    } else if (mmWaitHandleOf("install", c.id)) mmWaitClear("install", c.id);
    ui.state.className = "mm-istate " + job.state;
    ui.state.textContent = text;
    // 组件说明（如 Godot：装的是哪个版本、项目里的插件要装哪个版本）
    ui.cnote.textContent = c.note || "";
    ui.cnote.hidden = !c.note;
    var a = actions[c.id];
    if (a) {
      // 随包自带的组件（builtin / needsInstall=false）不需要「先安装」才能用插件按钮：
      // GameBot 的 Minaret 就是这种——代码随包发布，按钮只要求填好目标目录。
      var gated = c.needsInstall ? !!c.installed : true;
      a.ready = gated && !busy;
      if (!a.busy) a.btn.disabled = !a.ready;
      a.btn.title = a.ready ? (a.readyTitle || "将与服务器同版本的插件安装到上方填写的项目") : busy ? "正在安装，请在安装完成后重试" : (c.needsInstall ? "安装完成后可用" : "请先填写目标目录");
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
        // connection 优先；否则用组件 status（含 connecting），idle 态也写入以便之后进入「正在连接」能提示
        if (c.connection) maybeToastConn(c, c.connection.state);
        else maybeToastConn(c, c.status);
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
    if (d.showExperimental === true) hiddenItems.forEach(function (it) { it.hidden = false; });
    applySearch();
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
      notifyChatroomPanels(lastValue);
      return lastValue;
    });
    saveQueue = run.catch(function () {});
    return run;
  }

  // 某个管理页的「保存」：以最近读到的完整设置为底，只换上本页的字段，
  // 其他功能的设置原样带回（不会被清空，也不会带上别的页里没保存的改动）。
  // 「启用」不在这里：它由旋钮单独保存，这里沿用已保存的值（即旋钮当前状态）。
  // 启用/停用通知用功能名（组件 title）；其它开关用字段 label。与「设置已保存」分开。
  function toggleToastLabel(t) {
    var key = t && t.key;
    if (!key) return "功能";
    for (var i = 0; i < FEATURES.length; i++) {
      var f = FEATURES[i];
      if (!f.keys || f.keys.indexOf(key) < 0) continue;
      if (/Enabled$/.test(key) && f.title) return f.title;
      break;
    }
    var fd = FIELD_BY_KEY[key];
    if (fd && fd.label && fd.label !== "启用") return fd.label.replace(/^启用/, "") || fd.label;
    if (fd && fd.label === "启用") {
      for (var j = 0; j < FEATURES.length; j++) {
        if (FEATURES[j].keys && FEATURES[j].keys.indexOf(key) >= 0 && FEATURES[j].title) return FEATURES[j].title;
      }
    }
    return (fd && fd.label) || "功能";
  }

  var afterSave = afterSave || {}; // 功能 id → 保存成功后的刷新钩子（如重新读取组件状态）
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
      var input = inputs[k];
      if (!input) return;
      var raw = fd.type === "password" ? secretValue(input) : input.value;
      values[k] = fd.type === "number" ? Number(raw) : fd.bool ? raw === "true" : raw;
    });
    // 主答为必填：未选择成员时不可保存房间设置
    if (f.keys.indexOf("chatroomDefaultMain") >= 0) {
      var mainFd = FIELD_BY_KEY["chatroomDefaultMain"];
      if (mainFd && mainFd.type === "seatmain" && !String(values.chatroomDefaultMain || "").trim()) {
        say("请选择主答成员", true);
        mmToast("请选择主答成员", "err");
        return;
      }
    }
    // 输入了新密钥（或点过清除）的密码框：保存后旧的掩码末四位已失效，先清掉，等组件状态返回新值
    var replaced = f.keys.filter(function (k) { var fd = FIELD_BY_KEY[k]; return fd && fd.type === "password" && inputs[k] && values[k] !== SECRET_SAVED; });
    ui.save.disabled = true;
    say("保存中…");
    postSettings(function (patch) { return Object.assign(patch, values); }).then(function () {
      replaced.forEach(function (k) { inputs[k].removeAttribute("data-tail"); });
      fill(lastValue, f.keys);
      if (afterSave[f.id]) { try { afterSave[f.id](); } catch (e) {} }
      if (mcRoomRefresh && f.keys.indexOf("gb_minecraft_MC_CHATROOM") >= 0) mcRoomRefresh();
      say("已保存");
      mmToast("设置已保存", "ok");
    }).catch(function (e) {
      if (disposed || isAbort(e)) return;
      say(e.message, true);
      mmToast(e.message || "保存失败", "err");
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
      mmToast(toggleToastLabel(t) + (v[t.key] ? " 已启用" : " 已停用"), "ok");
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


  // ── 插件自更新（MM_UPDATE_V3）────────────────────────────────
  var updateBusy = false;
  var updatePollTimer = null;
  function stopUpdatePoll() {
    if (updatePollTimer) clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
  function formatUpdateLabel(info) {
    if (!info) return "";
    if (info.installKind === "git") {
      if (info.displayVersion) return info.displayVersion;
      if (info.behind) return (info.latestSubject || info.remote || "新提交") + "（落后 " + info.behind + "）";
      return info.latestVersion || "";
    }
    return info.latestVersion || info.displayVersion || "";
  }
  function showUpdateAvailableToast(info) {
    var ver = formatUpdateLabel(info);
    var handle = mmToast("发现新版本 " + ver, "info", {
      id: "mm-update",
      persistent: true,
      actions: [
        {
          label: "下载",
          primary: true,
          onClick: function (toastApi) {
            // 下载进度走等待层：关掉「发现新版本」卡片，改由 update:apply 等待条显示进度，结束即关闭。
            toastApi.dismiss();
            mmWaitShow("正在下载更新…", "update", "apply");
            var api = mmWaitApi("update", "apply");
            pageFetch("/update/apply", {
              method: "POST",
              body: JSON.stringify({ version: info.latestVersion || info.targetVersion || "" })
            }).then(function () {
              pollUpdateJob(api);
            }).catch(function (e) {
              mmToast("更新失败：" + (e.message || e), "err");
              api.dismiss();
            });
          }
        },
        {
          label: "忽略",
          onClick: function (api) {
            var v = info.latestVersion || info.targetVersion || "";
            pageFetch("/update/ignore", { method: "POST", body: JSON.stringify({ version: v }) }).then(function () {
              api.dismiss();
              mmToast("已忽略版本 " + (ver || v), "info");
            }).catch(function (e) {
              mmToast("忽略失败：" + (e.message || e), "err");
            });
          }
        }
      ]
    });
    return handle;
  }
  function pollUpdateJob(api) {
    stopUpdatePoll();
    var ticks = 0;
    updatePollTimer = setInterval(function () {
      if (disposed) { stopUpdatePoll(); return; }
      ticks++;
      pageFetch("/update/status").then(function (d) {
        var job = (d && d.job) || {};
        if (job.progress != null && job.mode !== "indeterminate") api.setProgress(Number(job.progress) || 0);
        else if (job.state === "running") api.setProgress("indeterminate");
        if (job.step) api.setText(job.step);
        if (job.state === "done") {
          stopUpdatePoll();
          api.dismiss();
          mmToast(job.message || "更新完成，重启 DeepSeek Harness 后生效", "ok");
        } else if (job.state === "error") {
          stopUpdatePoll();
          api.dismiss();
          mmToast("更新失败：" + (job.error || job.message || "未知错误"), "err");
        }
      }).catch(function () { /* 轮询容错 */ });
      if (ticks > 600) { stopUpdatePoll(); api.dismiss(); }
    }, 700);
  }
  function runUpdateCheck(opts) {
    opts = opts || {};
    if (updateBusy || disposed) return Promise.resolve();
    updateBusy = true;
    updateBtn.disabled = true;
    if (opts.manual) updateMsg.textContent = "正在检查…";
    // 等待条：与「正在连接」共用 mm-wait 槽；至少亮一会，避免「今日已检查」瞬间 skipped 时看不见（Ash 已写过 lastCheckDate 时的情况）
    var showWait = !!(opts.manual || opts.toast);
    if (showWait) mmWaitShow("正在检查更新", "update", "check");
    var q = opts.force ? "/update/check?force=1" : "/update/check";
    return pageFetch(q).then(function (info) {
      if (disposed) {
        return mmWaitClear("update", "check").then(function () { return info; });
      }
      if (info && info.skipped) {
        if (opts.manual) updateMsg.textContent = "今日已检查";
        // 日门禁跳过时请求几乎瞬间返回：把等待条文案改为「今日已检查更新」并至少亮一会再收起
        var _uw = mmWaitHandleOf("update", "check");
        if (showWait && _uw) {
          try { _uw.setText("今日已检查更新"); _uw.setProgress("none"); } catch (e0) {}
        }
        return mmWaitClear("update", "check", { minMs: showWait ? 1200 : 0 }).then(function () { return info; });
      }
      return mmWaitClear("update", "check", { minMs: showWait ? 600 : 0 }).then(function () {
        if (disposed) return info;
        if (!info || info.ok === false) {
          var err = (info && info.error) || "检查更新失败";
          if (/not found|404/i.test(String(err))) {
            err = "更新检查暂不可用：请重启 DeepSeek Harness 后再生效（客户端通知已可用）";
            if (opts.manual) updateMsg.textContent = err;
            mmToast(err, "info");
            return info;
          }
          if (opts.manual) updateMsg.textContent = err;
          mmToast(err, "err");
          return info;
        }
        if (info.updateAvailable && (info.prompt || opts.manual)) {
          updateMsg.textContent = info.message || ("发现新版本 " + formatUpdateLabel(info));
          showUpdateAvailableToast(info);
        } else if (info.updateAvailable && info.ignored) {
          if (opts.manual) {
            updateMsg.textContent = "有更新但已忽略：" + formatUpdateLabel(info);
            showUpdateAvailableToast(info);
          } else {
            updateMsg.textContent = "";
          }
        } else {
          updateMsg.textContent = opts.manual ? (info.message || "已是最新版本") : "";
          if (opts.manual || opts.toast) mmToast(info.message || "已是最新版本", "ok");
        }
        return info;
      });
    }).catch(function (e) {
      return mmWaitClear("update", "check").then(function () {
        if (disposed || isAbort(e)) return;
        if (opts.manual) updateMsg.textContent = e.message || "检查失败";
        var msg = e && e.message ? String(e.message) : String(e);
        // UPDATE_NEEDS_RESTART_HINT：服务端路由在构建后需重启 DSH 才挂上。
        if (/not found|404|Failed to fetch|NetworkError/i.test(msg) || (e && e.status === 404)) {
          msg = "更新检查暂不可用：请重新打开本页；若仍失败，请重启 DeepSeek Harness 后再试";
          if (opts.manual) updateMsg.textContent = msg;
          mmToast(msg, "info");
          return;
        }
        mmToast("检查更新失败：" + msg, "err");
      });
    }).finally(function () {
      updateBusy = false;
      if (!disposed) updateBtn.disabled = false;
    });
  }
  updateBtn.addEventListener("click", function () { runUpdateCheck({ force: true, manual: true }); });
  // 自动检查改由 DSH 启动时的 startMmBackgroundWatch 触发（每次启动，不再按日门禁）。

  page.__mmDispose = function () {
    stopUpdatePoll();
    disposed = true;
    try { window.removeEventListener(TGDM_EVENT, onTelegramDmEvent); } catch (_) { /* ignore */ }
    try { window.removeEventListener(QQPD_EVENT, onQQPendingEvent); } catch (_) { /* ignore */ }
    try { window.removeEventListener(ROOMCFG_EVENT, onRoomConfigEvent); } catch (_) { /* ignore */ }
    stopPolling();
    page.removeEventListener("keydown", onKeydown);
    // 中止所有进行中的请求；回调里见到 disposed / AbortError 会直接返回，不再写 DOM。
    controllers.forEach(function (c) { c.abort(); });
    controllers.clear();
    calendarRoots.forEach(function (root) {
      try { root.unmount(); } catch (_) { /* already unmounted */ }
    });
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

function mmPreviewKind(mm) {
  return mm && mm.file && mm.file.previewKind;
}

function mmKindIcon(kind, mm) {
  var preview = mmPreviewKind(mm);
  if (preview === "audio") return "🎵";
  if (preview === "pdf") return "📕";
  if (preview === "text") return "📝";
  if (preview === "word") return "📘";
  if (preview === "sheet") return "📊";
  if (preview === "slides") return "📽";
  if (preview === "archive") return "🗜";
  if (preview === "file") return "📎";
  if (kind === "place") return "📍";
  if (kind === "route") return "🧭";
  if (kind === "calendar") return "📅";
  if (kind === "video" || preview === "video") return "🎬";
  if (kind === "webpage") return "🌐";
  if (kind === "document") return "📄";
  return "🖼";
}

function mmKindLabel(kind, mm) {
  var preview = mmPreviewKind(mm);
  if (preview === "audio") return "音频";
  if (preview === "pdf") return "PDF";
  if (preview === "text") return "文本";
  if (preview === "word") return "Word 文档";
  if (preview === "sheet") return "表格";
  if (preview === "slides") return "演示文稿";
  if (preview === "archive") return "压缩包";
  if (preview === "file") return "文件";
  if (preview === "image") return "图片";
  if (kind === "place") return "地点";
  if (kind === "route") return "路线";
  if (kind === "calendar") return "日历";
  if (kind === "video") return "视频";
  if (kind === "webpage") return "网页";
  if (kind === "document") return "文件";
  return "图片";
}

function mmStatusLabel(status) {
  if (status === "pending") return "生成中";
  if (status === "error") return "失败";
  if (status === "canceled") return "已取消";
  return "";
}

var MM_SHELL_STYLE = {
  border: "1px solid var(--mm-border, rgba(127,127,127,.28))",
  borderRadius: 14,
  padding: 8,
  margin: 0,
  fontSize: 12,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  width: "fit-content",
  maxWidth: "100%",
  flex: "0 0 auto",
  background: "var(--dsw-alias-bg-layer-1, var(--theme-bg-secondary, Canvas))",
  boxShadow: "0 8px 18px rgba(0,0,0,.12)"
};

/** 有图片时，标题和说明跟随图片宽度并省略，避免把卡片撑成整行。 */
function mmLockStyle(locked) {
  if (locked) return { width: 0, minWidth: "100%", maxWidth: "100%", boxSizing: "border-box" };
  return { maxWidth: 280, boxSizing: "border-box" };
}

function mmCardLocked(mm) {
  var status = (mm && mm.status) || "ready";
  if (status === "pending") return true;
  return !!(mm && mm.asset && mm.asset.attachment);
}

/** 卡片显示尺寸：不超过 320，保持原图比例。 */
function mmFittedSize(width, height) {
  var max = 320;
  var w = Number(width);
  var h = Number(height);
  if (!w || !h || w < 1 || h < 1) return null;
  var scale = Math.min(max / w, max / h, 1);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale))
  };
}

var MM_SKELETON_STYLE = {
  width: 160,
  height: 120,
  borderRadius: 8,
  background: "linear-gradient(90deg, rgba(127,127,127,.12) 25%, rgba(127,127,127,.22) 50%, rgba(127,127,127,.12) 75%)",
  backgroundSize: "200% 100%"
};

function MmLightbox(props) {
  React.useEffect(function () {
    function onKey(event) {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", onKey);
    return function () { document.removeEventListener("keydown", onKey); };
  }, [props.onClose]);
  return h("div", {
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "查看大图",
    onClick: props.onClose,
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 10000,
      background: "rgba(0,0,0,.72)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24
    }
  },
    h("button", {
      type: "button",
      onClick: function (event) { event.stopPropagation(); props.onClose(); },
      style: {
        position: "absolute",
        top: 16,
        right: 16,
        border: "1px solid rgba(255,255,255,.35)",
        borderRadius: 6,
        background: "rgba(0,0,0,.45)",
        color: "#fff",
        fontSize: 12,
        padding: "4px 10px",
        cursor: "pointer"
      }
    }, "关闭"),
    h("img", {
      src: props.src,
      alt: props.alt || "image",
      onClick: function (event) { event.stopPropagation(); },
      style: { maxWidth: "92vw", maxHeight: "92vh", objectFit: "contain", borderRadius: 8 }
    })
  );
}

function MmAttachmentImage(props) {
  var st = React.useState(null);
  var url = st[0];
  var setUrl = st[1];
  var es = React.useState(false);
  var failed = es[0];
  var setFailed = es[1];
  var zoom = React.useState(false);
  var open = zoom[0];
  var setOpen = zoom[1];
  var close = React.useCallback(function () { setOpen(false); }, []);
  React.useEffect(function () {
    var alive = true;
    if (!props.loadImage || !props.attachment) return undefined;
    props.loadImage(props.attachment).then(function (u) { if (alive) setUrl(u); }, function () { if (alive) setFailed(true); });
    return function () { alive = false; };
  }, [props.attachment, props.loadImage]);
  if (failed) return h("div", { style: { fontSize: 12, color: "#e55" } }, "图片加载失败");
  if (!url) return h("div", { style: MM_SKELETON_STYLE, title: "加载中…" });
  var alt = props.alt || (props.attachment && props.attachment.name) || "image";
  var zoomable = props.zoomable !== false;
  var box = props.frame;
  return h("span", { style: { display: "block", width: box ? box.width : "fit-content", maxWidth: "100%" } },
    h("img", {
      src: url,
      alt: alt,
      title: zoomable ? "点击查看大图" : undefined,
      role: zoomable ? "button" : undefined,
      tabIndex: zoomable ? 0 : undefined,
      onClick: zoomable ? function () { setOpen(true); } : undefined,
      onLoad: function (event) {
        var img = event.currentTarget;
        var size = mmFittedSize(img.naturalWidth, img.naturalHeight);
        if (size && props.onFrame) props.onFrame(size);
      },
      onKeyDown: zoomable ? function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpen(true);
        }
      } : undefined,
      style: box
        ? {
            width: box.width,
            height: box.height,
            objectFit: "cover",
            borderRadius: 8,
            display: "block",
            cursor: zoomable ? "zoom-in" : "inherit"
          }
        : {
            width: "auto",
            height: "auto",
            maxWidth: "min(320px, 100%)",
            maxHeight: 320,
            borderRadius: 8,
            display: "block",
            cursor: zoomable ? "zoom-in" : "inherit"
          }
    }),
    open ? h(MmLightbox, { src: url, alt: alt, onClose: close }) : null
  );
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
        background: "var(--mm-accent)",
        transition: "width .2s ease"
      }
    })),
    h("div", { style: { marginTop: 4, fontSize: 11, color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, pct + "%")
  );
}

function MmImageBody(props) {
  var mm = props.mm;
  var status = mm.status || "ready";
  if (status === "pending") {
    return h("div", null,
      h("div", { style: MM_SKELETON_STYLE }),
      h(MmProgressBar, { progress: mm.progress }),
      h("div", { style: { marginTop: 6, color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "生成中…")
    );
  }
  if (status === "error") {
    return h("div", { style: { color: "#e55" } }, mm.error || "生成失败");
  }
  if (status === "canceled") {
    return h("div", { style: { color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "已取消");
  }
  var att = mm.asset && mm.asset.attachment;
  if (!att) {
    return h("div", { style: { color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "无图片资源");
  }
  return h(MmAttachmentImage, {
    attachment: att,
    loadImage: props.loadImage,
    zoomable: props.zoomable,
    frame: props.frame,
    onFrame: props.onFrame,
    alt: mm.title || (att && att.name) || "image"
  });
}

function amapPageUrl(mm) {
  var raw = mm && mm.source && mm.source.url;
  if (typeof raw !== "string" || !raw) return "";
  try {
    var url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "uri.amap.com") return "";
    if (url.pathname !== "/marker" && url.pathname !== "/navigation") return "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function MmPlaceBody(props) {
  var mm = props.mm || {};
  var status = mm.status || "ready";
  if (status === "pending" || status === "error" || status === "canceled") return h(MmImageBody, props);
  var url = amapPageUrl(mm);
  var att = mm.asset && mm.asset.attachment;
  var label = mm.kind === "route" ? "打开这条路线" : "在高德地图中打开";
  return h("div", { style: { width: "fit-content", maxWidth: "100%" } },
    att
      ? h(MmImageBody, {
          mm: mm,
          loadImage: props.loadImage,
          zoomable: props.zoomable,
          frame: props.frame,
          onFrame: props.onFrame
        })
      : null,
    url
      ? h("div", { style: mmLockStyle(!!att) },
          h("a", {
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
            style: {
              display: "inline-block",
              marginTop: att ? 8 : 0,
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid var(--mm-border, rgba(127,127,127,.35))",
              color: "var(--mm-fg, inherit)",
              textDecoration: "none",
              fontSize: 12,
              fontWeight: 600,
              maxWidth: "100%",
              boxSizing: "border-box"
            }
          }, label))
      : null
  );
}

function shiftCalendarMonth(month, delta) {
  var matched = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!matched) return month || "";
  var date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1 + delta, 1));
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
}

function ensureCalendarSpinStyle() {
  if (typeof document === "undefined" || document.getElementById("mm-cal-spin")) return;
  var style = document.createElement("style");
  style.id = "mm-cal-spin";
  style.textContent = "@keyframes mm-cal-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";
  document.head.appendChild(style);
}

function calendarUpdateIcon(spinning) {
  ensureCalendarSpinStyle();
  return h("svg", {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: spinning ? { animation: "mm-cal-spin .8s linear infinite" } : null,
    "aria-hidden": "true"
  },
    h("path", { d: "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
    h("path", { d: "M3 3v5h5" }),
    h("path", { d: "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" }),
    h("path", { d: "M21 21v-5h-5" })
  );
}

var WEATHER_KIND_TEXT = {
  "晴": "clear",
  "大部晴朗": "mainly-clear",
  "多云": "partly",
  "阴": "overcast",
  "雾": "fog",
  "雾凇": "fog",
  "小毛毛雨": "drizzle",
  "毛毛雨": "drizzle",
  "大毛毛雨": "drizzle",
  "冻毛毛雨": "freezing-drizzle",
  "强冻毛毛雨": "freezing-drizzle",
  "小雨": "rain",
  "中雨": "rain",
  "大雨": "rain-heavy",
  "冻雨": "freezing-rain",
  "强冻雨": "freezing-rain",
  "小雪": "snow",
  "中雪": "snow",
  "大雪": "snow-heavy",
  "雪粒": "grains",
  "小阵雨": "showers",
  "阵雨": "showers",
  "强阵雨": "showers-heavy",
  "小阵雪": "snow-showers",
  "阵雪": "snow-showers",
  "雷暴": "thunder",
  "雷暴伴冰雹": "hail",
  "强雷暴伴冰雹": "hail"
};

function ensureWeatherStyle() {
  if (typeof document === "undefined" || document.getElementById("mm-wx-style")) return;
  var style = document.createElement("style");
  style.id = "mm-wx-style";
  style.textContent = [
    "@keyframes mm-wx-spin{to{transform:rotate(360deg)}}",
    "@keyframes mm-wx-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.1px)}}",
    "@keyframes mm-wx-drift{0%,100%{transform:translateX(0)}50%{transform:translateX(1.3px)}}",
    "@keyframes mm-wx-fall{0%{transform:translateY(-2px);opacity:.4}30%{opacity:1}100%{transform:translateY(4px);opacity:.3}}",
    "@keyframes mm-wx-flake{0%{transform:translate(0,-2px) rotate(0deg);opacity:.55}40%{opacity:1}100%{transform:translate(1.6px,5px) rotate(28deg);opacity:.4}}",
    "@keyframes mm-wx-flash{0%,42%,100%{opacity:1}50%{opacity:.28}58%{opacity:1}66%{opacity:.4}}",
    "@keyframes mm-wx-pulse{0%,100%{opacity:.5}50%{opacity:1}}",
    "@keyframes mm-wx-mist{0%,100%{transform:translateX(-1.4px);opacity:.35}50%{transform:translateX(1.6px);opacity:.85}}",
    "@media (prefers-reduced-motion:reduce){.mm-wx,.mm-wx *{animation:none!important}}"
  ].join("");
  document.head.appendChild(style);
}

function wxMotion(animation, origin) {
  return { animation: animation, transformOrigin: origin || "8px 8px", transformBox: "view-box" };
}

function wxSun(cx, cy, radius) {
  var rays = [];
  var i;
  for (i = 0; i < 8; i++) {
    var angle = Math.PI * 2 * i / 8;
    rays.push(h("line", {
      key: "ray-" + i,
      x1: cx + Math.cos(angle) * (radius + 1.15),
      y1: cy + Math.sin(angle) * (radius + 1.15),
      x2: cx + Math.cos(angle) * (radius + 2.55),
      y2: cy + Math.sin(angle) * (radius + 2.55),
      stroke: "#f0b429",
      strokeWidth: 1.15,
      strokeLinecap: "round"
    }));
  }
  return h("g", { key: "sun", style: wxMotion("mm-wx-spin 14s linear infinite", cx + "px " + cy + "px") },
    h("circle", { cx: cx, cy: cy, r: radius + 1.7, fill: "#f0b429", style: wxMotion("mm-wx-pulse 2.6s ease-in-out infinite", cx + "px " + cy + "px") }),
    rays,
    h("circle", { cx: cx, cy: cy, r: radius, fill: "#f6c453" }),
    h("circle", { cx: cx - radius * 0.28, cy: cy - radius * 0.32, r: radius * 0.28, fill: "#fff6d2" })
  );
}

function wxCloud(motion, shift) {
  return h("g", { key: "cloud", style: motion || wxMotion("mm-wx-bob 3.4s ease-in-out infinite") },
    h("g", { transform: shift || "" },
      h("ellipse", { cx: 6.1, cy: 8.7, rx: 2.35, ry: 2.05, fill: "currentColor" }),
      h("ellipse", { cx: 9.5, cy: 8.9, rx: 2.55, ry: 2.15, fill: "currentColor" }),
      h("ellipse", { cx: 8, cy: 10.35, rx: 4.15, ry: 2.25, fill: "currentColor" })
    )
  );
}

function wxDrops(count, duration) {
  var nodes = [];
  var i;
  for (i = 0; i < count; i++) {
    var x = 3.6 + (count === 1 ? 4 : i * (8.2 / (count - 1)));
    nodes.push(h("line", {
      key: "drop-" + i,
      x1: x,
      y1: 11.2,
      x2: x - 0.7,
      y2: 13.5,
      stroke: "#3d8bfd",
      strokeWidth: count > 3 ? 1.35 : 1.15,
      strokeLinecap: "round",
      style: { animation: "mm-wx-fall " + duration + "s linear infinite", animationDelay: (i * 0.16) + "s" }
    }));
  }
  return nodes;
}

function wxFlakes(count, duration) {
  var nodes = [];
  var i;
  for (i = 0; i < count; i++) {
    var x = 4 + (count === 1 ? 4 : i * (7.2 / (count - 1)));
    nodes.push(h("g", {
      key: "flake-" + i,
      style: { animation: "mm-wx-flake " + duration + "s ease-in infinite", animationDelay: (i * 0.22) + "s" }
    }, h("path", {
      d: "M" + x + " 10.4 v2.8 M" + (x - 1.05) + " 11.2 l2.1 1.5 M" + (x - 1.05) + " 12.7 l2.1-1.5",
      stroke: "#3d7eb8",
      strokeWidth: 1.2,
      strokeLinecap: "round",
      fill: "none"
    })));
  }
  return nodes;
}

function wxIce() {
  return h("path", {
    key: "ice",
    d: "M12.2 10.6 l1.35 1.45 -1.35 1.45 -1.35-1.45 z",
    fill: "#b9e4ff",
    style: wxMotion("mm-wx-pulse 1.6s ease-in-out infinite", "12.4px 12.6px")
  });
}

function wxBolt() {
  return h("path", {
    key: "bolt",
    d: "M9.15 8.1 7.2 11.1 h1.55 L7.35 14.2 11.1 10.3 H9.35 Z",
    fill: "#f5c542",
    style: { animation: "mm-wx-flash 2.4s ease-in-out infinite" }
  });
}

function wxMist() {
  return [0, 1].map(function (index) {
    return h("rect", {
      key: "mist-" + index,
      x: 2.1,
      y: 10.3 + index * 2.05,
      width: 11.6,
      height: 1.15,
      rx: 0.6,
      fill: "currentColor",
      style: { animation: "mm-wx-mist 2.6s ease-in-out infinite", animationDelay: (index * 0.35) + "s" }
    });
  });
}

function weatherGlyphNodes(kind) {
  if (kind === "clear") return [wxSun(8, 8, 2.7)];
  if (kind === "mainly-clear") return [wxSun(5.6, 5.8, 2.15), wxCloud(wxMotion("mm-wx-drift 3.6s ease-in-out infinite"), "translate(1.4 2.2) scale(.72)")];
  if (kind === "partly") return [wxSun(5.2, 5.4, 2.05), wxCloud(wxMotion("mm-wx-drift 3.8s ease-in-out infinite"), "translate(0.4 1.2) scale(.92)")];
  if (kind === "overcast") return [wxCloud()];
  if (kind === "fog") return [wxCloud(wxMotion("mm-wx-bob 4s ease-in-out infinite"), "translate(0 -1.6) scale(.78)"), wxMist()];
  if (kind === "drizzle") return [wxCloud(null, "translate(0 -2.5) scale(.72)")].concat(wxDrops(2, 1.35));
  if (kind === "freezing-drizzle") return [wxCloud(null, "translate(0 -2.5) scale(.72)")].concat(wxDrops(2, 1.35), [wxIce()]);
  if (kind === "rain") return [wxCloud(null, "translate(0 -2.6) scale(.74)")].concat(wxDrops(3, 1.05));
  if (kind === "rain-heavy") return [wxCloud(null, "translate(0 -2.7) scale(.76)")].concat(wxDrops(4, 0.72));
  if (kind === "freezing-rain") return [wxCloud(null, "translate(0 -2.6) scale(.74)")].concat(wxDrops(3, 1.05), [wxIce()]);
  if (kind === "snow") return wxFlakes(3, 1.7);
  if (kind === "snow-heavy") return [wxCloud(null, "translate(0 -3.1) scale(.62)")].concat(wxFlakes(4, 1.15));
  if (kind === "grains") return [0, 1, 2, 3].map(function (index) {
    return h("circle", {
      key: "grain-" + index,
      cx: 4 + index * 2.4,
      cy: 12,
      r: 0.85,
      fill: "#3d7eb8",
      style: { animation: "mm-wx-fall 1.5s linear infinite", animationDelay: (index * 0.2) + "s" }
    });
  });
  if (kind === "showers") return [wxSun(4.8, 4.8, 1.7), wxCloud(wxMotion("mm-wx-drift 3.6s ease-in-out infinite"), "translate(0.8 0.2) scale(.78)")].concat(wxDrops(2, 1.15));
  if (kind === "showers-heavy") return [wxSun(4.2, 4.4, 1.35), wxCloud(null, "translate(0.6 -0.4) scale(.86)")].concat(wxDrops(4, 0.78));
  if (kind === "snow-showers") return [wxCloud(null, "translate(0 -3) scale(.64)")].concat(wxFlakes(3, 1.45));
  if (kind === "thunder") return [wxCloud(null, "translate(0 -2.8) scale(.7)"), wxBolt()];
  if (kind === "hail") return [wxCloud(null, "translate(0 -2.8) scale(.7)"), wxBolt()].concat([0, 1].map(function (index) {
    return h("circle", {
      key: "hail-" + index,
      cx: 5.2 + index * 3.2,
      cy: 13.1,
      r: 1.15,
      fill: "#d7ecff",
      stroke: "#3d7eb8",
      strokeWidth: 0.6,
      style: { animation: "mm-wx-fall 0.9s linear infinite", animationDelay: (index * 0.2) + "s" }
    });
  }));
  return [wxCloud(wxMotion("mm-wx-pulse 2.8s ease-in-out infinite"))];
}

function weatherKindOf(forecast) {
  if (!forecast) return "";
  if (forecast.icon && forecast.icon !== "unknown") return forecast.icon;
  return WEATHER_KIND_TEXT[forecast.dayWeather] || forecast.icon || "unknown";
}

function WeatherGlyph(props) {
  ensureWeatherStyle();
  var kind = props.kind || "unknown";
  var size = props.size || 16;
  return h("svg", {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    className: "mm-wx",
    role: "img",
    "aria-label": props.label || kind,
    style: { display: "block", overflow: "visible", flex: "0 0 auto", color: "var(--mm-fg, currentColor)" }
  }, weatherGlyphNodes(kind));
}

function calendarWeatherText(forecast) {
  if (!forecast) return null;
  var temps = (forecast.dayTemp || forecast.nightTemp)
    ? ((forecast.dayTemp || "–") + "°/" + (forecast.nightTemp || "–") + "°")
    : "";
  return h("div", {
    title: forecast.dayWeather || "",
    style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, flex: "0 0 auto", color: "var(--mm-muted, GrayText)" }
  },
    h(WeatherGlyph, { kind: weatherKindOf(forecast), label: forecast.dayWeather, size: 16 }),
    temps ? h("div", { style: { fontSize: 10, lineHeight: "12px" } }, temps) : null
  );
}

function MmCalendarPanel(props) {
  var seed = props.initial || null;
  var monthState = React.useState(seed && seed.month || "");
  var dataState = React.useState(seed);
  var selectedState = React.useState("");
  var formState = React.useState(null);
  var msgState = React.useState("");
  var loadingState = React.useState(false);
  var reloadState = React.useState(0);
  var month = monthState[0];
  var setMonth = monthState[1];
  var data = dataState[0];
  var setData = dataState[1];
  var selected = selectedState[0];
  var setSelected = selectedState[1];
  var form = formState[0];
  var setForm = formState[1];
  var message = msgState[0];
  var setMessage = msgState[1];
  var loading = loadingState[0];
  var setLoading = loadingState[1];
  var reload = reloadState[0];
  var setReload = reloadState[1];
  var echo = React.useRef("");

  React.useEffect(function () {
    if (echo.current && echo.current === month) {
      echo.current = "";
      return undefined;
    }
    var alive = true;
    setLoading(true);
    props.loadMonth(month).then(function (cal) {
      if (!alive || !cal) return;
      setData(cal);
      if (!month && cal.month) {
        echo.current = cal.month;
        setMonth(cal.month);
      }
      setSelected(function (cur) {
        var days = cal.days || [];
        if (cur && days.some(function (day) { return day.date === cur; })) return cur;
        if (cal.today && String(cal.today).slice(0, 7) === cal.month) return cal.today;
        return days[0] ? days[0].date : "";
      });
    }, function (error) {
      if (alive) setMessage(error.message || "加载日历失败");
    }).then(function () {
      if (alive) setLoading(false);
    });
    return function () { alive = false; };
  }, [month, props.loadMonth, reload]);

  var days = data && data.days || [];
  var picked = null;
  for (var i = 0; i < days.length; i++) if (days[i].date === selected) picked = days[i];
  var lead = days[0] ? days[0].weekday : 0;
  var cells = [];
  for (var b = 0; b < lead; b++) cells.push(null);
  days.forEach(function (day) { cells.push(day); });
  var week = ["日", "一", "二", "三", "四", "五", "六"];
  var box = { width: 760, maxWidth: "100%" };

  function openNew() {
    setMessage("");
    setForm({ id: "", title: "", date: selected || (data && data.today) || "", endDate: "", time: "", note: "" });
  }
  function openEdit(event) {
    setMessage("");
    setForm({
      id: event.id,
      title: event.title || "",
      date: event.date || selected,
      endDate: event.endDate || "",
      time: event.time || "",
      note: event.note || ""
    });
  }
  function onSave() {
    if (!form || !String(form.title || "").trim()) {
      setMessage("请填写标题");
      return;
    }
    if (!form.date) {
      setMessage("请填写日期");
      return;
    }
    setMessage("");
    setLoading(true);
    props.saveEvent(form).then(function (body) {
      var cal = body && body.calendar;
      if (cal && cal.month && cal.month !== (data && data.month)) {
        echo.current = cal.month;
        setMonth(cal.month);
      }
      if (cal) setData(cal);
      if (form.date) setSelected(form.date);
      setForm(null);
      setMessage("已保存");
    }, function (error) {
      setMessage(error.message || "保存失败");
    }).then(function () { setLoading(false); });
  }
  function onDelete(id) {
    if (!window.confirm("确定删除该数据？删除后数据无法恢复，请谨慎操作！")) return;
    setLoading(true);
    props.deleteEvent(id).then(function () {
      return props.loadMonth((data && data.month) || month);
    }).then(function (cal) {
      if (cal) setData(cal);
      setForm(null);
      setMessage("已删除");
    }, function (error) {
      setMessage(error.message || "删除失败");
    }).then(function () { setLoading(false); });
  }

  var inputStyle = {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--mm-border, rgba(127,127,127,.35))",
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    padding: "4px 6px"
  };

  return h("div", { style: box },
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
      h("button", {
        type: "button",
        onClick: function () { setMonth(shiftCalendarMonth(data && data.month || month, -1)); },
        style: { border: "none", background: "transparent", color: "inherit", cursor: "pointer" }
      }, "‹"),
      h("div", { style: { flex: 1, textAlign: "center", fontWeight: 600 } }, (data && data.title) || month || "日历"),
      h("button", {
        type: "button",
        title: loading ? "正在更新" : "更新",
        "aria-label": loading ? "正在更新" : "更新",
        disabled: loading,
        onClick: function () { setReload(function (n) { return n + 1; }); },
        style: {
          border: "none",
          background: "transparent",
          color: "inherit",
          cursor: loading ? "progress" : "pointer",
          padding: 2,
          display: "inline-flex",
          alignItems: "center"
        }
      }, calendarUpdateIcon(loading)),
      h("button", {
        type: "button",
        onClick: function () { setMonth(shiftCalendarMonth(data && data.month || month, 1)); },
        style: { border: "none", background: "transparent", color: "inherit", cursor: "pointer" }
      }, "›")
    ),
    data && data.weather && data.weather.error
      ? h("div", { style: { fontSize: 11, color: "#e55", marginBottom: 6 } }, data.weather.error)
      : null,
    data && data.weather && data.weather.source && !data.weather.error
      ? h("div", { style: { fontSize: 10, color: "var(--mm-muted, GrayText)", marginBottom: 6 } }, "天气数据来自 " + data.weather.source)
      : null,
    h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 } },
      week.map(function (label) {
        return h("div", { key: label, style: { textAlign: "center", fontSize: 10, color: "var(--mm-muted, GrayText)" } }, label);
      }),
      cells.map(function (day, index) {
        if (!day) return h("div", { key: "blank-" + index });
        var on = day.date === selected;
        var mark = day.rest ? "休" : day.work ? "班" : "";
        return h("button", {
          key: day.date,
          type: "button",
          onClick: function () { setSelected(day.date); setForm(null); },
          style: {
            width: "100%",
            minHeight: 48,
            padding: "3px 4px",
            borderRadius: 6,
            cursor: "pointer",
            color: "inherit",
            border: on ? "1px solid var(--mm-accent, #4a9eff)" : "1px solid transparent",
            background: day.date === (data && data.today) ? "rgba(74,158,255,.16)" : "transparent"
          }
        },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, width: "100%" } },
            h("div", { style: { textAlign: "left", minWidth: 0 } },
              h("div", { style: { fontSize: 13, lineHeight: "16px" } }, String(day.solarDay)),
              h("div", {
                style: {
                  fontSize: 9,
                  lineHeight: "12px",
                  color: mark === "休" ? "#e55" : "var(--mm-muted, GrayText)",
                  overflow: "hidden",
                  whiteSpace: "nowrap"
                }
              },
                mark || day.mark || "",
                day.events && day.events.length
                  ? h("span", {
                    style: {
                      display: "inline-block",
                      width: 4,
                      height: 4,
                      marginLeft: 2,
                      borderRadius: 4,
                      background: "currentColor",
                      verticalAlign: "middle"
                    }
                  })
                  : null
              )
            ),
            calendarWeatherText(day.forecast)
          )
        );
      })
    ),
    picked
      ? h("div", { style: { marginTop: 8, fontSize: 12 } },
          h("div", { style: { fontWeight: 600 } }, picked.date + " " + picked.lunarText + (picked.term ? " " + picked.term : "")),
          picked.holiday ? h("div", null, picked.holiday + (picked.rest ? " · 休" : "")) : null,
          picked.work ? h("div", null, "调休上班") : null,
          picked.forecast
            ? h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 2 } },
                h(WeatherGlyph, { kind: weatherKindOf(picked.forecast), label: picked.forecast.dayWeather, size: 20 }),
                h("span", null, picked.forecast.dayWeather + " " + picked.forecast.dayTemp + "° / " + picked.forecast.nightTemp + "°")
              )
            : null,
          (picked.events || []).length
            ? h("div", { style: { marginTop: 6 } }, picked.events.map(function (event) {
                var when = event.allDay ? "全天" : (event.time || "");
                return h("div", { key: event.id, style: { display: "flex", gap: 6, alignItems: "center", marginTop: 4 } },
                  h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, when + " " + event.title),
                  h("button", { type: "button", onClick: function () { openEdit(event); }, style: { border: "none", background: "transparent", color: "inherit", cursor: "pointer" } }, "修改"),
                  h("button", { type: "button", onClick: function () { onDelete(event.id); }, style: { border: "none", background: "transparent", color: "#e55", cursor: "pointer" } }, "删除")
                );
              }))
            : h("div", { style: { marginTop: 6, color: "var(--mm-muted, GrayText)" } }, "这一天没有日程"),
          h("button", {
            type: "button",
            onClick: openNew,
            style: { marginTop: 6, border: "1px solid var(--mm-border, rgba(127,127,127,.35))", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer", padding: "2px 8px" }
          }, "添加日程")
        )
      : null,
    form
      ? h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
          h("input", {
            value: form.title,
            placeholder: "标题",
            onChange: function (event) { setForm(Object.assign({}, form, { title: event.target.value })); },
            style: inputStyle
          }),
          h("input", {
            value: form.date,
            placeholder: "YYYY-MM-DD",
            onChange: function (event) { setForm(Object.assign({}, form, { date: event.target.value })); },
            style: inputStyle
          }),
          h("input", {
            value: form.endDate,
            placeholder: "结束日期 YYYY-MM-DD，可空",
            onChange: function (event) { setForm(Object.assign({}, form, { endDate: event.target.value })); },
            style: inputStyle
          }),
          h("input", {
            value: form.time,
            placeholder: "时间 HH:MM，留空为全天",
            onChange: function (event) { setForm(Object.assign({}, form, { time: event.target.value })); },
            style: inputStyle
          }),
          h("input", {
            value: form.note,
            placeholder: "备注",
            onChange: function (event) { setForm(Object.assign({}, form, { note: event.target.value })); },
            style: inputStyle
          }),
          h("div", { style: { display: "flex", gap: 8 } },
            h("button", { type: "button", onClick: onSave, style: { cursor: "pointer" } }, "保存"),
            h("button", { type: "button", onClick: function () { setForm(null); }, style: { cursor: "pointer" } }, "取消")
          )
        )
      : null,
    message ? h("div", { style: { marginTop: 6, fontSize: 11, color: "var(--mm-muted, GrayText)" } }, message) : null
  );
}

function MmCalendarBody(props) {
  var cal = props.mm && props.mm.calendar;
  return h(MmCalendarPanel, {
    initial: cal || null,
    loadMonth: loadCalendarMonth,
    saveEvent: saveCalendarEvent,
    deleteEvent: deleteCalendarEvent
  });
}

function mmPreviewUrl(id) {
  return API + "/file-preview/" + id;
}

function mmFormatBytes(bytes) {
  var n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function mmFileExt(name) {
  var text = String(name || "");
  var dot = text.lastIndexOf(".");
  var ext = dot >= 0 ? text.slice(dot + 1) : "FILE";
  return ext.slice(0, 4).toUpperCase();
}

function mmReportFrame(onFrame, width, height) {
  if (typeof onFrame === "function") onFrame({ width: width, height: height || 1 });
}

function mmPreviewBoxStyle() {
  return {
    margin: 0, width: 320, maxWidth: "100%", maxHeight: 240, overflow: "auto",
    fontSize: 12, lineHeight: 1.45, padding: 8, borderRadius: 8, boxSizing: "border-box",
    background: "rgba(127,127,127,.1)", color: "var(--mm-fg, inherit)"
  };
}

function mmInline(text, key) {
  var nodes = [];
  var rest = String(text || "");
  var re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  var match;
  var last = 0;
  var i = 0;
  while ((match = re.exec(rest))) {
    if (match.index > last) nodes.push(rest.slice(last, match.index));
    var token = match[0];
    if (token.charAt(0) === "`") nodes.push(h("code", { key: key + "-" + i }, token.slice(1, -1)));
    else if (token.slice(0, 2) === "**") nodes.push(h("strong", { key: key + "-" + i }, token.slice(2, -2)));
    else if (token.charAt(0) === "*") nodes.push(h("em", { key: key + "-" + i }, token.slice(1, -1)));
    else nodes.push(h("a", {
      key: key + "-" + i, href: match[3], target: "_blank", rel: "noopener noreferrer",
      style: { color: "inherit" }
    }, match[2]));
    last = match.index + token.length;
    i += 1;
  }
  if (last < rest.length) nodes.push(rest.slice(last));
  return nodes;
}

function MmMarkdown(props) {
  var lines = String(props.text || "").split(/\r?\n/);
  var blocks = [];
  var para = [];
  function flush() {
    if (!para.length) return;
    blocks.push(h("p", { key: "p" + blocks.length, style: { margin: "0 0 6px" } }, mmInline(para.join(" "), "p" + blocks.length)));
    para = [];
  }
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.slice(0, 3) === "```") {
      flush();
      var code = [];
      i += 1;
      while (i < lines.length && lines[i].slice(0, 3) !== "```") { code.push(lines[i]); i += 1; }
      blocks.push(h("pre", { key: "c" + blocks.length, style: { margin: "0 0 6px", whiteSpace: "pre-wrap", fontSize: 11 } }, code.join("\n")));
      i += 1;
      continue;
    }
    var heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(h("div", {
        key: "h" + blocks.length,
        style: { fontWeight: 700, fontSize: heading[1].length === 1 ? 15 : 13, margin: "0 0 6px" }
      }, mmInline(heading[2], "h" + blocks.length)));
      i += 1;
      continue;
    }
    var item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      flush();
      blocks.push(h("div", { key: "li" + blocks.length, style: { margin: "0 0 4px", paddingLeft: 12 } }, ["• "].concat(mmInline(item[1], "li" + blocks.length))));
      i += 1;
      continue;
    }
    if (!line.trim()) { flush(); i += 1; continue; }
    para.push(line.trim());
    i += 1;
  }
  flush();
  return h("div", { style: mmPreviewBoxStyle() }, blocks.length ? blocks : "（没有可显示的文本）");
}

function MmPlainText(props) {
  return h("pre", {
    style: Object.assign({}, mmPreviewBoxStyle(), { whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11 })
  }, props.text || "（没有可显示的文本）");
}

function MmSheet(props) {
  var rows = props.rows || [];
  return h("div", { style: Object.assign({}, mmPreviewBoxStyle(), { padding: 0 }) },
    h("table", { style: { borderCollapse: "collapse", width: "100%", fontSize: 11 } },
      h("tbody", null, rows.map(function (row, r) {
        return h("tr", { key: r }, (row || []).map(function (cell, c) {
          return h("td", {
            key: c,
            style: {
              borderBottom: "1px solid rgba(127,127,127,.28)",
              padding: "3px 6px",
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: r === 0 ? 650 : 400
            }
          }, cell || "");
        }));
      }))
    )
  );
}

function MmSlides(props) {
  var slides = props.slides || [];
  return h("div", { style: mmPreviewBoxStyle() }, slides.map(function (lines, index) {
    return h("div", { key: index, style: { marginBottom: index === slides.length - 1 ? 0 : 8 } },
      h("div", { style: { fontSize: 11, fontWeight: 700, marginBottom: 2, color: "var(--mm-muted, GrayText)" } }, "第 " + (index + 1) + " 页"),
      (lines || []).map(function (line, lineIndex) {
        return h("div", { key: lineIndex, style: { marginBottom: 2 } }, line);
      })
    );
  }));
}

function MmFilePreview(props) {
  var mm = props.mm || {};
  var file = mm.file || {};
  var kind = file.previewKind || "file";
  var zoom = React.useState(false);
  var open = zoom[0];
  var setOpen = zoom[1];
  var close = React.useCallback(function () { setOpen(false); }, []);
  React.useEffect(function () {
    var wide = kind === "pdf" || kind === "text" || kind === "markdown" || kind === "word" || kind === "sheet" || kind === "slides" || kind === "audio" || kind === "image";
    mmReportFrame(props.onFrame, wide ? 320 : 220, kind === "pdf" && !file.text ? 360 : 180);
  }, [kind, file.text]);
  if (kind === "markdown") return h(MmMarkdown, { text: file.text || "" });
  if (kind === "sheet" && file.rows && file.rows.length) return h(MmSheet, { rows: file.rows });
  if (kind === "slides" && file.slides && file.slides.length) return h(MmSlides, { slides: file.slides });
  if (kind === "text" || kind === "word" || ((kind === "pdf" || kind === "sheet" || kind === "slides") && file.text)) {
    return h(MmPlainText, { text: file.text });
  }
  if (kind === "image" && file.previewId) {
    var src = mmPreviewUrl(file.previewId);
    return h("span", { style: { display: "block", width: "fit-content", maxWidth: "100%" } },
      h("img", {
        src: src,
        alt: file.name || "image",
        title: "点击查看大图",
        onClick: function () { setOpen(true); },
        onLoad: function (event) {
          var img = event.currentTarget;
          var size = mmFittedSize(img.naturalWidth, img.naturalHeight);
          if (size) mmReportFrame(props.onFrame, size.width, size.height);
        },
        style: { maxWidth: "min(320px, 100%)", maxHeight: 320, borderRadius: 8, display: "block", cursor: "zoom-in" }
      }),
      open ? h(MmLightbox, { src: src, alt: file.name || "image", onClose: close }) : null
    );
  }
  if ((kind === "audio" || kind === "video" || kind === "pdf") && file.previewId) {
    var url = mmPreviewUrl(file.previewId);
    if (kind === "audio") {
      return h("audio", { src: url, controls: true, style: { width: 320, maxWidth: "100%", display: "block" } });
    }
    if (kind === "pdf") {
      return h("iframe", {
        src: url,
        title: file.name || "PDF",
        style: { width: 320, maxWidth: "100%", height: 360, border: "none", borderRadius: 8, display: "block", background: "#fff" }
      });
    }
  }
  return h("div", {
    style: {
      width: 220, maxWidth: "100%", boxSizing: "border-box",
      padding: "16px 12px", borderRadius: 8, background: "rgba(127,127,127,.1)",
      display: "flex", alignItems: "center", gap: 10
    }
  },
    h("div", {
      style: {
        width: 44, height: 52, borderRadius: 6, flex: "0 0 auto",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(127,127,127,.16)", fontSize: 11, fontWeight: 700
      }
    }, mmFileExt(file.name)),
    h("div", { style: { minWidth: 0 } },
      h("div", { style: { fontWeight: 600 } }, mmKindLabel("document", mm)),
      h("div", { style: { marginTop: 2, fontSize: 11, color: "var(--mm-muted, GrayText)" } }, mmFormatBytes(file.bytes))
    )
  );
}

function MmDocumentBody(props) {
  var mm = props.mm || {};
  var status = mm.status || "ready";
  if (status === "pending") {
    return h("div", null,
      h("div", { style: Object.assign({}, MM_SKELETON_STYLE, { width: 220, height: 72 }) }),
      h("div", { style: { marginTop: 6, color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "读取文件…")
    );
  }
  if (status === "error") return h("div", { style: { color: "#e55" } }, mm.error || "文件读取失败");
  if (status === "canceled") return h("div", { style: { color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "已取消");
  return h(MmFilePreview, { mm: mm, onFrame: props.onFrame });
}

function MmVideoBody(props) {
  var mm = props.mm || {};
  var status = mm.status || "ready";
  var file = mm.file || {};
  if (status === "pending") {
    return h("div", null,
      h("div", { style: MM_SKELETON_STYLE }),
      h("div", { style: { marginTop: 6, color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "读取视频…")
    );
  }
  if (status === "error") return h("div", { style: { color: "#e55" } }, mm.error || "视频读取失败");
  if (status === "canceled") return h("div", { style: { color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "已取消");
  if (!file.previewId) return h(MmFilePreview, { mm: mm, onFrame: props.onFrame });
  return h("video", {
    src: mmPreviewUrl(file.previewId),
    controls: true,
    preload: "metadata",
    onLoadedMetadata: function (event) {
      var video = event.currentTarget;
      var size = mmFittedSize(video.videoWidth, video.videoHeight);
      if (size) mmReportFrame(props.onFrame, size.width, size.height);
    },
    style: { width: 320, maxWidth: "100%", maxHeight: 320, borderRadius: 8, display: "block", background: "#000" }
  });
}

/** Placeholder body for kinds not yet wired (webpage). */
function MmStubBody(props) {
  var mm = props.mm;
  var kind = mm.kind || "document";
  var status = mm.status || "ready";
  var label = mmKindLabel(kind);
  if (status === "pending") {
    return h("div", null,
      h("div", { style: Object.assign({}, MM_SKELETON_STYLE, { width: 160, maxWidth: 280, height: 72 }) }),
      h(MmProgressBar, { progress: mm.progress }),
      h("div", { style: { marginTop: 6, color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, label + "生成中…（占位）")
    );
  }
  if (status === "error") {
    return h("div", { style: { color: "#e55" } }, mm.error || (label + "失败"));
  }
  if (status === "canceled") {
    return h("div", { style: { color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" } }, "已取消");
  }
  var src = (mm.source && (mm.source.url || mm.source.href)) || (mm.asset && mm.asset.url) || "";
  return h("div", {
    style: {
      padding: "14px 12px", borderRadius: 8,
      background: "rgba(127,127,127,.1)",
      color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))"
    }
  },
    h("div", { style: { fontWeight: 600, marginBottom: 4, color: "var(--mm-fg)" } }, label + "卡片（占位）"),
    src ? h("div", { style: { wordBreak: "break-all", fontSize: 11 } }, String(src)) : null,
    h("div", { style: { marginTop: 4, fontSize: 11 } }, "后续接入真实 " + kind + " 预览")
  );
}

var MM_BODIES = {
  image: MmImageBody,
  place: MmPlaceBody,
  route: MmPlaceBody,
  calendar: MmCalendarBody,
  document: MmDocumentBody,
  video: MmVideoBody
};

function MmCard(props) {
  var mm = props.mm || {};
  var kind = mm.kind || "image";
  var status = mm.status || "ready";
  var statusLbl = mmStatusLabel(status);
  var title = mm.title || "";
  var locked = mmCardLocked(mm) || kind === "calendar";
  var zoomable = props.zoomable !== false;
  var ownFrame = React.useState(null);
  var frame = props.frame || ownFrame[0];
  function reportFrame(size) {
    if (!props.frame) ownFrame[1](size);
    if (props.onFrame) props.onFrame(size);
  }
  var shell = Object.assign({}, MM_SHELL_STYLE);
  if (frame) shell.width = frame.width + 16;
  var textStyle = frame ? { width: "100%", boxSizing: "border-box" } : mmLockStyle(locked);
  var Body = MM_BODIES[kind] || MmStubBody;
  var body = h(Body, { mm: mm, loadImage: props.loadImage, zoomable: zoomable, frame: frame, onFrame: reportFrame });
  return h("div", { style: shell },
    h("div", {
      style: Object.assign({
        display: "flex", alignItems: "center", gap: 6, marginBottom: 6,
        fontWeight: 600
      }, textStyle)
    },
      h("span", null, mmKindIcon(kind, mm)),
      h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        title || mmKindLabel(kind, mm)),
      statusLbl
        ? h("span", {
            style: {
              fontSize: 11, fontWeight: 500, padding: "1px 6px", borderRadius: 999,
              color: status === "error" ? "#e55" : "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))",
              background: "rgba(127,127,127,.12)"
            }
          }, statusLbl)
        : null
    ),
    body,
    mm.caption
      ? h("div", {
          style: Object.assign({
            marginTop: 6,
            color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: locked ? "nowrap" : "normal",
            wordBreak: locked ? "normal" : "break-word"
          }, textStyle)
        }, mm.caption)
      : null
  );
}

/** 连续同类型媒体合成一叠。depth 0 在最前，其余向右下旋转露出边缘。 */
function mmFanTransform(depth) {
  if (!depth) return "none";
  return "translate(" + (depth * 18) + "px, " + (depth * 6) + "px) rotate(" + (depth * 6) + "deg)";
}

function mmFlattenCards(entries) {
  var flat = [];
  (entries || []).forEach(function (entry) {
    (entry.mms || []).forEach(function (mm, index) {
      var attachmentId = mm && mm.asset && mm.asset.attachment && mm.asset.attachment.attachmentId;
      flat.push({
        mm: mm,
        kind: (mm && mm.kind) || "image",
        key: String(attachmentId || entry.callId || "mm") + "-" + flat.length + "-" + index
      });
    });
  });
  var groups = [];
  flat.forEach(function (item) {
    var last = groups[groups.length - 1];
    if (last && last.kind === item.kind) last.items.push(item);
    else groups.push({ kind: item.kind, items: [item] });
  });
  return groups;
}

function MmFan(props) {
  var items = props.items || [];
  var count = items.length;
  var state = React.useState(0);
  var active = state[0] < count ? state[0] : 0;
  var setActive = state[1];
  var spread = Math.min(Math.max(count - 1, 0), 4);
  var padRight = spread * 20 + 10;
  return h("div", {
    style: {
      position: "relative",
      display: "inline-grid",
      width: "fit-content",
      maxWidth: "100%",
      flex: "0 0 auto",
      paddingRight: padRight,
      paddingBottom: spread * 12 + 8,
      verticalAlign: "top"
    },
    "data-mm-fan": String(count)
  },
    items.map(function (item, index) {
      var steps = (index - active + count) % count;
      var depth = Math.min(steps, 4);
      var front = steps === 0;
      return h("div", {
        key: item.key,
        style: {
          gridArea: "1 / 1",
          justifySelf: "start",
          alignSelf: "start",
          zIndex: front ? 20 : 10 - depth,
          transform: mmFanTransform(front ? 0 : depth),
          transformOrigin: "0 16%",
          position: "relative"
        }
      }, h("div", { style: front ? null : { pointerEvents: "none" } },
        h(MmCard, {
          mm: item.mm,
          loadImage: props.loadImage,
          zoomable: front
        })
      ));
    }),
    count > 1
      ? h("button", {
          type: "button",
          title: "查看下一张",
          "aria-label": "查看下一张",
          onClick: function () { setActive(function (current) { return (current + 1) % count; }); },
          style: {
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: padRight,
            zIndex: 15,
            border: "none",
            padding: 0,
            margin: 0,
            background: "transparent",
            cursor: "pointer"
          }
        })
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
        color: err ? "#e55" : "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))"
      },
      "data-tool": toolName,
      "data-state": err ? "error" : "ok"
    }, toolName + " · " + status + (label ? " · " + label : ""));
  }
  // Preparing / running: pending card only (no settled gallery here).
  var pendingTitle = label || undefined;
  return h("div", {
    style: { margin: "4px 0" },
    "data-tool": toolName,
    "data-state": "running"
  },
    h("div", {
      style: { fontWeight: 600, marginBottom: 4, fontSize: 12, color: "var(--mm-muted,var(--dsw-alias-label-secondary,GrayText))" }
    }, toolName + (label ? " · " + label : "") + " · 发送中"),
    h(MmCard, {
      mm: {
        type: "mm",
        kind: toolName === "calendar_show" ? "calendar" : toolName === "map_card" ? "place" : toolName === "route" ? "route" : toolName === "mm_send_file" ? mmPendingFileKind(args.path) : "image",
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
 * Collect settled mm_send_image / map_card / route / calendar_show cards for one Turn into turn data `mmCards`.
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

function mmPendingFileKind(path) {
  var name = String(path || "").toLowerCase();
  var dot = name.lastIndexOf(".");
  var ext = dot >= 0 ? name.slice(dot) : "";
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif" || ext === ".bmp") return "image";
  if (ext === ".mp4" || ext === ".webm" || ext === ".mov") return "video";
  return "document";
}

var MM_CARD_TOOLS = { mm_send_image: 1, mm_send_file: 1, map_card: 1, route: 1, calendar_show: 1 };

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
      if (!MM_CARD_TOOLS[match.event.data.name]) return context.state;
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
    if (!call || !MM_CARD_TOOLS[call.name]) return context.state;
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
  var groups = mmFlattenCards(matched);
  if (!groups.length) return null;
  return h("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "flex-end",
      justifyContent: "flex-start",
      gap: 16,
      margin: "4px 0",
      maxWidth: "100%"
    },
    "data-mm-turn-tail": true
  }, groups.map(function (group, index) {
    if (group.items.length === 1) {
      var only = group.items[0];
      return h(MmCard, { key: only.key, mm: only.mm, loadImage: loadImage });
    }
    return h(MmFan, {
      key: "fan-" + index + "-" + group.kind,
      items: group.items,
      loadImage: loadImage
    });
  }));
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
/** Bottom-right stacked toasts (body-level, own <style>): oldest is the front card; only the front stays 3s; hover pauses. MM_TOAST_PROGRESS_V3 */
var MM_TOAST_CSS = [
  ".mm-toast-host{position:fixed;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));z-index:2147483000;pointer-events:none;display:flex;flex-direction:column-reverse;gap:8px;font-family:inherit}",
  ".mm-toast-wait-stack{position:relative;flex:none;width:100%;display:flex;flex-direction:column;gap:8px;pointer-events:none}",
  ".mm-toast-wait-stack .mm-toast{position:relative;pointer-events:auto;transform:none;opacity:1}",
  // 普通堆叠内卡片为 absolute 叠放：容器高度由 mmToast._fitStack 按可见卡片实测（ResizeObserver），与等待层同在 host 的 flex 列中，互不覆盖。
  ".mm-toast-stack{position:relative;flex:none;width:100%;height:0;pointer-events:none;transition:height .22s ease}",
  ".mm-toast{--mm-t-fg:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary,#0f1115));--mm-t-track:rgba(127,127,127,.18);--mm-t-fill:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);position:absolute;right:0;bottom:0;width:100%;box-sizing:border-box;display:flex;flex-direction:column;padding:0;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-layer-2,#fff));color:var(--mm-t-fg);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.22));pointer-events:auto;transform-origin:50% 100%;transition:transform .22s ease,opacity .22s ease;font-size:13px;line-height:1.45;overflow:hidden}",
  "body[data-ds-dark-theme] .mm-toast{background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-layer-2,#2a2c31));--mm-t-fg:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary,#f9fafb));--mm-t-track:rgba(255,255,255,.12)}",
  ".mm-toast[data-leaving=true]{opacity:0!important;transform:translateY(12px) scale(.96)!important;pointer-events:none!important}",
  ".mm-toast-main{display:flex;align-items:flex-start;gap:10px;padding:12px 14px 10px;width:100%;box-sizing:border-box}",
  ".mm-toast-accent{flex:none;width:3px;align-self:stretch;border-radius:2px;background:var(--mm-t-fill);margin:2px 0}",
  ".mm-toast.ok .mm-toast-accent{background:#2da44e}",
  ".mm-toast.err .mm-toast-accent{background:#e55}",
  ".mm-toast.info .mm-toast-accent{background:var(--mm-t-fill)}",
  ".mm-toast-body{flex:1;min-width:0;word-break:break-word;padding-top:1px;white-space:pre-line;max-height:40vh;overflow:auto}",
  ".mm-toast-close{flex:none;width:24px;height:24px;margin:-4px -6px -4px 0;padding:0;border:none;border-radius:6px;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:16px;line-height:1}",
  ".mm-toast-close:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
  ".mm-toast-progress{position:relative;flex:none;height:3px;width:100%;background:var(--mm-t-track);overflow:hidden}",
  ".mm-toast-progress[data-mode=actions]{height:auto;min-height:32px;display:flex;align-items:stretch;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}",
  ".mm-toast-progress-fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:left center;background:var(--mm-t-fill);pointer-events:none}",
  ".mm-toast.ok .mm-toast-progress-fill{background:#2da44e}",
  ".mm-toast.err .mm-toast-progress-fill{background:#e55}",
  ".mm-toast-progress[data-mode=indeterminate] .mm-toast-progress-fill{width:40%;animation:mm-toast-indeterminate 1.1s ease-in-out infinite}",
  ".mm-toast-progress[data-mode=none]{display:none}",
  ".mm-toast-progress[data-mode=actions] .mm-toast-progress-fill{display:none}",
  ".mm-toast-actions{position:relative;z-index:1;display:flex;width:100%;align-items:stretch}",
  ".mm-toast-actions button{flex:1;margin:0;padding:7px 10px;border:none;border-right:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}",
  ".mm-toast-actions button:last-child{border-right:none}",
  ".mm-toast-actions button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
  ".mm-toast-actions button:disabled{opacity:.5;cursor:default}",
  ".mm-toast-actions button.primary{font-weight:600;color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6)}",
  // 非主按钮（如「忽略」）不能 inherit：--dsw-alias-toast-label 是官方深底 toast 的浅色字，浅色主题下会白字白底。
  ".mm-toast-actions button:not(.primary){color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary,#4b5563))}",
  "body[data-ds-dark-theme] .mm-toast-actions button:not(.primary){color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary,#d1d5db))}",
  ".mm-toast-actions button:not(.primary):hover{color:var(--dsw-alias-label-primary,#0f1115)}",
  "body[data-ds-dark-theme] .mm-toast-actions button:not(.primary):hover{color:var(--dsw-alias-label-primary,#f9fafb)}",
  "@keyframes mm-toast-indeterminate{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}",
  "@media (prefers-reduced-motion:reduce){.mm-toast,.mm-toast-stack{transition:none}.mm-toast[data-leaving=true]{transform:none!important}.mm-toast-progress[data-mode=indeterminate] .mm-toast-progress-fill{animation:none;width:100%;opacity:.45}}"
].join("\n");
function mmToast(text, kind, opts) {
  try {
    mmToast._ensure();
    opts = opts || {};
    var k = kind === "err" || kind === "error" ? "err" : kind === "info" ? "info" : "ok";
    return mmToast._push(String(text || ""), k, opts);
  } catch (e) {
    try { console.warn("dsh-workbench: toast failed", e); } catch (e2) { /* ignore */ }
    return null;
  }
}
mmToast._items = [];
mmToast._waitItems = [];
mmToast._host = null;
mmToast._waitStack = null;
mmToast._timer = null;
mmToast._raf = null;
mmToast._paused = false;
mmToast._seq = 0;
mmToast._stack = null;
mmToast._reduce = function () {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
};
mmToast._ensure = function () {
  var doc = document;
  if (!doc.getElementById("mm-toast-style")) {
    var st = doc.createElement("style");
    st.id = "mm-toast-style";
    st.textContent = MM_TOAST_CSS;
    (doc.head || doc.documentElement).appendChild(st);
  } else if (!doc.getElementById("mm-toast-style").textContent.includes("mm-toast-wait-stack")) {
    doc.getElementById("mm-toast-style").textContent = MM_TOAST_CSS;
  }
  var host = mmToast._host;
  if (!host || !host.isConnected || host.parentNode !== doc.body) {
    host = doc.getElementById("mm-toast-host");
    if (!host) {
      host = doc.createElement("div");
      host.id = "mm-toast-host";
      host.className = "mm-toast-host";
    }
    doc.body.appendChild(host);
    mmToast._host = host;
  } else if (host !== doc.body.lastElementChild) {
    doc.body.appendChild(host);
  }
  var waitStack = mmToast._waitStack;
  if (!waitStack || !waitStack.isConnected || waitStack.parentNode !== host) {
    waitStack = doc.getElementById("mm-toast-wait-stack");
    if (!waitStack) {
      waitStack = doc.createElement("div");
      waitStack.id = "mm-toast-wait-stack";
      waitStack.className = "mm-toast-wait-stack";
      waitStack.setAttribute("aria-live", "polite");
    }
    // column-reverse host: first child is visually at bottom → normal stack first, wait stack last (= above)
    host.appendChild(waitStack); // 始终为最后一个子节点 = 视觉最上方；普通堆叠恒为 firstChild（最下方）
    mmToast._waitStack = waitStack;
  }
  var stack = mmToast._stack;
  if (!stack || !stack.isConnected || stack.parentNode !== host) {
    stack = doc.getElementById("mm-toast-stack");
    if (!stack) {
      stack = doc.createElement("div");
      stack.id = "mm-toast-stack";
      stack.className = "mm-toast-stack";
      stack.setAttribute("aria-live", "polite");
      stack.addEventListener("mouseenter", function () {
        mmToast._paused = true;
        mmToast._clearTimer();
        mmToast._freezeProgress();
      });
      stack.addEventListener("mouseleave", function () {
        mmToast._paused = false;
        mmToast._arm();
      });
    }
    host.insertBefore(stack, host.firstChild);
    mmToast._stack = stack;
  }
  if (!mmToast._ro && typeof ResizeObserver === "function") {
    try { mmToast._ro = new ResizeObserver(function () { mmToast._fitStack(); }); } catch (e) { mmToast._ro = null; }
  }
  mmToast._fitStack();
};
/** 普通堆叠容器高度 = 可见卡片（含后排上移/缩放的露边）实际占用的最大高度；等待层排在其上方，因此永不重叠。 */
mmToast._fitStack = function () {
  var stack = mmToast._stack;
  if (!stack) return;
  var items = mmToast._items, top = 0;
  for (var i = 0; i < items.length && i <= 3; i++) {
    var h = items[i].el.offsetHeight || 0;
    top = Math.max(top, 10 * i + h * (1 - 0.05 * i));
  }
  stack.style.height = Math.ceil(top) + "px";
};
mmToast._clearTimer = function () {
  if (mmToast._timer) clearTimeout(mmToast._timer);
  mmToast._timer = null;
  if (mmToast._raf) cancelAnimationFrame(mmToast._raf);
  mmToast._raf = null;
};
mmToast._freezeProgress = function () {
  var front = mmToast._items[0];
  if (!front || front.progressMode !== "dwell" || !front.fill) return;
  var remaining = Math.max(0, front.dwellEndsAt - Date.now());
  front.dwellLeft = remaining;
  front.fill.style.transition = "none";
  front.fill.style.width = (front.dwellMs ? (remaining / front.dwellMs) * 100 : 0) + "%";
};
mmToast._push = function (text, kind, opts) {
  opts = opts || {};
  var id = opts.id || ("t" + (++mmToast._seq));
  // Replace existing toast with same id
  if (opts.id) {
    for (var i = 0; i < mmToast._items.length; i++) {
      if (mmToast._items[i].key === opts.id) {
        mmToast._dismiss(mmToast._items[i].id, true);
        break;
      }
    }
  }
  var numericId = ++mmToast._seq;
  var el = document.createElement("div");
  el.className = "mm-toast " + kind;
  el.setAttribute("role", kind === "err" ? "alert" : "status");
  el.setAttribute("data-id", String(numericId));
  var main = document.createElement("div");
  main.className = "mm-toast-main";
  var accent = document.createElement("div");
  accent.className = "mm-toast-accent";
  accent.setAttribute("aria-hidden", "true");
  var body = document.createElement("div");
  body.className = "mm-toast-body";
  body.textContent = text;
  var close = document.createElement("button");
  close.type = "button";
  close.className = "mm-toast-close";
  close.setAttribute("aria-label", "关闭通知");
  close.textContent = "×";
  close.addEventListener("click", function (e) { e.stopPropagation(); mmToast._dismiss(numericId); });
  // 右键关闭该条通知（与 × 相同的退出动画）。
  el.addEventListener("contextmenu", function (e) { e.preventDefault(); e.stopPropagation(); mmToast._dismiss(numericId); });
  main.appendChild(accent);
  main.appendChild(body);
  main.appendChild(close);
  var progress = document.createElement("div");
  progress.className = "mm-toast-progress";
  var fill = document.createElement("div");
  fill.className = "mm-toast-progress-fill";
  progress.appendChild(fill);
  el.appendChild(main);
  el.appendChild(progress);
  var persistent = !!opts.persistent;
  var progressMode = opts.progress === "indeterminate" ? "indeterminate"
    : typeof opts.progress === "number" ? "determinate"
    : opts.actions && opts.actions.length ? "actions"
    : persistent ? "none"
    : "dwell";
  progress.setAttribute("data-mode", progressMode);
  if (progressMode === "determinate") {
    fill.style.width = Math.max(0, Math.min(100, Number(opts.progress) || 0)) + "%";
  } else if (progressMode === "dwell") {
    fill.style.width = "100%";
  }
  var actionsWrap = null;
  if (opts.actions && opts.actions.length) {
    progressMode = progressMode === "dwell" ? "actions" : progressMode;
    if (opts.actions && opts.actions.length && (opts.progress === undefined || opts.progress === null || progress.getAttribute("data-mode") === "actions")) {
      progress.setAttribute("data-mode", "actions");
      progressMode = "actions";
    }
    actionsWrap = document.createElement("div");
    actionsWrap.className = "mm-toast-actions";
    opts.actions.forEach(function (a) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label || "";
      if (a.primary) btn.className = "primary";
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        try { a.onClick && a.onClick({ dismiss: function () { mmToast._dismiss(numericId); }, toastId: numericId, setProgress: function (p) { mmToast._setProgress(numericId, p); }, setText: function (t) { body.textContent = t; }, setActions: function (next) { mmToast._setActions(numericId, next); } }); } catch (err) { console.warn(err); }
      });
      actionsWrap.appendChild(btn);
    });
    progress.appendChild(actionsWrap);
  }
  var item = {
    id: numericId,
    key: opts.id || null,
    el: el,
    kind: kind,
    body: body,
    fill: fill,
    progressEl: progress,
    actionsWrap: actionsWrap,
    persistent: persistent,
    progressMode: progressMode,
    dwellMs: 3000,
    dwellLeft: 3000,
    dwellEndsAt: 0
  };
  mmToast._items.push(item);
  mmToast._stack.appendChild(el);
  if (mmToast._ro) { try { mmToast._ro.observe(el); } catch (e) {} }
  mmToast._layout();
  if (mmToast._items.length === 1) mmToast._arm();
  return {
    id: numericId,
    dismiss: function () { mmToast._dismiss(numericId); },
    setText: function (t) { body.textContent = t; },
    setProgress: function (p) { mmToast._setProgress(numericId, p); },
    setActions: function (next) { mmToast._setActions(numericId, next); },
    setPersistent: function (v) { item.persistent = !!v; if (!v && mmToast._items[0] && mmToast._items[0].id === numericId) mmToast._arm(); }
  };
};
mmToast._setProgress = function (id, p) {
  var item = null;
  for (var i = 0; i < mmToast._items.length; i++) if (mmToast._items[i].id === id) { item = mmToast._items[i]; break; }
  if (!item) return;
  if (p === "indeterminate") {
    item.progressMode = "indeterminate";
    item.progressEl.setAttribute("data-mode", "indeterminate");
    item.fill.style.width = "";
    item.fill.style.transition = "";
    return;
  }
  if (p === null || p === "none") {
    item.progressMode = "none";
    item.progressEl.setAttribute("data-mode", "none");
    return;
  }
  var n = Math.max(0, Math.min(100, Number(p) || 0));
  item.progressMode = "determinate";
  item.progressEl.setAttribute("data-mode", "determinate");
  item.fill.style.transition = mmToast._reduce() ? "none" : "width .2s linear";
  item.fill.style.width = n + "%";
};
mmToast._setActions = function (id, actions) {
  var item = null;
  for (var i = 0; i < mmToast._items.length; i++) if (mmToast._items[i].id === id) { item = mmToast._items[i]; break; }
  if (!item) return;
  if (item.actionsWrap && item.actionsWrap.parentNode) item.actionsWrap.parentNode.removeChild(item.actionsWrap);
  item.actionsWrap = null;
  if (!actions || !actions.length) {
    if (item.progressMode === "actions") {
      item.progressMode = item.persistent ? "none" : "dwell";
      item.progressEl.setAttribute("data-mode", item.progressMode);
    }
    return;
  }
  item.progressMode = "actions";
  item.progressEl.setAttribute("data-mode", "actions");
  var wrap = document.createElement("div");
  wrap.className = "mm-toast-actions";
  actions.forEach(function (a) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = a.label || "";
    if (a.primary) btn.className = "primary";
    if (a.disabled) btn.disabled = true;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      try { a.onClick && a.onClick({ dismiss: function () { mmToast._dismiss(id); }, setProgress: function (p) { mmToast._setProgress(id, p); }, setText: function (t) { item.body.textContent = t; }, setActions: function (next) { mmToast._setActions(id, next); } }); } catch (err) { console.warn(err); }
    });
    wrap.appendChild(btn);
  });
  item.progressEl.appendChild(wrap);
  item.actionsWrap = wrap;
};
mmToast._layout = function () {
  var items = mmToast._items;
  var maxBehind = 3;
  for (var i = 0; i < items.length; i++) {
    var el = items[i].el;
    var depth = Math.min(i, maxBehind);
    el.style.zIndex = String(1000 - i);
    el.style.transform = "translateY(" + (-10 * depth) + "px) scale(" + (1 - 0.05 * depth) + ")";
    el.style.opacity = i > maxBehind ? "0" : i === 0 ? "1" : String(Math.max(0.5, 1 - 0.15 * i));
    el.style.pointerEvents = i === 0 ? "auto" : "none";
    el.setAttribute("aria-hidden", i === 0 ? "false" : "true");
    // Only the front card runs dwell animation; freeze behind cards' bars.
    if (i > 0 && items[i].progressMode === "dwell" && items[i].fill) {
      items[i].fill.style.transition = "none";
      items[i].fill.style.width = "100%";
    }
  }
  mmToast._fitStack();
};
mmToast._arm = function () {
  mmToast._clearTimer();
  if (mmToast._paused || !mmToast._items.length) return;
  var front = mmToast._items[0];
  if (front.persistent || front.progressMode === "indeterminate" || front.progressMode === "determinate" || front.progressMode === "actions" || front.progressMode === "none") {
    return; // no auto-dismiss
  }
  var ms = front.dwellLeft != null ? front.dwellLeft : front.dwellMs;
  if (!(ms > 0)) ms = front.dwellMs;
  front.dwellEndsAt = Date.now() + ms;
  if (front.fill && front.progressMode === "dwell") {
    if (mmToast._reduce()) {
      front.fill.style.transition = "none";
      front.fill.style.width = "100%";
    } else {
      front.fill.style.transition = "none";
      front.fill.style.width = (ms / front.dwellMs) * 100 + "%";
      // Force reflow then animate to 0
      void front.fill.offsetWidth;
      front.fill.style.transition = "width " + ms + "ms linear";
      front.fill.style.width = "0%";
    }
  }
  mmToast._timer = setTimeout(function () {
    mmToast._timer = null;
    if (mmToast._paused || !mmToast._items.length) return;
    if (mmToast._items[0].id !== front.id) return;
    mmToast._dismiss(front.id);
  }, ms);
};
mmToast._dismiss = function (id, instant) {
  var items = mmToast._items;
  var idx = -1;
  for (var i = 0; i < items.length; i++) if (items[i].id === id) { idx = i; break; }
  if (idx < 0) return;
  var item = items.splice(idx, 1)[0];
  if (mmToast._ro) { try { mmToast._ro.unobserve(item.el); } catch (e) {} }
  if (instant) {
    if (item.el.parentNode) item.el.parentNode.removeChild(item.el);
  } else {
    item.el.setAttribute("data-leaving", "true");
    setTimeout(function () { if (item.el.parentNode) item.el.parentNode.removeChild(item.el); }, mmToast._reduce() ? 0 : 230);
  }
  mmToast._layout();
  if (idx === 0) {
    // New front: reset dwell fully
    if (mmToast._items[0] && mmToast._items[0].progressMode === "dwell") {
      mmToast._items[0].dwellLeft = mmToast._items[0].dwellMs;
    }
    mmToast._arm();
  }
};
/** Page closed: let visible toasts finish on their own (stack lives on <body>). */
mmToast.dispose = function () {};

/** 等待进度层：独立于普通堆叠通知，可同时多条，不顶替普通 toast。 */
mmToast._pushWait = function (text, opts) {
  opts = opts || {};
  mmToast._ensure();
  var key = opts.id || ("w" + (++mmToast._seq));
  for (var i = 0; i < mmToast._waitItems.length; i++) {
    if (mmToast._waitItems[i].key === key) {
      mmToast._dismissWait(mmToast._waitItems[i].id, true);
      break;
    }
  }
  // DOM 级去重：其它脚本实例留下的同 key 元素直接移除（以本实例新建的为准，保证事件绑定有效）。
  try {
    var dups = mmToast._waitStack.querySelectorAll('[data-wait="true"]');
    for (var d = 0; d < dups.length; d++) {
      if (dups[d].getAttribute("data-key") === key && dups[d].parentNode) dups[d].parentNode.removeChild(dups[d]);
    }
  } catch (e) {}
  var numericId = ++mmToast._seq;
  var el = document.createElement("div");
  el.className = "mm-toast info";
  el.setAttribute("data-key", key);
  el.setAttribute("role", "status");
  el.setAttribute("data-id", String(numericId));
  el.setAttribute("data-wait", "true");
  var main = document.createElement("div");
  main.className = "mm-toast-main";
  var accent = document.createElement("div");
  accent.className = "mm-toast-accent";
  accent.setAttribute("aria-hidden", "true");
  var body = document.createElement("div");
  body.className = "mm-toast-body";
  body.textContent = text;
  var close = document.createElement("button");
  close.type = "button";
  close.className = "mm-toast-close";
  close.setAttribute("aria-label", "关闭通知");
  close.textContent = "×";
  // × 与右键：只隐藏这条等待通知，不取消底层操作；onUserClose 让调用方记住「本次等待已被用户关闭」。
  var userClose = function (e) {
    e.preventDefault();
    e.stopPropagation();
    mmToast._dismissWait(numericId);
    try { if (typeof opts.onUserClose === "function") opts.onUserClose(); } catch (err) { /* ignore */ }
  };
  close.addEventListener("click", userClose);
  el.addEventListener("contextmenu", userClose);
  main.appendChild(accent);
  main.appendChild(body);
  main.appendChild(close);
  var progress = document.createElement("div");
  progress.className = "mm-toast-progress";
  progress.setAttribute("data-mode", opts.progress === "none" ? "none" : "indeterminate");
  var fill = document.createElement("div");
  fill.className = "mm-toast-progress-fill";
  progress.appendChild(fill);
  el.appendChild(main);
  el.appendChild(progress);
  var item = {
    id: numericId,
    key: key,
    el: el,
    body: body,
    fill: fill,
    progressEl: progress,
    progressMode: progress.getAttribute("data-mode"),
    shownAt: Date.now(),
  };
  // 等待层进度：数字 0–100 为确定进度，"none" 隐藏进度条，其它为不确定进度。
  function setWaitProgress(p) {
    if (p === "none") { item.progressMode = "none"; progress.setAttribute("data-mode", "none"); return; }
    if (typeof p === "number" && isFinite(p)) {
      item.progressMode = "determinate";
      progress.setAttribute("data-mode", "determinate");
      fill.style.width = Math.max(0, Math.min(100, p)) + "%";
      return;
    }
    item.progressMode = "indeterminate";
    progress.setAttribute("data-mode", "indeterminate");
    fill.style.width = "";
  }
  if (opts.progress !== undefined && opts.progress !== null) setWaitProgress(opts.progress);
  mmToast._waitItems.push(item);
  mmToast._waitStack.appendChild(el);
  return {
    id: numericId,
    key: key,
    dismiss: function () { mmToast._dismissWait(numericId); },
    isAlive: function () { return mmToast._waitItems.indexOf(item) >= 0 && !!el.parentNode; },
    setText: function (t) { body.textContent = t; },
    setProgress: setWaitProgress,
  };
};
mmToast._dismissWait = function (id, instant) {
  var items = mmToast._waitItems;
  var idx = -1;
  for (var i = 0; i < items.length; i++) if (items[i].id === id) { idx = i; break; }
  if (idx < 0) return;
  var item = items.splice(idx, 1)[0];
  if (instant) {
    if (item.el.parentNode) item.el.parentNode.removeChild(item.el);
  } else {
    item.el.setAttribute("data-leaving", "true");
    setTimeout(function () { if (item.el.parentNode) item.el.parentNode.removeChild(item.el); }, mmToast._reduce() ? 0 : 230);
  }
};

// 模块级连接/等待通知（设置页与 DSH 启动后台共用，避免只开设置页才挂载）
// 状态挂在 window 上：客户端脚本可能被重复求值（插件重载 / 重新挂载），模块级变量会各有一份，
// 导致多个后台轮询各自弹出同一条「正在连接」。全局共享后，同一 key 只有一条等待通知。
var mmGlobal = (function () {
  var w = typeof window !== "undefined" ? window : globalThis;
  var g = w.__dshWorkbenchMm || (w.__dshWorkbenchMm = {});
  g.prevConnState = g.prevConnState || {};
  g.connToastAt = g.connToastAt || {};
  g.waitHandles = g.waitHandles || {};
  g.bgWatch = g.bgWatch || { started: false, timer: null };
  return g;
})();
var mmPrevConnState = mmGlobal.prevConnState;
var mmConnToastAt = mmGlobal.connToastAt;
var mmWaitHandles = mmGlobal.waitHandles; // ownerKey -> { handle, shownAt, text, userHidden }

function mmWaitOwnerKey(type, id) { return String(type || "wait") + ":" + String(id || ""); }
function mmWaitShow(text, type, id, opts) {
  var key = mmWaitOwnerKey(type, id);
  var prevRec = mmWaitHandles[key];
  // 用户已关闭本次等待（未经 mmWaitClear 结束、文案未变）→ 不再弹出；返回原句柄（已脱离 DOM，setText 等无副作用）。
  if (prevRec && prevRec.userHidden && prevRec.text === String(text || "")) return prevRec.handle;
  // 同一 key 已有存活的等待通知 → 原地更新文案，不新建。
  if (prevRec && !prevRec.userHidden && prevRec.handle && prevRec.handle.isAlive && prevRec.handle.isAlive()) {
    prevRec.text = String(text || "");
    try { prevRec.handle.setText(prevRec.text); } catch (e) {}
    if (opts && opts.progress != null) { try { prevRec.handle.setProgress(opts.progress); } catch (e) {} }
    return prevRec.handle;
  }
  var rec = { handle: null, shownAt: Date.now(), text: String(text || ""), userHidden: false };
  rec.handle = mmToast._pushWait(rec.text, {
    id: "mm-wait-" + key.replace(/[^a-zA-Z0-9_-]+/g, "-"),
    persistent: true,
    progress: opts && opts.progress != null ? opts.progress : "indeterminate",
    onUserClose: function () { rec.userHidden = true; },
  });
  mmWaitHandles[key] = rec;
  return rec.handle;
}
function mmWaitClear(type, id, opts) {
  opts = opts || {};
  var key = mmWaitOwnerKey(type, id);
  var rec = mmWaitHandles[key];
  delete mmWaitHandles[key];
  if (!rec || !rec.handle) return Promise.resolve();
  var minMs = opts.minMs != null ? opts.minMs : 0;
  var wait = Math.max(0, minMs - (Date.now() - (rec.shownAt || 0)));
  function dismiss() { try { rec.handle.dismiss(); } catch (e) {} }
  if (wait > 0) {
    return new Promise(function (resolve) { setTimeout(function () { dismiss(); resolve(); }, wait); });
  }
  dismiss();
  return Promise.resolve();
}
function mmWaitHandleOf(type, id) {
  var rec = mmWaitHandles[mmWaitOwnerKey(type, id)];
  return rec && rec.handle ? rec.handle : null;
}
/** 等待层条目的 mmToast 同形句柄（setText / setProgress / setActions / dismiss），供原先用普通 toast 显示进度的流程改走等待层。 */
function mmWaitApi(type, id) {
  function cur() { return mmWaitHandleOf(type, id); }
  return {
    setText: function (t) { var x = cur(); if (x) { try { x.setText(t); } catch (e) {} } },
    setProgress: function (p) { var x = cur(); if (x) { try { x.setProgress(p); } catch (e) {} } },
    setActions: function () {},
    dismiss: function () { mmWaitClear(type, id); },
  };
}

function mmConnKind(state, prevKind) {
  if (state === "connected") return "up";
  if (state === "connecting" || state === "checking") return "pending";
  if (state === "no-app" || state === "unreachable" || state === "mcp-down") {
    return prevKind === "up" ? "down" : "pending";
  }
  if (state === "disconnected" || state === "error") return "down";
  return "idle";
}
var mmChatroomTgNotify = { kind: null, errAt: 0 };
// 聊天室工具：选择器所用的 DeepSeek 服务商缺失时提示一次（状态恢复后再变坏会再提示）。
var mmChatroomToolsNotify = { problem: "" };
function maybeToastChatroomTools(tools, enabled) {
  if (!enabled || !tools || !tools.available || !tools.settings || tools.settings.enabled === false) { mmChatroomToolsNotify.problem = ""; return; }
  var f = tools.finder || {};
  if (f.ready) { mmChatroomToolsNotify.problem = ""; return; }
  var p = String(f.problem || "选择器不可用");
  if (p === mmChatroomToolsNotify.problem) return;
  mmChatroomToolsNotify.problem = p;
  mmToast("聊天室工具：find_tools 暂不可用 — " + p, "err");
}
/** 聊天室 Telegram 接收状态通知（与通道「连接中」相同：后台轮询即可，不依赖设置页打开）。 */
function maybeToastChatroomTg(tgs, enabled) {
  tgs = tgs || {};
  if (!enabled) {
    if (mmChatroomTgNotify.kind === "pending") mmWaitClear("chatroom-tg", "intake");
    mmChatroomTgNotify.kind = "off";
    return;
  }
  var phase = tgs.phase || (tgs.error ? "error" : (tgs.ready ? "ready" : (tgs.ingest ? "waiting" : "off")));
  var detail = tgs.detail || tgs.error || "";
  var kind = (tgs.error || phase === "error") ? "error" : ((phase === "ready" || tgs.ready) ? "ready" : (tgs.ingest ? "pending" : "off"));
  if (kind === mmChatroomTgNotify.kind && kind !== "error") return;
  if (kind === "pending") {
    if (mmChatroomTgNotify.kind === "pending") {
      var wh = mmWaitHandleOf("chatroom-tg", "intake");
      if (wh && wh.setText) wh.setText("聊天室：Telegram 接收尚未就绪");
    } else {
      mmWaitShow("聊天室：Telegram 接收尚未就绪", "chatroom-tg", "intake");
    }
    mmChatroomTgNotify.kind = "pending";
    return;
  }
  if (mmChatroomTgNotify.kind === "pending") mmWaitClear("chatroom-tg", "intake");
  if (kind === "error") {
    var now = Date.now();
    if (mmChatroomTgNotify.kind !== "error" || now - mmChatroomTgNotify.errAt > 8000) {
      mmToast("聊天室：Telegram 接收失败 — " + (tgs.error || detail || "未知错误"), "err");
      mmChatroomTgNotify.errAt = now;
    }
    mmChatroomTgNotify.kind = "error";
    return;
  }
  if (kind === "ready" && mmChatroomTgNotify.kind !== "ready") {
    mmToast("聊天室：Telegram 接收已就绪" + (tgs.mode === "delegated" ? "（经通道共享轮询）" : ""), "ok");
  }
  mmChatroomTgNotify.kind = kind;
}
function maybeToastConn(c, state) {
  if (!c || !state) return;
  var prev = mmPrevConnState[c.id];
  var prevKind = prev === undefined ? null : mmConnKind(prev, null);
  var kind = mmConnKind(state, prevKind);
  mmPrevConnState[c.id] = state;
  if (prevKind === kind) return;
  if (prevKind === "pending" && kind !== "pending") mmWaitClear("conn", c.id);
  if (kind === "idle") return;
  if (kind === "down" && (prevKind === "idle" || prevKind == null)) return;
  if (prev === undefined && kind !== "pending") return;
  var now = Date.now();
  var flap = !!prevKind && (prevKind === "up" || prevKind === "down") && (kind === "up" || kind === "down");
  if (flap && (mmConnToastAt[c.id] || 0) + 2500 > now) return;
  mmConnToastAt[c.id] = now;
  var name = c.label || c.id;
  if (kind === "up") mmToast(name + " 已连接", "ok");
  else if (kind === "pending") mmWaitShow(name + " 正在连接", "conn", c.id);
  else mmToast(name + " 已断开连接", "info");
}

function mmShowUpdateAvailableToast(info) {
  var ver = "";
  if (info) {
    if (info.installKind === "git") {
      ver = info.displayVersion || (info.behind ? ((info.latestSubject || info.remote || "新提交") + "（落后 " + info.behind + "）") : (info.latestVersion || ""));
    } else {
      ver = info.latestVersion || info.displayVersion || "";
    }
  }
  return mmToast("发现新版本 " + ver, "info", {
    id: "mm-update",
    persistent: true,
    actions: [
      {
        label: "下载",
        primary: true,
        onClick: function (toastApi) {
          toastApi.dismiss();
          mmWaitShow("正在下载更新…", "update", "apply");
          var api = mmWaitApi("update", "apply");
          fetchJson("/update/apply", {
            method: "POST",
            body: JSON.stringify({ version: (info && (info.latestVersion || info.targetVersion)) || "" }),
          }).then(function () {
            // 设置页内的 pollUpdateJob 更完整；此处仅提示去设置页或轮询简版
            var ticks = 0;
            var t = setInterval(function () {
              ticks++;
              fetchJson("/update/status").then(function (d) {
                var job = (d && d.job) || {};
                if (job.progress != null && job.mode !== "indeterminate") api.setProgress(Number(job.progress) || 0);
                if (job.step) api.setText(job.step);
                if (job.state === "done") {
                  clearInterval(t);
                  api.dismiss();
                  mmToast(job.message || "更新完成，重启 DeepSeek Harness 后生效", "ok");
                } else if (job.state === "error") {
                  clearInterval(t);
                  api.dismiss();
                  mmToast("更新失败：" + (job.error || job.message || "未知错误"), "err");
                }
              }).catch(function () {});
              if (ticks > 600) { clearInterval(t); api.dismiss(); }
            }, 700);
          }).catch(function (e) {
            mmToast("更新失败：" + (e.message || e), "err");
            api.dismiss();
          });
        },
      },
      {
        label: "忽略",
        onClick: function (api) {
          var v = (info && (info.latestVersion || info.targetVersion)) || "";
          fetchJson("/update/ignore", { method: "POST", body: JSON.stringify({ version: v }) }).then(function () {
            api.dismiss();
            mmToast("已忽略版本 " + (ver || v), "info");
          }).catch(function (e) {
            mmToast("忽略失败：" + (e.message || e), "err");
          });
        },
      },
    ],
  });
}

function runStartupUpdateCheck() {
  mmWaitShow("正在检查更新", "update", "check");
  return fetchJson("/update/check").then(function (info) {
    if (info && info.skipped) {
      var h = mmWaitHandleOf("update", "check");
      if (h) { try { h.setText("今日已检查更新"); h.setProgress("none"); } catch (e0) {} }
      return mmWaitClear("update", "check", { minMs: 900 }).then(function () { return info; });
    }
    return mmWaitClear("update", "check", { minMs: 600 }).then(function () {
      if (!info || info.ok === false) {
        var err = (info && info.error) || "检查更新失败";
        if (/not found|404/i.test(String(err))) {
          mmToast("更新检查暂不可用：请重启 DeepSeek Harness 后再生效", "info");
        } else {
          mmToast(err, "err");
        }
        return info;
      }
      if (info.updateAvailable && info.prompt) {
        mmShowUpdateAvailableToast(info);
      } else if (!info.updateAvailable) {
        mmToast(info.message || "已是最新版本", "ok");
      }
      return info;
    });
  }).catch(function (e) {
    return mmWaitClear("update", "check").then(function () {
      var msg = e && e.message ? String(e.message) : String(e);
      if (/not found|404|Failed to fetch|NetworkError/i.test(msg) || (e && e.status === 404)) {
        mmToast("更新检查暂不可用：请重新打开本页；若仍失败，请重启 DeepSeek Harness 后再试", "info");
      } else {
        mmToast("检查更新失败：" + msg, "err");
      }
    });
  });
}

var mmBgWatch = mmGlobal.bgWatch;
function startMmBackgroundWatch() {
  if (mmBgWatch.started) return;
  mmBgWatch.started = true;
  try { mmToast._ensure(); } catch (e) {}
  function tick() {
    fetchJson("/components").then(function (d) {
      if (!d || !d.ok || !Array.isArray(d.components)) return;
      d.components.forEach(function (c) {
        if (c.connection) maybeToastConn(c, c.connection.state);
        else maybeToastConn(c, c.status);
      });
    }).catch(function () { /* 后台容错 */ });
    // 聊天室 Telegram：与通道「连接中」一样后台轮询，不依赖设置页 / 悬浮窗打开
    fetchJson("/chatroom").then(function (body) {
      if (!body || body.ok === false) return;
      var enabled = !!body.enabled;
      var tgs = body.telegram || {};
      maybeToastChatroomTg(tgs, enabled);
      maybeToastChatroomTools(body.tools, enabled);
    }).catch(function () { /* 后台容错 */ });
    // Telegram 未授权私聊：新账号首次出现时通知一次（不依赖设置页打开）
    fetchJson("/telegram/dm-pending").then(function (body) { maybeToastTelegramDm(body); }).catch(function () { /* 后台容错 */ });
    // QQ 未授权私聊/群聊：新条目首次出现时通知一次（不依赖设置页打开）
    fetchJson("/qq/pending").then(function (body) { maybeToastQQPending(body); }).catch(function () { /* 后台容错 */ });
  }
  tick();
  mmBgWatch.timer = setInterval(tick, 5000);
  setTimeout(function () { runStartupUpdateCheck(); }, 700);
}


// ── 「笔记」设置页面板：三级树（类型 › 类别 › 笔记），浏览、查看、编辑、删除。弹窗沿用 dsw-sc-modal，不用原生对话框与原生下拉。──
var NOTES_CSS_TAG = "dsh-workbench-notes";
var NOTES_CSS = [
  ".nt-panel{margin-top:12px;display:flex;flex-direction:column;gap:10px}",
  ".nt-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".nt-bar .mm-input{flex:1 1 180px;min-width:0}",
  ".nt-tree{border:1px solid var(--mm-border);border-radius:8px;overflow:hidden}",
  ".nt-empty{padding:14px;color:var(--mm-muted);font-size:12px}",
  ".nt-row{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:12px;min-height:22px}",
  ".nt-row+.nt-row{border-top:1px solid var(--mm-border)}",
  ".nt-row:hover{background:var(--mm-hover)}",
  ".nt-row.nt-l2{padding-left:28px}",
  ".nt-row.nt-l3{padding-left:48px}",
  ".nt-tw{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--mm-muted);cursor:pointer;border-radius:4px;font-size:10px;padding:0}",
  ".nt-tw:hover{background:var(--mm-hover);color:var(--mm-fg)}",
  ".nt-tw:focus-visible,.nt-act:focus-visible,.nt-name:focus-visible{outline:2px solid var(--mm-accent);outline-offset:1px}",
  ".nt-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}",
  ".nt-name{width:100%;min-width:0;display:flex;gap:8px;align-items:baseline;border:none;background:transparent;color:inherit;font:inherit;text-align:left;padding:0;cursor:pointer}",
  ".nt-name b{flex:0 1 auto;min-width:0;max-width:100%;font-weight:600;white-space:normal;overflow-wrap:anywhere}",
  ".nt-name span{flex:1 1 0;color:var(--mm-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
  ".nt-tags{display:flex;flex-wrap:wrap;gap:4px;min-width:0}",
  ".nt-count{flex:none;color:var(--mm-muted);font-size:11px}",
  ".nt-acts{flex:none;display:flex;gap:2px;opacity:.75}",
  ".nt-row:hover .nt-acts,.nt-row:focus-within .nt-acts{opacity:1}",
  ".nt-act{border:none;background:transparent;color:var(--mm-muted);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px}",
  ".nt-act:hover{background:var(--mm-hover);color:var(--mm-fg)}",
  ".nt-act.nt-danger:hover{color:var(--dsw-alias-state-error,#d14343)}",
  ".nt-tag{flex:none;display:inline-block;box-sizing:border-box;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:18px;padding:0 6px;border-radius:999px;border:1px solid var(--mm-border);font-size:11px;color:var(--mm-muted)}",
  ".nt-form{display:flex;flex-direction:column;gap:12px;padding:0 24px;max-height:60vh;overflow:auto}",
  ".nt-form label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dsw-alias-label-primary)}",
  ".nt-form .nt-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".nt-in{box-sizing:border-box;width:100%;font:inherit;font-size:13px;padding:7px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit)}",
  ".nt-in:focus{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-button-primary-fill,#4d6bfe));outline-offset:-1px}",
  "textarea.nt-in{min-height:160px;resize:vertical;line-height:1.6}",
  ".nt-sel{position:relative}",
  ".nt-sel-trigger{display:flex;justify-content:space-between;align-items:center;gap:8px;text-align:left;cursor:pointer}",
  ".nt-sel-trigger::after{content:'\\25BE';color:var(--dsw-alias-label-secondary);font-size:11px}",
  ".nt-sel-menu{position:absolute;z-index:5;left:0;right:0;top:calc(100% + 4px);max-height:220px;overflow:auto;padding:4px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2,Canvas));box-shadow:0 6px 24px rgba(0,0,0,.18)}",
  ".nt-sel-menu[hidden]{display:none!important}",
  ".nt-sel-opt{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;padding:6px 8px;border-radius:6px;cursor:pointer}",
  ".nt-sel-opt:hover,.nt-sel-opt:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));outline:none}",
  ".nt-sel-opt[aria-selected=true]{font-weight:600}",
  ".nt-view{margin:0;padding:0 24px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto}",
  ".nt-meta{padding:0 24px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".nt-err{padding:0 24px;font-size:12px;color:var(--dsw-alias-state-error,#d14343);min-height:0}",
  ".nt-err:empty{display:none}"
].join("\n");

function notesEnsureCss() {
  if (typeof document === "undefined") return;
  if (!document.querySelector('style[data-plugin-css="' + SC_CSS_TAG + '"]')) {
    var sc = document.createElement("style");
    sc.dataset.plugin = "dsh-workbench";
    sc.dataset.pluginCss = SC_CSS_TAG;
    sc.textContent = SC_CSS;
    document.head.appendChild(sc);
  }
  if (!document.querySelector('style[data-plugin-css="' + NOTES_CSS_TAG + '"]')) {
    var st = document.createElement("style");
    st.dataset.plugin = "dsh-workbench";
    st.dataset.pluginCss = NOTES_CSS_TAG;
    st.textContent = NOTES_CSS;
    document.head.appendChild(st);
  }
}

function notesJson(path, init) {
  return fetchJson(path, init).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "笔记请求失败");
    return body;
  });
}

function notesFormatTime(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  function p(n) { return n < 10 ? "0" + n : String(n); }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 自绘下拉（主题色），返回 { root, get, set }。 */
function notesSelect(options, value, onChange) {
  var root = el("div", "nt-sel");
  var trigger = el("button", "nt-in nt-sel-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  var label = el("span");
  trigger.append(label);
  var menu = el("div", "nt-sel-menu");
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  var current = value || (options[0] && options[0].value) || "";
  var items = [];
  function sync() {
    var found = options.filter(function (o) { return o.value === current; })[0];
    label.textContent = found ? found.label : "请选择";
    items.forEach(function (it) { it.el.setAttribute("aria-selected", it.value === current ? "true" : "false"); });
  }
  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDoc, true);
  }
  function onDoc(e) { if (!root.contains(e.target)) close(); }
  trigger.addEventListener("click", function () {
    if (!menu.hidden) { close(); return; }
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onDoc, true);
    var sel = menu.querySelector('[aria-selected="true"]') || menu.querySelector(".nt-sel-opt");
    if (sel) try { sel.focus(); } catch (_) {}
  });
  menu.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); }
  });
  options.forEach(function (o) {
    var b = el("button", "nt-sel-opt", o.label);
    b.type = "button";
    b.setAttribute("role", "option");
    if (o.title) b.title = o.title;
    b.addEventListener("click", function () { var was = current; current = o.value; sync(); close(); trigger.focus(); if (onChange && was !== current) onChange(current); });
    menu.append(b);
    items.push({ value: o.value, el: b });
  });
  root.append(trigger, menu);
  sync();
  return { root: root, focusEl: trigger, get: function () { return current; } };
}

/**
 * 表单弹窗。fields: [{ key, label, type: "text"|"textarea"|"select", value, options, placeholder, hint }]
 * onSubmit(values) 返回 Promise；失败时在弹窗内显示错误，不关闭。只读查看时 fields 为空并传 view。
 */
function notesDialog(opts) {
  notesEnsureCss();
  return new Promise(function (resolve) {
    var restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    var root = el("div", "dsw-sc-modal");
    root.setAttribute("role", "presentation");
    var mask = el("div", "dsw-sc-modal-mask");
    mask.setAttribute("aria-hidden", "true");
    var dialog = el("div", "dsw-sc-modal-dialog");
    dialog.tabIndex = -1;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "nt-dialog-title");
    dialog.style.width = "min(560px, calc(100vw - 32px))";
    dialog.style.maxWidth = "none";
    var header = el("div", "dsw-sc-modal-header");
    var title = el("h2", "dsw-sc-modal-title", opts.title);
    title.id = "nt-dialog-title";
    var closeBtn = el("button", "dsw-sc-modal-close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.innerHTML = SC_CLOSE_ICON;
    header.append(title, closeBtn);
    dialog.append(header);
    var getters = {};
    var firstFocus = null;
    if (opts.view) {
      if (opts.meta) dialog.append(el("div", "nt-meta", opts.meta));
      dialog.append(el("pre", "nt-view", opts.view));
    }
    if (opts.fields && opts.fields.length) {
      var form = el("div", "nt-form");
      opts.fields.forEach(function (f) {
        var wrap = el("label");
        var cap = el("span", null, f.label);
        wrap.append(cap);
        var control;
        if (f.type === "select") {
          var s = notesSelect(f.options || [], f.value);
          wrap = el("div");
          wrap.style.display = "flex";
          wrap.style.flexDirection = "column";
          wrap.style.gap = "4px";
          wrap.style.fontSize = "13px";
          wrap.append(cap, s.root);
          getters[f.key] = s.get;
          control = s.focusEl;
        } else if (f.type === "checks") {
          // 多选（复选框列表）：值为所选 value 的数组；disabled 的选项不可选。
          wrap = el("div");
          wrap.style.display = "flex";
          wrap.style.flexDirection = "column";
          wrap.style.gap = "4px";
          wrap.style.fontSize = "13px";
          wrap.append(cap);
          var boxes = [];
          (f.options || []).forEach(function (o) {
            var line = el("label");
            line.style.display = "flex";
            line.style.gap = "6px";
            line.style.alignItems = "center";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = o.value;
            cb.disabled = !!o.disabled;
            cb.checked = !!o.checked && !o.disabled;
            line.append(cb, el("span", null, o.label));
            wrap.append(line);
            boxes.push(cb);
          });
          getters[f.key] = (function (list) { return function () { return list.filter(function (c) { return c.checked && !c.disabled; }).map(function (c) { return c.value; }); }; })(boxes);
          control = boxes.filter(function (c) { return !c.disabled; })[0] || null;
        } else {
          control = el(f.type === "textarea" ? "textarea" : "input", "nt-in");
          if (f.type !== "textarea") control.type = f.type === "password" ? "password" : "text";
          if (f.type === "password") control.autocomplete = "new-password";
          control.value = f.value || "";
          if (f.placeholder) control.placeholder = f.placeholder;
          if (f.maxLength) control.maxLength = f.maxLength;
          wrap.append(control);
          getters[f.key] = (function (c) { return function () { return c.value; }; })(control);
        }
        if (f.hint) wrap.append(el("span", "nt-hint", f.hint));
        if (!firstFocus) firstFocus = control;
        form.append(wrap);
      });
      dialog.append(form);
    }
    var err = el("div", "nt-err");
    err.setAttribute("role", "alert");
    dialog.append(err);
    var footer = el("div", "dsw-sc-modal-footer");
    (opts.extraButtons || []).forEach(function (b) {
      var x = el("button", "dsw-sc-modal-btn dsw-sc-modal-btn-outline", b.label);
      x.type = "button";
      x.style.marginRight = "auto";
      x.addEventListener("click", function () { finish(null); b.onClick(); });
      footer.append(x);
    });
    var cancelBtn = el("button", "dsw-sc-modal-btn dsw-sc-modal-btn-outline", opts.cancelText || "取消");
    cancelBtn.type = "button";
    var okBtn = el("button", "dsw-sc-modal-btn dsw-sc-modal-btn-primary", opts.okText || "保存");
    okBtn.type = "button";
    if (!opts.alert) footer.append(cancelBtn);
    footer.append(okBtn);
    dialog.append(footer);
    root.append(mask, dialog);
    var settled = false;
    function finish(v) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      if (root.parentNode) root.parentNode.removeChild(root);
      resolve(v);
      if (restore && restore.isConnected) restore.focus();
    }
    function onKey(ev) {
      if (ev.key === "Escape") {
        if (dialog.querySelector('.nt-sel-menu:not([hidden])')) return;
        ev.preventDefault(); ev.stopPropagation(); finish(null); return;
      }
      if (ev.key !== "Tab") return;
      var list = Array.prototype.filter.call(dialog.querySelectorAll("button,input,textarea"), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!list.length) return;
      var i = list.indexOf(document.activeElement);
      ev.preventDefault();
      list[(i < 0 ? 0 : i + (ev.shiftKey ? list.length - 1 : 1)) % list.length].focus();
    }
    mask.addEventListener("click", function () { finish(null); });
    closeBtn.addEventListener("click", function () { finish(null); });
    cancelBtn.addEventListener("click", function () { finish(null); });
    okBtn.addEventListener("click", function () {
      var values = {};
      Object.keys(getters).forEach(function (k) { values[k] = getters[k](); });
      if (!opts.onSubmit) { finish(values); return; }
      okBtn.disabled = true;
      err.textContent = "";
      Promise.resolve(opts.onSubmit(values)).then(function (r) { finish(r === undefined ? values : r); }).catch(function (e) {
        okBtn.disabled = false;
        err.textContent = (e && e.message) || String(e);
      });
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    (firstFocus || okBtn).focus();
  });
}


function stickersJson(path, init) {
  return fetchJson(path, init).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "表情包请求失败");
    return body;
  });
}

var STICKERS_CSS = [
  ".sk-wrap{display:flex;flex-direction:column;gap:12px;margin-top:8px}",
  ".sk-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
  ".sk-msg{font-size:12px;color:var(--mm-muted)}",
  ".sk-msg.ok{color:var(--mm-ok,#3a7)}",
  ".sk-msg.err{color:var(--mm-err,#c45)}",
  ".sk-packs{display:flex;flex-wrap:wrap;gap:6px}",
  ".sk-pack{border:1px solid var(--mm-border);background:var(--mm-card,transparent);border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}",
  ".sk-pack.on{border-color:var(--mm-accent,#6af);background:rgba(100,160,255,.12)}",
  ".sk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}",
  ".sk-card{border:1px solid var(--mm-border);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--mm-card,transparent)}",
  ".sk-card img{width:100%;aspect-ratio:1;object-fit:contain;border-radius:6px;background:rgba(0,0,0,.04)}",
  ".sk-meta{font-size:11px;color:var(--mm-muted);line-height:1.35;word-break:break-all}",
  ".sk-card .sk-actions{display:flex;flex-wrap:wrap;gap:4px}",
  ".sk-card button,.sk-bar button{font-size:12px}",
  ".sk-edit{display:flex;flex-direction:column;gap:6px;font-size:12px}",
  ".sk-edit input,.sk-edit textarea{width:100%;box-sizing:border-box}"
].join("\n");

function ensureStickersCss() {
  if (document.getElementById("dsh-stickers-css")) return;
  var st = document.createElement("style");
  st.id = "dsh-stickers-css";
  st.textContent = STICKERS_CSS;
  document.head.appendChild(st);
}

function buildStickersPanel(host) {
  ensureStickersCss();
  host.textContent = "";
  var wrap = el("div", "sk-wrap");
  host.append(wrap);
  var stats = el("div", "sk-msg");
  var msg = el("div", "sk-msg");
  var bar = el("div", "sk-bar");
  var packsRow = el("div", "sk-packs");
  var grid = el("div", "sk-grid");
  wrap.append(stats, bar, packsRow, msg, grid);

  var state = { packs: [], stickers: [], packId: "", busy: false };
  var fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif";
  fileInput.multiple = true;
  fileInput.style.display = "none";
  wrap.append(fileInput);

  function setMsg(text, cls) {
    msg.textContent = text || "";
    msg.className = "sk-msg" + (cls ? (" " + cls) : "");
  }

  function refresh() {
    return stickersJson("/stickers").then(function (body) {
      state.packs = body.packs || [];
      state.stickers = body.stickers || [];
      var st = body.stats || {};
      stats.textContent = "库内 " + (st.packs || 0) + " 包 · " + (st.stickers || 0) + " 张";
      if (!state.packId || !state.packs.some(function (p) { return p.id === state.packId; })) {
        state.packId = (state.packs[0] && state.packs[0].id) || "";
      }
      renderPacks();
      renderGrid();
    }).catch(function (e) {
      setMsg((e && e.message) || String(e), "err");
    });
  }

  function renderPacks() {
    packsRow.textContent = "";
    state.packs.forEach(function (p) {
      var b = el("button", "sk-pack" + (p.id === state.packId ? " on" : ""));
      b.type = "button";
      b.textContent = p.name + " (" + (p.stickers || 0) + ")";
      b.addEventListener("click", function () { state.packId = p.id; renderPacks(); renderGrid(); });
      packsRow.append(b);
    });
  }

  function renderGrid() {
    grid.textContent = "";
    var list = state.stickers.filter(function (s) { return !state.packId || s.packId === state.packId; });
    if (!list.length) {
      var empty = el("div", "sk-msg");
      empty.textContent = "这个包还没有贴纸。可点「导入图片」或让 AI 用 sticker_save。";
      grid.append(empty);
      return;
    }
    list.forEach(function (s) {
      var card = el("div", "sk-card");
      var img = el("img");
      img.alt = s.id;
      img.loading = "lazy";
      img.src = API + "/stickers/file/" + encodeURIComponent(s.id);
      var meta = el("div", "sk-meta");
      meta.textContent = (s.emoji ? s.emoji + " " : "") + (s.aliases && s.aliases.length ? s.aliases.join(", ") : s.id);
      if (s.tags && s.tags.length) meta.textContent += "\n#" + s.tags.join(" #");
      var actions = el("div", "sk-actions");
      var editBtn = el("button");
      editBtn.type = "button";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", function () { editSticker(s); });
      var delBtn = el("button");
      delBtn.type = "button";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", function () {
        if (!confirm("删除这张贴纸？")) return;
        stickersJson("/stickers/items/" + encodeURIComponent(s.id), { method: "DELETE" })
          .then(function () { setMsg("已删除", "ok"); return refresh(); })
          .catch(function (e) { setMsg((e && e.message) || String(e), "err"); });
      });
      actions.append(editBtn, delBtn);
      card.append(img, meta, actions);
      grid.append(card);
    });
  }

  function editSticker(s) {
    var tags = prompt("标签（逗号分隔）", (s.tags || []).join(", "));
    if (tags === null) return;
    var aliases = prompt("别名（逗号分隔）", (s.aliases || []).join(", "));
    if (aliases === null) return;
    var emoji = prompt("emoji（可选）", s.emoji || "");
    if (emoji === null) return;
    stickersJson("/stickers/items/" + encodeURIComponent(s.id), {
      method: "PUT",
      body: JSON.stringify({
        tags: tags.split(/[,，、\s]+/).filter(Boolean),
        aliases: aliases.split(/[,，、\s]+/).filter(Boolean),
        emoji: emoji
      })
    }).then(function () { setMsg("已更新", "ok"); return refresh(); })
      .catch(function (e) { setMsg((e && e.message) || String(e), "err"); });
  }

  function btn(label, onClick) {
    var b = el("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    bar.append(b);
    return b;
  }

  btn("刷新", function () { refresh(); });
  btn("新建包", function () {
    var name = prompt("新表情包名称");
    if (!name) return;
    stickersJson("/stickers/packs", { method: "POST", body: JSON.stringify({ name: name }) })
      .then(function (body) {
        setMsg("已创建包", "ok");
        if (body.pack) state.packId = body.pack.id;
        return refresh();
      })
      .catch(function (e) { setMsg((e && e.message) || String(e), "err"); });
  });
  btn("重命名包", function () {
    var p = state.packs.filter(function (x) { return x.id === state.packId; })[0];
    if (!p) return;
    var name = prompt("包名称", p.name);
    if (!name) return;
    stickersJson("/stickers/packs/" + encodeURIComponent(p.id), { method: "PUT", body: JSON.stringify({ name: name }) })
      .then(function () { setMsg("已重命名", "ok"); return refresh(); })
      .catch(function (e) { setMsg((e && e.message) || String(e), "err"); });
  });
  btn("删除包", function () {
    var p = state.packs.filter(function (x) { return x.id === state.packId; })[0];
    if (!p) return;
    if (!confirm("删除包「" + p.name + "」及其全部贴纸？")) return;
    stickersJson("/stickers/packs/" + encodeURIComponent(p.id), { method: "DELETE" })
      .then(function () { state.packId = ""; setMsg("已删除包", "ok"); return refresh(); })
      .catch(function (e) { setMsg((e && e.message) || String(e), "err"); });
  });
  btn("导入图片", function () { fileInput.click(); });
  btn("清空最近缓冲", function () {
    if (!confirm("清空所有会话的最近入站图片缓冲？")) return;
    stickersJson("/stickers/recent", { method: "DELETE", body: JSON.stringify({ sessionId: "*" }) })
      .then(function () { setMsg("已清空最近缓冲", "ok"); })
      .catch(function (e) { setMsg((e && e.message) || String(e), "err"); });
  });

  fileInput.addEventListener("change", function () {
    var files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = "";
    if (!files.length) return;
    setMsg("正在导入 " + files.length + " 张…");
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            var dataUrl = String(reader.result || "");
            stickersJson("/stickers/items", {
              method: "POST",
              body: JSON.stringify({
                base64: dataUrl,
                mediaType: file.type || undefined,
                originalName: file.name,
                pack: state.packId || undefined
              })
            }).then(resolve, reject);
          };
          reader.onerror = function () { reject(new Error("读取文件失败")); };
          reader.readAsDataURL(file);
        });
      });
    });
    chain.then(function () { setMsg("导入完成", "ok"); return refresh(); })
      .catch(function (e) { setMsg((e && e.message) || String(e), "err"); return refresh(); });
  });

  refresh();
}


function buildNotesPanel(host) {
  notesEnsureCss();
  var panel = el("div", "nt-panel");
  var bar = el("div", "nt-bar");
  var q = el("input", "mm-input");
  q.type = "search";
  q.placeholder = "搜索笔记标题、内容或标签";
  q.setAttribute("aria-label", "搜索笔记");
  var addType = el("button", "mm-btn mm-ghost", "新建类型");
  addType.type = "button";
  var addNote = el("button", "mm-btn", "新建笔记");
  addNote.type = "button";
  bar.append(q, addType, addNote);
  var tree = el("div", "nt-tree");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "笔记");
  panel.append(bar, tree);
  host.append(panel);

  var data = { categories: [], notes: [] };
  var open = {};
  var loaded = false;

  function applyTree(t) { if (t) data = { categories: t.categories || [], notes: t.notes || [] }; render(); }
  function reload() {
    return notesJson("/notes").then(function (b) { loaded = true; applyTree(b.tree); }).catch(function (e) {
      tree.textContent = "";
      tree.append(el("div", "nt-empty", "笔记读取失败：" + ((e && e.message) || e)));
    });
  }
  function level1() { return data.categories.filter(function (c) { return c.level === 1; }); }
  function childrenOf(id) { return data.categories.filter(function (c) { return c.parentId === id; }); }
  function notesOf(id) {
    return data.notes.filter(function (n) { return n.categoryId === id; })
      .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  }
  function level2Options() {
    var out = [];
    level1().forEach(function (p) { childrenOf(p.id).forEach(function (c) { out.push({ value: c.id, label: p.name + " › " + c.name }); }); });
    return out;
  }

  function act(label, fn, danger) {
    var b = el("button", "nt-act" + (danger ? " nt-danger" : ""), label);
    b.type = "button";
    b.addEventListener("click", function (e) { e.stopPropagation(); fn(); });
    return b;
  }
  function row(levelCls, opts) {
    var r = el("div", "nt-row " + levelCls);
    r.setAttribute("role", "treeitem");
    if (opts.expanded !== undefined) r.setAttribute("aria-expanded", opts.expanded ? "true" : "false");
    var tw = el("button", "nt-tw", opts.expanded === undefined ? "" : (opts.expanded ? "\u25BE" : "\u25B8"));
    tw.type = "button";
    if (opts.expanded === undefined) { tw.style.visibility = "hidden"; tw.tabIndex = -1; }
    else { tw.setAttribute("aria-label", opts.expanded ? "收起" : "展开"); tw.addEventListener("click", opts.onToggle); }
    var name = el("button", "nt-name");
    name.type = "button";
    name.append(el("b", null, opts.name));
    if (opts.sub) name.append(el("span", null, opts.sub));
    name.addEventListener("click", opts.onOpen || opts.onToggle);
    var main = el("div", "nt-main");
    main.append(name);
    if (opts.tags && opts.tags.length) {
      var tags = el("div", "nt-tags");
      opts.tags.forEach(function (t) { var chip = el("span", "nt-tag", t); chip.title = t; tags.append(chip); });
      main.append(tags);
    }
    r.append(tw, main);
    if (opts.count) r.append(el("span", "nt-count", opts.count));
    var acts = el("div", "nt-acts");
    opts.actions.forEach(function (a) { acts.append(a); });
    r.append(acts);
    return r;
  }
  function noteRow(n, levelCls) {
    return row(levelCls, {
      name: n.title,
      sub: q.value.trim() ? (n.path + " · " + n.summary) : n.summary,
      tags: n.tags,
      onOpen: function () { viewNote(n.id); },
      actions: [act("编辑", function () { editNote(n.id); }), act("删除", function () { removeNote(n); }, true)]
    });
  }

  function render() {
    tree.textContent = "";
    var words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      var hits = data.notes.filter(function (n) {
        var hay = [n.title, n.summary, n.path, (n.tags || []).join(" ")].join("\n").toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
      if (!hits.length) { tree.append(el("div", "nt-empty", "没有匹配的笔记。列表仅按标题、摘要、类别与标签筛选。")); return; }
      hits.forEach(function (n) { tree.append(noteRow(n, "nt-l1")); });
      return;
    }
    var tops = level1();
    if (!tops.length) {
      tree.append(el("div", "nt-empty", loaded ? "暂无笔记。可先新建知识点类型（如「知识」「技巧」「规则」），再在其下建立细分类别并记录笔记；启用后，智能体也会通过笔记工具自行整理。" : "正在读取…"));
      return;
    }
    tops.forEach(function (p) {
      var isOpen = open[p.id] !== false;
      tree.append(row("nt-l1", {
        name: p.name, sub: p.description || "", expanded: isOpen,
        count: p.subcategories + " 个类别 · " + p.notes + " 条笔记",
        onToggle: function () { open[p.id] = !isOpen; render(); },
        actions: [
          act("新建类别", function () { editCategory(null, p); }),
          act("重命名", function () { editCategory(p); }),
          act("删除", function () { removeCategory(p); }, true)
        ]
      }));
      if (!isOpen) return;
      childrenOf(p.id).forEach(function (c) {
        var cOpen = open[c.id] === true;
        tree.append(row("nt-l2", {
          name: c.name, sub: c.description || "", expanded: cOpen,
          count: c.notes + " 条笔记",
          onToggle: function () { open[c.id] = !cOpen; render(); },
          actions: [
            act("新建笔记", function () { editNote(null, c.id); }),
            act("重命名", function () { editCategory(c); }),
            act("删除", function () { removeCategory(c); }, true)
          ]
        }));
        if (!cOpen) return;
        notesOf(c.id).forEach(function (n) { tree.append(noteRow(n, "nt-l3")); });
      });
    });
  }

  function editCategory(cat, parent) {
    var isNew = !cat;
    var lvl1 = isNew ? !parent : cat.level === 1;
    notesDialog({
      title: isNew ? (lvl1 ? "新建知识点类型" : "在「" + parent.name + "」下新建类别") : "重命名类别",
      okText: isNew ? "创建" : "保存",
      fields: [
        { key: "name", label: "名称", value: cat ? cat.name : "", maxLength: 40, placeholder: lvl1 ? "例如 知识、技巧、规则" : "例如 数学" },
        { key: "description", label: "说明（可选）", value: cat ? (cat.description || "") : "", maxLength: 200 }
      ],
      onSubmit: function (v) {
        var payload = { name: v.name, description: v.description };
        if (isNew && parent) payload.parentId = parent.id;
        return notesJson(isNew ? "/notes/categories" : "/notes/categories/" + encodeURIComponent(cat.id), {
          method: isNew ? "POST" : "PUT", body: JSON.stringify(payload)
        }).then(function (b) {
          if (parent) open[parent.id] = true;
          applyTree(b.tree);
          mmToast(isNew ? "类别已创建" : "类别已保存", "ok");
        });
      }
    });
  }

  function removeCategory(cat) {
    var body = cat.notes > 0
      ? "该类别下仍有 " + cat.notes + " 条笔记" + (cat.subcategories ? "（分布在 " + cat.subcategories + " 个子类别中）" : "") + "，删除后将一并删除，且无法恢复。"
      : (cat.subcategories ? "将同时删除其下 " + cat.subcategories + " 个空类别。" : "该类别为空，删除后无法恢复。");
    scConfirm("删除「" + cat.path + "」？", { title: "删除「" + cat.path + "」", body: body, okText: "删除", cancelText: "保留" }).then(function (ok) {
      if (!ok) return;
      notesJson("/notes/categories/" + encodeURIComponent(cat.id) + (cat.notes > 0 ? "?confirm=1" : ""), { method: "DELETE" }).then(function (b) {
        applyTree(b.tree);
        mmToast(b.deleted === false ? "类别下仍有笔记，未删除" : "类别已删除", b.deleted === false ? "info" : "ok");
      }).catch(function (e) { mmToast("删除失败：" + ((e && e.message) || e), "err"); });
    });
  }

  function viewNote(id) {
    notesJson("/notes/items/" + encodeURIComponent(id)).then(function (b) {
      var n = b.note;
      notesDialog({
        title: n.title,
        meta: n.path + (n.tags && n.tags.length ? " · 标签：" + n.tags.join("、") : "") + " · 创建于 " + notesFormatTime(n.createdAt) + " · 更新于 " + notesFormatTime(n.updatedAt),
        view: n.content,
        alert: true,
        okText: "关闭",
        extraButtons: [{ label: "编辑", onClick: function () { editNote(n.id); } }]
      });
    }).catch(function (e) { mmToast("读取笔记失败：" + ((e && e.message) || e), "err"); });
  }

  function editNote(id, categoryId) {
    var opts = level2Options();
    if (!opts.length) {
      scAlert("尚无可用的类别", "笔记须放在第二级类别下。请先新建知识点类型，再在其下新建类别。");
      return;
    }
    var start = id ? notesJson("/notes/items/" + encodeURIComponent(id)).then(function (b) { return b.note; }) : Promise.resolve(null);
    start.then(function (n) {
      notesDialog({
        title: n ? "编辑笔记" : "新建笔记",
        okText: n ? "保存" : "创建",
        fields: [
          { key: "categoryId", label: "类别", type: "select", options: opts, value: n ? n.categoryId : (categoryId || opts[0].value) },
          { key: "title", label: "标题", value: n ? n.title : "", maxLength: 80 },
          { key: "content", label: "要点", type: "textarea", value: n ? n.content : "", maxLength: 8000, hint: "建议分条书写，只记已验证、可复用的内容。" },
          { key: "tags", label: "标签（可选）", value: n ? (n.tags || []).join("，") : "", placeholder: "以逗号分隔" }
        ],
        onSubmit: function (v) {
          var payload = {
            categoryId: v.categoryId, title: v.title, content: v.content,
            tags: String(v.tags || "").split(/[,，、\s]+/).filter(Boolean)
          };
          return notesJson(n ? "/notes/items/" + encodeURIComponent(n.id) : "/notes/items", {
            method: n ? "PUT" : "POST", body: JSON.stringify(payload)
          }).then(function (b) {
            var cat = data.categories.filter(function (c) { return c.id === payload.categoryId; })[0];
            open[payload.categoryId] = true;
            if (cat && cat.parentId) open[cat.parentId] = true;
            applyTree(b.tree);
            mmToast(n ? "笔记已保存" : "笔记已创建", "ok");
          });
        }
      });
    }).catch(function (e) { mmToast("读取笔记失败：" + ((e && e.message) || e), "err"); });
  }

  function removeNote(n) {
    scConfirm("删除笔记「" + n.title + "」？", { title: "删除笔记", body: "将删除「" + n.title + "」，删除后无法恢复。", okText: "删除", cancelText: "保留" }).then(function (ok) {
      if (!ok) return;
      notesJson("/notes/items/" + encodeURIComponent(n.id), { method: "DELETE" }).then(function (b) {
        applyTree(b.tree);
        mmToast("笔记已删除", "ok");
      }).catch(function (e) { mmToast("删除失败：" + ((e && e.message) || e), "err"); });
    });
  }

  addType.addEventListener("click", function () { editCategory(null, null); });
  addNote.addEventListener("click", function () { editNote(null); });
  q.addEventListener("input", render);
  render();
  reload();
  return { reload: reload };
}

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

// DSH 智能体预设（GET /dsh/presets → ctx.agentPresets.list()），供 Telegram 机器人与聊天室席位共用。
var dshPresetsPromise = null;
function dshPresets(force) {
  if (!dshPresetsPromise || force) {
    dshPresetsPromise = fetchJson("/dsh/presets").then(function (b) { return b && b.ok ? b : { available: false, presets: [] }; }, function () { dshPresetsPromise = null; return { available: false, presets: [] }; });
  }
  return dshPresetsPromise;
}
function dshPresetLabel(p, defaultId) {
  return (p.name && p.name !== p.id ? p.name + "（" + p.id + "）" : p.id) + (p.id === defaultId ? " · 默认" : "") + (p.broken ? " · 不可用" : "");
}
function dshPresetOptions(emptyLabel) {
  return dshPresets().then(function (b) {
    if (!b.available) return null;
    return [{ value: "", label: emptyLabel }].concat(b.presets.map(function (p) { return { value: p.id, label: dshPresetLabel(p, b.defaultId) }; }));
  });
}

function telegramBotsJson(path, init) {
  return fetchJson(path, init).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "机器人请求失败");
    return body;
  });
}

function dshCatalogJson(path) {
  return fetchJson(path).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "目录请求失败");
    return body;
  });
}

/** 服务商 / 模型 / 推理强度。Telegram 机器人与聊天室席位共用，不依赖聊天室是否启用。 */
function loadModelChooser(provider, model) {
  var effortsP = provider && model
    ? dshCatalogJson("/dsh/efforts?provider=" + encodeURIComponent(provider) + "&model=" + encodeURIComponent(model)).catch(function () { return { efforts: [] }; })
    : Promise.resolve({ efforts: [] });
  return Promise.all([dshCatalogJson("/dsh/llm-catalog"), dshPresets(true), effortsP]);
}

function modelRouteOptions(cat, current) {
  var routes = [];
  ((cat && cat.providers) || []).forEach(function (p) {
    (p.models || []).forEach(function (m) {
      routes.push({ value: p.id + "\u0000" + m.id, label: (p.name || p.id) + " · " + (m.name || m.id), title: p.id + " / " + m.id });
    });
  });
  var provider = current && current.provider;
  var model = current && current.model;
  if (provider && model) {
    var cur = provider + "\u0000" + model;
    if (!routes.some(function (o) { return o.value === cur; })) {
      routes.unshift({ value: cur, label: (current.providerName || provider) + " · " + (current.modelName || model) + "（当前不可用）" });
    }
  }
  return routes;
}

function effortSelectOptions(eff, current) {
  var effortOpts = [{ value: "", label: "模型默认" + (eff && eff.defaultEffort ? "（" + eff.defaultEffort + "）" : "") }];
  ((eff && eff.efforts) || []).forEach(function (e) {
    effortOpts.push({ value: e.id, label: e.name && e.name !== e.id ? e.name + "（" + e.id + "）" : e.id });
  });
  if (current && !effortOpts.some(function (o) { return o.value === current; })) effortOpts.push({ value: current, label: current });
  return effortOpts;
}

function fillSelect(select, options, value) {
  select.textContent = "";
  options.forEach(function (o) {
    var opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.title) opt.title = o.title;
    select.append(opt);
  });
  if (value && options.some(function (o) { return o.value === value; })) select.value = value;
  else if (options.length) select.value = options[0].value;
}

/** 通道页下方：机器人表格，选中一行后在下方编辑该机器人。 */
// ── Telegram 未授权私聊：设置页名单 + 通知（与聊天室「发现的群聊」同一思路）。授权只能在本机设置页完成，没有任何聊天指令可以授权。──
var TGDM_CSS_TAG = "dsh-workbench-telegram-dm";
var TGDM_EVENT = "dsh-workbench:telegram-dm";
// 聊天室成员（AI）经房间控制工具改了默认主答 / 领队：把写入的设置片段合并进设置页缓存，之后保存其它设置时不会把它覆盖回去。
var ROOMCFG_EVENT = "dsh-workbench:chatroom-config";
var TGDM_SEEN_KEY = "dsh-workbench.telegramDmSeen";
var TGDM_CSS = [
  ".tgdm{margin-top:16px;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--mm-accent,#3b82f6);border-radius:8px}",
  ".tgdm[hidden]{display:none}",
  ".tgdm-title{font-size:13px;font-weight:600}",
  ".tgdm-warn{font-size:12px;line-height:1.5;padding:6px 8px;border-radius:6px;border:1px solid var(--mm-warn-border,#c9842a);background:rgba(201,132,42,.12);color:var(--mm-warn,#b45309)}",
  ".tgdm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".tgdm-row .mm-btn{padding:2px 10px;font-size:12px}",
  ".tgdm-main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:12px}",
  ".tgdm-name{font-weight:600;overflow-wrap:anywhere}",
  ".tgdm-sub{font-size:11px;color:var(--mm-muted);overflow-wrap:anywhere}",
  ".tgdm-preview{font-size:12px;color:var(--mm-fg,inherit);opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".tgdm-fold{align-self:flex-start;background:none;border:none;padding:0;color:var(--mm-muted);font-size:12px;cursor:pointer}",
  ".tgdm-fold:hover{color:var(--mm-fg,inherit)}",
  ".tgdm-hint{font-size:11px;line-height:1.5;color:var(--mm-muted)}"
].join("\n");

function tgdmEnsureCss() {
  if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="' + TGDM_CSS_TAG + '"]')) return;
  var st = document.createElement("style");
  st.dataset.plugin = "dsh-workbench";
  st.dataset.pluginCss = TGDM_CSS_TAG;
  st.textContent = TGDM_CSS;
  document.head.appendChild(st);
}
function tgdmJson(path, init) {
  return fetchJson(path, init).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "私聊名单请求失败");
    return body;
  });
}
function tgdmWho(u) {
  var parts = [];
  if (u && u.name) parts.push(u.name);
  if (u && u.username) parts.push("@" + u.username);
  return parts.join(" ") || ("用户 " + (u && u.userId));
}
function tgdmPublish(body) {
  try { window.dispatchEvent(new CustomEvent(TGDM_EVENT, { detail: body || {} })); } catch (e) { /* ignore */ }
  // 已处理的账号：收起它仍在显示的通知。
  try {
    var done = {};
    ((body && body.users) || []).forEach(function (u) { if (u.status !== "new") done["mm-tgdm-" + u.userId] = true; });
    (mmToast._items || []).slice().forEach(function (it) { if (it && it.key && done[it.key]) mmToast._dismiss(it.id); });
  } catch (e) { /* ignore */ }
}
function tgdmAuthorize(u) {
  return tgdmJson("/telegram/dm-pending/" + encodeURIComponent(u.userId) + "/authorize", { method: "POST", body: "{}" }).then(function (b) {
    tgdmPublish(b);
    mmToast("已授权 " + tgdmWho(u) + "（ID " + u.userId + "）私聊机器人", "ok");
    return b;
  });
}
function tgdmIgnore(u) {
  return tgdmJson("/telegram/dm-pending/" + encodeURIComponent(u.userId) + "/ignore", { method: "POST", body: "{}" }).then(function (b) {
    tgdmPublish(b);
    mmToast("已忽略 " + tgdmWho(u) + " 的私聊", "info");
    return b;
  });
}
function tgdmRemove(u) {
  return tgdmJson("/telegram/dm-pending/" + encodeURIComponent(u.userId) + "/remove", { method: "POST", body: "{}" }).then(function (b) {
    tgdmPublish(b);
    return b;
  });
}
var TGDM_AUTH_NOTE = "授权后，该账号可以私聊所有通道机器人（用户 ID 写入「允许的其他用户 ID」，删除即可撤销）。授权不包括使用会更改电脑的工具，该权限仍只属于「授权用户 ID」。";
function tgdmConfirmAuthorize(u) {
  return scConfirm("授权该账号私聊机器人？", {
    title: "授权私聊",
    body: tgdmWho(u) + "（ID " + u.userId + "）\n" + TGDM_AUTH_NOTE + "\n保存后通道会按新名单重新连接。",
    okText: "授权",
    cancelText: "取消"
  });
}

function tgdmSeenLoad() {
  try {
    var j = JSON.parse(window.localStorage.getItem(TGDM_SEEN_KEY) || "{}");
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return mmGlobal.tgdmSeenMem || (mmGlobal.tgdmSeenMem = {});
  }
}
function tgdmSeenSave(map) {
  try { window.localStorage.setItem(TGDM_SEEN_KEY, JSON.stringify(map)); } catch (e) { mmGlobal.tgdmSeenMem = map; }
}
function tgdmToastText(u) {
  var bot = u.lastBotLabel || u.lastBotName || u.lastBotId || "机器人";
  var lines = ["未授权的账号私聊了「" + bot + "」", tgdmWho(u) + "（ID " + u.userId + "）"];
  if (u.lastPreview) lines.push("「" + u.lastPreview + "」");
  return lines.join("\n");
}
function tgdmToast(u) {
  var text = tgdmToastText(u);
  var id = "mm-tgdm-" + u.userId;
  function first() {
    return [
      { label: "授权", primary: true, onClick: function (api) {
        api.setText("确认授权 " + tgdmWho(u) + "（ID " + u.userId + "）私聊机器人？\n" + TGDM_AUTH_NOTE);
        api.setActions(confirmActs());
      } },
      { label: "忽略", onClick: function (api) {
        tgdmIgnore(u).then(function () { api.dismiss(); }).catch(function (e) { mmToast("忽略失败：" + ((e && e.message) || e), "err"); });
      } }
    ];
  }
  function confirmActs() {
    return [
      { label: "确认授权", primary: true, onClick: function (api) {
        tgdmAuthorize(u).then(function () { api.dismiss(); }).catch(function (e) { mmToast("授权失败：" + ((e && e.message) || e), "err"); });
      } },
      { label: "取消", onClick: function (api) { api.setText(text); api.setActions(first()); } }
    ];
  }
  return mmToast(text, "info", { id: id, persistent: true, actions: first() });
}
/** 后台轮询：每个新出现的未授权账号只通知一次（记在 localStorage，跨窗口、跨重开有效），不按消息条数重复通知。 */
function maybeToastTelegramDm(body) {
  if (!body || body.ok === false || !Array.isArray(body.users)) return;
  var seen = tgdmSeenLoad();
  var next = {};
  var changed = false;
  body.users.forEach(function (u) {
    var key = String(u.userId) + "@" + String(u.firstSeen || "");
    if (seen[key]) { next[key] = seen[key]; return; }
    if (u.status !== "new") return;
    next[key] = Date.now();
    changed = true;
    tgdmToast(u);
  });
  if (changed || Object.keys(next).length !== Object.keys(seen).length) tgdmSeenSave(next);
}

/** 「通道 › Telegram」管理页里的未授权私聊名单。onAllowFrom(value)：授权后同步本页「允许的其他用户 ID」输入框与已读设置。 */
function buildTelegramDmPanel(host, onAllowFrom) {
  tgdmEnsureCss();
  var box = el("div", "tgdm");
  box.hidden = true;
  host.append(box);
  var showIgnored = false;
  var lastBody = null;
  var busy = false;
  var wasConnected = false;

  function act(btns, run) {
    if (busy) return;
    busy = true;
    btns.forEach(function (b) { b.disabled = true; });
    run().catch(function (e) { mmToast((e && e.message) || String(e), "err"); }).finally(function () {
      busy = false;
      btns.forEach(function (b) { if (b.isConnected) b.disabled = false; });
    });
  }
  function row(u, ignored) {
    var r = el("div", "tgdm-row");
    var main = el("div", "tgdm-main");
    main.append(el("span", "tgdm-name", tgdmWho(u)));
    var bits = ["ID " + u.userId];
    var bot = u.lastBotLabel || u.lastBotName || u.lastBotId;
    if (bot) bits.push("发给 " + bot);
    if (u.count > 1) bits.push("共 " + u.count + " 条");
    if (u.lastSeen) bits.push("最近 " + notesFormatTime(u.lastSeen));
    if (u.firstSeen && u.firstSeen !== u.lastSeen) bits.push("首次 " + notesFormatTime(u.firstSeen));
    main.append(el("span", "tgdm-sub", bits.join(" · ")));
    if (u.lastPreview) {
      var pv = el("span", "tgdm-preview", "「" + u.lastPreview + "」");
      pv.title = u.lastPreview;
      main.append(pv);
    }
    var auth = el("button", "mm-btn", "授权");
    var other = el("button", "mm-btn mm-ghost", ignored ? "删除记录" : "忽略");
    auth.type = other.type = "button";
    if (lastBody && !lastBody.ownerSet) { auth.disabled = true; auth.title = "请先填写并保存「所有者用户 ID」"; }
    auth.addEventListener("click", function () {
      if (busy) return;
      tgdmConfirmAuthorize(u).then(function (ok) {
        if (!ok) return;
        act([auth, other], function () { return tgdmAuthorize(u); });
      });
    });
    other.addEventListener("click", function () {
      if (ignored) {
        other.title = "删除后，该账号再次私聊时会重新出现并通知";
        act([auth, other], function () { return tgdmRemove(u); });
      } else act([auth, other], function () { return tgdmIgnore(u); });
    });
    if (ignored) other.title = "删除后，该账号再次私聊时会重新出现并通知";
    r.append(main, auth, other);
    return r;
  }
  function render(body) {
    lastBody = body || lastBody;
    if (!lastBody) return;
    if (typeof lastBody.allowFrom === "string" && typeof onAllowFrom === "function") {
      try { onAllowFrom(lastBody.allowFrom); } catch (e) { /* ignore */ }
    }
    var users = Array.isArray(lastBody.users) ? lastBody.users : [];
    var pending = users.filter(function (u) { return u.status === "new"; });
    var ignored = users.filter(function (u) { return u.status === "ignored"; });
    box.textContent = "";
    if (!pending.length && !ignored.length) { box.hidden = true; return; }
    box.hidden = false;
    box.append(el("div", "tgdm-title", pending.length ? "未授权的私聊（" + pending.length + "）" : "未授权的私聊"));
    if (!lastBody.ownerSet) box.append(el("div", "tgdm-warn", "尚未填写「所有者用户 ID」：通道不会按本页写入私聊白名单，授权不会生效。请先填写并保存。"));
    if (!pending.length) box.append(el("div", "tgdm-hint", "没有待处理的账号。"));
    pending.forEach(function (u) { box.append(row(u, false)); });
    if (ignored.length) {
      var fold = el("button", "tgdm-fold", (showIgnored ? "▾ " : "▸ ") + "已忽略（" + ignored.length + "）");
      fold.type = "button";
      fold.setAttribute("aria-expanded", showIgnored ? "true" : "false");
      fold.addEventListener("click", function () { showIgnored = !showIgnored; render(null); });
      box.append(fold);
      if (showIgnored) ignored.forEach(function (u) { box.append(row(u, true)); });
    }
    box.append(el("div", "tgdm-hint", "这些 Telegram 账号私聊了通道机器人，但不在私聊白名单里；机器人不会回复它们，也不会提示如何获得授权。" + TGDM_AUTH_NOTE + "授权只能在本页完成，任何聊天指令都不能授权。"));
  }
  function load() {
    if (busy) return;
    tgdmJson("/telegram/dm-pending").then(function (b) { render(b); }).catch(function () { /* 后台容错 */ });
  }
  function onEvt(e) {
    if (wasConnected && !box.isConnected) { window.removeEventListener(TGDM_EVENT, onEvt); return; }
    var d = e && e.detail;
    if (d && Array.isArray(d.users)) render(d); else load();
  }
  window.addEventListener(TGDM_EVENT, onEvt);
  load();
  var timer = setInterval(function () {
    if (box.isConnected) wasConnected = true;
    else if (wasConnected) { clearInterval(timer); window.removeEventListener(TGDM_EVENT, onEvt); return; }
    load();
  }, 5000);
}

// ── QQ 未授权私聊 + 群聊：设置页名单 + 通知（Telegram dm-pending 孪生，并扩展到群）。授权只能在本机设置页完成。──
var QQPD_CSS_TAG = "dsh-workbench-qq-pending";
var QQPD_EVENT = "dsh-workbench:qq-pending";
var QQPD_SEEN_KEY = "dsh-workbench.qqPendingSeen";
var QQPD_CSS = [
  ".qqpd{margin-top:16px;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--mm-accent,#3b82f6);border-radius:8px}",
  ".qqpd[hidden]{display:none}",
  ".qqpd-title{font-size:13px;font-weight:600}",
  ".qqpd-warn{font-size:12px;line-height:1.5;padding:6px 8px;border-radius:6px;border:1px solid var(--mm-warn-border,#c9842a);background:rgba(201,132,42,.12);color:var(--mm-warn,#b45309)}",
  ".qqpd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".qqpd-row .mm-btn{padding:2px 10px;font-size:12px}",
  ".qqpd-main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:12px}",
  ".qqpd-name{font-weight:600;overflow-wrap:anywhere}",
  ".qqpd-sub{font-size:11px;color:var(--mm-muted);overflow-wrap:anywhere}",
  ".qqpd-preview{font-size:12px;color:var(--mm-fg,inherit);opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".qqpd-fold{align-self:flex-start;background:none;border:none;padding:0;color:var(--mm-muted);font-size:12px;cursor:pointer}",
  ".qqpd-fold:hover{color:var(--mm-fg,inherit)}",
  ".qqpd-hint{font-size:11px;line-height:1.5;color:var(--mm-muted)}",
  ".qqpd-sec{font-size:12px;font-weight:600;margin-top:4px}"
].join("\n");

function qqpdEnsureCss() {
  if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="' + QQPD_CSS_TAG + '"]')) return;
  var st = document.createElement("style");
  st.dataset.plugin = "dsh-workbench";
  st.dataset.pluginCss = QQPD_CSS_TAG;
  st.textContent = QQPD_CSS;
  document.head.appendChild(st);
}
function qqpdJson(path, init) {
  return fetchJson(path, init).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "QQ 待处理名单请求失败");
    return body;
  });
}
function qqpdWhoUser(u) {
  return (u && u.name) || ("用户 " + (u && u.userId));
}
function qqpdWhoGroup(g) {
  return (g && g.name) || ("群 " + (g && g.groupId));
}
function qqpdPublish(body) {
  try { window.dispatchEvent(new CustomEvent(QQPD_EVENT, { detail: body || {} })); } catch (e) { /* ignore */ }
  try {
    var done = {};
    ((body && body.users) || []).forEach(function (u) { if (u.status !== "new") done["mm-qqpd-u-" + u.userId] = true; });
    ((body && body.groups) || []).forEach(function (g) { if (g.status !== "new") done["mm-qqpd-g-" + g.groupId] = true; });
    (mmToast._items || []).slice().forEach(function (it) { if (it && it.key && done[it.key]) mmToast._dismiss(it.id); });
  } catch (e) { /* ignore */ }
}
function qqpdAuthorizeUser(u) {
  return qqpdJson("/qq/pending/dm/" + encodeURIComponent(u.userId) + "/authorize", { method: "POST", body: "{}" }).then(function (b) {
    qqpdPublish(b);
    mmToast("已授权 " + qqpdWhoUser(u) + "（OpenID " + u.userId + "）私聊机器人", "ok");
    return b;
  });
}
function qqpdIgnoreUser(u) {
  return qqpdJson("/qq/pending/dm/" + encodeURIComponent(u.userId) + "/ignore", { method: "POST", body: "{}" }).then(function (b) {
    qqpdPublish(b);
    mmToast("已忽略 " + qqpdWhoUser(u) + " 的私聊", "info");
    return b;
  });
}
function qqpdRemoveUser(u) {
  return qqpdJson("/qq/pending/dm/" + encodeURIComponent(u.userId) + "/remove", { method: "POST", body: "{}" }).then(function (b) {
    qqpdPublish(b);
    return b;
  });
}
function qqpdAuthorizeGroup(g) {
  return qqpdJson("/qq/pending/group/" + encodeURIComponent(g.groupId) + "/authorize", { method: "POST", body: "{}" }).then(function (b) {
    qqpdPublish(b);
    mmToast("已授权群 " + qqpdWhoGroup(g) + "（group_openid " + g.groupId + "）", "ok");
    return b;
  });
}
function qqpdIgnoreGroup(g) {
  return qqpdJson("/qq/pending/group/" + encodeURIComponent(g.groupId) + "/ignore", { method: "POST", body: "{}" }).then(function (b) {
    qqpdPublish(b);
    mmToast("已忽略群 " + qqpdWhoGroup(g), "info");
    return b;
  });
}
function qqpdRemoveGroup(g) {
  return qqpdJson("/qq/pending/group/" + encodeURIComponent(g.groupId) + "/remove", { method: "POST", body: "{}" }).then(function (b) {
    qqpdPublish(b);
    return b;
  });
}
var QQPD_DM_NOTE = "授权后，该 OpenID 可以私聊本通道机器人（写入「允许的其他用户 OpenID」，删除即可撤销）。授权不包括使用会更改电脑的工具，该权限仍只属于「授权用户 OpenID」。";
var QQPD_GROUP_NOTE = "授权后，该群 OpenID 写入「允许的群 OpenID」；若群聊策略为「禁用」，会自动改为「白名单」以便真正放行。不会自动开放全部群。";
function qqpdConfirmAuthorizeUser(u) {
  return scConfirm("授权该账号私聊机器人？", {
    title: "授权私聊",
    body: qqpdWhoUser(u) + "（OpenID " + u.userId + "）\n" + QQPD_DM_NOTE + "\n保存后通道会按新名单重新连接。",
    okText: "授权",
    cancelText: "取消"
  });
}
function qqpdConfirmAuthorizeGroup(g) {
  return scConfirm("授权该群接入机器人？", {
    title: "授权群聊",
    body: qqpdWhoGroup(g) + "（group_openid " + g.groupId + "）\n" + QQPD_GROUP_NOTE + "\n保存后通道会按新名单重新连接。",
    okText: "授权",
    cancelText: "取消"
  });
}
function qqpdSeenLoad() {
  try {
    var j = JSON.parse(window.localStorage.getItem(QQPD_SEEN_KEY) || "{}");
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return mmGlobal.qqpdSeenMem || (mmGlobal.qqpdSeenMem = {});
  }
}
function qqpdSeenSave(map) {
  try { window.localStorage.setItem(QQPD_SEEN_KEY, JSON.stringify(map)); } catch (e) { mmGlobal.qqpdSeenMem = map; }
}
function qqpdToastUser(u) {
  var lines = ["未授权的账号私聊了 QQ 机器人", qqpdWhoUser(u) + "（OpenID " + u.userId + ")"];
  if (u.lastPreview) lines.push("「" + u.lastPreview + "」");
  var text = lines.join("\n");
  var id = "mm-qqpd-u-" + u.userId;
  function first() {
    return [
      { label: "授权", primary: true, onClick: function (api) {
        api.setText("确认授权 " + qqpdWhoUser(u) + "（OpenID " + u.userId + "）私聊机器人？\n" + QQPD_DM_NOTE);
        api.setActions(confirmActs());
      } },
      { label: "忽略", onClick: function (api) {
        qqpdIgnoreUser(u).then(function () { api.dismiss(); }).catch(function (e) { mmToast("忽略失败：" + ((e && e.message) || e), "err"); });
      } }
    ];
  }
  function confirmActs() {
    return [
      { label: "确认授权", primary: true, onClick: function (api) {
        qqpdAuthorizeUser(u).then(function () { api.dismiss(); }).catch(function (e) { mmToast("授权失败：" + ((e && e.message) || e), "err"); });
      } },
      { label: "取消", onClick: function (api) { api.setText(text); api.setActions(first()); } }
    ];
  }
  return mmToast(text, "info", { id: id, persistent: true, actions: first() });
}
function qqpdToastGroup(g) {
  var lines = ["未列入白名单的群发来了消息", qqpdWhoGroup(g) + "（group_openid " + g.groupId + ")"];
  if (g.lastSenderName || g.lastSenderId) lines.push("来自 " + (g.lastSenderName || g.lastSenderId));
  if (g.lastPreview) lines.push("「" + g.lastPreview + "」");
  var text = lines.join("\n");
  var id = "mm-qqpd-g-" + g.groupId;
  function first() {
    return [
      { label: "授权", primary: true, onClick: function (api) {
        api.setText("确认授权群 " + qqpdWhoGroup(g) + "？\n" + QQPD_GROUP_NOTE);
        api.setActions(confirmActs());
      } },
      { label: "忽略", onClick: function (api) {
        qqpdIgnoreGroup(g).then(function () { api.dismiss(); }).catch(function (e) { mmToast("忽略失败：" + ((e && e.message) || e), "err"); });
      } }
    ];
  }
  function confirmActs() {
    return [
      { label: "确认授权", primary: true, onClick: function (api) {
        qqpdAuthorizeGroup(g).then(function () { api.dismiss(); }).catch(function (e) { mmToast("授权失败：" + ((e && e.message) || e), "err"); });
      } },
      { label: "取消", onClick: function (api) { api.setText(text); api.setActions(first()); } }
    ];
  }
  return mmToast(text, "info", { id: id, persistent: true, actions: first() });
}
/** 后台轮询：每个新出现的未授权私聊/群只通知一次。 */
function maybeToastQQPending(body) {
  if (!body || body.ok === false) return;
  var seen = qqpdSeenLoad();
  var next = {};
  var changed = false;
  (Array.isArray(body.users) ? body.users : []).forEach(function (u) {
    var key = "u:" + String(u.userId) + "@" + String(u.firstSeen || "");
    if (seen[key]) { next[key] = seen[key]; return; }
    if (u.status !== "new") return;
    next[key] = Date.now();
    changed = true;
    qqpdToastUser(u);
  });
  (Array.isArray(body.groups) ? body.groups : []).forEach(function (g) {
    var key = "g:" + String(g.groupId) + "@" + String(g.firstSeen || "");
    if (seen[key]) { next[key] = seen[key]; return; }
    if (g.status !== "new") return;
    next[key] = Date.now();
    changed = true;
    qqpdToastGroup(g);
  });
  if (changed || Object.keys(next).length !== Object.keys(seen).length) qqpdSeenSave(next);
}

/** 「通道 › QQ」管理页里的未授权私聊/群聊名单。 */
function buildQQPendingPanel(host, hooks) {
  qqpdEnsureCss();
  var onAllowFrom = hooks && hooks.onAllowFrom;
  var onGroupAllow = hooks && hooks.onGroupAllow;
  var box = el("div", "qqpd");
  box.hidden = true;
  host.append(box);
  var showIgnoredUsers = false;
  var showIgnoredGroups = false;
  var lastBody = null;
  var busy = false;
  var wasConnected = false;

  function act(btns, run) {
    if (busy) return;
    busy = true;
    btns.forEach(function (b) { b.disabled = true; });
    run().catch(function (e) { mmToast((e && e.message) || String(e), "err"); }).finally(function () {
      busy = false;
      btns.forEach(function (b) { if (b.isConnected) b.disabled = false; });
    });
  }
  function userRow(u, ignored) {
    var r = el("div", "qqpd-row");
    var main = el("div", "qqpd-main");
    main.append(el("span", "qqpd-name", qqpdWhoUser(u)));
    var bits = ["OpenID " + u.userId];
    if (u.count > 1) bits.push("共 " + u.count + " 条");
    if (u.lastSeen) bits.push("最近 " + notesFormatTime(u.lastSeen));
    if (u.firstSeen && u.firstSeen !== u.lastSeen) bits.push("首次 " + notesFormatTime(u.firstSeen));
    main.append(el("span", "qqpd-sub", bits.join(" · ")));
    if (u.lastPreview) {
      var pv = el("span", "qqpd-preview", "「" + u.lastPreview + "」");
      pv.title = u.lastPreview;
      main.append(pv);
    }
    var auth = el("button", "mm-btn", "授权");
    var other = el("button", "mm-btn mm-ghost", ignored ? "删除记录" : "忽略");
    auth.type = other.type = "button";
    if (lastBody && !lastBody.ownerSet) { auth.disabled = true; auth.title = "请先填写并保存「所有者 OpenID」"; }
    auth.addEventListener("click", function () {
      if (busy) return;
      qqpdConfirmAuthorizeUser(u).then(function (ok) {
        if (!ok) return;
        act([auth, other], function () { return qqpdAuthorizeUser(u); });
      });
    });
    other.addEventListener("click", function () {
      if (ignored) {
        other.title = "删除后，该账号再次私聊时会重新出现并通知";
        act([auth, other], function () { return qqpdRemoveUser(u); });
      } else act([auth, other], function () { return qqpdIgnoreUser(u); });
    });
    if (ignored) other.title = "删除后，该账号再次私聊时会重新出现并通知";
    r.append(main, auth, other);
    return r;
  }
  function groupRow(g, ignored) {
    var r = el("div", "qqpd-row");
    var main = el("div", "qqpd-main");
    main.append(el("span", "qqpd-name", qqpdWhoGroup(g)));
    var bits = ["group_openid " + g.groupId];
    if (g.lastSenderName || g.lastSenderId) bits.push("来自 " + (g.lastSenderName || g.lastSenderId));
    if (g.count > 1) bits.push("共 " + g.count + " 条");
    if (g.lastSeen) bits.push("最近 " + notesFormatTime(g.lastSeen));
    main.append(el("span", "qqpd-sub", bits.join(" · ")));
    if (g.lastPreview) {
      var pv = el("span", "qqpd-preview", "「" + g.lastPreview + "」");
      pv.title = g.lastPreview;
      main.append(pv);
    }
    var auth = el("button", "mm-btn", "授权");
    var other = el("button", "mm-btn mm-ghost", ignored ? "删除记录" : "忽略");
    auth.type = other.type = "button";
    if (lastBody && !lastBody.ownerSet) { auth.disabled = true; auth.title = "请先填写并保存「所有者 OpenID」"; }
    auth.addEventListener("click", function () {
      if (busy) return;
      qqpdConfirmAuthorizeGroup(g).then(function (ok) {
        if (!ok) return;
        act([auth, other], function () { return qqpdAuthorizeGroup(g); });
      });
    });
    other.addEventListener("click", function () {
      if (ignored) {
        other.title = "删除后，该群再次发消息时会重新出现并通知";
        act([auth, other], function () { return qqpdRemoveGroup(g); });
      } else act([auth, other], function () { return qqpdIgnoreGroup(g); });
    });
    if (ignored) other.title = "删除后，该群再次发消息时会重新出现并通知";
    r.append(main, auth, other);
    return r;
  }
  function render(body) {
    lastBody = body || lastBody;
    if (!lastBody) return;
    if (typeof lastBody.allowFrom === "string" && typeof onAllowFrom === "function") {
      try { onAllowFrom(lastBody.allowFrom); } catch (e) { /* ignore */ }
    }
    if ((typeof lastBody.groupIds === "string" || typeof lastBody.groupPolicy === "string") && typeof onGroupAllow === "function") {
      try { onGroupAllow({ groupIds: lastBody.groupIds, groupPolicy: lastBody.groupPolicy }); } catch (e) { /* ignore */ }
    }
    var users = Array.isArray(lastBody.users) ? lastBody.users : [];
    var groups = Array.isArray(lastBody.groups) ? lastBody.groups : [];
    var pendingU = users.filter(function (u) { return u.status === "new"; });
    var ignoredU = users.filter(function (u) { return u.status === "ignored"; });
    var pendingG = groups.filter(function (g) { return g.status === "new"; });
    var ignoredG = groups.filter(function (g) { return g.status === "ignored"; });
    box.textContent = "";
    if (!pendingU.length && !ignoredU.length && !pendingG.length && !ignoredG.length) { box.hidden = true; return; }
    box.hidden = false;
    var n = pendingU.length + pendingG.length;
    box.append(el("div", "qqpd-title", n ? "未授权的私聊 / 群聊（" + n + "）" : "未授权的私聊 / 群聊"));
    if (!lastBody.ownerSet) box.append(el("div", "qqpd-warn", "尚未填写「所有者 OpenID」：通道不会按本页写入白名单，授权不会生效。请先填写并保存。"));

    box.append(el("div", "qqpd-sec", pendingU.length ? "私聊（" + pendingU.length + "）" : "私聊"));
    if (!pendingU.length) box.append(el("div", "qqpd-hint", "没有待处理的私聊账号。"));
    pendingU.forEach(function (u) { box.append(userRow(u, false)); });
    if (ignoredU.length) {
      var foldU = el("button", "qqpd-fold", (showIgnoredUsers ? "▾ " : "▸ ") + "已忽略的私聊（" + ignoredU.length + "）");
      foldU.type = "button";
      foldU.setAttribute("aria-expanded", showIgnoredUsers ? "true" : "false");
      foldU.addEventListener("click", function () { showIgnoredUsers = !showIgnoredUsers; render(null); });
      box.append(foldU);
      if (showIgnoredUsers) ignoredU.forEach(function (u) { box.append(userRow(u, true)); });
    }

    box.append(el("div", "qqpd-sec", pendingG.length ? "群聊（" + pendingG.length + "）" : "群聊"));
    if (!pendingG.length) box.append(el("div", "qqpd-hint", "没有待处理的群。群聊策略为「禁用」时仍会发现新群，便于择群开通。"));
    pendingG.forEach(function (g) { box.append(groupRow(g, false)); });
    if (ignoredG.length) {
      var foldG = el("button", "qqpd-fold", (showIgnoredGroups ? "▾ " : "▸ ") + "已忽略的群（" + ignoredG.length + "）");
      foldG.type = "button";
      foldG.setAttribute("aria-expanded", showIgnoredGroups ? "true" : "false");
      foldG.addEventListener("click", function () { showIgnoredGroups = !showIgnoredGroups; render(null); });
      box.append(foldG);
      if (showIgnoredGroups) ignoredG.forEach(function (g) { box.append(groupRow(g, true)); });
    }

    box.append(el("div", "qqpd-hint", "这些私聊 / 群聊不在白名单里；机器人不会回复，也不会提示如何获得授权。" + QQPD_DM_NOTE + " " + QQPD_GROUP_NOTE + " 授权只能在本页完成，任何聊天指令都不能授权。"));
  }
  function load() {
    if (busy) return;
    qqpdJson("/qq/pending").then(function (b) { render(b); }).catch(function () { /* 后台容错 */ });
  }
  function onEvt(e) {
    if (wasConnected && !box.isConnected) { window.removeEventListener(QQPD_EVENT, onEvt); return; }
    var d = e && e.detail;
    if (d && (Array.isArray(d.users) || Array.isArray(d.groups))) render(d); else load();
  }
  window.addEventListener(QQPD_EVENT, onEvt);
  load();
  var timer = setInterval(function () {
    if (box.isConnected) wasConnected = true;
    else if (wasConnected) { clearInterval(timer); window.removeEventListener(QQPD_EVENT, onEvt); return; }
    load();
  }, 5000);
}

function buildTelegramBotsPanel(host) {
  var box = el("div");
  box.style.marginTop = "16px";
  box.style.display = "flex";
  box.style.flexDirection = "column";
  box.style.gap = "8px";
  var head = el("div", "mm-row");
  head.append(el("span", null, "机器人"));
  var addBtn = el("button", "mm-btn mm-ghost", "添加机器人");
  addBtn.type = "button";
  head.append(addBtn);
  var note = el("div", "mm-note", "选择表格中的一行，编辑该机器人的令牌、预设和模型。模型来自 DSH「设置 › 模型」里已启用的服务商。账号标识创建后不能修改。令牌保存在宿主凭据里，不能和聊天室接收机器人相同。已绑定的会话要在该机器人的私聊里发送 /new 才会换预设和模型。");
  var tableWrap = el("div");
  tableWrap.style.overflowX = "auto";
  var msg = el("div", "mm-msg", "正在读取…");
  var detail = el("div");
  detail.style.display = "none";
  detail.style.flexDirection = "column";
  detail.style.gap = "8px";
  detail.style.padding = "10px";
  detail.style.border = "1px solid var(--mm-border)";
  detail.style.borderRadius = "8px";
  box.append(head, note, msg, tableWrap, detail);
  host.append(box);
  var bots = [];
  var selectedId = "";

  function recordOf(b) {
    return {
      id: b.id, name: b.name || b.id, tokenRef: b.tokenRef || "",
      preset: b.preset || "", groupPreset: b.groupPreset || "",
      enabled: b.enabled !== false, provider: b.provider || "", model: b.model || "",
      reasoningEffort: b.reasoningEffort || ""
    };
  }
  function modelText(b) {
    if (b.provider && b.model) return b.provider + " / " + b.model;
    return "宿主默认";
  }
  function cell(text) {
    var td = el("td", null, text || "");
    td.style.padding = "6px 8px";
    td.style.borderBottom = "1px solid var(--mm-border)";
    td.style.whiteSpace = "nowrap";
    return td;
  }
  function render() {
    tableWrap.textContent = "";
    var table = el("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "12px";
    var headRow = el("tr");
    ["名称", "@username", "账号", "模型", "预设", "令牌", "启用", "冲突"].forEach(function (label) {
      var th = el("th", null, label);
      th.style.textAlign = "left";
      th.style.padding = "6px 8px";
      th.style.borderBottom = "1px solid var(--mm-border)";
      th.style.color = "var(--mm-muted)";
      th.style.fontWeight = "600";
      headRow.append(th);
    });
    var thead = el("thead");
    thead.append(headRow);
    var tbody = el("tbody");
    bots.forEach(function (b) {
      var tr = el("tr");
      tr.style.cursor = "pointer";
      if (b.id === selectedId) tr.style.background = "rgba(127,127,127,.16)";
      tr.append(
        cell(b.name || b.id),
        cell(b.username ? "@" + b.username : ""),
        cell(b.id),
        cell(modelText(b)),
        cell(b.preset || "宿主默认"),
        cell(b.hasToken ? "已保存" : "未保存"),
        cell(b.enabled === false ? "停用" : "启用"),
        cell(b.conflict ? "冲突" : "")
      );
      tr.addEventListener("click", function () { selectedId = b.id; render(); });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    tableWrap.append(table);
    renderDetail();
  }
  function fieldRow(label, node) {
    var row = el("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "7.5em minmax(0, 1fr)";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    var lab = el("label", null, label);
    lab.style.fontSize = "12px";
    row.append(lab, node);
    return row;
  }
  function inputEl(value) {
    var input = el("input");
    input.type = "text";
    input.value = value || "";
    input.style.width = "100%";
    input.style.boxSizing = "border-box";
    return input;
  }
  function selectEl() {
    var select = el("select");
    select.style.width = "100%";
    return select;
  }
  function renderDetail() {
    detail.textContent = "";
    var bot = bots.filter(function (b) { return b.id === selectedId; })[0];
    if (!bot) { detail.style.display = "none"; return; }
    detail.style.display = "flex";
    detail.append(el("div", null, "编辑「" + (bot.name || bot.id) + "」"));
    var nameInput = inputEl(bot.name);
    var idInput = inputEl(bot.id);
    idInput.readOnly = true;
    var enabledSel = selectEl();
    fillSelect(enabledSel, [{ value: "true", label: "启用" }, { value: "false", label: "停用" }], bot.enabled === false ? "false" : "true");
    var tokenInput = el("input");
    tokenInput.type = "password";
    tokenInput.placeholder = bot.hasToken ? "已保存；留空则不修改，输入 - 清除" : "123456789:AA…";
    tokenInput.autocomplete = "off";
    tokenInput.style.width = "100%";
    tokenInput.style.boxSizing = "border-box";
    var presetSel = selectEl();
    var groupSel = selectEl();
    var routeSel = selectEl();
    var effortSel = selectEl();
    detail.append(
      fieldRow("账号：", idInput),
      fieldRow("显示名：", nameInput),
      fieldRow("启用：", enabledSel),
      fieldRow("令牌：", tokenInput),
      fieldRow("私聊预设：", presetSel),
      fieldRow("群聊预设：", groupSel),
      fieldRow("模型：", routeSel),
      fieldRow("推理强度：", effortSel)
    );
    var actions = el("div", "mm-row");
    function action(text, fn) {
      var button = el("button", "mm-btn mm-ghost", text);
      button.type = "button";
      button.addEventListener("click", fn);
      return button;
    }
    actions.append(action("保存", saveDetail), action("检查", function () { checkBot(bot); }), action("增加服务商", function () { openDshModelSettings(box); }));
    if (bot.id !== "main") actions.append(action("删除", function () { removeBot(bot); }));
    detail.append(actions);
    var hint = el("div", "mm-note", "令牌保存在宿主凭据（" + (bot.tokenRef || "TELEGRAM_BOT_TOKEN") + "），不写入插件设置。留空预设表示使用宿主默认。更换模型会清空推理强度，保存后按新模型再选。已绑定的会话要在这个机器人的私聊里发送 /new 才会换预设和模型。");
    hint.style.margin = "0";
    detail.append(hint);
    var ready = false;
    loadModelChooser(bot.provider, bot.model).then(function (r) {
      if (selectedId !== bot.id) return;
      ready = true;
      var pre = r[1] || { presets: [] };
      var presetOpts = [{ value: "", label: "宿主默认" }].concat((pre.presets || []).map(function (p) { return { value: p.id, label: dshPresetLabel(p, pre.defaultId) }; }));
      var groupOpts = [{ value: "", label: "与本机器人私聊相同" }].concat((pre.presets || []).map(function (p) { return { value: p.id, label: dshPresetLabel(p, pre.defaultId) }; }));
      if (bot.preset && !presetOpts.some(function (o) { return o.value === bot.preset; })) presetOpts.push({ value: bot.preset, label: bot.preset });
      if (bot.groupPreset && !groupOpts.some(function (o) { return o.value === bot.groupPreset; })) groupOpts.push({ value: bot.groupPreset, label: bot.groupPreset });
      fillSelect(presetSel, presetOpts, bot.preset || "");
      fillSelect(groupSel, groupOpts, bot.groupPreset || "");
      var routes = modelRouteOptions(r[0].llm, bot);
      routes.unshift({ value: "", label: "宿主默认模型" });
      fillSelect(routeSel, routes, bot.provider && bot.model ? bot.provider + "\u0000" + bot.model : "");
      fillSelect(effortSel, effortSelectOptions(r[2], bot.reasoningEffort || ""), bot.reasoningEffort || "");
    }).catch(function (e) {
      if (selectedId !== bot.id) return;
      ready = true;
      var current = bot.provider && bot.model ? bot.provider + "\u0000" + bot.model : "";
      fillSelect(routeSel, [{ value: "", label: "宿主默认模型" }].concat(current ? [{ value: current, label: bot.provider + " / " + bot.model }] : []), current);
      fillSelect(presetSel, [{ value: "", label: "宿主默认" }].concat(bot.preset ? [{ value: bot.preset, label: bot.preset }] : []), bot.preset || "");
      fillSelect(groupSel, [{ value: "", label: "与本机器人私聊相同" }].concat(bot.groupPreset ? [{ value: bot.groupPreset, label: bot.groupPreset }] : []), bot.groupPreset || "");
      fillSelect(effortSel, effortSelectOptions({}, bot.reasoningEffort || ""), bot.reasoningEffort || "");
      msg.textContent = "读取模型目录失败：" + ((e && e.message) || e);
      msg.className = "mm-msg err";
    });
    routeSel.addEventListener("change", function () {
      var parts = String(routeSel.value || "").split("\u0000");
      dshCatalogJson("/dsh/efforts?provider=" + encodeURIComponent(parts[0] || "") + "&model=" + encodeURIComponent(parts[1] || "")).then(function (eff) {
        fillSelect(effortSel, effortSelectOptions(eff, ""), "");
      }).catch(function () { fillSelect(effortSel, effortSelectOptions({ efforts: [] }, ""), ""); });
    });
    function saveDetail() {
      if (!ready) { msg.textContent = "模型目录还在读取，请稍后再保存"; msg.className = "mm-msg"; return; }
      var parts = String(routeSel.value || "").split("\u0000");
      var next = bots.map(recordOf);
      var row = next.filter(function (b) { return b.id === bot.id; })[0];
      if (!row) return;
      row.name = String(nameInput.value || "").trim() || bot.id;
      row.enabled = enabledSel.value !== "false";
      row.preset = presetSel.value || "";
      row.groupPreset = groupSel.value || "";
      row.provider = parts[0] || "";
      row.model = parts[1] || "";
      row.reasoningEffort = effortSel.value || "";
      var token = String(tokenInput.value || "").trim();
      msg.textContent = "正在保存…";
      msg.className = "mm-msg";
      saveBots(next).then(function () {
        if (!token) { mmToast("已保存 " + row.name, "ok"); return; }
        return telegramBotsJson("/telegram/bots/" + encodeURIComponent(bot.id) + "/token", { method: "PUT", body: JSON.stringify({ token: token }) }).then(function () { return load(); }).then(function () { mmToast("已保存 " + row.name, "ok"); });
      }).catch(function (e) {
        msg.textContent = "保存失败：" + ((e && e.message) || e);
        msg.className = "mm-msg err";
      });
    }
  }
  function load() {
    msg.textContent = "正在读取…";
    msg.className = "mm-msg";
    return telegramBotsJson("/telegram/bots").then(function (body) {
      bots = body.bots || [];
      if (!bots.some(function (b) { return b.id === selectedId; })) selectedId = bots[0] ? bots[0].id : "";
      msg.textContent = "";
      render();
    }).catch(function (e) {
      msg.textContent = "读取失败：" + ((e && e.message) || e);
      msg.className = "mm-msg err";
    });
  }
  function saveBots(listBots) {
    return telegramBotsJson("/telegram/bots", { method: "PUT", body: JSON.stringify({ bots: listBots }) }).then(function (body) {
      bots = body.bots || [];
      if (!bots.some(function (b) { return b.id === selectedId; })) selectedId = bots[0] ? bots[0].id : "";
      render();
    });
  }
  function checkBot(b) {
    msg.textContent = "正在检查 " + b.name + "…";
    msg.className = "mm-msg";
    telegramBotsJson("/telegram/bots/" + encodeURIComponent(b.id) + "/check", { method: "POST", body: "{}" }).then(function (c) {
      msg.textContent = c.username ? ("@" + c.username + " 可以连接") : "已连接";
      msg.className = "mm-msg ok";
      return load();
    }).catch(function (e) {
      msg.textContent = "检查失败：" + ((e && e.message) || e);
      msg.className = "mm-msg err";
    });
  }
  function removeBot(b) {
    if (b.id === "main") return;
    notesDialog({
      title: "删除机器人", okText: "删除",
      view: "确定不再连接机器人「" + b.name + "」（账号 " + b.id + "）吗？已经建立的 DSH 会话仍保留，只是不再接收新消息。",
      onSubmit: function () {
        return saveBots(bots.filter(function (x) { return x.id !== b.id; }).map(recordOf)).then(function () {
          if (selectedId === b.id) selectedId = bots[0] ? bots[0].id : "";
          mmToast("已删除 " + b.name, "ok");
        });
      }
    });
  }
  addBtn.addEventListener("click", function () {
    notesDialog({
      title: "添加机器人",
      okText: "添加",
      fields: [{ key: "id", label: "账号标识", placeholder: "例如 claude", maxLength: 24, hint: "小写字母开头，只能含小写字母、数字和连字符。创建后不能修改，并会出现在 DSH 会话名称里。" }],
      onSubmit: function (v) {
        var id = String(v.id || "").trim().toLowerCase();
        if (!/^[a-z][a-z0-9-]{0,23}$/.test(id) || id === "main") return Promise.reject(new Error("账号标识须以小写字母开头，只含小写字母、数字和连字符，且不能是 main"));
        if (bots.some(function (b) { return b.id === id; })) return Promise.reject(new Error("账号标识已存在"));
        var next = bots.map(recordOf);
        next.push({ id: id, name: id, tokenRef: "", preset: "", groupPreset: "", enabled: true, provider: "", model: "", reasoningEffort: "" });
        selectedId = id;
        return saveBots(next).then(function () { mmToast("已添加 " + id + "，请在下方填写令牌和模型", "ok"); });
      }
    });
  });
  load();
}

// 设置页「网关核验」：llm-gateway-bench 的安装状态、下载安装（钉死提交，保存到数据目录 tools/llm-gateway-bench）、进度与安装日志。
// ── 「通用 › 余额查询」管理页面板：各服务商一行（启用、单独保存的密钥、结果、刷新）。密钥从不回显，只显示「已保存」。──
var BALANCE_CSS = [
  ".mm-bal-root{container-type:inline-size;min-width:0;max-width:100%}",
  ".mm-bal-root,.mm-bal-root *{box-sizing:border-box}",
  ".mm-bal-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 8px}",
  ".mm-bal-top .mm-msg{min-width:0;overflow-wrap:anywhere}",
  ".mm-bal-row{margin:10px 0;padding:10px;border:1px solid var(--mm-border);border-radius:8px;background:rgba(127,127,127,.06);min-width:0;max-width:100%}",
  ".mm-bal-head{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;min-width:0}",
  ".mm-bal-head h4{margin:0;font-size:13px;min-width:0;overflow-wrap:anywhere}",
  ".mm-bal-head .mm-bal-sp{flex:1 1 0;min-width:0}",
  ".mm-bal-head .mm-btn{flex:none;white-space:nowrap}",
  ".mm-bal-desc{margin:6px 0 8px;font-size:11px;line-height:1.55;color:var(--mm-muted);overflow-wrap:anywhere}",
  ".mm-bal-fields{display:grid;grid-template-columns:fit-content(11em) minmax(0,1fr);gap:6px 10px;align-items:center;margin:4px 0 8px;min-width:0}",
  ".mm-bal-fields label{font-size:12px;font-weight:600;min-width:0;overflow-wrap:anywhere}",
  ".mm-bal-fval{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}",
  ".mm-bal-fval .mm-input{flex:1 1 9em;min-width:0;width:100%;max-width:100%}",
  ".mm-bal-fval .mm-btn{flex:none;white-space:nowrap}",
  ".mm-bal-row .mm-row{flex-wrap:wrap;min-width:0}",
  ".mm-bal-row .mm-row .mm-btn{flex:none;white-space:nowrap}",
  ".mm-bal-row .mm-row .mm-msg{min-width:0;overflow-wrap:anywhere}",
  ".mm-bal-res{margin-top:6px;font-size:12px;line-height:1.7;overflow-wrap:anywhere;word-break:break-word;min-width:0}",
  ".mm-bal-res .mm-bal-amt{font-weight:600;font-variant-numeric:tabular-nums}",
  ".mm-bal-res .mm-bal-main{font-size:14px}",
  ".mm-bal-res.err{color:#e55}",
  ".mm-bal-res.low .mm-bal-main{color:var(--mm-warn)}",
  ".mm-bal-time{font-size:11px;color:var(--mm-muted)}",
  ".mm-bal-entry{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto auto;grid-template-areas:\"name url url url\" \"key key sw del\";gap:6px;align-items:center;margin:8px 0 6px;min-width:0}",
  ".mm-bal-entry .mm-input{width:100%;min-width:0;max-width:100%}",
  ".mm-bal-entry .mm-bal-e-name{grid-area:name}",
  ".mm-bal-entry .mm-bal-e-url{grid-area:url}",
  ".mm-bal-entry .mm-bal-e-key{grid-area:key}",
  ".mm-bal-entry .mm-switch{grid-area:sw;justify-self:start}",
  ".mm-bal-entry .mm-bal-e-del{grid-area:del;white-space:nowrap}",
  "@container (max-width:420px){.mm-bal-fields{grid-template-columns:minmax(0,1fr);gap:4px}.mm-bal-fields label{margin-top:4px}.mm-bal-entry{grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:\"name name name\" \"url url url\" \"key sw del\"}}"
].join("\n");

function balanceFmt(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  try { return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 }); } catch (e) { return String(v); }
}

function balanceTime(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try { return d.toLocaleString("zh-CN", { hour12: false }); } catch (e) { return d.toISOString(); }
}

function balanceSwitch(checked, label) {
  var b = el("button", "mm-switch");
  b.type = "button";
  b.setAttribute("role", "switch");
  b.setAttribute("aria-checked", checked ? "true" : "false");
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}

function balanceResultEl(r) {
  var box = el("div", "mm-bal-res");
  box.setAttribute("aria-live", "polite");
  if (!r) { box.className = "mm-bal-res mm-bal-time"; box.textContent = "尚未查询。"; return box; }
  if (!r.ok) {
    box.className = "mm-bal-res err";
    box.textContent = "查询失败：" + (r.error || "未知错误");
  } else {
    if (r.low) box.className = "mm-bal-res low";
    var items = r.items || [];
    if (!items.length) box.append(el("div", "mm-bal-time", "未返回可显示的金额。"));
    items.forEach(function (x, i) {
      var line = el("div");
      var main = i === 0 || x.type === "balance";
      var amt = el("span", "mm-bal-amt" + (main ? " mm-bal-main" : ""), balanceFmt(x.value) + " " + (x.currency || ""));
      line.append(el("span", null, x.label + "："), amt);
      box.append(line);
    });
    if (r.low) box.append(el("div", null, "余额低于提示阈值，请及时充值。"));
    if (r.note) box.append(el("div", "mm-bal-time", r.note));
  }
  if (r.checkedAt) box.append(el("div", "mm-bal-time", "上次查询：" + balanceTime(r.checkedAt)));
  return box;
}

function buildBalancePanel(host) {
  if (!document.getElementById("mm-balance-css")) {
    var st = document.createElement("style");
    st.id = "mm-balance-css";
    st.textContent = BALANCE_CSS;
    document.head.appendChild(st);
  }
  var top = el("div", "mm-bal-top");
  var allBtn = el("button", "mm-btn", "全部刷新");
  allBtn.type = "button";
  var topMsg = el("span", "mm-msg", "正在读取…");
  topMsg.setAttribute("aria-live", "polite");
  top.append(allBtn, topMsg);
  var off = el("div", "mm-warn", "余额查询尚未启用：打开上方「启用」后才会查询。各服务商的密钥可以先保存。");
  off.hidden = true;
  var note = el("div", "mm-note", "每个服务商使用在此单独保存的密钥，不读取 DSH「设置 › 模型」中的密钥。密钥保存后不再显示，只标注「已保存」；结果缓存约 60 秒，「刷新」会立即重新查询。只请求各服务商的官方查询接口。");
  var list = el("div");
  var root = el("div", "mm-bal-root");
  root.append(top, off, note, list);
  host.append(root);
  var last = null;
  var busy = false;
  var lowSeen = {};
  var drafts = null; // 附加条目的未保存编辑

  function say(text, isErr) {
    topMsg.textContent = text || "";
    topMsg.className = isErr ? "mm-msg err" : (text ? "mm-msg" : "mm-msg");
  }

  function call(path, body) {
    return fetchJson(path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }).then(function (j) {
      if (!j || j.ok === false) throw new Error((j && j.error) || "请求失败");
      return j;
    });
  }

  function notifyLow(v) {
    var rows = [];
    (v.providers || []).forEach(function (p) { if (p.result) rows.push({ id: p.id, name: p.name, r: p.result }); });
    ((v.extra && v.extra.entries) || []).forEach(function (e) { if (e.result) rows.push({ id: "x:" + e.id, name: e.name, r: e.result }); });
    rows.forEach(function (x) {
      if (!x.r.low) return;
      var k = x.id + "|" + x.r.checkedAt;
      if (lowSeen[k]) return;
      lowSeen[k] = true;
      mmToast(x.name + " 余额低于提示阈值", "info");
    });
  }

  function render(v) {
    last = v;
    off.hidden = !!v.enabled;
    allBtn.disabled = !v.enabled || busy;
    list.textContent = "";
    (v.providers || []).forEach(function (p) { list.append(providerRow(p, v)); });
    if (v.extra) list.append(extraBox(v.extra, v));
    (v.unsupported || []).forEach(function (u) {
      var row = el("div", "mm-bal-row");
      var head = el("div", "mm-bal-head");
      head.append(el("h4", null, u.name), el("span", "mm-src", "无官方查询接口"), el("span", "mm-bal-sp"));
      if (u.console) {
        var a = el("a", "mm-ext", "打开控制台");
        a.href = u.console; a.target = "_blank"; a.rel = "noopener noreferrer";
        head.append(a);
      }
      row.append(head, el("div", "mm-bal-desc", u.desc || ""));
      list.append(row);
    });
    notifyLow(v);
  }

  function providerRow(p, v) {
    var row = el("div", "mm-bal-row");
    var head = el("div", "mm-bal-head");
    var sw = balanceSwitch(p.enabled, "启用 " + p.name);
    head.append(el("h4", null, p.name), el("span", "mm-src", p.kind === "spend" ? "已用金额" : "余额"));
    if (p.console) {
      var a = el("a", "mm-ext", "控制台");
      a.href = p.console; a.target = "_blank"; a.rel = "noopener noreferrer";
      head.append(a);
    }
    var refresh = el("button", "mm-btn mm-ghost", "刷新");
    refresh.type = "button";
    refresh.disabled = !v.enabled || !p.enabled || !p.configured;
    refresh.title = !p.configured ? "请先保存密钥" : !p.enabled ? "请先启用此服务商" : "立即重新查询";
    head.append(el("span", "mm-bal-sp"), sw, refresh);
    row.append(head, el("div", "mm-bal-desc", p.desc || ""));
    var grid = el("div", "mm-bal-fields");
    var inputs = {};
    (p.fields || []).forEach(function (f) {
      var id = "mm-bal-" + f.key;
      var lab = el("label", null, f.label);
      lab.htmlFor = id;
      var val = el("div", "mm-bal-fval");
      var input;
      if (f.type === "secret") {
        input = el("input", "mm-input");
        input.type = "password";
        input.autocomplete = "new-password";
        input.spellcheck = false;
        input.setAttribute("data-secret", "true");
        input.placeholder = f.configured ? "已保存（不显示）；输入新值可替换" : (f.placeholder || "");
        val.append(input);
        if (f.configured) {
          var clr = el("button", "mm-btn mm-ghost", "清除");
          clr.type = "button";
          clr.title = "删除已保存的" + f.label;
          clr.addEventListener("click", function () {
            var values = {};
            values[f.key] = "";
            save(p, values, "已清除" + f.label);
          });
          val.append(clr);
          val.append(el("span", "mm-src bundled", "已保存"));
        }
      } else if (f.type === "select") {
        input = el("select", "mm-input");
        (f.options || []).forEach(function (o) {
          var op = el("option", null, o.label);
          op.value = o.value;
          if (o.value === f.value) op.selected = true;
          input.append(op);
        });
        val.append(input);
      } else if (f.type === "switch") {
        input = balanceSwitch(f.value === true, f.label);
        input.addEventListener("click", function () {
          var values = {};
          values[f.key] = input.getAttribute("aria-checked") !== "true";
          save(p, values);
        });
        val.append(input);
      } else {
        input = el("input", "mm-input");
        input.type = "text";
        input.value = f.value || "";
        input.placeholder = f.placeholder || "";
        val.append(input);
      }
      input.id = id;
      inputs[f.key] = { f: f, input: input };
      grid.append(lab, val);
    });
    row.append(grid);
    var srow = el("div", "mm-row");
    var sbtn = el("button", "mm-btn", "保存");
    sbtn.type = "button";
    var smsg = el("span", "mm-msg");
    srow.append(sbtn, smsg);
    row.append(srow, balanceResultEl(p.result));
    sbtn.addEventListener("click", function () {
      var values = {};
      Object.keys(inputs).forEach(function (k) {
        var x = inputs[k];
        if (x.f.type === "switch") return;
        if (x.f.type === "secret") { if (x.input.value) values[k] = x.input.value; return; }
        values[k] = x.input.value;
      });
      save(p, values, "已保存", smsg);
    });
    sw.addEventListener("click", function () {
      save(p, null, null, smsg, sw.getAttribute("aria-checked") !== "true");
    });
    refresh.addEventListener("click", function () { doRefresh(p.id, refresh); });
    return row;
  }

  function save(p, values, okText, msgEl, enabled) {
    var body = { provider: p.id };
    if (values) body.values = values;
    if (typeof enabled === "boolean") body.enabled = enabled;
    if (msgEl) { msgEl.textContent = "保存中…"; msgEl.className = "mm-msg"; }
    return call("/balance/config", body).then(function (v) {
      render(v);
      mmToast(p.name + "：" + (typeof enabled === "boolean" ? (enabled ? "已启用" : "已停用") : (okText || "已保存")), "ok");
    }).catch(function (e) {
      if (msgEl) { msgEl.textContent = e.message; msgEl.className = "mm-msg err"; }
      mmToast(e.message || "保存失败", "err");
    });
  }

  function extraBox(x, v) {
    var box = el("div", "mm-bal-row");
    var head = el("div", "mm-bal-head");
    head.append(el("h4", null, x.title), el("span", "mm-src local", "本地扩展"));
    box.append(head, el("div", "mm-bal-desc", x.note || ""));
    if (!drafts) {
      drafts = (x.entries || []).map(function (e) { return { id: e.id, name: e.name, baseUrl: e.baseUrl, enabled: e.enabled, configured: e.configured, apiKey: "" }; });
      if (!drafts.length && x.example) drafts.push({ id: "", name: x.example.name, baseUrl: x.example.baseUrl, enabled: false, configured: false, apiKey: "" });
    }
    var results = {};
    (x.entries || []).forEach(function (e) { results[e.id] = e; });
    drafts.forEach(function (d, i) {
      var line = el("div", "mm-bal-entry");
      var n = el("input", "mm-input mm-bal-e-name"); n.type = "text"; n.value = d.name; n.placeholder = "名称"; n.setAttribute("aria-label", "名称");
      var u = el("input", "mm-input mm-bal-e-url"); u.type = "text"; u.value = d.baseUrl; u.placeholder = "https://…"; u.setAttribute("aria-label", "地址");
      var k = el("input", "mm-input mm-bal-e-key"); k.type = "password"; k.autocomplete = "new-password"; k.spellcheck = false; k.setAttribute("data-secret", "true");
      k.value = d.apiKey || "";
      k.placeholder = d.configured ? "已保存（不显示）" : x.keyLabel;
      k.setAttribute("aria-label", x.keyLabel);
      var sw = balanceSwitch(d.enabled, "启用 " + (d.name || "条目"));
      var del = el("button", "mm-btn mm-ghost mm-bal-e-del", "删除"); del.type = "button";
      n.addEventListener("input", function () { d.name = n.value; });
      u.addEventListener("input", function () { d.baseUrl = u.value; });
      k.addEventListener("input", function () { d.apiKey = k.value; });
      sw.addEventListener("click", function () { d.enabled = !d.enabled; sw.setAttribute("aria-checked", d.enabled ? "true" : "false"); });
      del.addEventListener("click", function () { drafts.splice(i, 1); render(last); });
      line.append(n, u, k, sw, del);
      box.append(line);
      var r = d.id && results[d.id];
      if (r) {
        var rr = el("div", "mm-row");
        var rb = el("button", "mm-btn mm-ghost", "刷新"); rb.type = "button";
        rb.disabled = !v.enabled || !r.enabled || !r.configured;
        rb.addEventListener("click", function () { doRefresh("x:" + d.id, rb); });
        rr.append(rb);
        if (r.configured) {
          var cl = el("button", "mm-btn mm-ghost", "清除密钥"); cl.type = "button";
          cl.addEventListener("click", function () { d.apiKey = ""; d.clearKey = true; saveExtra("已清除密钥"); });
          rr.append(cl, el("span", "mm-src bundled", "已保存"));
        }
        box.append(rr, balanceResultEl(r.result));
      }
    });
    var actions = el("div", "mm-row");
    var add = el("button", "mm-btn mm-ghost", "添加条目"); add.type = "button";
    var sv = el("button", "mm-btn", "保存条目"); sv.type = "button";
    var msg = el("span", "mm-msg");
    add.addEventListener("click", function () { drafts.push({ id: "", name: "", baseUrl: "", enabled: false, configured: false, apiKey: "" }); render(last); });
    sv.addEventListener("click", function () { saveExtra("条目已保存", msg); });
    actions.append(add, sv, msg);
    box.append(actions);
    return box;
  }

  function saveExtra(okText, msgEl) {
    var entries = (drafts || []).map(function (d) {
      var e = { name: d.name, baseUrl: d.baseUrl, enabled: !!d.enabled };
      if (d.id) e.id = d.id;
      if (d.clearKey) e.apiKey = "";
      else if (d.apiKey) e.apiKey = d.apiKey;
      return e;
    });
    if (msgEl) { msgEl.textContent = "保存中…"; msgEl.className = "mm-msg"; }
    return call("/balance/extra", { entries: entries }).then(function (v) {
      drafts = null;
      render(v);
      mmToast(okText || "已保存", "ok");
    }).catch(function (e) {
      if (msgEl) { msgEl.textContent = e.message; msgEl.className = "mm-msg err"; }
      mmToast(e.message || "保存失败", "err");
    });
  }

  function doRefresh(id, btn) {
    if (busy) return;
    busy = true;
    if (btn) btn.disabled = true;
    allBtn.disabled = true;
    say(id ? "正在查询…" : "正在查询全部已启用的服务商…");
    call("/balance/refresh", id ? { id: id } : {}).then(function (v) {
      busy = false;
      render(v);
      say("已更新：" + balanceTime(new Date().toISOString()));
    }).catch(function (e) {
      busy = false;
      say(e.message, true);
      if (last) render(last);
    });
  }

  function load() {
    return call("/balance/state").then(function (v) {
      if (!v.extra) drafts = null;
      // 正在输入时不覆盖（未保存的附加条目编辑保留在 drafts 中）。
      var editing = host.contains(document.activeElement) && document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName);
      if (!editing) render(v);
      if (!busy && topMsg.textContent === "正在读取…") say("");
    }).catch(function (e) { say("读取失败：" + e.message, true); });
  }

  allBtn.addEventListener("click", function () { doRefresh("", null); });
  load();
  // 卡片上方的「启用」等设置保存后立即重读（与聊天室面板共用同一通知）。
  chatroomPanelReloaders.push({ alive: function () { return host.isConnected; }, reload: function () { load(); } });
  // 停留在本页时每 30 秒同步一次（后台自动刷新的结果、低余额提示）；离开页面后停止。
  var timer = setInterval(function () {
    if (!host.isConnected) { clearInterval(timer); return; }
    if (host.offsetParent === null || busy) return;
    load();
  }, 30000);
}

function buildTrustBenchPanel(host) {
  var box = el("div");
  box.style.marginTop = "12px";
  var row = el("div", "mm-row");
  row.style.flexWrap = "wrap";
  var label = el("span", null, "判定规则 · ");
  var link = el("a", "mm-ext", "llm-gateway-bench");
  link.href = "https://github.com/cuihuan/llm-gateway-bench";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  label.append(link);
  label.style.minWidth = "11em";
  var state = el("span", "mm-msg", "正在读取…");
  var btn = el("button", "mm-btn mm-ghost", "下载安装");
  btn.type = "button";
  btn.disabled = true;
  var cancel = el("button", "mm-btn mm-ghost", "取消");
  cancel.type = "button";
  cancel.style.display = "none";
  var meta = el("div", "mm-msg", "");
  meta.style.flexBasis = "100%";
  var active = el("div", "mm-msg", "");
  active.style.flexBasis = "100%";
  var logBox = el("pre", "mm-msg");
  logBox.style.cssText = "flex-basis:100%;display:none;max-height:180px;overflow:auto;white-space:pre-wrap;margin:6px 0 0;font-size:11px;line-height:16px";
  row.append(label, state, btn, cancel, meta, active, logBox);
  box.append(row);
  host.append(box);
  var pollTimer = null;
  var wasRunning = false;

  function render(b) {
    var job = b.job || null;
    var running = !!(job && job.state === "running");
    if (running) {
      state.className = "mm-msg";
      state.textContent = (job.step || "正在下载") + (job.progress != null ? "（" + job.progress + "%）" : "");
    } else if (b.installed) {
      state.className = "mm-msg ok";
      state.textContent = "已安装" + (b.installedCommit ? " · " + String(b.installedCommit).slice(0, 12) : "") + (b.outdated ? " · 有新的钉死版本" : "");
    } else {
      state.className = job && job.state === "error" ? "mm-msg err" : "mm-msg";
      state.textContent = job && job.state === "error" ? "未安装 · 安装失败：" + (job.error || "未知错误") : "未安装";
    }
    btn.textContent = running ? "正在下载…" : b.installed ? (b.outdated ? "更新" : "重新安装") : "下载安装";
    btn.disabled = running;
    cancel.style.display = running ? "" : "none";
    meta.textContent = (b.license || "MIT") + " 许可 · 钉死提交 " + String(b.commit || "").slice(0, 12) + " · 保存位置：插件数据目录 " + (b.relDir || "tools/llm-gateway-bench") + "。从 GitHub 下载源码包，不随本插件分发。";
    if (b.active && b.active.available) active.textContent = "当前使用：" + b.active.dir;
    else if (b.active && b.active.installed) active.textContent = "llm-gateway-bench 无法加载：" + (b.active.reason || "未知错误") + "。请重新安装。";
    else active.textContent = "尚未下载 llm-gateway-bench，输入栏不显示「核验」开关。下载完成后开关自动出现，无需重启 DSH。";
    var known = !!(b.active && b.active.available);
    if (trustBenchKnown !== known) { trustBenchKnown = known; trustRefreshAll(true); }
    var log = job && job.log ? job.log : [];
    logBox.style.display = log.length ? "" : "none";
    logBox.textContent = log.join("\n");
    logBox.scrollTop = logBox.scrollHeight;
    if (running) {
      var p = job.progress == null ? "indeterminate" : (Number(job.progress) || 0);
      var w = mmWaitHandleOf("trust-bench", "bench") || mmWaitShow("正在下载 llm-gateway-bench", "trust-bench", "bench", { progress: p });
      if (w) { try { if (job.step) w.setText("llm-gateway-bench：" + job.step); w.setProgress(p); } catch (e) {} }
      startPoll();
    } else {
      if (wasRunning) {
        mmWaitClear("trust-bench", "bench");
        if (job && job.state === "done") { mmToast("llm-gateway-bench 已安装，可在输入栏打开「核验」", "ok"); trustRefreshAll(true); }
        else if (job && job.state === "error") mmToast("llm-gateway-bench 安装失败：" + (job.error || "未知错误"), "err");
      }
      stopPoll();
    }
    wasRunning = running;
  }
  function refresh() {
    return fetchJson("/trust/bench").then(function (b) {
      if (!b || b.ok === false) throw new Error((b && b.error) || "状态不可用");
      render(b);
    }).catch(function (e) {
      state.className = "mm-msg err";
      state.textContent = "暂时读不到安装状态：" + (e.message || e);
      btn.disabled = false;
    });
  }
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (!host.isConnected) { stopPoll(); return; }
      refresh();
    }, 700);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  btn.addEventListener("click", function () {
    btn.disabled = true;
    fetchJson("/trust/bench/install", { method: "POST", body: "{}" }).then(function (b) {
      if (!b || b.ok === false) throw new Error((b && b.error) || "下载失败");
      wasRunning = true;
      render(b);
      startPoll();
    }).catch(function (e) {
      btn.disabled = false;
      mmToast("llm-gateway-bench 下载失败：" + (e.message || e), "err");
    });
  });
  cancel.addEventListener("click", function () {
    fetchJson("/trust/bench/cancel", { method: "POST", body: "{}" }).then(refresh, function () {});
  });
  refresh();
}

function buildCardsPanel(host) {
  var box = el("div");
  box.style.marginTop = "12px";
  var note = el("p", "mm-sub", "牌类规则源不随本插件分发。一次下载钉死提交的 RLCard（许可证必须是 MIT）。下面每一行是一种牌自己的规则核对：二十一点、勒杜克、限注德州、UNO、斗地主。只下载到二十一点文件时，其它行不会显示为就绪。本插件不运行它的对局或智能体。");
  var list = el("div");
  box.append(note, list);
  host.append(box);
  function render(games) {
    list.textContent = "";
    (games || []).forEach(function (item) {
      var row = el("div", "mm-row");
      row.style.flexWrap = "wrap";
      var label = el("span", null, item.label + " · ");
      var link = el("a", "mm-ext", "RLCard");
      link.href = item.repo;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      label.append(link);
      var state = el("span", item.ready ? "mm-msg ok" : "mm-msg", item.ready ? "已下载" : "未下载");
      var btn = el("button", "mm-btn mm-ghost", item.ready ? "重新核对" : "下载规则源");
      btn.type = "button";
      btn.addEventListener("click", function () {
        btn.disabled = true;
        fetchJson("/cards/download", { method: "POST", body: JSON.stringify({ game: item.id }) }).then(function (body) {
          if (!body || body.ok === false) throw new Error((body && body.error) || "下载失败");
          render(body.games);
          mmToast(item.label + " 规则源已就绪", "ok");
        }).catch(function (e) {
          btn.disabled = false;
          mmToast("下载失败：" + (e.message || e), "err");
        });
      });
      var meta = el("div", "mm-msg", (item.license || "") + " · " + String(item.commit || "").slice(0, 12) + (item.note ? "。" + item.note : ""));
      meta.style.flexBasis = "100%";
      row.append(label, state, btn, meta);
      list.append(row);
    });
  }
  fetchJson("/cards/status").then(function (body) {
    if (!body || body.ok === false) throw new Error((body && body.error) || "状态不可用");
    render(body.games);
  }).catch(function (e) {
    list.textContent = "暂时读不到牌类下载状态：" + (e.message || e);
  });
}

// ── 「聊天室」设置页面板：房间、对话记录（流式）、发言与停止。核心在 src/chatroom/，这里只调同源接口。──
var CHATROOM_CSS_TAG = "dsh-workbench-chatroom-cmg";
var CHATROOM_CSS = [
  ".cr-panel{margin-top:14px;display:flex;flex-direction:column;gap:10px}",
  ".cr-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
".cr-selbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0}",
".cr-msg-sel{display:flex;gap:8px;align-items:flex-start}",
".cr-msg-sel>input[type=checkbox]{margin-top:12px;flex:none;accent-color:var(--mm-accent,#3b82f6)}",
".cr-msg-sel.selected>.cr-msg{outline:1px solid var(--mm-accent,#3b82f6);border-radius:8px}",
".cr-log.selecting .cr-msg{cursor:pointer}",
  ".cr-room{flex:1;min-width:180px}",
  ".cr-seats{display:flex;flex-direction:column;gap:6px}",
  ".cr-seat-list{display:flex;flex-direction:column;gap:6px}",
  ".cr-seats-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".cr-seats-title{flex:1;min-width:0;font-size:13px;font-weight:600}",
  ".cr-seat-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 10px;border:1px solid var(--mm-border);border-radius:8px}",
  ".cr-seat-row.off{opacity:.6}",
  ".cr-seat-row.live{border-color:var(--mm-accent)}",
  ".cr-seat-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
  ".cr-seat-name{font-size:13px;font-weight:600}",
  ".cr-seat-sub{font-size:11px;color:var(--mm-muted);white-space:normal;overflow-wrap:anywhere}",
  ".cr-seat-sub.warn{color:var(--mm-warn)}",
  ".cr-seat-row .mm-btn{padding:2px 8px;font-size:12px}",
  ".cr-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--mm-muted)}",
  ".cr-dot.ok{background:#3a3}",
  ".cr-dot.warn{background:#e55}",
  ".cr-seat{font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;border:1px solid var(--mm-border);color:var(--mm-muted);white-space:nowrap}",
  ".cr-seat.on{color:var(--mm-fg)}",
  ".cr-seat.warn{color:var(--mm-warn);border-color:var(--mm-warn-border)}",
  ".cr-seat.live{border-color:var(--mm-accent);color:var(--mm-accent)}",
  ".cr-log{display:flex;flex-direction:column;gap:8px;max-height:460px;min-height:120px;overflow:auto;padding:10px;border:1px solid var(--mm-border);border-radius:8px;background:var(--mm-input)}",
  ".cr-more-wrap{display:flex;justify-content:center;flex:none;min-width:0}",
  ".cr-more-wrap .mm-btn{max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:center;line-height:1.5}",
  ".cr-more-wrap .mm-btn:disabled{opacity:.6;cursor:default}",
  ".cr-ctxsum{flex:none;border:1px dashed var(--mm-border,#8884);border-radius:8px;padding:8px 10px;background:var(--mm-bg-soft,transparent)}",
  ".cr-ctxsum-head{font-size:12px;color:var(--mm-muted);margin-bottom:4px}",
  ".cr-ctxsum-body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}",
  ".cr-ctxlive .cr-ctxlive-state{font-size:12px;color:var(--mm-muted);margin-top:4px}",
  ".cr-ctxlive.failed .cr-ctxlive-state{color:var(--mm-danger,#c0392b)}",
  ".cr-msg{display:flex;flex-direction:column;gap:2px;max-width:88%;padding:6px 10px;border-radius:8px;border:1px solid var(--mm-border);background:var(--dsw-alias-bg-layer-2,transparent)}",
  ".cr-msg.user{align-self:flex-end;border-color:var(--mm-accent)}",
  ".cr-head{display:flex;gap:6px;align-items:baseline;font-size:11px;color:var(--mm-muted)}",
  ".cr-name{font-weight:600;color:var(--mm-fg)}",
  ".cr-text{white-space:pre-wrap;word-break:break-word;font-size:13px}",
  ".cr-usage{font-size:10px;color:var(--mm-muted)}",
  ".cr-msg.pass .cr-text,.cr-msg.stopped .cr-head{color:var(--mm-muted)}",
  ".cr-msg.error .cr-text{color:#e55}",
  ".cr-msg.streaming{border-style:dashed}",
  ".cr-empty{color:var(--mm-muted);font-size:12px;text-align:center;padding:16px 0}",
  ".cr-input{display:flex;flex-direction:column;gap:6px}",
  ".cr-input textarea{min-height:64px;resize:vertical}",
  ".cr-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".cr-state{flex:1;min-width:0;font-size:12px;color:var(--mm-muted)}",
  ".mm-page.cr-dock-root{flex:1;min-height:0;display:flex;flex-direction:column;max-width:none;padding:10px 12px;box-sizing:border-box;overflow:hidden;background:var(--dsw-alias-bg-layer-1,Canvas)}",
  ".cr-panel.cr-dock{flex:1;min-height:0;margin-top:0}",
  ".cr-dock .cr-log{flex:1;max-height:none;min-height:80px}",
  ".cr-dock .cr-seats{flex:none;max-height:40%;min-height:0;overflow:hidden}",
  ".cr-dock .cr-seats[hidden]{display:none}",
  ".cr-dock .cr-seat-list{flex:0 1 auto;min-height:0;overflow:auto}",
  ".cr-dock .cr-seat-row{padding:4px 8px}",
  ".cr-dock-title{flex:1 1 96px;min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".cr-dock-tabs{display:flex;gap:4px;flex:0 1 auto;flex-wrap:wrap;min-width:0}",
  ".cr-cm{gap:8px;min-width:0}",
  ".cr-cm-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}",
  ".cr-cm-filters select,.cr-cm-filters input{flex:1 1 110px;min-width:0;max-width:100%;box-sizing:border-box}",
  ".cr-cm-filters input{flex-basis:160px}",
  ".cr-cm-group{display:inline-flex;flex:none;align-items:stretch;border:1px solid var(--mm-border);border-radius:6px;overflow:hidden;min-width:0}",
  ".cr-cm-group .mm-btn{border-radius:0;border:0;margin:0;padding:2px 10px;font-size:12px;box-shadow:none}",
  ".cr-cm-group .mm-btn+.mm-btn{border-left:1px solid var(--mm-border)}",
  ".cr-cm-bar .cr-cm-group{margin-right:4px}",
  ".cr-cm-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--mm-muted);min-width:0}",
  ".cr-cm-bar label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:var(--mm-fg)}",
  ".cr-cm-bar .mm-btn,.cr-cm-row .mm-btn,.cr-cm-pager .mm-btn{padding:2px 10px;font-size:12px}",
  ".cr-cm-count{flex:1 1 auto;min-width:0}",
  ".cr-cm-list{flex:1;min-height:80px;overflow:auto;display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;align-content:flex-start;gap:10px 12px;padding:6px;border:1px solid var(--mm-border);border-radius:8px;background:var(--mm-input)}",
  ".cr-cm-row{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border:1px solid var(--mm-border);border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--mm-input));box-shadow:0 1px 2px rgba(0,0,0,.10),0 4px 12px rgba(0,0,0,.08);min-width:0;flex:none;box-sizing:border-box}",
".cr-cm-stack{display:flex;flex-direction:column;gap:6px;min-width:0;flex:none}",
".cr-cm-stack-head{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;min-width:0;box-sizing:border-box;width:100%;padding:2px 2px;border:0;background:transparent;color:var(--mm-fg);font:inherit;font-size:12px;text-align:left;cursor:pointer;border-radius:6px}",
".cr-cm-stack-head:focus-visible,.cr-cm-fan:focus-visible{outline:2px solid var(--mm-accent);outline-offset:2px}",
".cr-cm-stack-type{flex:0 1 auto;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".cr-cm-stack-badge{flex:none;min-width:18px;padding:0 6px;border-radius:9px;background:var(--mm-accent);color:#fff;font-size:11px;line-height:18px;text-align:center}",
".cr-cm-stack-sub{flex:1 1 auto;min-width:0;color:var(--mm-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".cr-cm-stack-hint{flex:none;color:var(--mm-muted);font-size:11px}",
".cr-cm-fan{position:relative;display:grid;width:fit-content;max-width:100%;box-sizing:border-box;align-self:flex-start;isolation:isolate;cursor:pointer;border-radius:10px;vertical-align:top;transition:transform .18s ease}",
".cr-cm-fan:hover{transform:translateY(-2px)}",
".cr-cm-face{grid-area:1/1;justify-self:start;align-self:start;position:relative;width:120px;height:180px;box-sizing:border-box;display:flex;flex-direction:column;gap:3px;padding:8px 9px;border:1px solid var(--mm-border);border-radius:10px;background:linear-gradient(var(--dsw-alias-bg-layer-2,var(--mm-input)),var(--dsw-alias-bg-layer-2,var(--mm-input))),var(--mm-pop-base,Canvas);background-color:Canvas;color:var(--mm-fg);box-shadow:0 1px 3px rgba(0,0,0,.12);transform-origin:0 50%;transition:transform .22s ease;font-size:12px;pointer-events:none}",
".cr-cm-face.back{box-shadow:none;filter:brightness(.97)}",
".cr-cm-face.back>*{visibility:hidden}",
".cr-cm-face.binned:not(.back)>*{opacity:.7}",
".cr-cm-face-type{font-size:11px;color:var(--mm-muted)}",
".cr-cm-face-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".cr-cm-face-sum{color:var(--mm-muted);font-size:11px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}",
".cr-cm-deck{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;min-width:0}",
".cr-cm-deck>.cr-cm-row{animation:cr-cm-deal .22s ease both}",
"@keyframes cr-cm-deal{from{opacity:0;transform:translate(-12px,-6px) rotate(-3deg)}to{opacity:1;transform:none}}",
"@media (prefers-reduced-motion:reduce){.cr-cm-fan,.cr-cm-face{transition:none}.cr-cm-fan:hover{transform:none}.cr-cm-deck>.cr-cm-row{animation:none}}",
  ".cr-cm-row.selected{border-color:var(--mm-accent)}",
  ".cr-cm-row.binned{opacity:.65}",
  ".cr-cm-row.binned:hover,.cr-cm-row.binned:has(.cr-card[open]){opacity:1}",
  ".cr-cm-row>input{flex:none;margin:4px 0 0}",
  ".cr-cm-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
  ".cr-cm-main .cr-card{margin-top:0;background:transparent;border:0}",
  ".cr-cm-main .cr-card>summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;padding:0;font-size:12px;color:var(--mm-fg);list-style:none;cursor:pointer}",
  ".cr-cm-main .cr-card>summary::-webkit-details-marker{display:none}",
  ".cr-cm-main .cr-card-title,.cr-cm-main .cr-card-inline{white-space:normal;overflow-wrap:anywhere}",
  ".cr-cm-main .cr-card-body{padding:4px 0 0}",
  ".cr-cm-meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;font-size:11px;color:var(--mm-muted);min-width:0}",
  ".cr-cm-meta>span{overflow-wrap:anywhere;min-width:0}",
  ".cr-cm-meta .mm-btn{margin-left:auto}",
/* 竖卡片（约 2:3）：收起的牌面与展开后的卡片同尺寸；多叠横向排列、自动换行，展开的一叠独占一行 */
".cr-cm-list>.cr-empty{flex:1 1 100%}",
".cr-cm-stack:not(.open){width:min-content;max-width:100%}",
".cr-cm-stack.open{flex:1 1 100%}",
".cr-cm-stack-head>*{min-width:0}",
".cr-cm-stack-bar{display:flex;align-items:center;gap:4px;min-width:0}",
".cr-cm-stack-bar>input{flex:none;margin:0 2px;cursor:pointer}",
".cr-cm-stack-bar>.cr-cm-stack-head{flex:1 1 auto;width:auto}",
".cr-cm-stack-badge,.cr-cm-stack-hint{flex:none}",
".cr-cm-face{padding:10px;gap:6px}",
".cr-cm-face-title{white-space:normal;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.35;flex:none}",
".cr-cm-face-sum{flex:1 1 auto;min-height:0;-webkit-line-clamp:7;line-height:1.4}",
".cr-cm-face>.cr-tag{margin-top:auto;flex:none}",
".cr-cm-deck{grid-template-columns:repeat(auto-fill,120px);gap:12px;justify-content:start}",
".cr-cm-deck>.cr-cm-row{position:relative;width:120px;height:180px;flex-direction:column;gap:0;padding:10px;overflow:hidden}",
".cr-cm-deck>.cr-cm-row>input{position:absolute;top:8px;right:8px;margin:0;z-index:1}",
".cr-cm-deck>.cr-cm-row>.cr-cm-main{flex:1 1 auto;min-height:0;width:100%;overflow:hidden}",
".cr-cm-deck>.cr-cm-row .cr-card>summary{flex-direction:column;align-items:stretch;padding-right:20px}",
".cr-cm-deck>.cr-cm-row .cr-card-title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-weight:600;line-height:1.35}",
".cr-cm-deck>.cr-cm-row .cr-card-inline{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--mm-muted)}",
".cr-cm-deck>.cr-cm-row .cr-cm-main{gap:6px}",
".cr-cm-deck>.cr-cm-row .cr-cm-meta{margin-top:auto;flex:none;font-size:10px;gap:2px 6px}",
".cr-cm-deck>.cr-cm-row .cr-cm-meta .mm-btn{margin:2px 0 0;flex:1 1 100%}",
".cr-cm-deck>.cr-cm-row.wide{grid-column:1/-1;width:auto;height:auto;overflow:visible}",
".cr-cm-deck>.cr-cm-row.wide .cr-card>summary{flex-direction:row;flex-wrap:wrap}",
".cr-cm-deck>.cr-cm-row.wide .cr-card-title,.cr-cm-deck>.cr-cm-row.wide .cr-card-inline{-webkit-line-clamp:unset;display:inline}",
".cr-cm-deck>.cr-cm-row.wide .cr-cm-meta{font-size:11px}",
".cr-cm-deck>.cr-cm-row.wide .cr-cm-meta .mm-btn{flex:none;margin-left:auto}",
  ".cr-tag.cr-st-ok{color:var(--mm-accent);border-color:var(--mm-accent)}",
  ".cr-tag.cr-st-blank{color:var(--mm-warn);border-color:var(--mm-warn)}",
  ".cr-cm-pager{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center;font-size:12px;color:var(--mm-muted)}",
  ".cr-cm-pager[hidden]{display:none}",
".cr-cs{gap:8px;min-width:0}",
".cr-cs-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--mm-muted)}",
".cr-cs-bar .mm-btn{padding:2px 10px;font-size:12px}",
".cr-cs-count{flex:1 1 auto;min-width:0}",
".cr-cs-list{flex:1;min-height:80px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--mm-border);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--mm-input))}",
".cr-cs-row{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--mm-border);border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--mm-input))}",
".cr-cs-row.continuable{border-color:var(--mm-accent)}",
".cr-cs-title{font-weight:600;font-size:13px;overflow-wrap:anywhere}",
".cr-cs-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--mm-muted)}",
".cr-cs-acts{display:flex;flex-wrap:wrap;gap:6px}",
".cr-cs-acts .mm-btn{padding:2px 10px;font-size:12px}",
".cr-cs-detail{font-size:12px;color:var(--mm-muted);white-space:pre-wrap;overflow-wrap:anywhere}",
  ".cr-dock-pages{flex:1;min-height:0;display:flex;flex-direction:column}",
  ".cr-dock-page{flex:1;min-height:0;display:flex;flex-direction:column}",
  ".cr-dock-page[hidden]{display:none}",
  ".cr-table-frame{flex:1;border:0;width:100%;min-height:0;background:var(--dsw-alias-bg-layer-1,Canvas)}",
  ".cr-dock-hint{font-size:11px;color:var(--mm-muted)}",
  ".cr-msg.system{align-self:center;max-width:96%;border-style:dashed;background:transparent}",
  ".cr-msg.system .cr-text{font-size:12px;color:var(--mm-muted)}",
  ".cr-msg.tool{max-width:96%;border-left:3px solid var(--mm-accent)}",
    ".cr-msg.tool.binned{opacity:.55;border-left-color:var(--mm-border)}",
    ".cr-msg.tool.binned:hover,.cr-msg.tool.binned:has(.cr-binned[open]){opacity:.9}",
    ".cr-binned>summary{cursor:pointer;color:var(--mm-muted);font-size:12px;padding:2px 0}",
    ".cr-binned-actions{margin-top:6px}",
  ".cr-msg.brief{max-width:96%;border:1px solid var(--mm-accent)}",
  ".cr-msg.dropped{opacity:.55}",
  ".cr-msg.pending{opacity:.7;border-style:dashed}",
  ".cr-msg.ephemeral{align-self:center;max-width:96%;border-style:dashed;border-color:#e55;background:transparent}",
  ".cr-msg.ephemeral .cr-text{font-size:12px;color:#e55}",
  ".cr-msg.dropped .cr-text{text-decoration:line-through}",
  ".cr-json{margin:4px 0 0;max-height:240px;overflow:auto;font-size:11px;white-space:pre-wrap;word-break:break-all;background:var(--mm-input);padding:6px;border-radius:6px}",
  ".cr-msg details summary{cursor:pointer;font-size:11px;color:var(--mm-muted)}",
  ".cr-card{margin-top:2px;border:1px solid var(--mm-border);border-radius:6px;background:var(--mm-input)}",
  ".cr-msg .cr-card>summary{display:flex;align-items:baseline;gap:6px;padding:4px 8px;font-size:12px;color:var(--mm-fg);list-style:none}",
  ".cr-msg .cr-card>summary::-webkit-details-marker{display:none}",
  ".cr-card>summary::before{content:'\\25B8';flex:none;color:var(--mm-muted);font-size:10px}",
  ".cr-card[open]>summary::before{content:'\\25BE'}",
  ".cr-card-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}",
  ".cr-card-inline{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mm-muted)}",
  ".cr-card.blank .cr-card-title{color:var(--mm-muted);font-weight:400}",
  ".cr-card-body{padding:0 8px 6px;display:flex;flex-direction:column;gap:4px}",
  ".cr-card-body .cr-json{margin:0;background:transparent;border:1px solid var(--mm-border);max-height:320px}",
  ".cr-card-meta{font-size:11px;color:var(--mm-muted);word-break:break-all}",
    ".cr-think{margin-top:4px;border:1px dashed var(--mm-border);border-radius:6px;background:var(--mm-input);min-width:0;max-width:100%}",
    ".cr-think>summary{cursor:pointer;padding:3px 8px;font-size:12px;color:var(--mm-muted);overflow-wrap:anywhere;user-select:none}",
    ".cr-think-body{padding:4px 8px 8px;font-size:12px;line-height:1.5;color:var(--mm-muted);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-height:360px;overflow:auto}",
    ".cr-think-note{font-size:11px;color:var(--mm-muted);padding:0 8px 6px}",
    ".cr-msg .cr-card.running>summary{flex-wrap:wrap}",
    ".cr-card-step{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".cr-steps{border:1px solid var(--mm-border);border-radius:6px;min-width:0;max-width:100%}",
    ".cr-steps>summary{cursor:pointer;padding:3px 8px;font-size:12px;color:var(--mm-muted);overflow-wrap:anywhere;user-select:none}",
    ".cr-steps-list{list-style:none;margin:0;padding:2px 8px 6px;max-height:280px;overflow:auto;font-size:12px;line-height:1.55}",
    ".cr-step{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;min-width:0;padding:1px 0;border-top:1px dotted var(--mm-border)}",
    ".cr-step:first-child{border-top:0}",
    ".cr-step-time{flex:none;color:var(--mm-muted);font-variant-numeric:tabular-nums;font-size:11px}",
    ".cr-step-tool{flex:none;padding:0 5px;border:1px solid var(--mm-border);border-radius:4px;background:var(--mm-input);color:var(--mm-fg);font-family:ui-monospace,Consolas,monospace;font-size:11px}",
    ".cr-step-target{flex:1 1 12em;min-width:0;color:var(--mm-fg);font-family:ui-monospace,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;word-break:break-all}",
    ".cr-step.say .cr-step-target{color:var(--mm-muted);font-family:inherit;font-size:12px;word-break:normal}",
    ".cr-step.think .cr-step-target{font-style:italic}",
    ".cr-elapsed{font-variant-numeric:tabular-nums}",
  ".cr-card-reason{font-size:12px;color:var(--mm-warn);white-space:pre-wrap;word-break:break-word}",
  ".cr-card-body .mm-btn{align-self:flex-start;padding:2px 10px;font-size:12px}",
  ".cr-brief-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}",
  ".cr-brief-actions .mm-btn{padding:2px 10px;font-size:12px}",
  ".cr-task{font-size:11px;color:var(--mm-muted)}",
  ".cr-disc{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--mm-accent);border-radius:8px}",
  ".cr-disc-title{font-size:13px;font-weight:600}",
  ".cr-disc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".cr-disc-row .mm-btn{padding:2px 10px;font-size:12px}",
  ".cr-disc-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;font-size:12px}",
  ".cr-hint{font-size:11px;color:var(--mm-muted);line-height:1.5}",
  ".cr-tag{font-size:10px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid var(--mm-border);color:var(--mm-muted)}",
  ".cr-atts{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}",
  ".cr-att-img{display:block;max-width:180px;max-height:140px;border-radius:6px;border:1px solid var(--mm-border);cursor:zoom-in;object-fit:cover;background:var(--mm-input)}",
  ".cr-att-file{display:inline-flex;align-items:center;gap:6px;max-width:260px;padding:4px 8px;border-radius:6px;border:1px solid var(--mm-border);background:var(--mm-input);color:var(--mm-fg);font-size:12px;text-decoration:none}",
  ".cr-att-file:hover{border-color:var(--mm-accent)}",
  ".cr-att-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
  ".cr-att-size{flex:none;color:var(--mm-muted);font-size:11px}",
  ".cr-att-audio{display:flex;flex-direction:column;gap:2px;max-width:300px}",
    ".cr-vid{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:min(560px,100%);flex:1 1 260px}",
    ".cr-vid .cr-att-file{max-width:100%}",
    ".cr-vid .cr-att-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
    ".cr-vid-card{border:1px solid var(--mm-border);border-radius:6px;background:var(--mm-input);color:var(--mm-fg);font-size:12px;min-width:0;max-width:100%}",
    ".cr-vid-card.warn{border-color:var(--mm-warn)}",
    ".cr-vid-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:4px 8px;cursor:pointer;list-style:none;user-select:none}",
    ".cr-vid-head::-webkit-details-marker{display:none}",
    ".cr-vid-head::before{content:'▸';color:var(--mm-muted);font-size:10px}",
    ".cr-vid-card[open]>.cr-vid-head::before{content:'▾'}",
    ".cr-vid-title{font-weight:600;min-width:0;overflow-wrap:anywhere}",
    ".cr-vid-state{color:var(--mm-muted);font-size:11px}",
    ".cr-vid-state.busy{color:var(--mm-accent)}",
    ".cr-vid-state.warn{color:var(--mm-warn)}",
    ".cr-vid-body{padding:6px 8px;border-top:1px solid var(--mm-border);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:320px;overflow:auto;line-height:1.5}",
    ".cr-vid-body.warn{color:var(--mm-warn)}",
    ".cr-vid-body.muted{color:var(--mm-muted)}",
    ".cr-vid-off{margin-top:4px;padding:5px 8px;border:1px dashed var(--mm-border);border-radius:6px;color:var(--mm-muted);font-size:12px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;word-break:break-word;max-width:100%;box-sizing:border-box}",
  ".cr-att-audio audio{width:280px;max-width:100%;height:32px}",
  ".cr-att-note{font-size:11px;color:var(--mm-muted)}",
  ".cr-att-note.warn{color:var(--mm-warn)}",
  ".cr-pending{display:flex;flex-wrap:wrap;gap:6px}",
  ".cr-pending:empty{display:none}",
  ".cr-chip{display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:2px 4px 2px 8px;border-radius:12px;border:1px solid var(--mm-border);background:var(--mm-input);font-size:12px;color:var(--mm-fg)}",
  ".cr-chip.uploading{opacity:.65;border-style:dashed}",
  ".cr-chip img{width:22px;height:22px;object-fit:cover;border-radius:4px}",
  ".cr-chip button{border:0;background:transparent;color:var(--mm-muted);cursor:pointer;font-size:14px;line-height:1;padding:0 4px}",
  ".cr-chip button:hover{color:var(--mm-fg)}",
  ".cr-input.drop{outline:2px dashed var(--mm-accent);outline-offset:2px;border-radius:8px}",
  ".cr-lightbox{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px}",
  ".cr-lightbox img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:8px}",
  ".cr-lightbox button{position:absolute;top:16px;right:16px;border:1px solid rgba(255,255,255,.35);border-radius:6px;background:rgba(0,0,0,.45);color:#fff;font-size:12px;padding:4px 10px;cursor:pointer}"
].join("\n");

var CR_ATTACH_MAX = 25 * 1024 * 1024;
// <cr-history-helpers> 聊天记录分页与渲染缓存的纯函数（只影响面板显示，不影响成员看到的上下文；测试从源码截取本段执行）
var CR_HISTORY_PAGE = 50;
/** 未显示的条数：已加载但不在显示窗口内的 + 服务端尚未加载的。 */
function crHiddenCount(loaded, shown, older) {
  loaded = Math.max(0, Number(loaded) || 0);
  shown = Math.max(0, Number(shown) || 0);
  return Math.max(0, loaded - Math.min(shown, loaded)) + Math.max(0, Number(older) || 0);
}
/** 顶部折叠控件的文字。 */
function crOlderLabel(hidden, page) {
  hidden = Math.max(0, Number(hidden) || 0);
  var n = Math.min(hidden, page || CR_HISTORY_PAGE);
  return "显示更早的 " + n + " 条消息" + (hidden > n ? "（共 " + hidden + " 条未显示）" : "");
}
/** 合并较早的一页：按消息编号去重，较早的在前，保持原有顺序。 */
function crMergeOlder(older, current) {
  var seen = {};
  (current || []).forEach(function (m) { if (m && m.id) seen[m.id] = true; });
  return (older || []).filter(function (m) { return m && !(m.id && seen[m.id]); }).concat(current || []);
}
/** 已加载消息中最小的有效序号（请求更早记录时的 before 参数）；没有时返回 0。 */
function crOldestSeq(list) {
  var min = 0;
  (list || []).forEach(function (m) { var q = Number(m && m.seq); if (q > 0 && (!min || q < min)) min = q; });
  return min;
}
/** 消息节点的渲染签名：内容或回收站状态不变时复用已渲染的节点，不重建。 */
function crMsgSig(m, binned, selectMode, selected) {
  var body;
  try { body = JSON.stringify(m); } catch (e) { body = String(Date.now()) + Math.random(); }
  return (binned ? "b:" : "") + (selectMode ? (selected ? "S1:" : "S0:") : "") + body;
}
/** 显示窗口的回收：停在底部且显示条数超过两页时缩回一页（较早的仍在内存中，点「显示更早」即可展开）。 */
function crTrimShown(shown, stick, page) {
  page = page || CR_HISTORY_PAGE;
  return stick && shown > page * 2 ? page : shown;
}
/** 压缩分界：已折叠进滚动摘要的消息（序号 ≤ untilSeq）与其后的消息；无序号的临时条目归入其后。 */
function crFoldSplit(list, untilSeq) {
  var u = Math.max(0, Math.floor(Number(untilSeq) || 0));
  var folded = [], rest = [];
  (list || []).forEach(function (m) {
    var q = Number(m && m.seq);
    if (u > 0 && q > 0 && q <= u) folded.push(m); else rest.push(m);
  });
  return { folded: folded, rest: rest };
}
/** 收起控件的文字。 */
function crFoldLabel(n, open) {
  n = Math.max(0, Number(n) || 0);
  return open ? "收起已压缩的 " + n + " 条消息" : "已收起 " + n + " 条已压缩的消息，点击展开";
}
/** 进入房间后的「贴底」窗口：窗口期内（默认 8 秒）且用户未主动滚动时，图片加载 / 面板尺寸变化后重新滚到底部。 */
var CR_INITIAL_STICK_MS = 8000;
function crInitialStickActive(now, until, userMoved) {
  return !userMoved && Number(until) > 0 && Number(now) < Number(until);
}
// </cr-history-helpers>
// <cr-cm-stack-helpers> 卡片管理堆叠的纯函数（只影响面板显示；测试从源码截取本段执行）
var CR_CM_GROUP_KEY = "dsh-wb.cmGroupBy";
/** 卡片管理每页显示组数（类型/轮次叠）；上下翻页按组计。筛选结果先分批拉齐再归组。 */
var CR_CM_PAGE_SIZE = 8;
/** 服务端 listCards 单次上限；客户端分批拉齐全部筛选结果后再按组分页。 */
var CR_CM_FETCH_LIMIT = 200;
/**
 * 按组分页：返回当前页的 groups，以及校正后的 page / pages / totalGroups。
 * size 缺省为 CR_CM_PAGE_SIZE；空列表仍为 1 页。
 */
function crCmSliceGroups(groups, page, size) {
  size = Math.max(1, Math.floor(Number(size) || CR_CM_PAGE_SIZE));
  var all = groups || [];
  var pages = Math.max(1, Math.ceil(all.length / size) || 1);
  var p = Math.max(0, Math.floor(Number(page) || 0));
  if (p >= pages) p = pages - 1;
  return { page: p, pages: pages, totalGroups: all.length, groups: all.slice(p * size, (p + 1) * size) };
}
/** 读取分组偏好：type = 按类型；round = 按轮次与时间。无效值回退为 type。 */
function crCmLoadGroupBy() {
  try {
    var v = String(window.localStorage.getItem(CR_CM_GROUP_KEY) || "");
    return v === "round" ? "round" : "type";
  } catch (e) { return "type"; }
}
function crCmSaveGroupBy(mode) {
  var v = mode === "round" ? "round" : "type";
  try { window.localStorage.setItem(CR_CM_GROUP_KEY, v); } catch (e) {}
  return v;
}
/** 读取分组方式：state 缺失或无效时默认 type；永不对 undefined 读 .groupBy。 */
function crCmNormGroupBy(state) {
  return (state && state.groupBy === "round") ? "round" : "type";
}
/** 卡片类型：Cursor 任务单列一类，其余按工具名。 */
function crCmTypeKey(it) {
  var d = (it && it.data) || {};
  if (d.cursorTask) return "cursor-task";
  return String((it && it.tool) || "") || "unknown";
}
function crCmTypeLabel(key) {
  if (key === "cursor-task") return "Cursor 任务";
  if (key === "unknown") return "未命名工具";
  return String(key);
}
/** 按轮次与时间归组键：优先时间精确到分钟；无有效时间时退回编号。 */
function crCmRoundKey(it) {
  var ts = it && it.ts;
  if (ts) {
    var d = new Date(ts);
    if (!isNaN(d.getTime())) {
      function p(n) { return n < 10 ? "0" + n : String(n); }
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
  }
  var seq = it && it.seq;
  return "seq:" + (seq != null && seq !== "" ? String(seq) : "?");
}
/** 轮次组标题：时间 · 编号范围（或仅编号）。 */
function crCmRoundLabel(key, items) {
  key = String(key || "");
  if (key.indexOf("seq:") === 0) {
    var s0 = key.slice(4);
    return s0 === "?" ? "轮次未知" : ("编号 " + s0);
  }
  var seqs = [];
  (items || []).forEach(function (it) {
    var n = Number(it && it.seq);
    if (isFinite(n)) seqs.push(n);
  });
  if (seqs.length) {
    seqs.sort(function (a, b) { return a - b; });
    var lo = seqs[0], hi = seqs[seqs.length - 1];
    return key + " · 编号 " + (lo === hi ? String(lo) : (lo + "–" + hi));
  }
  return key;
}
/** 卡片摘要：优先短结果，其次预览首行，最后为参数；最多 max 字。 */
function crCmSummary(it, max) {
  var d = (it && it.data) || {};
  max = max || 80;
  var t = d.ok === false ? "调用失败，成员只看到空白卡片" : (d.inline || d.preview || (it && it.text) || d.args || "");
  t = String(t).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
/**
 * 分组：mode "type"（默认）按工具类型；"round" 按轮次与时间（分钟）。
 * 组与组内顺序均保持原列表顺序（首次出现的键在前）。
 */
function crCmGroup(items, mode) {
  var byRound = mode === "round";
  var groups = [], at = {};
  (items || []).forEach(function (it) {
    if (!it) return;
    var k = byRound ? crCmRoundKey(it) : crCmTypeKey(it);
    var g = at[k];
    if (!g) {
      g = at[k] = {
        key: k,
        label: byRound ? "" : crCmTypeLabel(k),
        items: [],
        counts: { ok: 0, blank: 0, binned: 0 },
        mode: byRound ? "round" : "type",
      };
      groups.push(g);
    }
    g.items.push(it);
    if (Object.prototype.hasOwnProperty.call(g.counts, it.status)) g.counts[it.status]++;
  });
  groups.forEach(function (g) {
    g.count = g.items.length;
    if (g.mode === "round") g.label = crCmRoundLabel(g.key, g.items);
  });
  return groups;
}
/** 一组卡片的选择状态："all" 全部已选 / "some" 部分已选 / "none" 未选（空组为 "none"）。 */
function crCmSelState(ids, sel) {
  var n = 0, total = 0;
  (ids || []).forEach(function (id) { total++; if (sel && sel[id]) n++; });
  return !total || !n ? "none" : n === total ? "all" : "some";
}
// </cr-cm-stack-helpers>
function crFormatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function crAttachmentUrl(roomId, id, download) {
  return API + "/chatroom/rooms/" + encodeURIComponent(roomId) + "/attachments/" + encodeURIComponent(id) + (download ? "?download=1" : "");
}
function crLightbox(src, alt) {
  var root = el("div", "cr-lightbox");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "查看大图");
  var close = el("button", null, "关闭");
  close.type = "button";
  var img = el("img");
  img.src = src;
  img.alt = alt || "图片";
  function done() { document.removeEventListener("keydown", onKey); root.remove(); }
  function onKey(e) { if (e.key === "Escape") done(); }
  root.addEventListener("click", done);
  img.addEventListener("click", function (e) { e.stopPropagation(); });
  close.addEventListener("click", function (e) { e.stopPropagation(); done(); });
  document.addEventListener("keydown", onKey);
  root.append(close, img);
  document.body.append(root);
  close.focus();
}
/** 房间消息上的附件：图片缩略图（点击看大图）、音频播放器（含转写状态）、其余为下载卡片。 */
function crAttachmentsEl(roomId, list) {
  var box = el("div", "cr-atts");
  (list || []).forEach(function (a) {
    if (!a || !a.id) return;
    var url = crAttachmentUrl(roomId, a.id);
    if (a.kind === "image" && a.mediaType !== "image/svg+xml") {
      var img = el("img", "cr-att-img");
      img.src = url;
      img.alt = a.name || "图片";
      img.loading = "lazy";
      img.decoding = "async";
      // 预留尺寸：懒加载的图片在加载前后占位一致，向上翻看 / 展开更早消息时滚动位置不跳动
      if (Number(a.width) > 0 && Number(a.height) > 0) { img.width = Number(a.width); img.height = Number(a.height); }
      img.title = (a.name || "") + " · " + crFormatBytes(a.bytes) + (a.description ? "\n" + a.description : "");
      img.addEventListener("click", function () { crLightbox(url, a.name); });
      box.append(img);
      return;
    }
    if (a.kind === "audio") {
      var wrap = el("div", "cr-att-audio");
      var au = el("audio");
      au.controls = true;
      au.preload = "none";
      au.src = url;
      wrap.append(au);
      if (a.transcript) wrap.append(el("span", "cr-att-note", "语音已转写（见正文）"));
      else if (a.transcriptError) wrap.append(el("span", "cr-att-note warn", "转写失败：" + a.transcriptError));
      box.append(wrap);
      return;
    }
    if (a.kind === "video") { box.append(crVideoEl(roomId, a, url)); return; }
    var link = el("a", "cr-att-file");
    link.href = crAttachmentUrl(roomId, a.id, true);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = (a.name || "") + "（" + (a.mediaType || "") + "）";
    link.append(el("span", null, "📄"), el("span", "cr-att-name", a.name || a.id), el("span", "cr-att-size", crFormatBytes(a.bytes)));
    box.append(link);
  });
  return box;
}

function crClock(sec) {
  var n = Math.max(0, Math.round(Number(sec) || 0));
  var h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = n % 60;
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0") : m + ":" + String(x).padStart(2, "0");
}

// 视频附件 / 视频链接：文件或链接 + 「视频 xx · 内容描述」卡片（描述中… / 内容描述 / 失败原因；失败原因只在界面显示）
function crVideoEl(roomId, a, url) {
  var wrap = el("div", "cr-vid");
  if (a.link) {
    var lk = el("a", "cr-att-file");
    lk.href = a.link;
    lk.target = "_blank";
    lk.rel = "noopener noreferrer";
    lk.title = a.link;
    lk.append(el("span", null, "🔗"), el("span", "cr-att-name", (a.linkKind === "youtube" ? "YouTube：" : a.linkKind === "bilibili" ? "哔哩哔哩：" : "") + a.link));
    wrap.append(lk);
  } else {
    var link = el("a", "cr-att-file");
    link.href = crAttachmentUrl(roomId, a.id, true);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = (a.name || "") + "（" + (a.mediaType || "") + "）";
    link.append(el("span", null, "🎞"), el("span", "cr-att-name", a.name || a.id), el("span", "cr-att-size", crFormatBytes(a.bytes)));
    wrap.append(link);
  }
  var st = a.videoStatus;
  if (st === "off" && !a.description) {
    wrap.append(el("div", "cr-vid-off", "视频理解未启用，此视频未生成内容描述（可在「多模态 › 视频理解」中开启）。"));
    return wrap;
  }
  if (!st && !a.description) return wrap;
  var label = "视频 " + (Number(a.durationSec) > 0 ? crClock(a.durationSec) : (a.link ? (a.linkKind === "youtube" ? "YouTube" : "链接") : (a.name || ""))) + " · 内容描述";
  var card = el("details", "cr-vid-card" + (st === "failed" ? " warn" : ""));
  var sum = el("summary", "cr-vid-head");
  sum.append(el("span", "cr-vid-title", label));
  var stateText = st === "pending" ? "描述中…" : st === "failed" ? "描述失败" : (a.describedBy ? "由 " + a.describedBy + " 观看后撰写" : "");
  if (stateText) sum.append(el("span", "cr-vid-state" + (st === "pending" ? " busy" : st === "failed" ? " warn" : ""), stateText));
  card.append(sum);
  if (st === "failed") card.append(el("div", "cr-vid-body warn", "原因：" + (a.videoError || "未知原因") + "\n（成员只会看到“这张单子是空白的”，可让成员调用 watch_video 重试。）"));
  else if (a.description) card.append(el("div", "cr-vid-body", a.description));
  else card.append(el("div", "cr-vid-body muted", "Gemini 正在观看视频，完成后此处显示带时间戳的内容描述。"));
  if (st === "failed" || (a.description && st !== "pending")) card.open = false;
  wrap.append(card);
  return wrap;
}

function chatroomEnsureCss() {
  notesEnsureCss();
  if (document.querySelector('style[data-plugin-css="' + CHATROOM_CSS_TAG + '"]')) return;
  var st = document.createElement("style");
  st.dataset.plugin = "dsh-workbench";
  st.dataset.pluginCss = CHATROOM_CSS_TAG;
  st.textContent = CHATROOM_CSS;
  document.head.appendChild(st);
}

function chatroomJson(path, init) {
  return fetchJson(path, init).then(function (body) {
    if (!body || body.ok === false) throw new Error((body && (body.error || body.notice || body.reason)) || "聊天室请求失败");
    return body;
  });
}

function chatroomUsageText(u) {
  if (!u) return "";
  var bits = ["输入 " + (u.input || 0), "输出 " + (u.output || 0)];
  if (u.cacheRead) bits.push("缓存命中 " + u.cacheRead);
  if (u.cacheWrite) bits.push("缓存写入 " + u.cacheWrite);
  return bits.join(" · ") + " tokens";
}

/**
 * 「增加服务商」：DSH 不向插件开放新增服务商的接口（新增需写 DSH 设置并经凭据服务保存密钥），
 * 因此转到 DSH 自己的「设置 › 模型」页（@deepseek-ai/dsh-client-ui-settings-models，section id "models"）。
 * 本页就在同一个设置对话框里：点击其导航中的「模型」项；找不到时给出操作说明。
 */
function openDshModelSettings(host) {
  var scopeEl = (host && host.closest && host.closest('[role="dialog"]')) || document;
  var cells = Array.prototype.slice.call(scopeEl.querySelectorAll('button[class*="navCell"]'));
  var target = cells.filter(function (b) { var t = (b.textContent || "").trim(); return t === "模型" || t === "Models"; })[0];
  if (target) { target.click(); return true; }
  notesDialog({
    title: "增加服务商", alert: true, okText: "知道了",
    view: "服务商与 API Key 由 DSH 统一管理。请打开 DSH「设置 › 模型」，点击「添加模型服务商」，选择第三方服务商或自定义模型接口，填写 API Key 后保存。\n\n密钥仅保存在 DSH 的凭据存储中，本插件不读取、不保存。添加完成后回到本页，即可在机器人或席位中选择新的服务商与模型。",
    onSubmit: function () { return Promise.resolve(); }
  });
  return false;
}

// 设置保存（含「启用」旋钮）后通知已挂载的聊天室面板重新读取 /chatroom，避免面板停留在挂载时的启用状态。
var chatroomPanelReloaders = [];
function notifyChatroomPanels(value) {
  chatroomPanelReloaders = chatroomPanelReloaders.filter(function (r) { return r.alive(); });
  chatroomPanelReloaders.forEach(function (r) { try { r.reload(value); } catch (e) {} });
}

/**
 * 席位管理：维护全局席位池（PUT /chatroom/seats）。聊天室房间只从本池挑选成员。
 */
function buildSeatsPanel(host) {
  chatroomEnsureCss();
  var box = el("div", "cr-seats");
  box.style.marginTop = "8px";
  var head = el("div", "cr-seats-head");
  var addBtn = el("button", "mm-btn", "添加席位");
  var addProvBtn = el("button", "mm-btn mm-ghost", "增加服务商");
  addBtn.type = addProvBtn.type = "button";
  addProvBtn.title = "在 DSH「设置 › 模型」中添加服务商并填写 API Key。密钥由 DSH 保管，本插件不接触。";
  var note = el("span", "mm-desc", "聊天室房间与 Minecraft（经绑定聊天室）都从本池挑选成员。");
  head.append(el("span", "cr-seats-title", "席位池"), addBtn, addProvBtn);
  var listEl = el("div", "cr-seat-list");
  box.append(head, note, listEl);
  host.append(box);
  var info = { seats: [], seatsRev: "" };

  function seatList() {
    return info.seats.map(function (s) {
      var t = s.telegram || {};
      return {
        id: s.id, name: s.name, provider: s.provider, model: s.model, preset: s.preset || "",
        reasoningEffort: s.reasoningEffort || "", vision: s.vision === "on" || s.vision === "off" ? s.vision : "auto",
        imageWindow: s.imageWindow === "latest" ? "latest" : "recent9", video: !!s.video,
        timeoutSec: Number(s.timeoutSec) > 0 ? Number(s.timeoutSec) : 0,
        talents: s.talents || "", prefer: s.prefer || "", rarely: s.rarely || "", never: s.never || "",
        leader: !!s.leader, aliases: s.aliases || [], persona: s.persona || "", enabled: s.enabled !== false,
        profileId: s.profileId || "", crossSessionMemoryEnabled: s.crossSessionMemoryEnabled === true,
        telegram: { tokenRef: t.tokenRef || "", ingest: !!t.ingest, username: t.username || "" }
      };
    });
  }
  function saveSeats(list, baseRev) {
    var body = { seats: list };
    if (baseRev) body.baseRev = baseRev;
    return chatroomJson("/chatroom/seats", { method: "PUT", body: JSON.stringify(body) }).then(function (b) {
      info.seats = b.seats || [];
      info.seatsRev = b.seatsRev || "";
      try { window.dispatchEvent(new CustomEvent(ROOMCFG_EVENT, { detail: { chatroomDefaultMain: b.defaultMain, chatroomSeats: b.seats || [] } })); } catch (_) {}
      render();
    });
  }
  function updateSeats(mutate, retried) {
    return chatroomJson("/chatroom").then(function (b) {
      info.seats = b.seats || [];
      info.seatsRev = b.seatsRev || "";
      var list = seatList();
      if (mutate(list) === false) { render(); return; }
      return saveSeats(list, b.seatsRev).catch(function (e) {
        if (!retried && /已在其他位置更新/.test((e && e.message) || "")) return updateSeats(mutate, true);
        throw e;
      });
    });
  }
  function failed(e) { mmToast("保存席位失败：" + ((e && e.message) || e), "err"); render(); }
  function newSeatId(list) {
    var n = list.length + 1;
    var ids = list.map(function (x) { return x.id; });
    while (ids.indexOf("seat-" + n) >= 0) n++;
    return "seat-" + n;
  }
  function render() {
    listEl.textContent = "";
    if (!info.seats.length) {
      listEl.append(el("div", "cr-empty", "尚未添加席位。点击「添加席位」，选择智能体预设与模型。"));
      return;
    }
    info.seats.forEach(function (s, i) {
      var row = el("div", "cr-seat-row" + (s.enabled ? "" : " off"));
      var dot = el("span", "cr-dot" + (!s.enabled ? "" : s.ready ? " ok" : " warn"));
      var main = el("div", "cr-seat-main");
      main.append(el("span", "cr-seat-name", s.name));
      var sub = [(s.providerName || s.provider || "未选择服务商") + " · " + (s.modelName || s.model || "未选择模型")];
      if (s.preset) sub.push("预设：" + (s.presetName || s.preset));
      if (s.profileId) sub.push("档案：" + s.profileId);
      if (s.crossSessionMemoryEnabled) sub.push("跨会话记忆：开");
      if (s.leader) sub.push("领队");
      if (!s.enabled) sub.push("未启用");
      main.append(el("span", "cr-seat-sub", sub.join(" · ")));
      if (s.enabled && !s.ready && s.problem) main.append(el("span", "cr-seat-sub warn", s.problem));
      function btn(text, label, fn, disabled) {
        var x = el("button", "mm-btn mm-ghost", text);
        x.type = "button";
        x.setAttribute("aria-label", label);
        x.title = label;
        x.disabled = !!disabled;
        x.addEventListener("click", fn);
        return x;
      }
      row.append(dot, main,
        btn("↑", "上移 " + s.name, function () { move(i, -1); }, i === 0),
        btn("↓", "下移 " + s.name, function () { move(i, 1); }, i === info.seats.length - 1),
        btn(s.enabled ? "停用" : "启用", (s.enabled ? "停用 " : "启用 ") + s.name, function () {
          var id = s.id;
          updateSeats(function (list) { var x = list.filter(function (y) { return y.id === id; })[0]; if (!x) return false; x.enabled = !x.enabled; }).catch(failed);
        }),
        btn("编辑", "编辑 " + s.name, function () { edit(i); }),
        btn("删除", "删除 " + s.name, function () { remove(i); }));
      listEl.append(row);
    });
  }
  function move(i, d) {
    var id = info.seats[i] && info.seats[i].id;
    updateSeats(function (list) {
      var a = -1;
      list.forEach(function (x, k) { if (x.id === id) a = k; });
      var j = a + d;
      if (a < 0 || j < 0 || j >= list.length) return false;
      var t = list[a]; list[a] = list[j]; list[j] = t;
    }).catch(failed);
  }
  function remove(i) {
    var s = info.seats[i];
    notesDialog({
      title: "删除席位", okText: "删除",
      view: "确定删除席位「" + s.name + "」吗？各房间名册中的该席位会被移除；房间里已有的发言记录不受影响。",
      onSubmit: function () { var id = s.id; return updateSeats(function (list) { var a = -1; list.forEach(function (x, k) { if (x.id === id) a = k; }); if (a < 0) return false; list.splice(a, 1); }); }
    });
  }
  function edit(i) {
    var editing = i === undefined ? null : info.seats[i];
    loadModelChooser(editing && editing.provider, editing && editing.model).then(function (r) {
      return fetchJson("/gamebot/minecraft/profiles").then(function (body) {
        r.profiles = (body && body.profiles) || [];
        return r;
      }, function () { r.profiles = []; return r; });
    }).then(function (r) {
      var cat = r[0].llm || { providers: [] };
      var pre = r[1] || { presets: [] };
      var curEffort = editing ? editing.reasoningEffort || "" : "";
      var effortOpts = effortSelectOptions(r[2], curEffort);
      var tgCur = (editing && editing.telegram) || {};
      var routes = modelRouteOptions(cat, editing);
      var cur = editing && editing.provider ? editing.provider + "\u0000" + editing.model : "";
      if (!routes.length) {
        notesDialog({
          title: "暂无可用模型", alert: true, okText: "知道了",
          view: cat.available === false
            ? "DSH 的服务商服务当前不可用，无法读取模型列表。请确认 DSH 已正常启动后重试。"
            : "DSH 中尚未启用任何服务商。请先点击「增加服务商」，在 DSH「设置 › 模型」中添加服务商并填写 API Key，然后再添加席位。",
          onSubmit: function () { return Promise.resolve(); }
        });
        return;
      }
      var presetOpts = [{ value: "", label: "不使用预设" }].concat((pre.presets || []).map(function (p) { return { value: p.id, label: dshPresetLabel(p, pre.defaultId) }; }));
      var curPreset = editing ? editing.preset || "" : "";
      if (curPreset && !presetOpts.some(function (o) { return o.value === curPreset; })) presetOpts.push({ value: curPreset, label: curPreset + "（当前不可用）" });
      var profileOpts = [{ value: "", label: "不使用档案（沿用上面的服务商）" }, { value: "__new__", label: "用当前服务商，从「MC 角色」模板复制一份个人档案" }];
      (r.profiles || []).forEach(function (p) { profileOpts.push({ value: p.id, label: (p.name || p.id) + "（" + p.id + "）" }); });
      var curProfile = editing ? editing.profileId || "" : "";
      if (curProfile && !profileOpts.some(function (o) { return o.value === curProfile; })) profileOpts.push({ value: curProfile, label: curProfile + "（当前不可用）" });
      notesDialog({
        title: editing ? "编辑席位" : "添加席位",
        okText: editing ? "保存" : "添加",
        fields: [
          { key: "name", label: "显示名", value: editing ? editing.name : "", placeholder: "可选。覆盖预设名，多 AI 房间中的称呼", maxLength: 40 },
          { key: "route", label: "服务商与模型", type: "select", options: routes, value: cur || routes[0].value, hint: "列表来自 DSH「设置 › 模型」中已启用的服务商。调用经 DSH 完成，API Key 由 DSH 保管。" },
          { key: "preset", label: "智能体预设", type: "select", options: presetOpts, value: curPreset, hint: "可选。只采用预设中的人设作为该席位的系统提示；预设中的工具不会在聊天室中运行。" },
          { key: "effort", label: "推理强度", type: "select", options: effortOpts, value: curEffort },
          { key: "vision", label: "识图", type: "select", options: [{ value: "auto", label: "自动（按模型信息判断）" }, { value: "on", label: "开（始终发送图片）" }, { value: "off", label: "关（只发送文字描述）" }], value: editing && (editing.vision === "on" || editing.vision === "off") ? editing.vision : "auto" },
          { key: "imageWindow", label: "发送图片", type: "select", options: [{ value: "recent9", label: "最近 9 张" }, { value: "latest", label: "仅最新消息" }], value: editing && editing.imageWindow === "latest" ? "latest" : "recent9" },
          { key: "video", label: "视频输入", type: "select", options: editing && editing.videoCapable ? [{ value: "false", label: "关（使用内容描述与 watch_video）" }, { value: "true", label: "开（直接观看最新消息中的视频）" }] : [{ value: "false", label: "关（使用内容描述与 watch_video）" }], value: editing && editing.video ? "true" : "false" },
          { key: "timeoutSec", label: "请求等待", type: "select", options: [{ value: "0", label: "不额外等待（默认）" }, { value: "15", label: "15 秒" }, { value: "20", label: "20 秒" }, { value: "30", label: "30 秒" }, { value: "45", label: "45 秒" }, { value: "60", label: "60 秒" }], value: String(editing && Number(editing.timeoutSec) > 0 ? Number(editing.timeoutSec) : 0) },
          { key: "enabled", label: "启用", type: "select", options: [{ value: "true", label: "启用" }, { value: "false", label: "暂不启用" }], value: editing && editing.enabled === false ? "false" : "true" },
          { key: "leader", label: "领队", type: "select", options: [{ value: "false", label: "否" }, { value: "true", label: "是（全员同意后起草 Cursor 任务书）" }], value: editing && editing.leader ? "true" : "false" },
          { key: "memory", label: "跨会话记忆", type: "select", options: [{ value: "false", label: "关" }, { value: "true", label: "开（供后续记忆系统使用，本版不写入记忆文件）" }], value: editing && editing.crossSessionMemoryEnabled ? "true" : "false", hint: "只保存开关。跨会话记忆的 JSONL 写入与提示注入尚未实现。" },
          { key: "profileId", label: "个人档案", type: "select", options: profileOpts, value: curProfile, hint: "可选。Minecraft 控制会话用人设与密钥留在档案库，席位只保存档案 id。" },
          { key: "talents", label: "擅长", value: editing ? editing.talents || "" : "", placeholder: "例如：架构设计、代码审查", maxLength: 400 },
          { key: "prefer", label: "优先参与的话题", value: editing ? editing.prefer || "" : "", placeholder: "以逗号分隔", maxLength: 400 },
          { key: "rarely", label: "较少参与的话题", value: editing ? editing.rarely || "" : "", placeholder: "以逗号分隔", maxLength: 400 },
          { key: "never", label: "不参与的话题", value: editing ? editing.never || "" : "", placeholder: "以逗号分隔", maxLength: 400 },
          { key: "token", label: "Telegram 机器人令牌", type: "password", value: "", placeholder: tgCur.hasToken ? "已保存；留空则不修改，输入 - 清除" : "BotFather 签发的令牌（可选）", hint: "令牌保存在 DSH 宿主凭据中，不写入插件设置。" },
          { key: "ingest", label: "接收群消息", type: "select", options: [{ value: "false", label: "否" }, { value: "true", label: "是（全体席位中只能有一个）" }], value: tgCur.ingest ? "true" : "false" },
          { key: "persona", label: "附加人设", type: "textarea", value: editing ? editing.persona || "" : "", placeholder: "可选。追加在预设人设之后的要求。" }
        ],
        onSubmit: function (v) {
          var parts = String(v.route || "").split("\u0000");
          if (!parts[0] || !parts[1]) return Promise.reject(new Error("请选择服务商与模型"));
          var list = seatList();
          var orig = editing ? list[i] : null;
          var routeChanged = !editing || editing.provider !== parts[0] || editing.model !== parts[1];
          var prevBot = editing ? orig.telegram : {};
          var chosen = String(v.profileId || "");
          function applyProfile(profileId) {
            var seat = {
              id: editing ? editing.id : "", name: String(v.name || "").trim(), provider: parts[0], model: parts[1], preset: v.preset || "",
              reasoningEffort: routeChanged ? "" : (v.effort || ""), vision: v.vision === "on" || v.vision === "off" ? v.vision : "auto",
              imageWindow: v.imageWindow === "latest" ? "latest" : "recent9",
              video: v.video === "true" && /^(google|gemini|google-ai|google-gemini|google-generative-ai)$/i.test(parts[0]),
              timeoutSec: Number(v.timeoutSec) > 0 ? Number(v.timeoutSec) : 0, leader: v.leader === "true",
              talents: v.talents || "", prefer: v.prefer || "", rarely: v.rarely || "", never: v.never || "",
              aliases: editing ? orig.aliases : [], persona: v.persona || "", enabled: v.enabled !== "false",
              profileId: profileId || "", crossSessionMemoryEnabled: v.memory === "true",
              telegram: { tokenRef: (prevBot && prevBot.tokenRef) || "", ingest: v.ingest === "true", username: (prevBot && prevBot.username) || "" }
            };
            if (!seat.name) { var label = routes.filter(function (o) { return o.value === v.route; })[0]; seat.name = label ? label.label.split(" · ").pop().replace(/（当前不可用）$/, "") : parts[1]; }
            var apply = function (fresh) {
              var target;
              if (editing) {
                target = fresh.filter(function (x) { return x.id === seat.id; })[0];
                if (!target) throw new Error("该席位已在其他位置被删除，请刷新后重试。");
                Object.keys(seat).forEach(function (k) {
                  if (k === "id" || k === "telegram") return;
                  if (JSON.stringify(seat[k]) !== JSON.stringify(orig[k])) target[k] = seat[k];
                });
                if (seat.telegram.ingest !== !!(orig.telegram && orig.telegram.ingest)) target.telegram = Object.assign({}, target.telegram || {}, { ingest: seat.telegram.ingest });
              } else {
                seat.id = newSeatId(fresh);
                target = seat;
                fresh.push(seat);
              }
              if (target.telegram && target.telegram.ingest && (!orig || !(orig.telegram && orig.telegram.ingest))) fresh.forEach(function (x) { if (x !== target && x.telegram) x.telegram.ingest = false; });
              if (target.leader && (!orig || !orig.leader)) fresh.forEach(function (x) { if (x !== target) x.leader = false; });
            };
            var token = String(v.token || "").trim();
            return updateSeats(apply).then(function () {
              if (!token) return;
              return chatroomJson("/chatroom/seats/" + encodeURIComponent(seat.id) + "/token", { method: "PUT", body: JSON.stringify({ token: token === "-" ? "" : token }) })
                .then(function () { return chatroomJson("/chatroom/seats/" + encodeURIComponent(seat.id) + "/check", { method: "POST", body: "{}" }); })
                .then(function (c) { mmToast(token === "-" ? "已清除机器人令牌" : (c.ok ? "机器人 @" + c.username + " 已连接" : "令牌已保存，但连接检查失败：" + c.error), c.ok || token === "-" ? "info" : "err"); });
            });
          }
          if (chosen === "__new__") {
            var display = String(v.name || "").trim() || parts[1];
            return fetchJson("/gamebot/minecraft/profiles", { method: "POST", body: JSON.stringify({ templateId: "profile_mc", name: display, provider: parts[0], model: parts[1] }) }).then(function (body) {
              if (!body || !body.profile || !body.profile.id) return Promise.reject(new Error((body && body.error) || "建立档案失败"));
              return applyProfile(body.profile.id);
            });
          }
          return applyProfile(chosen);
        }
      });
    }).catch(function (e) { mmToast("读取 DSH 服务商失败：" + ((e && e.message) || e), "err"); });
  }
  addBtn.addEventListener("click", function () { edit(); });
  addProvBtn.addEventListener("click", function () { openDshModelSettings(host); });
  function reload() {
    return chatroomJson("/chatroom").then(function (b) {
      info.seats = b.seats || [];
      info.seatsRev = b.seatsRev || "";
      render();
    }).catch(function (e) { listEl.textContent = ""; listEl.append(el("div", "cr-empty", "席位读取失败：" + ((e && e.message) || e))); });
  }
  chatroomPanelReloaders.push({ alive: function () { return host.isConnected; }, reload: reload });
  reload();
}

/**
 * @param {HTMLElement} host
 * @param {{ roomId?: string, dock?: boolean }} [opts] dock：右侧停靠窗（固定房间，不显示房间下拉与成员挑选按钮）
 */
function buildChatroomPanel(host, opts) {
  opts = opts || {};
  var dock = !!opts.dock;
  chatroomEnsureCss();
  var panel = el("div", "cr-panel" + (dock ? " cr-dock" : ""));
  var bar = el("div", "cr-bar");
  var selHost = el("div", "cr-room");
  var newBtn = el("button", "mm-btn", "新建房间");
  var renameBtn = el("button", "mm-btn mm-ghost", "重命名");
  newBtn.type = renameBtn.type = "button";
  var bindBtn = el("button", "mm-btn mm-ghost", "绑定 Telegram 群");
  var rulesBtn = el("button", "mm-btn mm-ghost", "房间规则");
  var compressBtn = el("button", "mm-btn mm-ghost", "压缩上下文");
  bindBtn.type = rulesBtn.type = compressBtn.type = "button";
  bindBtn.title = "为本房间绑定一个或多个 Telegram 群聊 ID。群里的消息进入本房间，各 AI 的回复经各自的机器人发到群里。";
  rulesBtn.title = "所有成员共用的附加规则，追加在内置角色规则之后。";
  compressBtn.title = "将窗口之外的较早消息折叠为一条滚动摘要；需先在设置中选择摘要模型。详情见 README。";
  var compressState = el("span", "mm-desc cr-compress-state", "");
  compressState.setAttribute("aria-live", "polite");
  var sessionBtn = el("button", "mm-btn mm-ghost", "打开房间会话");
  sessionBtn.type = "button";
  sessionBtn.title = "在左侧会话列表中创建或恢复本房间对应的 DSH 会话。打开该会话时，右侧显示本房间。";
  var dockTitle = el("span", "cr-dock-title", "");
  var tabLog = el("button", "mm-btn", "记录");
  var tabTable = el("button", "mm-btn mm-ghost", "牌桌");
  var tabCards = el("button", "mm-btn mm-ghost", "卡片管理");
  var tabCursor = el("button", "mm-btn mm-ghost", "Cursor 会话记录");
  tabLog.type = tabTable.type = tabCards.type = tabCursor.type = "button";
  tabCards.title = "查看本房间的全部工具卡片，可按轮次与时间或按类型归组，按成员、工具、状态筛选，并收进或移出回收站。";
  tabCursor.title = "管理本房间的 Cursor 任务书：查看状态，对中断或待执行的任务一键继续（等同发送「执行 <编号>」）。";
  var dockTabs = el("div", "cr-dock-tabs");
  dockTabs.append(tabLog, tabTable, tabCards, tabCursor);
  if (dock) bar.append(dockTitle, dockTabs, renameBtn, compressBtn, compressState);
  else bar.append(selHost, newBtn, renameBtn, bindBtn, rulesBtn, compressBtn, compressState, sessionBtn);
  var seatsBox = el("div", "cr-seats");
  var seatsHead = el("div", "cr-seats-head");
  var addSeatBtn = el("button", "mm-btn mm-ghost", "从席位池添加");
  addSeatBtn.type = "button";
  addSeatBtn.title = "从「席位管理」的席位池为本房间挑选成员。席位定义请在席位管理中编辑。";
  var tgState = el("span", "cr-task", "");
  if (dock) seatsHead.append(el("span", "cr-seats-title", "成员"), tgState);
  else seatsHead.append(el("span", "cr-seats-title", "成员"), tgState, addSeatBtn);
  var seatsHint = el("span", "mm-desc", "本房间成员是席位池中的有序名单。请先在「席位管理」中创建席位，再在此挑选；不同房间可以有不同组合。");
  var seatsRow = el("div", "cr-seat-list");
  if (dock) seatsBox.append(seatsHead, seatsRow);
  else seatsBox.append(seatsHead, seatsHint, seatsRow);
  var discBox = el("div", "cr-disc");
  discBox.hidden = true;
  if (!dock) seatsBox.append(discBox);
  var log = el("div", "cr-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.setAttribute("aria-label", "聊天记录");
  var inputWrap = el("div", "cr-input");
  var ta = el("textarea", "mm-input");
  ta.placeholder = "输入消息，Ctrl+Enter 发送。发言进行中也可以插话。";
  ta.setAttribute("aria-label", "消息");
  var actions = el("div", "cr-actions");
  var sendBtn = el("button", "mm-btn", "发送");
  var contBtn = el("button", "mm-btn mm-ghost", "继续");
  var stopBtn = el("button", "mm-btn mm-ghost", "停止");
  var attachBtn = el("button", "mm-btn mm-ghost", "附件");
  sendBtn.type = contBtn.type = stopBtn.type = attachBtn.type = "button";
  attachBtn.title = "添加图片、文件或语音（单个 25 MB 以内）。也可以直接粘贴图片，或把文件拖到输入框。";
  var fileInput = el("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  var pendingBox = el("div", "cr-pending");
  pendingBox.setAttribute("aria-label", "待发送的附件");
  var state = el("span", "cr-state");
  state.setAttribute("aria-live", "polite");
  var selectBtn = el("button", "mm-btn mm-ghost", "选择");
  selectBtn.type = "button";
  selectBtn.title = "选择聊天记录中的消息并删除（仅本机桌面端）。";
  var selBar = el("div", "cr-selbar");
  selBar.hidden = true;
  selBar.setAttribute("aria-label", "消息选择");
  var selAllBtn = el("button", "mm-btn mm-ghost", "全选");
  var selDelBtn = el("button", "mm-btn mm-ghost", "删除");
  var selCancelBtn = el("button", "mm-btn mm-ghost", "取消");
  selAllBtn.type = selDelBtn.type = selCancelBtn.type = "button";
  var selCount = el("span", "mm-desc", "");
  selBar.append(selCount, selAllBtn, selDelBtn, selCancelBtn);
  actions.append(state, selectBtn, attachBtn, contBtn, stopBtn, sendBtn);
  inputWrap.append(pendingBox, ta, actions, fileInput);
  var tableFrame = null;
  var tableEmpty = null;
  var recordPage = null;
  var tablePage = null;
  var tableSeen = "";
  var showTable = false;
  var cardsPage = null;
  var cmEls = null;
  var cm = { filter: { member: "", tool: "", status: "", q: "" }, page: 0, size: CR_CM_PAGE_SIZE, sel: {}, data: null, dirty: true, timer: null, seq: 0, busy: false, open: {}, groupBy: crCmLoadGroupBy() };
  var cursorPage = null;
  var csEls = null;
  var cs = { data: null, dirty: true, timer: null, seq: 0, busy: false, detail: {} };
  if (dock) {
    ta.placeholder = "以你的身份发言，Ctrl+Enter 发送。发言进行中也可以插话。";
    var dockHint = el("div", "cr-dock-hint", "在左侧本房间会话的输入框中发送的内容，也会以你的身份进入本房间。");
    var pages = el("div", "cr-dock-pages");
    recordPage = el("div", "cr-dock-page");
    recordPage.append(log, selBar, inputWrap, dockHint);
    tablePage = el("div", "cr-dock-page");
    tablePage.hidden = true;
    tableFrame = el("iframe", "cr-table-frame");
    tableFrame.title = "牌桌";
    tableEmpty = el("div", "cr-empty", "这个房间还没有进行中的棋局或牌局。");
    tableEmpty.hidden = true;
    tablePage.append(tableFrame, tableEmpty);
    cardsPage = el("div", "cr-dock-page cr-cm");
    cardsPage.hidden = true;
    cmEls = buildCardManagerEls();
    cardsPage.append(cmEls.filters, cmEls.bar, cmEls.list, cmEls.pager);
    cursorPage = el("div", "cr-dock-page cr-cs");
    cursorPage.hidden = true;
    csEls = buildCursorSessionEls();
    cursorPage.append(csEls.bar, csEls.list);
    pages.append(recordPage, tablePage, cardsPage, cursorPage);
    panel.append(bar, seatsBox, pages);
    function setDockTab(name) {
      showTable = name === "table";
      recordPage.hidden = name !== "log";
      tablePage.hidden = !showTable;
      cardsPage.hidden = name !== "cards";
      cursorPage.hidden = name !== "cursor";
      seatsBox.hidden = name === "cards" || name === "cursor";
      tabLog.className = name === "log" ? "mm-btn" : "mm-btn mm-ghost";
      tabTable.className = showTable ? "mm-btn" : "mm-btn mm-ghost";
      tabCards.className = name === "cards" ? "mm-btn" : "mm-btn mm-ghost";
      tabCursor.className = name === "cursor" ? "mm-btn" : "mm-btn mm-ghost";
      if (showTable) refreshTable();
      if (name === "cards") cmLoad();
      if (name === "cursor") csLoad();
    }
    tabLog.addEventListener("click", function () { setDockTab("log"); });
    tabTable.addEventListener("click", function () { setDockTab("table"); });
    tabCards.addEventListener("click", function () { setDockTab("cards"); });
    tabCursor.addEventListener("click", function () { setDockTab("cursor"); });
  } else panel.append(seatsBox, bar, log, selBar, inputWrap);
  host.append(panel);

  var info = { enabled: false, seats: [], rooms: [] };
  var roomId = null;
  var messages = [];
  var cardBin = {};
  var running = false;
  var liveSeat = null;
  var liveEl = null;
  var es = null;
  var sel = null;
  var pending = []; // 待发送的附件 { name, bytes, kind, status: uploading|ready, att?, preview? }
  // 聊天记录折叠：只渲染最近 shownCount 条；olderOnServer 为服务端尚未加载的较早条数；nodeCache 按消息编号缓存已渲染节点（签名不变即复用）
  var shownCount = CR_HISTORY_PAGE, olderOnServer = 0, olderLoading = false, nodeCache = {};
  var msgSelectMode = false, msgSel = {}, msgSelBusy = false;
  // 滚动摘要与收起状态（只影响面板显示）；压缩过程的实时条目仅在本页显示，不写入聊天记录
  var ctxSummary = null, foldOpen = false, ctxLiveEl = null, ctxLiveId = "";

  function attachOn() { return !(info.attach && info.attach.settings && info.attach.settings.enabled === false); }
  function renderPending() {
    pendingBox.textContent = "";
    pending.forEach(function (p) {
      var chip = el("span", "cr-chip" + (p.status === "uploading" ? " uploading" : ""));
      if (p.preview) { var im = el("img"); im.src = p.preview; im.alt = ""; chip.append(im); }
      chip.append(el("span", "cr-att-name", p.name), el("span", "cr-att-size", p.status === "uploading" ? "上传中…" : crFormatBytes(p.bytes)));
      var x = el("button", null, "×");
      x.type = "button";
      x.title = "移除";
      x.setAttribute("aria-label", "移除附件 " + p.name);
      x.addEventListener("click", function () {
        pending = pending.filter(function (q) { return q !== p; });
        if (p.preview) { try { URL.revokeObjectURL(p.preview); } catch (e) {} }
        renderPending(); syncButtons();
      });
      chip.append(x);
      pendingBox.append(chip);
    });
  }
  function uploadFile(file) {
    if (!roomId || !file) return;
    if (!attachOn()) { mmToast("聊天室附件功能未启用，请在「附件与语音」中开启。", "err"); return; }
    var name = file.name || ("粘贴的图片-" + Date.now() + ".png");
    if (file.size > CR_ATTACH_MAX) {
      mmToast("附件「" + name + "」大小为 " + crFormatBytes(file.size) + "，超过单个附件 25 MB 的上限，未予接收。", "err");
      chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/attachments/rejected", { method: "POST", body: JSON.stringify({ name: name, bytes: file.size }) }).catch(function () {});
      return;
    }
    var item = { name: name, bytes: file.size, kind: /^image\//.test(file.type) ? "image" : "file", status: "uploading" };
    if (item.kind === "image") { try { item.preview = URL.createObjectURL(file); } catch (e) {} }
    pending.push(item);
    renderPending(); syncButtons();
    var rid = roomId;
    fetch(API + "/chatroom/rooms/" + encodeURIComponent(rid) + "/attachments", { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(name) }, body: file })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
      .then(function (b) {
        if (!b || b.ok === false) throw new Error((b && b.error) || "上传失败");
        if (rid !== roomId || pending.indexOf(item) < 0) return;
        item.status = "ready";
        item.att = b.attachment;
        renderPending(); syncButtons();
      })
      .catch(function (e) {
        pending = pending.filter(function (q) { return q !== item; });
        renderPending(); syncButtons();
        mmToast("附件上传失败：" + ((e && e.message) || e), "err");
      });
  }
  function addFiles(list) { Array.prototype.slice.call(list || []).forEach(uploadFile); }

  function seatName(id) {
    var s = info.seats.filter(function (x) { return x.id === id; })[0];
    return s ? s.name : id;
  }
  // 设置中的默认主答（名字 / 编号 / 别名，不区分大小写与空格）对应的成员。
  function isDefaultMain(s) {
    var n = function (v) { return String(v || "").trim().toLowerCase().replace(/[\s_-]+/g, ""); };
    var want = n(info.defaultMain);
    if (!want) return false;
    var hit = info.seats.filter(function (x) { return x.enabled !== false && (n(x.id) === want || n(x.name) === want || (x.aliases || []).some(function (a) { return n(a) === want; })); })[0];
    return !!hit && hit.id === s.id;
  }
  function setState(text) { state.textContent = text || ""; }
  function syncButtons() {
    var on = info.enabled && !!roomId;
    sendBtn.disabled = !on || pending.some(function (p) { return p.status === "uploading"; });
    attachBtn.disabled = !on || !attachOn();
    attachBtn.hidden = !attachOn();
    contBtn.disabled = !on || running;
    stopBtn.disabled = !running;
    newBtn.disabled = !info.enabled;
    renameBtn.disabled = !roomId;
    bindBtn.disabled = !roomId;
    sessionBtn.disabled = !info.enabled || !roomId;
    compressState.textContent = info.summarizerReady ? "" : "自动压缩未启用：请选择摘要模型";
    compressState.hidden = !!info.summarizerReady;
    addSeatBtn.disabled = running || !roomId;
    if (dock) { var cur = info.rooms.filter(function (r) { return r.id === roomId; })[0]; dockTitle.textContent = cur ? cur.title : "聊天室"; }
    ta.disabled = !on;
    if (!info.enabled) setState("聊天室未启用。打开上方「启用」后即可新建房间并发言；已有记录仍可查看。");
    else if (!roomId) setState("请先新建房间。");
    else if (running) setState(liveSeat ? seatName(liveSeat) + " 正在发言…" : "正在发言…");
    else setState("");
  }
  function poolSeats() { return Array.isArray(info.seats) ? info.seats.filter(function (s) { return s && s.id; }) : []; }
  function currentRoom() { return (info.rooms || []).filter(function (r) { return r.id === roomId; })[0]; }
  function roomSeatIds() {
    var r = currentRoom();
    return r && Array.isArray(r.memberSeatIds) ? r.memberSeatIds.slice() : [];
  }
  function roomSeats() {
    var byId = {};
    poolSeats().forEach(function (s) { byId[s.id] = s; });
    return roomSeatIds().map(function (id) { return byId[id]; }).filter(Boolean);
  }
  function saveRoomMembers(ids) {
    if (!roomId) return Promise.resolve();
    return chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/members", { method: "PUT", body: JSON.stringify({ seatIds: ids }) }).then(function (b) {
      var next = (b && b.seatIds) || ids;
      (info.rooms || []).forEach(function (r) { if (r.id === roomId) r.memberSeatIds = next; });
      renderSeats();
      syncButtons();
    });
  }
  function memberSaveFailed(e) { mmToast("保存房间成员失败：" + ((e && e.message) || e), "err"); renderSeats(); syncButtons(); }
  function renderSeats() {
    seatsRow.textContent = "";
    var members = roomSeats();
    if (!members.length) {
      var msg = !poolSeats().length
        ? "尚未添加席位。请先在「席位管理」中创建席位。"
        : (roomId ? "尚未为本房间选择席位。点击「从席位池添加」。" : "请先新建房间，再从席位池挑选成员。");
      seatsRow.append(el("div", "cr-empty", msg));
      return;
    }
    members.forEach(function (s, i) {
      try { renderSeatRow(s, i, members.length); } catch (e) {
        // 单行出错不影响其余成员：退回只显示名字
        var bad = el("div", "cr-seat-row");
        bad.append(el("span", "cr-dot warn"), el("div", "cr-seat-main", (s && s.name) || ("成员 " + (i + 1))));
        bad.title = "显示该成员时出错：" + ((e && e.message) || e);
        seatsRow.append(bad);
      }
    });
  }
  function renderSeatRow(s, i, n) {
    var row = el("div", "cr-seat-row" + (s.enabled ? "" : " off") + (running && liveSeat === s.id ? " live" : ""));
    var dot = el("span", "cr-dot" + (!s.enabled ? "" : s.ready ? " ok" : " warn"));
    var main = el("div", "cr-seat-main");
    main.append(el("span", "cr-seat-name", s.name));
    var sub = [(s.providerName || s.provider || "未选择服务商") + " · " + (s.modelName || s.model || "未选择模型")];
    if (s.preset) sub.push("预设：" + (s.presetName || s.preset));
    if (s.reasoningEffort) sub.push("推理：" + s.reasoningEffort);
    sub.push(seatVisionLabel(s));
    if (s.imageWindow === "latest") sub.push("发送图片：仅最新消息");
    if (s.video) sub.push("视频：直接观看");
    if (Number(s.timeoutSec) > 0) sub.push("请求等待 " + Number(s.timeoutSec) + " 秒");
    if (isDefaultMain(s)) sub.push("主答");
    if (s.leader) sub.push("领队");
    if (s.crossSessionMemoryEnabled) sub.push("跨会话记忆：开");
    if (s.talents) sub.push("擅长：" + s.talents);
    var tgb = s.telegram || {};
    sub.push(tgb.hasToken ? ("机器人已配置" + (tgb.ingest ? "（接收群消息）" : "")) : "未配置机器人");
    if (!s.enabled) sub.push("未参与");
    main.append(el("span", "cr-seat-sub", sub.join(" · ")));
    if (s.enabled && !s.ready && s.problem) main.append(el("span", "cr-seat-sub warn", s.problem));
    row.title = s.enabled ? (s.ready ? "可以发言" : s.problem) : "未参与发言";
    function btn(text, label, fn, disabled) {
      var x = el("button", "mm-btn mm-ghost", text);
      x.type = "button";
      x.setAttribute("aria-label", label);
      x.title = label;
      x.disabled = !!disabled || running;
      x.addEventListener("click", fn);
      return x;
    }
    if (dock) { row.append(dot, main); seatsRow.append(row); return; }
    row.append(dot, main,
      btn("↑", "上移 " + s.name, function () { moveMember(i, -1); }, i === 0),
      btn("↓", "下移 " + s.name, function () { moveMember(i, 1); }, i === n - 1),
      btn("移出", "从本房间移出 " + s.name, function () { removeMember(s); }));
    seatsRow.append(row);
  }
  // 「识图」状态：自动时显示模型信息的判断；开 / 关为手动设置。
  function seatVisionLabel(s) {
    var mode = s.vision === "on" || s.vision === "off" ? s.vision : "auto";
    if (mode === "on") return "识图：开" + (s.visionOn === false ? "（服务商拒收图片，暂改为文字描述）" : "");
    if (mode === "off") return "识图：关";
    return "识图：自动（" + (s.visionOn ? "可识图" : "仅文字描述") + "）";
  }
  function moveMember(i, d) {
    var ids = roomSeatIds();
    var j = i + d;
    if (j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    saveRoomMembers(ids).catch(memberSaveFailed);
  }
  function removeMember(s) {
    if (!s) return;
    notesDialog({
      title: "移出成员", okText: "移出",
      view: "将「" + s.name + "」从本房间移出？席位仍保留在席位池中，其他房间不受影响。",
      onSubmit: function () {
        return saveRoomMembers(roomSeatIds().filter(function (id) { return id !== s.id; }));
      }
    });
  }
  function pickSeats() {
    if (!roomId) { mmToast("请先新建房间。", "err"); return; }
    var have = {};
    roomSeatIds().forEach(function (id) { have[id] = true; });
    var pool = poolSeats();
    if (!pool.length) {
      notesDialog({
        title: "从席位池添加", alert: true, okText: "知道了",
        view: "席位池还是空的。请先打开设置中的「席位管理」，添加席位后再回到本页挑选成员。",
        onSubmit: function () { return Promise.resolve(); }
      });
      return;
    }
    var leftover = pool.filter(function (s) { return !have[s.id]; });
    if (!leftover.length) {
      notesDialog({
        title: "从席位池添加", alert: true, okText: "知道了",
        view: "席位池中的席位都已加入本房间。可在「席位管理」中新增席位，或先从本房间移出后再添加。",
        onSubmit: function () { return Promise.resolve(); }
      });
      return;
    }
    notesDialog({
      title: "从席位池添加",
      okText: "添加",
      fields: [{
        key: "ids",
        label: "选择要加入本房间的席位",
        type: "checks",
        options: leftover.map(function (s) {
          return { value: s.id, label: (s.name || s.id) + (s.enabled === false ? "（未启用）" : "") };
        }),
        hint: "不会修改席位本身。同一席位可出现在多个房间。"
      }],
      onSubmit: function (v) {
        var extra = v.ids || [];
        if (!extra.length) return Promise.reject(new Error("请至少选择一个席位"));
        return saveRoomMembers(roomSeatIds().concat(extra));
      }
    });
  }
  addSeatBtn.addEventListener("click", pickSeats);
  /** 失败回合的临时提示行：只在当前界面显示，不写入房间记录，重新打开房间后消失。 */
  function failedTurnEl(d) {
    var box = el("div", "cr-msg ephemeral");
    var head = el("div", "cr-head");
    head.append(el("span", "cr-name", d.name || seatName(d.seatId) || "成员"));
    if (d.model) head.append(el("span", null, d.model));
    if (d.at) head.append(el("span", null, notesFormatTime(d.at)));
    head.append(el("span", "cr-tag", "未计入记录"));
    box.append(head, el("div", "cr-text", "本轮回复失败：" + (d.reason || "未知错误") + "。本轮产生的内容已撤回，不会进入聊天记录，也不会提供给其他成员。"));
    return box;
  }
  function msgEl(m) {
    var n = msgElBase(m);
    if (n && m && m.id && n.setAttribute) n.setAttribute("data-mid", m.id);
    if (!msgSelectMode || !m || !m.id || m.ephemeralFailure) return n;
    var row = el("div", "cr-msg-sel" + (msgSel[m.id] ? " selected" : ""));
    row.setAttribute("data-mid", m.id);
    if (n.getAttribute) n.removeAttribute("data-mid");
    var cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!msgSel[m.id];
    cb.setAttribute("aria-label", "选择消息");
    cb.addEventListener("click", function (ev) { ev.stopPropagation(); });
    cb.addEventListener("change", function () { toggleMsgSel(m.id, cb.checked); });
    row.addEventListener("click", function (ev) {
      if (ev.target === cb) return;
      toggleMsgSel(m.id, !msgSel[m.id]);
    });
    row.append(cb, n);
    return row;
  }
  function msgElBase(m) {
    if (m.ephemeralFailure) return failedTurnEl(m.ephemeralFailure);
    // 旧版本存下的回收站操作卡片（data.binOp）：已有一行「…收进了回收站」提示，不再单独显示
    if (m.kind === "tool" && m.data && m.data.binOp) { var hb = el("div", "cr-msg tool"); hb.hidden = true; return hb; }
    if (m.kind === "tool" || m.kind === "brief" || m.kind === "system") return specialMsgEl(m);
    var kind = m.kind === "user" ? "user" : m.status || "ok";
    var box = el("div", "cr-msg " + kind);
    var head = el("div", "cr-head");
    head.append(el("span", "cr-name", (m.speaker && m.speaker.name) || ""));
    if (m.model) head.append(el("span", null, m.model));
    if (m.ts) head.append(el("span", null, notesFormatTime(m.ts)));
    if (m.status === "pass") head.append(el("span", null, "跳过本轮"));
    if (m.status === "stopped") head.append(el("span", null, "已停止"));
    if (m.status === "error") head.append(el("span", null, "出错"));
    if (m.status === "dropped") head.append(el("span", null, "已撤回（基于过时内容）"));
    if (m.source === "telegram") head.append(el("span", "cr-tag", "Telegram"));
    if (m.budgetReport) head.append(el("span", "cr-tag", "回合预算汇报"));
    if (m.handoffTo) head.append(el("span", "cr-tag", "交棒 → " + seatName(m.handoffTo)));
    box.append(head);
    var hasAtt = m.attachments && m.attachments.length;
    if (hasAtt && m.attachments.some(function (a) { return a && a.transcript; })) head.append(el("span", "cr-tag", "语音转写"));
    var text = m.status === "error" ? (m.error || "请求失败") : m.status === "pass" ? "（无补充）" : (m.text || (m.status === "stopped" ? "（未生成内容）" : ""));
    if (text || !hasAtt) box.append(el("div", "cr-text", text));
    if (m.kind === "seat" && m.status === "ok" && m.id && Number(m.thinkingChars) > 0) box.append(thinkingEl(m));
    if (hasAtt) box.append(crAttachmentsEl(roomId, m.attachments));
    if (m.videoLinks && m.videoLinks.length) box.append(crAttachmentsEl(roomId, m.videoLinks));
    var u = chatroomUsageText(m.usage);
    if (u && m.kind !== "user") box.append(el("div", "cr-usage", u));
    return box;
  }
  // 思考过程（仅您可见）：默认折叠，展开时才从本机接口读取；成员与 Telegram 都看不到。
  var thinkCache = {}, thinkOpen = {};
  // 卡片 / 执行明细的展开状态与滚动位置：原位重绘（每秒的进度更新）时保持不变
  var cardOpen = {}, stepsOpen = {}, stepsScroll = {};
  function keepOpen(det, id) {
    if (!id) return;
    if (cardOpen[id]) det.open = true;
    det.addEventListener("toggle", function () { cardOpen[id] = det.open; });
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function elapsedText(ms) {
    var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)), h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
    return h ? h + " 小时 " + pad2(mi) + " 分 " + pad2(se) + " 秒" : mi ? mi + " 分 " + pad2(se) + " 秒" : se + " 秒";
  }
  function stepTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  // 「已运行」计时：一个每秒的定时器，只更新仍在页面上的计时元素；没有时自动停止
  var elapsedEls = [], elapsedTimer = null;
  function elapsedEl(startIso) {
    var start = Date.parse(startIso);
    var sp = el("span", "cr-elapsed", isNaN(start) ? "" : elapsedText(Date.now() - start));
    if (isNaN(start)) return sp;
    sp._start = start;
    elapsedEls.push(sp);
    if (!elapsedTimer) elapsedTimer = setInterval(function () {
      elapsedEls = elapsedEls.filter(function (x) { return x.isConnected || !x._seen; });
      elapsedEls.forEach(function (x) { if (x.isConnected) { x._seen = true; x.textContent = elapsedText(Date.now() - x._start); } });
      elapsedEls = elapsedEls.filter(function (x) { return x.isConnected; });
      if (!elapsedEls.length) { clearInterval(elapsedTimer); elapsedTimer = null; }
    }, 1000);
    return sp;
  }
  // Cursor 任务的「执行明细」：时间、工具、目标（路径 / 命令），以及工具调用前的简短说明；进行中默认展开，交卷后默认收起
  function stepsEl(m, running) {
    var t = (m.data && m.data.cursorTask) || {};
    var steps = Array.isArray(t.steps) ? t.steps : [];
    if (!steps.length || !m.id) return null;
    var key = m.id;
    var total = Number(t.stepsTotal) || steps.length;
    var det = el("details", "cr-steps");
    det.open = stepsOpen[key] == null ? !!running : !!stepsOpen[key];
    det.addEventListener("toggle", function () { stepsOpen[key] = det.open; if (det.open) restore(); });
    var label = "执行明细（共 " + total + " 步" + (total > steps.length ? "，显示最近 " + steps.length + " 步" : "") + "）";
    if (!running && Number(t.durationMs) > 0) label += " · 用时 " + elapsedText(t.durationMs);
    det.append(el("summary", null, label));
    var list = el("ol", "cr-steps-list");
    steps.forEach(function (st) {
      var li = el("li", "cr-step" + (st.k === "say" || st.k === "thinking" ? " say" : "") + (st.k === "thinking" ? " think" : ""));
      li.append(el("span", "cr-step-time", stepTime(st.t)));
      if (st.k === "say" || st.k === "thinking") li.append(el("span", "cr-step-target", (st.k === "thinking" ? "💭 " : "") + (st.text || "")));
      else { li.append(el("span", "cr-step-tool", st.tool || "工具")); if (st.target) li.append(el("span", "cr-step-target", st.target)); }
      list.append(li);
    });
    list.addEventListener("scroll", function () { stepsScroll[key] = list.scrollHeight - list.scrollTop - list.clientHeight < 8 ? -1 : list.scrollTop; });
    function restore() {
      var sc = stepsScroll[key];
      requestAnimationFrame(function () { list.scrollTop = sc == null ? (running ? list.scrollHeight : 0) : sc === -1 ? list.scrollHeight : sc; });
    }
    det.append(list);
    if (det.open) restore();
    return det;
  }
  function thinkingEl(m) {
    var det = el("details", "cr-think");
    det.append(el("summary", null, "思考过程（" + Number(m.thinkingChars) + " 字，仅您可见）"));
    var body = el("div", "cr-think-body", "");
    det.append(body);
    var loading = false;
    function fill() {
      if (thinkCache[m.id] != null) { body.textContent = thinkCache[m.id]; return; }
      if (loading) return;
      loading = true;
      body.textContent = "正在读取…";
      chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/messages/" + encodeURIComponent(m.id) + "/thinking").then(function (r) {
        thinkCache[m.id] = String((r && r.text) || "") + (r && r.truncated ? "\n\n（内容过长，仅保存了前一部分）" : "");
        body.textContent = thinkCache[m.id];
      }).catch(function (e) { loading = false; body.textContent = "读取失败：" + ((e && e.message) || e); });
    }
    det.addEventListener("toggle", function () { thinkOpen[m.id] = det.open; if (det.open) fill(); });
    if (thinkOpen[m.id]) { det.open = true; fill(); }
    return det;
  }
  // 进行中的回复：思考过程实时追加在折叠块里（不展开不打扰）
  function liveThinking(text) {
    if (!liveEl) return;
    var det = liveEl.querySelector(".cr-think");
    if (!det) {
      det = el("details", "cr-think");
      det.append(el("summary", null, ""));
      det.append(el("div", "cr-think-body", ""));
      det._n = 0;
      var t = liveEl.querySelector(".cr-text");
      if (t && t.nextSibling) liveEl.insertBefore(det, t.nextSibling); else liveEl.append(det);
    }
    det._n += String(text || "").length;
    det.querySelector("summary").textContent = "思考中（" + det._n + " 字，仅您可见）";
    var b = det.querySelector(".cr-think-body");
    var stickB = det.open && b.scrollTop + b.clientHeight >= b.scrollHeight - 8;
    crAppendText(b, text);
    if (stickB) b.scrollTop = b.scrollHeight;
  }
  // 回收站里的卡片：变暗、折叠，标「已收进回收站」，展开后仍可查看，并可移出回收站。
  function specialMsgEl(m) {
    var box = specialMsgElInner(m);
    if (m.kind === "tool" && m.id && !m.pending && Object.prototype.hasOwnProperty.call(cardBin, m.id)) markBinned(box, m);
    return box;
  }
  function markBinned(box, m) {
    box.classList.add("binned");
    var head = box.querySelector(".cr-head");
    var tag = el("span", "cr-tag", "已收进回收站");
    var by = cardBin[m.id] && cardBin[m.id].by;
    if (by) tag.title = "由 " + by + " 收进回收站";
    if (head) head.append(tag);
    var det = el("details", "cr-binned");
    det.append(el("summary", null, "已折叠，点击展开"));
    Array.prototype.slice.call(box.childNodes).forEach(function (n) { if (n !== head) det.append(n); });
    var acts = el("div", "cr-binned-actions");
    var b = el("button", "mm-btn mm-ghost", "移出回收站");
    b.type = "button";
    b.addEventListener("click", function () {
      b.disabled = true;
      chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/bin", { method: "POST", body: JSON.stringify({ restore: [m.id] }) })
        .then(function (r) { if (r && r.bin) { cardBin = r.bin; renderLog({ keep: true }); } })
        .catch(function (e) { b.disabled = false; mmToast("移出回收站失败：" + ((e && e.message) || e), "err"); });
    });
    acts.append(b);
    det.append(acts);
    box.append(det);
  }
  function specialMsgElInner(m) {
    var box = el("div", "cr-msg " + m.kind + (m.pending ? " pending" : ""));
    var head = el("div", "cr-head");
    head.append(el("span", "cr-name", (m.speaker && m.speaker.name) || ""));
    var isCard = m.kind === "tool" && m.data && (m.data.resultId || m.data.cursorTask);
    if (m.kind === "tool") head.append(el("span", "cr-tag", isCard ? "卡片 · " + (m.tool || "工具") : (m.tool || "工具")));
    if (m.pending) head.append(el("span", "cr-tag", "本轮进行中"));
    if (m.kind === "brief") head.append(el("span", "cr-tag", (m.action === "read" ? "代码阅读请求" : "Cursor 任务书") + " #" + m.briefId));
    var briefState = m.kind === "brief" ? briefStatusText(m.briefStatus) : "";
    if (briefState) head.append(el("span", "cr-tag", briefState));
    if (m.ts) head.append(el("span", null, notesFormatTime(m.ts)));
    box.append(head);
    if (m.kind === "brief") {
      box.append(el("div", "cr-text", (m.title ? m.title + "\n" : "") + (m.repo ? "目录：" + m.repo + "\n\n" : "") + (m.text || "")));
      var acts = el("div", "cr-brief-actions");
      function act(label, cls, fn) { var b = el("button", cls, label); b.type = "button"; b.addEventListener("click", function () { fn(b); }); acts.append(b); return b; }
      var bs = m.briefStatus || "awaiting_owner";
      var canContinue = bs === "awaiting_owner" || bs === "interrupted" || bs === "shutdown" || bs === "fused" || bs === "no_result" || bs === "timeout" || bs === "aborted";
      if (canContinue) act(bs === "awaiting_owner" ? "执行" : "继续", "mm-btn", function (b) {
        var resume = bs !== "awaiting_owner";
        notesDialog({
          title: resume ? "继续 Cursor 任务" : "执行 Cursor 任务", okText: resume ? "继续" : "执行",
          view: (resume ? "任务书 #" + m.briefId + " 先前被中断（状态未知）。继续将先收回待执行，再" : "将") + "在「" + (m.repo || "") + "」中以 headless 模式运行 cursor-agent（--force，可修改文件）。确定吗？",
          onSubmit: function () { b.disabled = true; return chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/briefs/" + encodeURIComponent(m.briefId) + "/execute", { method: "POST", body: "{}" }).then(function () { cs.dirty = true; }); }
        });
      });
      if (bs === "awaiting_owner" || bs === "running") act(bs === "running" ? "取消执行" : "取消", "mm-btn mm-ghost", function () { chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/briefs/" + encodeURIComponent(m.briefId) + "/cancel", { method: "POST", body: "{}" }).then(function () { cs.dirty = true; }).catch(function (e) { mmToast((e && e.message) || String(e), "err"); }); });
      act("复制任务书", "mm-btn mm-ghost", function () {
        var payload = (m.title ? m.title + "\n" : "") + (m.repo ? "目录：" + m.repo + "\n\n" : "") + (m.text || "");
        if (!payload) { mmToast("任务书为空", "err"); return; }
        copyTextToClipboard(payload).then(function (ok) {
          mmToast(ok ? "任务书已复制到剪贴板" : "复制失败，请手动全选任务书", ok ? "info" : "err");
        });
      });
      box.append(acts);
      return box;
    }
    if (isCard) { box.append(toolCardEl(m)); return box; }
    box.append(el("div", "cr-text", m.text || ""));
    if (m.kind === "tool" && m.data !== undefined && !(m.data && (m.data.binOp || m.data.endRound))) {
      var det = el("details");
      det.append(el("summary", null, "完整输出（JSON）"));
      var pre = el("pre", "cr-json");
      // 折叠状态下不序列化，展开时才生成
      var filled = false;
      var fillJson = function () { if (filled) return; filled = true; try { pre.textContent = JSON.stringify(m.data, null, 2); } catch (e) { pre.textContent = String(m.data); } };
      det.addEventListener("toggle", function () { if (det.open) fillJson(); });
      det.append(pre);
      box.append(det);
    }
    return box;
  }
  function briefStatusText(st) {
    if (!st || st === "awaiting_owner") return "";
    return ({ running: "执行中", success: "已完成", failed: "失败", error: "失败", cancelled: "已取消", stopped: "已取消", interrupted: "状态未知（已中断）", shutdown: "状态未知（已中断）", fused: "已熔断", no_result: "无结果", timeout: "超时", aborted: "已中止" })[st] || "已结束";
  }
  // Cursor 任务卡片：进行中 / 空白卷（显示真实原因）；交卷后与普通卡片相同（可分页加载完整报告）。
  function cursorCardEl(m) {
    var d = m.data || {};
    var t = d.cursorTask || {};
    if (t.status !== "running" && !(d.ok === false || d.blank)) return null;
    var running = t.status === "running";
    var det = el("details", "cr-card" + (running ? " running" : " blank"));
    var sum = el("summary");
    sum.append(el("span", "cr-card-title", d.title || "Cursor 任务"));
    var tag = running ? "进行中" + (t.lastStep ? " · " + t.lastStep : "") : "空白 · " + (t.status === "cancelled" ? "已取消" : "状态未知");
    var tagEl = el("span", "cr-tag cr-card-step", tag);
    tagEl.title = tag;
    sum.append(tagEl);
    det.append(sum);
    var body = el("div", "cr-card-body");
    body.append(el("div", "cr-card-meta", (t.repo || d.repo ? "目录：" + (t.repo || d.repo) : "") + (t.startedAt ? (t.repo || d.repo ? " · " : "") + "开始于 " + notesFormatTime(t.startedAt) : "")));
    if (running) {
      var note = el("div", "cr-card-meta", "Cursor 任务进行中");
      if (t.startedAt) { note.append(document.createTextNode(" · 已运行 ")); note.append(elapsedEl(t.startedAt)); }
      note.append(document.createTextNode("；完成后在此更新。"));
      body.append(note);
    } else body.append(el("div", "cr-card-reason", "这张是空的。原因（仅您可见，成员只看到粗略原因）：" + (t.reason || m.text || "未知")));
    var stepsBox = stepsEl(m, running);
    if (stepsBox) body.append(stepsBox);
    det.append(body);
    keepOpen(det, m.id);
    return det;
  }
  // 工具结果卡片：标题（很短的结果直接显示在标题后），展开后显示预览，可加载完整内容；失败时显示真实原因。
  function toolCardEl(m) {
    var cc = m.data && m.data.cursorTask ? cursorCardEl(m) : null;
    if (cc) return cc;
    var d = m.data || {};
    var failed = d.ok === false;
    var blank = failed || !!d.blank;
    var det = el("details", "cr-card" + (blank ? " blank" : ""));
    var sum = el("summary");
    sum.append(el("span", "cr-card-title", d.title || m.tool || "工具结果"));
    if (d.inline && !blank) sum.append(el("span", "cr-card-inline", "→ " + d.inline));
    if (failed) sum.append(el("span", "cr-tag", "空白 · 失败"));
    else if (d.blank) sum.append(el("span", "cr-tag", "空白"));
    if (d.dedupeOf) sum.append(el("span", "cr-tag", "同 #" + d.dedupeOf));
    det.append(sum);
    var body = el("div", "cr-card-body");
    body.append(el("div", "cr-card-meta", (d.resultId ? "#" + d.resultId : "无结果文件") + (d.chars != null ? " · 共 " + d.chars + " 字符" : "") + (d.args && d.args !== "{}" ? " · 参数：" + String(d.args).slice(0, 300) : "")));
    if (failed) body.append(el("div", "cr-card-reason", "原因（仅您可见，成员只看到空白卡片）：" + String(m.text || "").replace(/^失败：/, "")));
    var pre = el("pre", "cr-json");
    pre.textContent = d.preview || (blank ? "" : m.text || "");
    if (pre.textContent && !failed) body.append(pre);
    var shown = String(d.preview || "").length;
    if (!failed && Number(d.chars) > shown) {
      var more = el("button", "mm-btn mm-ghost", "加载完整内容");
      more.type = "button";
      var nextOff = 0, loaded = "";
      more.addEventListener("click", function () {
        more.disabled = true;
        chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/cards/" + encodeURIComponent(d.resultId) + "?offset=" + nextOff).then(function (r) {
          loaded += r.text || "";
          pre.textContent = loaded;
          if (!pre.parentNode) body.insertBefore(pre, more);
          if (r.next != null) { nextOff = r.next; more.textContent = "继续加载（已显示 " + loaded.length + " / " + r.total + " 字符）"; more.disabled = false; }
          else more.remove();
        }).catch(function (e) { more.disabled = false; mmToast((e && e.message) || String(e), "err"); });
      });
      body.append(more);
    }
    if (d.cursorTask) { var doneSteps = stepsEl(m, false); if (doneSteps) body.append(doneSteps); }
    det.append(body);
    keepOpen(det, m.id);
    return det;
  }
  // ── 卡片管理（停靠窗「卡片管理」页）：服务端筛选；客户端拉齐结果后按组（类型/轮次）分页；选择限于当前筛选结果，可跨页；新卡片 / 回收站变化时自动刷新。──
  function buildCardManagerEls() {
    var e = {};
    e.filters = el("div", "cr-cm-filters");
    e.member = el("select", "mm-input"); e.member.setAttribute("aria-label", "按成员筛选");
    e.tool = el("select", "mm-input"); e.tool.setAttribute("aria-label", "按工具筛选");
    e.status = el("select", "mm-input"); e.status.setAttribute("aria-label", "按状态筛选");
    e.q = el("input", "mm-input"); e.q.type = "search"; e.q.placeholder = "搜索标题或参数"; e.q.setAttribute("aria-label", "搜索标题或参数");
    e.filters.append(e.member, e.tool, e.status, e.q);
    e.bar = el("div", "cr-cm-bar");
    var lab = el("label");
    e.all = el("input"); e.all.type = "checkbox";
    lab.append(e.all, el("span", null, "全选筛选结果"));
    e.count = el("span", "cr-cm-count", "");
    e.sweep = el("button", "mm-btn mm-ghost", "收进回收站");
    e.restore = el("button", "mm-btn mm-ghost", "移出回收站");
    e.clear = el("button", "mm-btn mm-ghost", "清除选择");
    e.sweep.type = e.restore.type = e.clear.type = "button";
    e.group = el("div", "cr-cm-group");
    e.group.setAttribute("role", "group");
    e.group.setAttribute("aria-label", "卡片分组方式");
    e.groupRound = el("button", "mm-btn mm-ghost", "轮次与时间");
    e.groupType = el("button", "mm-btn mm-ghost", "类型");
    e.groupRound.type = e.groupType.type = "button";
    e.groupRound.title = "按轮次编号与时间归组显示";
    e.groupType.title = "按工具类型归组显示";
    e.groupRound.setAttribute("aria-pressed", "false");
    e.groupType.setAttribute("aria-pressed", "false");
    e.group.append(e.groupRound, e.groupType);
    function cmSetGroupBy(mode, persist) {
      if (!cm) return;
      var next = mode === "round" ? "round" : "type";
      if (crCmNormGroupBy(cm) === next) { cmSyncGroupBtns(); return; }
      cm.groupBy = next;
      cm.open = {};
      cm.page = 0;
      if (persist !== false) crCmSaveGroupBy(next);
      cmSyncGroupBtns();
      cmRender();
    }
    function cmSyncGroupBtns() {
      var roundOn = crCmNormGroupBy(cm) === "round";
      e.groupRound.className = roundOn ? "mm-btn" : "mm-btn mm-ghost";
      e.groupType.className = roundOn ? "mm-btn mm-ghost" : "mm-btn";
      e.groupRound.setAttribute("aria-pressed", roundOn ? "true" : "false");
      e.groupType.setAttribute("aria-pressed", roundOn ? "false" : "true");
    }
    e.groupRound.addEventListener("click", function () { cmSetGroupBy("round"); });
    e.groupType.addEventListener("click", function () { cmSetGroupBy("type"); });
    cmSyncGroupBtns();
    e.bar.append(e.group, lab, e.count, e.sweep, e.restore, e.clear);
    e.list = el("div", "cr-cm-list");
    e.list.setAttribute("aria-label", "工具卡片列表");
    e.pager = el("div", "cr-cm-pager");
    e.prev = el("button", "mm-btn mm-ghost", "上一页");
    e.next = el("button", "mm-btn mm-ghost", "下一页");
    e.prev.type = e.next.type = "button";
    e.pageInfo = el("span", null, "");
    e.pager.append(e.prev, e.pageInfo, e.next);
    e.pager.hidden = true;
    function setFilter(k, v) { cm.filter[k] = v; cm.page = 0; cmLoad(); }
    e.member.addEventListener("change", function () { setFilter("member", e.member.value); });
    e.tool.addEventListener("change", function () { setFilter("tool", e.tool.value); });
    e.status.addEventListener("change", function () { setFilter("status", e.status.value); });
    var qt = null;
    e.q.addEventListener("input", function () { clearTimeout(qt); qt = setTimeout(function () { setFilter("q", e.q.value.trim()); }, 250); });
    e.all.addEventListener("change", function () {
      var ids = (cm.data && cm.data.ids) || [];
      if (e.all.checked) ids.forEach(function (id) { cm.sel[id] = true; }); else cm.sel = {};
      cmSyncChecks();
    });
    e.clear.addEventListener("click", function () { cm.sel = {}; cmSyncChecks(); });
    e.sweep.addEventListener("click", function () { cmAct("sweep", Object.keys(cm.sel)); });
    e.restore.addEventListener("click", function () { cmAct("restore", Object.keys(cm.sel)); });
    e.prev.addEventListener("click", function () { if (cm.page > 0) { cm.page--; cmRender(); } });
    e.next.addEventListener("click", function () {
      var g = crCmGroup((cm.data && cm.data.items) || [], crCmNormGroupBy(cm));
      var sl = crCmSliceGroups(g, cm.page, cm.size);
      if (cm.page < sl.pages - 1) { cm.page++; cmRender(); }
    });
    return e;
  }
  function cmVisible() { return !!(cardsPage && !cardsPage.hidden); }
  function cmSchedule() {
    cm.dirty = true;
    if (!cmVisible()) return;
    clearTimeout(cm.timer);
    cm.timer = setTimeout(cmLoad, 300);
  }
  function csVisible() { return !!(cursorPage && !cursorPage.hidden); }
  function csSchedule() {
    cs.dirty = true;
    if (!csVisible()) return;
    clearTimeout(cs.timer);
    cs.timer = setTimeout(function () { csLoad(true); }, 300);
  }
  function buildCursorSessionEls() {
    var e = {};
    e.bar = el("div", "cr-cs-bar");
    e.count = el("span", "cr-cs-count", "");
    e.refresh = el("button", "mm-btn mm-ghost", "刷新");
    e.refresh.type = "button";
    e.bar.append(e.count, e.refresh);
    e.list = el("div", "cr-cs-list");
    e.refresh.addEventListener("click", function () { cs.dirty = true; csLoad(true); });
    return e;
  }
  function csStatusLabel(st) {
    return ({ awaiting_owner: "待执行", running: "进行中", success: "已完成", failed: "失败", error: "失败", cancelled: "已取消", stopped: "已取消", interrupted: "状态未知（已中断）", shutdown: "状态未知（已中断）", fused: "已熔断", no_result: "无结果", timeout: "超时", aborted: "已中止" })[st] || (st || "未知");
  }
  function csLoad(force) {
    if (!csEls) return;
    clearTimeout(cs.timer);
    if (!force && !cs.dirty && cs.data) { csRender(); return; }
    if (!roomId) { cs.data = null; csRender(); return; }
    cs.dirty = false;
    var my = ++cs.seq;
    var rid = roomId;
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(rid) + "/briefs").then(function (r) {
      if (my !== cs.seq || rid !== roomId) return;
      cs.data = r;
      csRender();
    }).catch(function (e) {
      if (my !== cs.seq) return;
      csEls.list.textContent = "";
      csEls.list.append(el("div", "cr-empty", "读取 Cursor 会话记录失败：" + ((e && e.message) || e)));
    });
  }
  function csRender() {
    if (!csEls) return;
    var e = csEls, r = cs.data;
    var items = (r && r.items) || [];
    var nCont = items.filter(function (x) { return x.continuable; }).length;
    e.count.textContent = r ? ("共 " + items.length + " 条" + (nCont ? "，可继续 " + nCont + " 条" : "")) : "";
    e.list.textContent = "";
    if (!roomId) { e.list.append(el("div", "cr-empty", "暂无房间。")); return; }
    if (!r) { e.list.append(el("div", "cr-empty", "正在读取…")); return; }
    if (!items.length) { e.list.append(el("div", "cr-empty", "这个房间还没有 Cursor 任务书。交卷卡片或中断后的任务会出现在这里。")); return; }
    items.forEach(function (it) { e.list.append(csRowEl(it)); });
  }
  function csRowEl(it) {
    var row = el("div", "cr-cs-row" + (it.continuable ? " continuable" : ""));
    row.append(el("div", "cr-cs-title", (it.title || "（无标题）") + "  ·  #" + it.id));
    var meta = el("div", "cr-cs-meta");
    meta.append(el("span", "cr-tag", csStatusLabel(it.status)));
    if (it.byName || it.by) meta.append(el("span", null, "席位：" + (it.byName || it.by)));
    if (it.at) meta.append(el("span", null, notesFormatTime(it.at)));
    if (it.repo) meta.append(el("span", null, "目录：" + it.repo));
    if (it.cardId) meta.append(el("span", null, "卡片：" + it.cardId));
    if (it.pending) meta.append(el("span", "cr-tag", "当前待执行"));
    row.append(meta);
    var acts = el("div", "cr-cs-acts");
    if (it.continuable) {
      var cont = el("button", "mm-btn", it.status === "awaiting_owner" ? "执行" : "继续");
      cont.type = "button";
      cont.disabled = cs.busy;
      cont.addEventListener("click", function () { csContinue(it, cont); });
      acts.append(cont);
    }
    if (it.cancellable) {
      var can = el("button", "mm-btn mm-ghost", it.status === "running" ? "取消执行" : "取消");
      can.type = "button";
      can.disabled = cs.busy;
      can.addEventListener("click", function () {
        cs.busy = true; can.disabled = true;
        chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/briefs/" + encodeURIComponent(it.id) + "/cancel", { method: "POST", body: "{}" })
          .then(function () { mmToast("已取消任务书 #" + it.id, "info"); cs.dirty = true; csLoad(true); })
          .catch(function (err) { mmToast((err && err.message) || String(err), "err"); })
          .finally(function () { cs.busy = false; });
      });
      acts.append(can);
    }
    var detBtn = el("button", "mm-btn mm-ghost", cs.detail[it.id] ? "收起详情" : "详情");
    detBtn.type = "button";
    detBtn.addEventListener("click", function () {
      cs.detail[it.id] = !cs.detail[it.id];
      csRender();
    });
    acts.append(detBtn);
    row.append(acts);
    if (cs.detail[it.id]) {
      row.append(el("div", "cr-cs-detail",
        "编号：" + it.id +
        "\n状态：" + csStatusLabel(it.status) + "（" + (it.status || "") + "）" +
        "\n动作：" + (it.action || "") +
        (it.sessionId ? "\nCursor session：" + it.sessionId : "") +
        (it.msgId ? "\n任务书消息：" + it.msgId : "") +
        (it.cardId ? "\n关联卡片：" + it.cardId : "") +
        "\n说明：中断后点「继续」会自动收回待执行并启动，无需手改 meta.json。Telegram「执行 <编号>」仍然可用。"
      ));
    }
    return row;
  }
  function csContinue(it, btn) {
    var resume = it.status !== "awaiting_owner";
    notesDialog({
      title: resume ? "继续 Cursor 任务" : "执行 Cursor 任务",
      okText: resume ? "继续" : "执行",
      view: (resume ? "任务书 #" + it.id + " 先前被中断（" + csStatusLabel(it.status) + "）。继续将先收回待执行，再" : "将") +
        "在「" + (it.repo || "") + "」中以 headless 模式运行 cursor-agent（--force，可修改文件）。确定吗？",
      onSubmit: function () {
        cs.busy = true; if (btn) btn.disabled = true;
        return chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/briefs/" + encodeURIComponent(it.id) + "/execute", { method: "POST", body: "{}" })
          .then(function () { mmToast((resume ? "已继续" : "已开始执行") + " #" + it.id, "info"); cs.dirty = true; csLoad(true); })
          .finally(function () { cs.busy = false; });
      }
    });
  }
  function cmLoad() {
    if (!cmEls) return;
    clearTimeout(cm.timer);
    if (!roomId) { cm.data = null; cmRender(); return; }
    cm.dirty = false;
    var my = ++cm.seq;
    var rid = roomId;
    // 按组分页需要完整筛选结果再归组；服务端单次上限 CR_CM_FETCH_LIMIT，分批拉齐。
    function pull(offset, acc, meta) {
      var q = new URLSearchParams();
      Object.keys(cm.filter).forEach(function (k) { if (cm.filter[k]) q.set(k, cm.filter[k]); });
      q.set("offset", String(offset));
      q.set("limit", String(CR_CM_FETCH_LIMIT));
      return chatroomJson("/chatroom/rooms/" + encodeURIComponent(rid) + "/cards?" + q.toString()).then(function (r) {
        if (my !== cm.seq || rid !== roomId) return null;
        var items = acc.concat(r.items || []);
        var nextMeta = meta || r;
        if (items.length < (r.total || 0) && (r.items || []).length > 0) {
          return pull(offset + r.items.length, items, nextMeta);
        }
        return { r: nextMeta, items: items };
      });
    }
    pull(0, [], null).then(function (pack) {
      if (!pack || my !== cm.seq || rid !== roomId) return;
      var r = pack.r;
      var items = pack.items;
      var keep = {};
      (r.ids || []).forEach(function (id) { if (cm.sel[id]) keep[id] = true; });
      cm.sel = keep;
      cm.data = Object.assign({}, r, { items: items, offset: 0, limit: items.length });
      var sl = crCmSliceGroups(crCmGroup(items, crCmNormGroupBy(cm)), cm.page, cm.size);
      cm.page = sl.page;
      cmRender();
    }).catch(function (e) {
      if (my !== cm.seq) return;
      cmEls.list.textContent = "";
      cmEls.list.append(el("div", "cr-empty", "读取卡片失败：" + ((e && e.message) || e)));
    });
  }
  var CM_STATUS = { ok: "正常", blank: "空白或失败", binned: "已收进回收站" };
  function cmFillSelect(sel, first, opts, value) {
    sel.textContent = "";
    var o0 = el("option", null, first); o0.value = ""; sel.append(o0);
    var found = !value;
    opts.forEach(function (o) { var op = el("option", null, o.label); op.value = o.value; if (o.value === value) found = true; sel.append(op); });
    if (!found) { var lost = el("option", null, value); lost.value = value; sel.append(lost); }
    sel.value = value || "";
  }
  function cmChars(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return "";
    return n < 10000 ? n + " 字符" : (n / 10000).toFixed(1).replace(/\.0$/, "") + " 万字符";
  }
  function cmRender() {
    if (!cmEls) return;
    var e = cmEls, r = cm.data;
    var c = (r && r.counts) || { all: 0, ok: 0, blank: 0, binned: 0 };
    cmFillSelect(e.member, "所有成员", ((r && r.members) || []).map(function (m) { return { value: m.id, label: m.name || m.id }; }), cm.filter.member);
    cmFillSelect(e.tool, "所有工具", ((r && r.tools) || []).map(function (t) { return { value: t, label: t }; }), cm.filter.tool);
    cmFillSelect(e.status, "全部状态（" + c.all + "）", ["ok", "blank", "binned"].map(function (k) { return { value: k, label: CM_STATUS[k] + "（" + (c[k] || 0) + "）" }; }), cm.filter.status);
    cmRenderBar();
    // 刷新时保留已展开的卡片与滚动位置
    var opened = {};
    Array.prototype.forEach.call(e.list.querySelectorAll(".cr-cm-row"), function (row) { var dt = row.querySelector(".cr-card"); if (dt && dt.open) opened[row.dataset.id] = true; });
    var top = e.list.scrollTop;
    e.list.textContent = "";
    if (!roomId) { e.list.append(el("div", "cr-empty", "暂无房间。")); e.pager.hidden = true; return; }
    if (!r) { e.list.append(el("div", "cr-empty", "正在读取…")); e.pager.hidden = true; return; }
    if (!r.items.length) e.list.append(el("div", "cr-empty", c.all ? "没有符合条件的卡片。" : "这个房间还没有工具卡片。"));
    // 先按类型/轮次归组，再按组分页（每页 CR_CM_PAGE_SIZE 组）；展开状态跨刷新保留
    var allGroups = crCmGroup(r.items, crCmNormGroupBy(cm));
    var sliced = crCmSliceGroups(allGroups, cm.page, cm.size);
    cm.page = sliced.page;
    cm.groupTotal = sliced.totalGroups;
    sliced.groups.forEach(function (g) { e.list.append(cmStackEl(g, opened)); });
    if (e.groupRound && e.groupType) {
      var roundOn = crCmNormGroupBy(cm) === "round";
      e.groupRound.className = roundOn ? "mm-btn" : "mm-btn mm-ghost";
      e.groupType.className = roundOn ? "mm-btn mm-ghost" : "mm-btn";
      e.groupRound.setAttribute("aria-pressed", roundOn ? "true" : "false");
      e.groupType.setAttribute("aria-pressed", roundOn ? "false" : "true");
    }
    e.list.scrollTop = top;
    e.pager.hidden = sliced.totalGroups <= cm.size;
    e.pageInfo.textContent = "第 " + (cm.page + 1) + " / " + sliced.pages + " 页";
    e.prev.disabled = cm.page <= 0;
    e.next.disabled = cm.page >= sliced.pages - 1;
  }
  // 选择变化只更新勾选框与操作栏，不重建列表（已展开的卡片和已加载的内容保持不变）
  function cmRenderBar() {
    var e = cmEls, r = cm.data;
    var ids = (r && r.ids) || [];
    var nSel = Object.keys(cm.sel).length;
    e.all.checked = !!ids.length && nSel === ids.length;
    e.all.indeterminate = nSel > 0 && nSel < ids.length;
    e.all.disabled = !ids.length || cm.busy;
    var nGrp = r ? crCmGroup(r.items || [], crCmNormGroupBy(cm)).length : 0;
    e.count.textContent = r ? ("共 " + r.total + " 张 · " + nGrp + " 组" + (nSel ? "，已选 " + nSel + " 张" : "")) : "";
    e.sweep.disabled = e.restore.disabled = !nSel || cm.busy;
    e.clear.hidden = !nSel;
  }
  function cmSyncTypeCheck(cb) {
    var st = crCmSelState(cb._ids, cm.sel);
    cb.checked = st === "all";
    cb.indeterminate = st === "some";
    cb.disabled = cm.busy;
  }
  function cmSyncChecks() {
    Array.prototype.forEach.call(cmEls.list.querySelectorAll(".cr-cm-stack-all"), cmSyncTypeCheck);
    Array.prototype.forEach.call(cmEls.list.querySelectorAll(".cr-cm-row"), function (row) {
      var on = !!cm.sel[row.dataset.id];
      row.classList.toggle("selected", on);
      var cb = row.querySelector("input[type=checkbox]");
      if (cb) cb.checked = on;
    });
    cmRenderBar();
  }
  /** 一叠卡片：收起时按 mmFanTransform 弧形叠放并显示张数；点击或回车展开为卡片网格，Esc 或再次点击标题收起。 */
  /** 卡片管理专用：后排卡片向右展开（每层右移 16px、几乎不下移、轻微旋转）。不改多模态共用的 mmFanTransform。 */
  function cmFanTransform(depth) {
    if (!depth) return "none";
    return "translate(" + (depth * 16) + "px, " + (depth * 1) + "px) rotate(" + (depth * 1.5) + "deg)";
  }
  function cmStackEl(g, opened) {
    var isOpen = !!cm.open[g.key];
    var wrap = el("section", "cr-cm-stack" + (isOpen ? " open" : ""));
    wrap.dataset.type = g.key;
    wrap.setAttribute("aria-label", g.label + "，共 " + g.count + " 张卡片");
    var head = el("button", "cr-cm-stack-head");
    head.type = "button";
    head.setAttribute("aria-expanded", isOpen ? "true" : "false");
    var sub = [];
    if (g.counts.blank) sub.push("空白或失败 " + g.counts.blank + " 张");
    if (g.counts.binned) sub.push("已收进回收站 " + g.counts.binned + " 张");
    head.append(el("span", "cr-cm-stack-type", g.label), el("span", "cr-cm-stack-badge", String(g.count)), el("span", "cr-cm-stack-sub", sub.join("，")), el("span", "cr-cm-stack-hint", isOpen ? "收起" : "展开"));
    head.title = isOpen ? "收起这一叠卡片（Esc）" : "展开这一叠卡片";
    function toggle(v) {
      if (v) cm.open[g.key] = true; else delete cm.open[g.key];
      var keepOpen = {};
      Array.prototype.forEach.call(wrap.querySelectorAll(".cr-cm-row"), function (row) { var dt = row.querySelector(".cr-card"); if (dt && dt.open) keepOpen[row.dataset.id] = true; });
      var next = cmStackEl(g, keepOpen);
      wrap.replaceWith(next);
      var h2 = next.querySelector(".cr-cm-stack-head");
      if (h2) h2.focus();
    }
    head.addEventListener("click", function () { toggle(!isOpen); });
    // 按类型全选：只作用于本页这一叠；不展开 / 收起
    var all = el("input", "cr-cm-stack-all"); all.type = "checkbox";
    all.setAttribute("aria-label", (g.mode === "round" ? "全选本组：" : "全选此类：") + g.label);
    all.title = g.mode === "round" ? "全选本组" : "全选此类";
    all._ids = g.items.map(function (it) { return it.id; });
    cmSyncTypeCheck(all);
    all.addEventListener("click", function (ev) { ev.stopPropagation(); });
    all.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
    all.addEventListener("change", function () {
      all._ids.forEach(function (id) { if (all.checked) cm.sel[id] = true; else delete cm.sel[id]; });
      cmSyncChecks();
    });
    var bar = el("div", "cr-cm-stack-bar");
    bar.append(all, head);
    wrap.append(bar);
    if (isOpen) {
      var deck = el("div", "cr-cm-deck");
      deck.setAttribute("role", "list");
      g.items.forEach(function (it, i) {
        var row = cmRowEl(it);
        row.setAttribute("role", "listitem");
        row.style.animationDelay = Math.min(i, 8) * 30 + "ms";
        if (opened && opened[it.id]) { var dt = row.querySelector(".cr-card"); if (dt) dt.open = true; }
        deck.append(row);
      });
      wrap.append(deck);
      wrap.addEventListener("keydown", function (ev) {
        if (ev.key !== "Escape") return;
        ev.preventDefault(); ev.stopPropagation();
        toggle(false);
      });
    } else {
      var spread = Math.min(Math.max(g.count - 1, 0), 4);
      var fan = el("div", "cr-cm-fan");
      fan.setAttribute("role", "button");
      fan.tabIndex = 0;
      fan.setAttribute("aria-label", "展开「" + g.label + "」，共 " + g.count + " 张卡片");
      fan.title = "点击展开这一叠卡片";
      fan.style.paddingRight = (spread * 16 + 12) + "px";
      fan.style.paddingBottom = (spread ? spread * 3 + 10 : 4) + "px";
      g.items.slice(0, 5).forEach(function (it, depth) {
        var d = it.data || {};
        var face = el("div", "cr-cm-face" + (depth ? " back" : "") + (it.status === "binned" ? " binned" : ""));
        face.style.zIndex = String(depth ? 10 - depth : 20);
        face.style.transform = cmFanTransform(depth);
        if (depth) face.setAttribute("aria-hidden", "true");
        face.append(el("div", "cr-cm-face-type", (g.mode === "round" ? crCmTypeLabel(crCmTypeKey(it)) : g.label) + (it.member && it.member.name ? " · " + it.member.name : "")));
        face.append(el("div", "cr-cm-face-title", d.title || it.tool || "工具结果"));
        var sm = crCmSummary(it, 80);
        if (sm) face.append(el("div", "cr-cm-face-sum", sm));
        var tg = el("span", "cr-tag cr-st-" + it.status, CM_STATUS[it.status] || it.status);
        tg.style.alignSelf = "flex-start";
        face.append(tg);
        fan.append(face);
      });
      fan.addEventListener("click", function () { toggle(true); });
      fan.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(true); } });
      wrap.append(fan);
    }
    return wrap;
  }
  function cmRowEl(it) {
    var row = el("div", "cr-cm-row" + (it.status === "binned" ? " binned" : "") + (cm.sel[it.id] ? " selected" : ""));
    row.dataset.id = it.id;
    var cb = el("input"); cb.type = "checkbox"; cb.checked = !!cm.sel[it.id];
    var title = (it.data && it.data.title) || it.tool || "工具结果";
    cb.setAttribute("aria-label", "选择卡片 " + title);
    cb.addEventListener("change", function () { if (cb.checked) cm.sel[it.id] = true; else delete cm.sel[it.id]; row.classList.toggle("selected", cb.checked); cmSyncChecks(); });
    var main = el("div", "cr-cm-main");
    main.append(toolCardEl({ tool: it.tool, text: it.text, data: it.data || {} }));
    // 竖卡片打开详情时横跨整行（toggle 不冒泡，用捕获监听）
    row.addEventListener("toggle", function (ev) { var dt = ev.target; if (dt && dt.classList && dt.classList.contains("cr-card")) row.classList.toggle("wide", !!dt.open); }, true);
    var meta = el("div", "cr-cm-meta");
    meta.append(el("span", "cr-name", (it.member && it.member.name) || "?"));
    // 类型已由所在卡叠标题显示，这里不再重复
    if (it.ts) meta.append(el("span", null, notesFormatTime(it.ts)));
    var size = cmChars(it.data && it.data.chars);
    if (size) meta.append(el("span", null, size));
    var tag = el("span", "cr-tag cr-st-" + it.status, CM_STATUS[it.status] || it.status);
    if (it.status === "binned" && it.binnedBy) tag.title = "由 " + it.binnedBy + " 收进回收站";
    meta.append(tag);
    var act = el("button", "mm-btn mm-ghost", it.status === "binned" ? "移出回收站" : "收进回收站");
    act.type = "button";
    act.disabled = cm.busy;
    act.addEventListener("click", function () { cmAct(it.status === "binned" ? "restore" : "sweep", [it.id]); });
    meta.append(act);
    main.append(meta);
    row.append(cb, main);
    return row;
  }
  function cmAct(op, ids) {
    if (!ids.length || !roomId || cm.busy) return;
    cm.busy = true; cmRender();
    var body = {}; body[op] = ids;
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/bin", { method: "POST", body: JSON.stringify(body) }).then(function (r) {
      if (r && r.bin) cardBin = r.bin;
      var n = (r && r.changed) || 0;
      mmToast(n ? (op === "sweep" ? "已将 " + n + " 张卡片收进回收站。" : "已将 " + n + " 张卡片移出回收站。") : (op === "sweep" ? "所选卡片均已在回收站中。" : "所选卡片均不在回收站中。"), "info");
      cm.sel = {};
    }).catch(function (e) { mmToast((op === "sweep" ? "收进回收站失败：" : "移出回收站失败：") + ((e && e.message) || e), "err"); })
      .then(function () { cm.busy = false; renderLog({ keep: true }); cmLoad(); });
  }
  function taskText(t) {
    if (!t) return "";
    var st = { running: "进行中", done: "已完成", budget: "等待「批准 +N」", superseded: "已转向新消息" }[t.state] || t.state;
    return "当前任务：主答 " + seatName(t.main) + " · 回合 " + t.used + "/" + t.budget + " · " + st;
  }
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
  // 进入房间（打开面板、切换房间、页面载入）默认停在底部：首屏与摘要收起块渲染后滚到底，
  // 并在短时间内随图片 / 附件加载、面板由隐藏变为可见再次贴底；用户一旦主动滚动、展开收起或翻看更早消息即停止。
  var initStick = { until: 0, moved: false };
  function initStickOn() { return crInitialStickActive(Date.now(), initStick.until, initStick.moved); }
  function toBottom() { log.scrollTop = log.scrollHeight; }
  function startInitialStick() {
    initStick.until = Date.now() + CR_INITIAL_STICK_MS; initStick.moved = false;
    toBottom();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { if (initStickOn()) { toBottom(); requestAnimationFrame(function () { if (initStickOn()) toBottom(); }); } });
  }
  function stopInitialStick() { initStick.moved = true; }
  ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (t) { log.addEventListener(t, stopInitialStick, { passive: true }); });
  log.addEventListener("load", function () { if (initStickOn()) toBottom(); }, true);
  if (typeof ResizeObserver === "function") { try { new ResizeObserver(function () { if (initStickOn()) toBottom(); }).observe(log); } catch (_) {} }
  function crAppendText(node, text) {
    if (!text) return;
    var last = node.lastChild;
    if (last && last.nodeType === 3) last.appendData(text); else node.append(document.createTextNode(text));
  }
  /** 按签名复用节点：内容未变的消息不重建 DOM。 */
  function cachedMsgEl(m) {
    if (!m || !m.id) return msgEl(m);
    var binned = m.kind === "tool" && !m.pending && Object.prototype.hasOwnProperty.call(cardBin, m.id);
    var sig = crMsgSig(m, binned, msgSelectMode, !!msgSel[m.id]);
    var c = nodeCache[m.id];
    if (c && c.sig === sig) return c.node;
    var node = msgEl(m);
    nodeCache[m.id] = { sig: sig, node: node };
    return node;
  }
  function selectableMsgIds() {
    return messages.filter(function (m) { return m && m.id && !m.ephemeralFailure; }).map(function (m) { return m.id; });
  }
  function syncMsgSelBar() {
    var ids = selectableMsgIds();
    var n = Object.keys(msgSel).filter(function (id) { return !!msgSel[id]; }).length;
    selBar.hidden = !msgSelectMode;
    log.classList.toggle("selecting", !!msgSelectMode);
    selectBtn.textContent = msgSelectMode ? "选择中" : "选择";
    selectBtn.className = msgSelectMode ? "mm-btn" : "mm-btn mm-ghost";
    selectBtn.disabled = !roomId || msgSelBusy;
    selCount.textContent = msgSelectMode ? ("已选 " + n + " 条" + (ids.length ? "（共 " + ids.length + " 条可选）" : "")) : "";
    selDelBtn.textContent = n ? ("删除（" + n + "）") : "删除";
    selDelBtn.disabled = !n || msgSelBusy;
    selAllBtn.disabled = !ids.length || msgSelBusy;
    selCancelBtn.disabled = msgSelBusy;
    selAllBtn.textContent = (n && n === ids.length) ? "取消全选" : "全选";
  }
  function setMsgSelectMode(on) {
    msgSelectMode = !!on;
    if (!msgSelectMode) msgSel = {};
    nodeCache = {};
    syncMsgSelBar();
    renderLog({ keep: true });
  }
  function toggleMsgSel(id, on) {
    if (!msgSelectMode || !id) return;
    if (on) msgSel[id] = true; else delete msgSel[id];
    var row = findMsgNode(id);
    if (row) {
      row.classList.toggle("selected", !!msgSel[id]);
      var cb = row.querySelector && row.querySelector("input[type=checkbox]");
      if (cb) cb.checked = !!msgSel[id];
      if (nodeCache[id]) nodeCache[id].sig = crMsgSig(messages.filter(function (x) { return x.id === id; })[0] || { id: id }, false, true, !!msgSel[id]);
    }
    syncMsgSelBar();
  }
  function deleteSelectedMessages() {
    var ids = Object.keys(msgSel).filter(function (id) { return !!msgSel[id]; });
    if (!roomId || !ids.length || msgSelBusy) return;
    scConfirm("确定删除所选的 " + ids.length + " 条消息？", {
      title: "删除消息",
      body: "将从本房间聊天记录中永久删除所选消息（含对应思考过程）。删除后无法恢复。仅影响本机桌面端发起的操作。",
      okText: "删除",
      cancelText: "保留"
    }).then(function (ok) {
      if (!ok) return;
      msgSelBusy = true; syncMsgSelBar();
      chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/messages", {
        method: "DELETE",
        body: JSON.stringify({ ids: ids })
      }).then(function (b) {
        var gone = (b && b.deleted) || ids;
        messages = messages.filter(function (x) { return gone.indexOf(x.id) < 0; });
        gone.forEach(function (id) { delete msgSel[id]; delete nodeCache[id]; delete thinkCache[id]; delete thinkOpen[id]; });
        if (b && b.room && info && Array.isArray(info.rooms)) {
          info.rooms.forEach(function (r) { if (r.id === roomId) { r.messages = b.room.messages; r.updatedAt = b.room.updatedAt; } });
          try { renderRooms && renderRooms(); } catch (e) {}
        }
        mmToast(gone.length ? ("已删除 " + gone.length + " 条消息") : "未删除任何消息", gone.length ? "ok" : "info");
        if (!Object.keys(msgSel).length) setMsgSelectMode(false);
        else { nodeCache = {}; renderLog({ keep: true }); syncMsgSelBar(); }
        cmSchedule();
      }).catch(function (e) {
        mmToast("删除失败：" + ((e && e.message) || e), "err");
      }).then(function () { msgSelBusy = false; syncMsgSelBar(); });
    });
  }
  selectBtn.addEventListener("click", function () {
    if (!roomId) { mmToast("请先选择房间", "err"); return; }
    setMsgSelectMode(!msgSelectMode);
  });
  selCancelBtn.addEventListener("click", function () { setMsgSelectMode(false); });
  selAllBtn.addEventListener("click", function () {
    var ids = selectableMsgIds();
    var n = Object.keys(msgSel).length;
    if (n && n === ids.length) msgSel = {};
    else { msgSel = {}; ids.forEach(function (id) { msgSel[id] = true; }); }
    nodeCache = {};
    renderLog({ keep: true });
    syncMsgSelBar();
  });
  selDelBtn.addEventListener("click", function () { deleteSelectedMessages(); });
  function findMsgNode(id) {
    var found = null;
    Array.prototype.some.call(log.children, function (x) { if (x.getAttribute && x.getAttribute("data-mid") === id) { found = x; return true; } return false; });
    return found;
  }
  function hiddenCount() { return crHiddenCount(messages.length, shownCount, olderOnServer); }
  function moreEl(hidden) {
    var wrap = el("div", "cr-more-wrap");
    var b = el("button", "mm-btn mm-ghost cr-more", olderLoading ? "正在读取更早的消息…" : crOlderLabel(hidden, CR_HISTORY_PAGE));
    b.type = "button";
    b.disabled = olderLoading;
    b.title = "较早的聊天记录已折叠以保持界面流畅；记录完整保存，成员看到的上下文不受影响。";
    b.addEventListener("click", function () { showOlder(); });
    wrap.append(b);
    return wrap;
  }
  /** 滚动摘要块 + 收起 / 展开已压缩消息的控件（消息仍完整保存，仅收起显示）。 */
  function ctxSummaryEl(n) {
    var box = el("div", "cr-ctxsum");
    box.append(el("div", "cr-ctxsum-head", "上下文摘要（已压缩至第 " + ctxSummary.untilSeq + " 条消息；成员此后看到的较早上下文即为本摘要）"));
    box.append(el("div", "cr-ctxsum-body", ctxSummary.text || ""));
    if (n > 0) {
      var wrap = el("div", "cr-more-wrap");
      var b = el("button", "mm-btn mm-ghost cr-fold", crFoldLabel(n, foldOpen));
      b.type = "button";
      b.title = "已压缩的消息仍完整保存在聊天记录中，此处仅收起显示。";
      b.addEventListener("click", function () { stopInitialStick(); foldOpen = !foldOpen; renderLog({ anchor: !foldOpen ? false : true, keep: true }); });
      wrap.append(b);
      box.append(wrap);
    }
    return box;
  }
  function setCtxSummary(s) {
    ctxSummary = (s && String(s.text || "").trim() && Number(s.untilSeq) > 0) ? { text: String(s.text), untilSeq: Number(s.untilSeq), at: s.at || "" } : null;
  }
  // 压缩过程实时显示（与成员发言同样的思考过程展示）；仅在本页，不写入聊天记录，也不进入成员上下文
  var ctxBuf = { text: "", think: "", timer: 0 };
  function ctxLiveStart(d) {
    if (ctxLiveEl) ctxLiveEl.remove();
    ctxLiveId = (d && d.id) || "";
    ctxBuf.text = ""; ctxBuf.think = "";
    ctxLiveEl = msgEl({ kind: "seat", speaker: { name: "上下文压缩" }, model: (d && d.model) || "", text: "" });
    ctxLiveEl.classList.add("streaming", "cr-ctxlive");
    ctxLiveEl.append(el("div", "cr-ctxlive-state", d && d.auto ? "正在自动压缩较早的上下文…（本条仅在本页显示，不计入聊天记录）" : "正在压缩较早的上下文…（本条仅在本页显示，不计入聊天记录）"));
    var stick = nearBottom();
    var empty = log.querySelector(".cr-empty");
    if (empty) empty.remove();
    log.append(ctxLiveEl);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function ctxThinkDet(create) {
    var det = ctxLiveEl && ctxLiveEl.querySelector(".cr-think");
    if (!det && create && ctxLiveEl) {
      det = el("details", "cr-think");
      det.append(el("summary", null, ""));
      det.append(el("div", "cr-think-body", ""));
      det._n = 0;
      var t = ctxLiveEl.querySelector(".cr-text");
      if (t && t.nextSibling) ctxLiveEl.insertBefore(det, t.nextSibling); else ctxLiveEl.append(det);
    }
    return det;
  }
  function ctxFlush() {
    ctxBuf.timer = 0;
    if (!ctxLiveEl || !host.isConnected) { ctxBuf.text = ""; ctxBuf.think = ""; return; }
    var stick = nearBottom();
    if (ctxBuf.think) {
      var det = ctxThinkDet(true);
      det._n += ctxBuf.think.length;
      det.querySelector("summary").textContent = "思考中（" + det._n + " 字，仅您可见）";
      crAppendText(det.querySelector(".cr-think-body"), ctxBuf.think);
      ctxBuf.think = "";
    }
    if (ctxBuf.text) { var t = ctxLiveEl.querySelector(".cr-text"); if (t) crAppendText(t, ctxBuf.text); ctxBuf.text = ""; }
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function ctxQueue(kind, d) {
    if (!d || !d.text || !ctxLiveEl || (d.id && ctxLiveId && d.id !== ctxLiveId)) return;
    ctxBuf[kind] += d.text;
    if (ctxBuf.timer) return;
    var visible = typeof document.visibilityState !== "string" || document.visibilityState === "visible";
    if (visible && typeof requestAnimationFrame === "function") ctxBuf.timer = requestAnimationFrame(ctxFlush) || 1;
    else ctxBuf.timer = setTimeout(ctxFlush, 200) || 1;
  }
  function ctxLiveEnd(d) {
    if (!ctxLiveEl || (d && d.id && ctxLiveId && d.id !== ctxLiveId)) return;
    ctxFlush();
    ctxLiveEl.classList.remove("streaming");
    var det = ctxThinkDet(false);
    if (det) det.querySelector("summary").textContent = "思考过程（" + det._n + " 字，仅您可见）";
    var ok = !!(d && d.ok);
    if (!ok) ctxLiveEl.classList.add("failed");
    var st = ctxLiveEl.querySelector(".cr-ctxlive-state");
    if (st) st.textContent = ok ? "压缩完成。本条仅在本页显示，不计入聊天记录。" : "压缩失败：" + ((d && d.error) || "未知错误") + "。本条仅在本页显示，不计入聊天记录。";
  }
  /**
   * 重绘聊天记录（只渲染最近 shownCount 条，较早的折叠在顶部控件后）。
   * opts.keep：不在底部时保持当前滚动位置；opts.anchor：展开更早消息后保持原先可见内容不动。
   */
  function renderLog(opts) {
    opts = opts || {};
    var stick = opts.anchor ? false : opts.keep ? nearBottom() : true;
    var prevTop = log.scrollTop, prevH = log.scrollHeight;
    log.textContent = "";
    if (!roomId) { log.append(el("div", "cr-empty", "暂无房间。")); return; }
    var hidden = hiddenCount();
    if (!messages.length && !liveEl && !hidden) log.append(el("div", "cr-empty", "房间里还没有消息。"));
    var start = Math.max(0, messages.length - shownCount);
    var cut = ctxSummary && ctxSummary.untilSeq > 0 ? ctxSummary.untilSeq : 0;
    var foldedLoaded = cut ? crFoldSplit(messages, cut).folded.length : 0;
    var foldedN = foldedLoaded + (foldedLoaded > 0 ? olderOnServer : 0);
    var collapsed = !!cut && !foldOpen;
    if (hidden > 0 && !(collapsed && foldedLoaded > 0)) log.append(moreEl(hidden));
    var frag = document.createDocumentFragment();
    var live = {};
    var sumPlaced = !cut;
    function placeSummary() {
      if (sumPlaced) return;
      sumPlaced = true;
      frag.append(ctxSummaryEl(foldedN));
    }
    if (collapsed) placeSummary();
    for (var i = start; i < messages.length; i++) {
      var m = messages[i];
      var q = Number(m && m.seq);
      var isFolded = cut && q > 0 && q <= cut;
      if (collapsed && isFolded) continue;
      if (!isFolded) placeSummary();
      if (m && m.id) live[m.id] = true;
      frag.append(cachedMsgEl(m));
    }
    placeSummary();
    Object.keys(nodeCache).forEach(function (k) { if (!live[k]) delete nodeCache[k]; });
    log.append(frag);
    if (liveEl) log.append(liveEl);
    if (ctxLiveEl) log.append(ctxLiveEl);
    if (stick) log.scrollTop = log.scrollHeight;
    else if (opts.anchor) log.scrollTop = prevTop + (log.scrollHeight - prevH);
    else log.scrollTop = prevTop;
  }
  /** 追加一条新消息（不整页重绘）；停在底部且显示条数超过两页时回收较早的节点。 */
  function appendMsg(m, forceBottom) {
    if (shownCount > messages.length) shownCount = messages.length; // 显示窗口按实际渲染条数计
    messages.push(m);
    shownCount++;
    var stick = nearBottom();
    if (crTrimShown(shownCount, stick || forceBottom, CR_HISTORY_PAGE) !== shownCount) {
      shownCount = CR_HISTORY_PAGE;
      renderLog();
      return;
    }
    var empty = log.querySelector(".cr-empty");
    if (empty) empty.remove();
    var node = cachedMsgEl(m);
    if (liveEl && liveEl.parentNode === log) log.insertBefore(node, liveEl); else log.append(node);
    if (stick || forceBottom) log.scrollTop = log.scrollHeight;
  }
  /** 展开更早的一页：先展开已加载但折叠的，不够时向服务端按 before=<seq>&limit= 分页读取。 */
  function showOlder() {
    if (olderLoading || !roomId) return;
    stopInitialStick();
    var loadedHidden = Math.max(0, messages.length - shownCount);
    if (loadedHidden > 0) {
      shownCount += Math.min(CR_HISTORY_PAGE, loadedHidden);
      renderLog({ anchor: true });
      return;
    }
    if (olderOnServer <= 0) return;
    var rid = roomId;
    var before = crOldestSeq(messages);
    if (!before) return;
    olderLoading = true;
    renderLog({ anchor: true });
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(rid) + "/messages?before=" + before + "&limit=" + CR_HISTORY_PAGE).then(function (r) {
      olderLoading = false;
      if (rid !== roomId) return;
      var got = Array.isArray(r.messages) ? r.messages : [];
      var n0 = messages.length;
      messages = crMergeOlder(got, messages);
      olderOnServer = got.length ? Math.max(0, Number(r.older) || 0) : 0;
      shownCount += messages.length - n0;
      renderLog({ anchor: true });
    }).catch(function (e) {
      olderLoading = false;
      if (rid === roomId) renderLog({ anchor: true });
      mmToast("读取更早的消息失败：" + ((e && e.message) || e), "err");
    });
  }
  // 滚动到顶部时自动展开更早的一页（只响应向上滚动，程序设置的滚动位置不会触发）
  var lastLogTop = 0, autoOlderAt = 0;
  log.addEventListener("scroll", function () {
    var t = log.scrollTop, up = t < lastLogTop;
    lastLogTop = t;
    if (!up || t > 40 || olderLoading || Date.now() - autoOlderAt < 400 || hiddenCount() <= 0) return;
    autoOlderAt = Date.now();
    showOlder();
  }, { passive: true });
  // 流式输出：增量文字先攒着，每帧最多写一次 DOM、读一次布局（避免每个分片都强制重排整列记录）
  var liveBuf = { el: null, text: "", think: "", timer: 0 };
  function queueLive(kind, text) {
    if (liveBuf.el !== liveEl) { liveBuf.el = liveEl; liveBuf.text = ""; liveBuf.think = ""; }
    liveBuf[kind] += text;
    if (liveBuf.timer) return;
    var visible = typeof document.visibilityState !== "string" || document.visibilityState === "visible";
    if (visible && typeof requestAnimationFrame === "function") liveBuf.timer = requestAnimationFrame(flushLive) || 1;
    else liveBuf.timer = setTimeout(flushLive, 200) || 1;
  }
  function flushLive() {
    liveBuf.timer = 0;
    if (!liveEl || liveBuf.el !== liveEl || !host.isConnected) { liveBuf.text = ""; liveBuf.think = ""; return; }
    var stick = nearBottom();
    if (liveBuf.text) { var t = liveEl.querySelector(".cr-text"); if (t) crAppendText(t, liveBuf.text); liveBuf.text = ""; }
    if (liveBuf.think) { var th = liveBuf.think; liveBuf.think = ""; liveThinking(th); }
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function startLive(seatId, model) {
    liveSeat = seatId;
    liveEl = msgEl({ kind: "seat", speaker: { name: seatName(seatId) }, model: model, text: "" });
    liveEl.classList.add("streaming");
    var stick = nearBottom();
    var empty = log.querySelector(".cr-empty");
    if (empty) empty.remove();
    log.append(liveEl);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function closeEvents() { if (es) { try { es.close(); } catch (_) {} es = null; } }
  function openEvents() {
    closeEvents();
    if (!roomId || typeof EventSource !== "function") return;
    var rid = roomId;
    es = new EventSource(API + "/chatroom/rooms/" + encodeURIComponent(rid) + "/events");
    function on(type, fn) {
      es.addEventListener(type, function (ev) {
        if (!host.isConnected) { closeEvents(); return; }
        if (rid !== roomId) return;
        var d; try { d = JSON.parse(ev.data); } catch (_) { return; }
        fn(d);
      });
    }
    on("hello", function (d) { running = !!d.running; liveSeat = d.seatId || null; if (d.task) tgState.textContent = taskText(d.task); renderSeats(); syncButtons(); });
    on("run", function (d) {
      running = !!d.running;
      if (!running) {
        liveSeat = null;
        if (liveEl) { liveEl.remove(); liveEl = null; }
        if (d.reason === "no-seats") mmToast("没有已启用的成员，请先在上方启用至少一位成员", "info");
      }
      renderSeats(); syncButtons();
    });
    on("turn", function (d) { if (liveEl) liveEl.remove(); startLive(d.seatId, d.model); renderSeats(); syncButtons(); });
    on("delta", function (d) {
      if (!d || !d.text) return;
      if (!liveEl || liveSeat !== d.seatId) startLive(d.seatId);
      queueLive("text", d.text);
    });
    on("thinking-delta", function (d) {
      if (!d || !d.text) return;
      if (!liveEl || liveSeat !== d.seatId) startLive(d.seatId);
      queueLive("think", d.text);
    });
    on("message", function (d) {
      var m = d.message;
      if (!m) return;
      if (m.kind === "tool" && !m.pending) cmSchedule();
      var at = -1;
      messages.forEach(function (x, i) { if (x.id === m.id) at = i; });
      if (at >= 0) {
        // 本轮暂存的消息转为正式记录：只原位替换这一条（不整页重绘）
        if (messages[at].pending && !m.pending) {
          messages[at] = m;
          var prev = findMsgNode(m.id);
          if (prev) prev.replaceWith(cachedMsgEl(m));
        }
        return;
      }
      if (liveEl && m.kind === "seat" && m.speaker && m.speaker.id === liveSeat) { liveEl.remove(); liveEl = null; }
      appendMsg(m, m.kind === "user");
    });
    // 原位更新（Cursor 任务卡片交卷 / 任务书状态变化）：替换同编号的消息并重绘
    on("message-update", function (d) {
      var m = d && d.message;
      if (!m || !m.id) return;
      var at = -1;
      messages.forEach(function (x, i) { if (x.id === m.id) at = i; });
      if (at < 0) return;
      messages[at] = m;
      // 原位替换这一条（不整页重绘、不跳到底部；展开状态由 cardOpen / stepsOpen 保持）
      // 不在显示窗口内（已折叠）的消息只更新数据，展开时按新内容渲染
      var old = findMsgNode(m.id);
      if (old) { var stick = nearBottom(); old.replaceWith(cachedMsgEl(m)); if (stick) log.scrollTop = log.scrollHeight; }
      if (m.kind === "tool" && !d.progress) cmSchedule();
      if (m.kind === "brief" || (m.kind === "tool" && m.data && m.data.cursorTask && !d.progress)) csSchedule();
    });
    on("error", function (d) { if (d && d.error) mmToast("聊天室出错：" + d.error, "err"); });
    on("retract", function (d) {
      var ids = (d && d.ids) || [];
      if (!ids.length) return;
      var before = messages.length;
      messages = messages.filter(function (x) { return ids.indexOf(x.id) < 0; });
      ids.forEach(function (id) { delete msgSel[id]; delete nodeCache[id]; });
      if (messages.length !== before) renderLog({ keep: true });
      if (msgSelectMode) syncMsgSelBar();
    });
    on("turn-failed", function (d) {
      if (!d) return;
      var who = d.name || seatName(d.seatId) || "成员";
      mmToast(who + " 本轮回复失败：" + (d.reason || "未知错误") + "（未计入聊天记录" + (d.awayMinutes ? "；接下来 " + d.awayMinutes + " 分钟内暂不安排其发言，在消息中提到其名字即可让其立即回来并主答" : "") + "）", "err");
      if (liveEl && liveSeat === d.seatId) { liveEl.remove(); liveEl = null; }
      appendMsg({ id: "failed-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ephemeralFailure: d }, false);
    });
    on("turn-interrupted", function (d) {
      if (!d) return;
      var who = d.name || seatName(d.seatId) || "成员";
      if (liveEl && liveSeat === d.seatId) { liveEl.remove(); liveEl = null; }
      mmToast(who + " 已打断（新消息到达，本轮未计入）", "info");
    });
    on("task", function (d) { tgState.textContent = taskText(d.task); });
    on("compress-start", function (d) { ctxLiveStart(d); });
    on("compress-delta", function (d) { ctxQueue("text", d); });
    on("compress-thinking", function (d) { ctxQueue("think", d); });
    on("compress-end", function (d) { ctxLiveEnd(d); });
    on("context-summary", function (d) { setCtxSummary(d && d.summary); foldOpen = false; renderLog({ keep: true }); });
    on("card-bin", function (d) {
      cardBin = (d && d.bin && typeof d.bin === "object") ? d.bin : {};
      renderLog({ keep: true });
      cmSchedule();
    });
    on("room-config", function (d) {
      if (d && d.patch) { try { window.dispatchEvent(new CustomEvent(ROOMCFG_EVENT, { detail: d.patch })); } catch (e) { /* ignore */ } }
      chatroomJson("/chatroom").then(function (b) { info = b; renderSeats(); syncButtons(); }).catch(function () {});
    });
    on("cursor", function (d) { tgState.textContent = d.running ? "Cursor 正在执行任务书 #" + d.briefId + "…" : "Cursor 任务 #" + d.briefId + " 已结束：" + (d.status || ""); csSchedule(); });
    on("cursor-progress", function (d) { if (d.kind === "tool") tgState.textContent = "Cursor #" + d.briefId + "：" + d.text; });
  }
  function renderRooms() {
    selHost.textContent = "";
    var opts = info.rooms.map(function (r) { return { value: r.id, label: r.title + "（" + (r.messages || 0) + " 条）" }; });
    if (!opts.length) { selHost.append(el("div", "cr-empty", "暂无房间")); sel = null; return; }
    sel = notesSelect(opts, roomId);
    selHost.append(sel.root);
    sel.root.addEventListener("click", function () {
      setTimeout(function () { var v = sel && sel.get(); if (v && v !== roomId) openRoom(v); }, 0);
    });
  }
  function refreshTable() {
    if (!tableFrame || !roomId) return;
    var key = "room:" + roomId;
    var q = "?key=" + encodeURIComponent(key);
    Promise.all([
      fetchJson("/boards/session" + q).catch(function () { return null; }),
      fetchJson("/cards/session" + q).catch(function () { return null; })
    ]).then(function (pair) {
      if (!tableFrame || ("room:" + roomId) !== key) return;
      var board = pair[0] && pair[0].open ? pair[0].session : null;
      var card = pair[1] && pair[1].open ? pair[1].session : null;
      var kind = board ? "board" : (card ? "card" : "");
      var id = board ? board.id : (card ? card.id : "");
      var sig = kind + ":" + id;
      if (!kind) {
        if (tableFrame.getAttribute("src")) tableFrame.removeAttribute("src");
        tableFrame.hidden = true;
        tableEmpty.hidden = false;
        tableSeen = "";
        return;
      }
      tableEmpty.hidden = true;
      tableFrame.hidden = false;
      if (tableSeen === sig) return;
      tableSeen = sig;
      tableFrame.src = kind === "board"
        ? "/dsh-workbench/boards/play?id=" + encodeURIComponent(id) + "&key=" + encodeURIComponent(key)
        : "/dsh-workbench/cards/play?id=" + encodeURIComponent(id) + "&key=" + encodeURIComponent(key);
    });
  }
  function openRoom(id) {
    if (id !== roomId) { pending = []; renderPending(); tableSeen = ""; if (msgSelectMode) { msgSelectMode = false; msgSel = {}; } cs.data = null; cs.detail = {}; cs.dirty = true; cs.busy = false; }
    roomId = id;
    if (id !== roomId) { cm.sel = {}; cm.page = 0; cm.filter = { member: "", tool: "", status: "", q: "" }; cm.data = null; if (cmEls) cmEls.q.value = ""; }
    messages = []; cardBin = {}; liveEl = null; liveSeat = null; running = false;
    ctxSummary = null; foldOpen = false; ctxLiveEl = null; ctxLiveId = "";
    shownCount = CR_HISTORY_PAGE; olderOnServer = 0; olderLoading = false; nodeCache = {};
    syncMsgSelBar();
    renderLog(); syncButtons();
    // 首屏只取最近一页（服务端分页）；旧版服务端忽略 limit、返回全部记录时，较早的在本地折叠
    return chatroomJson("/chatroom/rooms/" + encodeURIComponent(id) + "?limit=" + CR_HISTORY_PAGE).then(function (b) {
      if (roomId !== id) return;
      messages = b.messages || [];
      olderOnServer = b.history ? Math.max(0, Number(b.history.older) || 0) : 0;
      cardBin = (b.room && b.room.cardBin && typeof b.room.cardBin === "object") ? b.room.cardBin : {};
      setCtxSummary(b.room && b.room.contextSummary);
      if (cmVisible()) cmLoad(); else cm.dirty = true;
      if (csVisible()) csLoad(true); else cs.dirty = true;
      running = !!b.running; liveSeat = b.seatId || null;
      renderLog(); renderSeats(); syncButtons(); openEvents();
      startInitialStick();
      if (showTable) refreshTable();
    }).catch(function (e) { mmToast("读取房间失败：" + ((e && e.message) || e), "err"); });
  }
  function applyTelegramStatus(tgs) {
    tgs = tgs || {};
    var enabled = !!(info && info.enabled);
    var label = tgs.ingest ? seatName(tgs.ingest) : "";
    var phase = tgs.phase || (tgs.error ? "error" : (tgs.ready ? "ready" : (tgs.ingest ? "waiting" : "off")));
    var detail = tgs.detail || tgs.error || "";
    var line = "";
    if (!enabled) line = "";
    else if (tgs.error || phase === "error") line = "Telegram：" + (tgs.error || detail || "接收失败");
    else if (!tgs.ingest) line = "Telegram：未指定接收群消息的机器人";
    else if (phase === "ready" || tgs.ready) {
      var mode = tgs.mode === "delegated" ? "（经通道共享轮询）" : (tgs.polling ? "（运行中）" : "");
      line = "Telegram 接收：" + label + mode;
    } else line = "Telegram 接收：" + label + "（尚未就绪）";
    tgState.textContent = line;
    maybeToastChatroomTg(tgs, enabled);
  }
  function reload(pick) {
    return chatroomJson("/chatroom").then(function (b) {
      info = b;
      applyTelegramStatus(b.telegram || {});
      loadDiscovered();
      if (pick) roomId = pick;
      if (dock) roomId = opts.roomId || null;
      if (roomId && !info.rooms.some(function (r) { return r.id === roomId; })) roomId = null;
      if (!roomId && info.rooms.length && !dock) roomId = info.rooms[0].id;
      renderRooms(); renderSeats(); syncButtons();
      if (roomId) return openRoom(roomId);
      renderLog();
    }).catch(function (e) { log.textContent = ""; log.append(el("div", "cr-empty", "聊天室读取失败：" + ((e && e.message) || e))); });
  }
  newBtn.addEventListener("click", function () {
    notesDialog({
      title: "新建房间", okText: "创建",
      fields: [{ key: "title", label: "房间名称", value: "", placeholder: "例如：方案讨论", maxLength: 80 }],
      onSubmit: function (v) { return chatroomJson("/chatroom/rooms", { method: "POST", body: JSON.stringify({ title: v.title }) }).then(function (b) { return reload(b.room.id); }); }
    });
  });
  renameBtn.addEventListener("click", function () {
    var r = info.rooms.filter(function (x) { return x.id === roomId; })[0];
    if (!r) return;
    notesDialog({
      title: "重命名房间",
      fields: [{ key: "title", label: "房间名称", value: r.title, maxLength: 80 }],
      onSubmit: function (v) { return chatroomJson("/chatroom/rooms/" + encodeURIComponent(r.id), { method: "PUT", body: JSON.stringify({ title: v.title }) }).then(function () { return reload(r.id); }); }
    });
  });
  var PRIVACY_HINT = "提示：接收群消息的机器人须在 BotFather 中关闭隐私模式（/setprivacy → Disable），否则在群里只能收到命令，看不到普通消息。/bind 与 /unbind 是命令，隐私模式开启时同样有效；关闭隐私模式后，需将机器人移出群再重新拉入才会生效。";
  function renderDiscovered(groups) {
    discBox.textContent = "";
    var pending = (groups || []).filter(function (g) { return g.status === "new" && g.active !== false; });
    if (!pending.length) { discBox.hidden = true; return; }
    discBox.hidden = false;
    discBox.append(el("div", "cr-disc-title", "发现的群聊（" + pending.length + "）"));
    pending.forEach(function (g) {
      var row = el("div", "cr-disc-row");
      var main = el("div", "cr-disc-main");
      main.append(el("span", "cr-seat-name", g.title || "（未命名群）"));
      var bits = ["ID " + g.chatId];
      if (g.addedBy) bits.push("由 " + g.addedBy + " 拉入");
      if (g.firstSeen) bits.push("发现于 " + notesFormatTime(g.firstSeen));
      main.append(el("span", "cr-seat-sub", bits.join(" · ")));
      var bind = el("button", "mm-btn", "绑定到房间");
      var ign = el("button", "mm-btn mm-ghost", "忽略");
      bind.type = ign.type = "button";
      bind.disabled = !info.rooms.length;
      if (!info.rooms.length) bind.title = "请先新建房间";
      bind.addEventListener("click", function () {
        var opts2 = info.rooms.map(function (r) { return { value: r.id, label: r.title }; });
        notesDialog({
          title: "绑定到房间", okText: "绑定",
          fields: [{ key: "room", label: "房间", type: "select", options: opts2, value: roomId || opts2[0].value, hint: "群「" + (g.title || g.chatId) + "」的消息将进入所选房间，各 AI 的回复也会发到该群。" }],
          onSubmit: function (v) {
            return chatroomJson("/chatroom/discovered/" + encodeURIComponent(g.chatId) + "/bind", { method: "POST", body: JSON.stringify({ roomId: v.room }) }).then(function () { mmToast("已绑定到房间", "info"); return reload(v.room); });
          }
        });
      });
      ign.addEventListener("click", function () {
        chatroomJson("/chatroom/discovered/" + encodeURIComponent(g.chatId) + "/ignore", { method: "POST", body: "{}" }).then(function (b) { renderDiscovered(b.groups); }).catch(function (e) { mmToast((e && e.message) || String(e), "err"); });
      });
      row.append(main, bind, ign);
      discBox.append(row);
    });
    discBox.append(el("div", "cr-hint", "也可以由所有者在群内发送 /bind（或 /bind 房间名）完成绑定，/unbind 解除。未绑定群的消息不会进入任何房间。" + PRIVACY_HINT));
  }
  var discSeen = {}; // chatId -> true，用于发现新群 toast（本页会话内）
  var discReady = false;
  function loadDiscovered() {
    if (dock) return;
    chatroomJson("/chatroom/discovered").then(function (b) {
      var groups = b.groups || [];
      var pending = groups.filter(function (g) { return g.status === "new" && g.active !== false; });
      if (discReady) {
        pending.forEach(function (g) {
          var id = String(g.chatId || "");
          if (!id || discSeen[id]) return;
          discSeen[id] = true;
          var label = g.title || id;
          mmToast("发现新群：" + label, "info");
        });
      } else {
        pending.forEach(function (g) { if (g.chatId) discSeen[String(g.chatId)] = true; });
        discReady = true;
      }
      renderDiscovered(groups);
    }).catch(function () {});
  }
  var discTimer = setInterval(function () {
    if (!host.isConnected) { clearInterval(discTimer); return; }
    if (!info.enabled) {
      if (mmChatroomTgNotify.kind === "pending") mmWaitClear("chatroom-tg", "intake");
      mmChatroomTgNotify.kind = "off";
      return;
    }
    loadDiscovered();
    chatroomJson("/chatroom/telegram").then(function (tgs) { applyTelegramStatus(tgs); }).catch(function () {});
  }, 3000);
  bindBtn.addEventListener("click", function () {
    var r = info.rooms.filter(function (x) { return x.id === roomId; })[0];
    if (!r) return;
    var tgs = info.telegram || {};
    notesDialog({
      title: "绑定 Telegram 群",
      fields: [{ key: "ids", label: "群聊 ID", type: "textarea", value: (r.telegramChatIds || []).join("\n"), placeholder: "-1001234567890\n每行一个；超级群以 -100 开头", hint: "群里的消息由「接收群消息」的机器人读取后进入本房间，无需 @。各 AI 的回复先写入房间，再经其各自的机器人发到这些群。" + (tgs.error ? "\n当前状态：" + tgs.error : (tgs.ingest ? "\n接收机器人：" + seatName(tgs.ingest) : "\n尚未指定接收群消息的机器人。")) + "\n" + PRIVACY_HINT }],
      onSubmit: function (v) {
        var ids = String(v.ids || "").split(/[\s,，]+/).filter(Boolean);
        var bad = ids.filter(function (x) { return !/^-\d{5,20}$/.test(x); });
        if (bad.length) return Promise.reject(new Error("群聊 ID 应为负数：" + bad.join("、")));
        return chatroomJson("/chatroom/rooms/" + encodeURIComponent(r.id), { method: "PUT", body: JSON.stringify({ telegramChatIds: ids }) }).then(function () { return reload(r.id); });
      }
    });
  });
  rulesBtn.addEventListener("click", function () {
    notesDialog({
      title: "附加房间规则",
      fields: [{ key: "rules", label: "规则", type: "textarea", value: info.rules || "", placeholder: "例如：讨论方案时先列出风险。", hint: "所有成员共用，追加在内置角色规则之后。内置规则包括：各 AI 是与您一样的规划参与者而非实施者；未经点名不直接修改文件；可回复 [PASS] 静默跳过；可用 [[NEXT: 名字]] 交棒。" }],
      onSubmit: function (v) {
        return chatroomJson("/chatroom/config", { method: "PUT", body: JSON.stringify({ rules: String(v.rules || "") }) }).then(function (b) { info.rules = b.rules; mmToast("房间规则已保存", "info"); });
      }
    });
  });
  compressBtn.addEventListener("click", function () {
    if (!roomId) return;
    if (!info.summarizerReady) { mmToast("自动压缩未启用：请选择摘要模型（设置 › 聊天室 › 摘要模型），选择后即可手动或自动压缩上下文。", "err"); return; }
    compressBtn.disabled = true;
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/compress", { method: "POST", body: "{}" }).then(function (b) {
      if (b.notice) mmToast(b.notice, b.ok ? "info" : "err");
      else if (b.skipped && b.reason === "unconfigured") mmToast("自动压缩未启用：请选择摘要模型", "err");
      else if (b.skipped && b.reason === "nothing-to-fold") mmToast("当前无需压缩", "info");
      else if (b.ok) mmToast("已压缩较早的上下文。", "info");
      else mmToast((b.error || b.notice || "压缩失败"), "err");
      return reload(roomId);
    }).catch(function (e) { mmToast("压缩失败：" + ((e && e.message) || e), "err"); }).then(function () { compressBtn.disabled = false; syncButtons(); });
  });
  function send() {
    var text = ta.value.trim();
    if (pending.some(function (p) { return p.status === "uploading"; })) { mmToast("附件仍在上传，请稍候。", "info"); return; }
    var ids = pending.filter(function (p) { return p.status === "ready" && p.att; }).map(function (p) { return p.att.id; });
    if ((!text && !ids.length) || !roomId) return;
    sendBtn.disabled = true;
    if (ids.some(function (id) { var p = pending.filter(function (q) { return q.att && q.att.id === id; })[0]; return p && p.att.kind === "audio"; })) setState("正在转写语音…");
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/messages", { method: "POST", body: JSON.stringify(ids.length ? { text: text, attachments: ids } : { text: text }) }).then(function (b) {
      ta.value = "";
      pending.forEach(function (p) { if (p.preview) { try { URL.revokeObjectURL(p.preview); } catch (e) {} } });
      pending = [];
      renderPending();
      if (b.message && !messages.some(function (x) { return x.id === b.message.id; })) appendMsg(b.message, true);
      if (b.started) { running = true; syncButtons(); }
    }).catch(function (e) { mmToast("发送失败：" + ((e && e.message) || e), "err"); }).then(function () { syncButtons(); ta.focus(); });
  }
  sendBtn.addEventListener("click", send);
  sessionBtn.addEventListener("click", function () {
    if (!roomId) return;
    sessionBtn.disabled = true;
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/session", { method: "POST", body: "{}" }).then(function () {
      mmToast("房间会话已就绪，请在左侧会话列表中打开「聊天室：" + ((info.rooms.filter(function (r) { return r.id === roomId; })[0] || {}).title || "") + "」。", "info");
      chatroomSessionMap.at = 0;
    }).catch(function (e) { mmToast("无法打开房间会话：" + ((e && e.message) || e), "err"); }).then(function () { syncButtons(); });
  });
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  attachBtn.addEventListener("click", function () { fileInput.value = ""; fileInput.click(); });
  fileInput.addEventListener("change", function () { addFiles(fileInput.files); fileInput.value = ""; });
  ta.addEventListener("paste", function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length || !info.enabled || !roomId) return;
    e.preventDefault();
    addFiles(files);
  });
  inputWrap.addEventListener("dragover", function (e) {
    if (!info.enabled || !roomId || !e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") < 0) return;
    e.preventDefault();
    inputWrap.classList.add("drop");
  });
  inputWrap.addEventListener("dragleave", function () { inputWrap.classList.remove("drop"); });
  inputWrap.addEventListener("drop", function (e) {
    inputWrap.classList.remove("drop");
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length || !info.enabled || !roomId) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
  contBtn.addEventListener("click", function () {
    if (!roomId) return;
    contBtn.disabled = true;
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/run", { method: "POST", body: "{}" }).then(function () { running = true; syncButtons(); })
      .catch(function (e) { mmToast((e && e.message) || String(e), "err"); syncButtons(); });
  });
  stopBtn.addEventListener("click", function () {
    if (!roomId) return;
    chatroomJson("/chatroom/rooms/" + encodeURIComponent(roomId) + "/stop", { method: "POST", body: "{}" }).catch(function (e) { mmToast("停止失败：" + ((e && e.message) || e), "err"); });
  });
  var watch = setInterval(function () {
    if (!host.isConnected) { clearInterval(watch); closeEvents(); return; }
    if (showTable) refreshTable();
  }, 2000);
  log.append(el("div", "cr-empty", "正在读取…"));
  syncButtons();
  var lastEnabled = null;
  function onPoolChanged(e) {
    if (!host.isConnected) { try { window.removeEventListener(ROOMCFG_EVENT, onPoolChanged); } catch (_) {} return; }
    var d = e && e.detail;
    if (!d || typeof d !== "object" || !("chatroomSeats" in d)) return;
    reload(roomId);
  }
  try { window.addEventListener(ROOMCFG_EVENT, onPoolChanged); } catch (_) {}
  chatroomPanelReloaders.push({
    alive: function () { return host.isConnected; },
    reload: function (value) {
      var en = !!(value && value.chatroomEnabled === true);
      if (en === info.enabled && en === lastEnabled) return;
      lastEnabled = en;
      reload(roomId);
    }
  });
  reload();
  return { reload: reload, dispose: function () { try { window.removeEventListener(ROOMCFG_EVENT, onPoolChanged); } catch (_) {} clearInterval(watch); closeEvents(); } };
}

// ── 聊天室「工具」分组：find_tools 选择器、上下文控制与各房间工具集 ──
function buildChatroomToolsPanel(host) {
  host.append(el("div", "mm-group", "工具"));
  host.append(el("p", "mm-sub", "成员可调用 find_tools 查找工具：由 DSH 已配置的 DeepSeek 服务商从工具目录中挑选至多 3 个，加入房间工具集，供全体成员共用。您（本机桌面端，或所有者 Telegram 账号）发起的任务可使用全部工具，无需另行确认；其他人发起的任务仅可使用只读工具。发送「停止」可中止，发送 /tools clear 可清空工具集。联网搜索（web_search、web_fetch）默认对所有房间开放，无需 find_tools，清空工具集后仍保留。"));
  var warn = el("div", "mm-warn");
  warn.style.display = "none";
  host.append(warn);
  var FIELDS = [
    { key: "enabled", label: "启用工具发现", type: "switch", desc: "关闭后成员不再获得 find_tools 与工具集中的工具；已保存的工具集保留。" },
    { key: "finderProvider", label: "选择器服务商", type: "text", placeholder: "deepseek", desc: "DSH 中已配置的服务商编号，默认 deepseek。本插件不另存密钥。" },
    { key: "finderModel", label: "选择器模型", type: "text", placeholder: "deepseek-flash", desc: "默认 deepseek-flash。选择器只需返回文字 JSON，无需工具调用能力。" },
    { key: "toolsetMax", label: "工具集上限", type: "number", min: 1, max: 50, desc: "超出时移出最久未用的工具。默认 12。" },
    { key: "resultTokens", label: "单条结果预览上限（tokens）", type: "number", min: 100, max: 8000, desc: "每次工具调用生成一张卡片，完整内容保存在数据目录。调用者在本次发言中看到该长度的预览；其他成员只看到卡片标题，需要时用 open_card 打开。默认 600。" },
    { key: "wallClockMin", label: "工具循环时间上限（分钟）", type: "number", min: 1, max: 120, desc: "单个成员一次发言中工具循环的时长上限，到时要求其收尾。另有重复调用拦截。默认 15。" },
    { key: "summaries", label: "超长结果生成摘要", type: "switch", desc: "开启后，超过阈值的结果由选择器模型压缩为摘要放入历史。默认关闭。" },
    { key: "summaryThreshold", label: "摘要阈值（字符）", type: "number", min: 2000, max: 500000, desc: "默认 20000。" }
  ];
  var inputs = {};
  FIELDS.forEach(function (f) {
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var id = "cr-tools-" + f.key + "-" + Math.random().toString(36).slice(2, 7);
    var label = el("label", undefined, f.label);
    label.htmlFor = id;
    var input = el("input", f.type === "switch" ? undefined : "mm-input");
    input.id = id;
    if (f.type === "switch") { input.type = "checkbox"; input.style.accentColor = "var(--mm-accent)"; input.style.width = "16px"; input.style.height = "16px"; }
    else { input.type = f.type; if (f.min !== undefined) input.min = String(f.min); if (f.max !== undefined) input.max = String(f.max); if (f.placeholder) input.placeholder = f.placeholder; }
    inputs[f.key] = input;
    if (f.type === "switch") {
      var line = el("div", "mm-row");
      line.style.marginTop = "0";
      line.append(input, label);
      wrap.append(line);
    } else wrap.append(label, input);
    wrap.append(el("div", "mm-desc", f.desc));
    host.append(wrap);
  });
  var srow = el("div", "mm-row");
  var save = el("button", "mm-btn", "保存工具设置");
  save.type = "button";
  save.disabled = true;
  var msg = el("span", "mm-msg");
  msg.setAttribute("aria-live", "polite");
  srow.append(save, msg);
  host.append(srow);
  host.append(el("div", "mm-group", "房间工具集"));
  var listHost = el("div");
  host.append(listHost);
  var toasted = "";

  var filled = false;
  function render(b, fill) {
    var s = b.settings || {};
    if (fill || !filled) FIELDS.forEach(function (f) {
      var v = s[f.key];
      if (f.type === "switch") inputs[f.key].checked = v === true || (f.key === "enabled" && v !== false);
      else inputs[f.key].value = v == null ? "" : String(v);
    });
    filled = true;
    save.disabled = false;
    var f = b.finder || {};
    var problem = !b.available ? "当前环境未启用聊天室工具。" : (s.enabled !== false && !f.ready ? (f.problem || "选择器不可用") : "");
    warn.textContent = problem ? "find_tools 暂不可用：" + problem : "";
    warn.style.display = problem ? "" : "none";
    if (problem && problem !== toasted) { toasted = problem; mmToast("聊天室工具：find_tools 暂不可用 — " + problem, "err"); }
    if (!problem) toasted = "";
    msg.textContent = f.ready ? "选择器：" + (f.provider || "") + " / " + (f.model || "") + (f.note ? "（" + f.note + "）" : "") + (b.catalogSize != null ? " · 工具目录 " + b.catalogSize + " 个" : "") : "";
    listHost.textContent = "";
    var rooms = (b.rooms || []);
    if (!rooms.length) { listHost.append(el("p", "mm-sub", "还没有房间。")); return; }
    rooms.forEach(function (r) {
      var box = el("div", "mm-field");
      var head = el("div", "mm-row");
      head.style.marginTop = "0";
      var title = el("strong", undefined, (r.title || r.id) + "（" + r.tools.length + "/" + (s.toolsetMax || 12) + "）");
      head.append(title);
      if (r.tools.length) {
        var clr = el("button", "mm-btn mm-ghost", "清空");
        clr.type = "button";
        clr.addEventListener("click", function () {
          clr.disabled = true;
          chatroomJson("/chatroom/rooms/" + encodeURIComponent(r.id) + "/toolset", { method: "DELETE" }).then(function (nb) { mmToast("已清空「" + (r.title || r.id) + "」的工具集", "info"); render(nb); })
            .catch(function (e) { clr.disabled = false; mmToast("清空失败：" + ((e && e.message) || e), "err"); });
        });
        head.append(clr);
      }
      box.append(head);
      (r.defaults || []).forEach(function (x) {
        var drow = el("div", "mm-row");
        drow.style.alignItems = "flex-start";
        var dtxt = el("div");
        dtxt.style.flex = "1 1 auto";
        dtxt.style.minWidth = "0";
        dtxt.append(el("code", undefined, x.name));
        dtxt.append(el("div", "mm-desc", "（默认开放，不占上限）" + (x.description || "")));
        drow.append(dtxt);
        box.append(drow);
      });
      if (!r.tools.length) box.append(el("div", "mm-desc", "工具集为空。成员调用 find_tools 后会出现在这里。"));
      r.tools.forEach(function (x) {
        var row = el("div", "mm-row");
        row.style.alignItems = "flex-start";
        var txt = el("div");
        txt.style.flex = "1 1 auto";
        txt.style.minWidth = "0";
        var name = el("code", undefined, x.name);
        txt.append(name);
        var d = (x.registered === false ? "（当前未注册）" : "") + (x.description || "");
        if (x.lastUsed) d += (d ? " · " : "") + "最近使用 " + new Date(x.lastUsed).toLocaleString();
        txt.append(el("div", "mm-desc", d));
        var rm = el("button", "mm-btn mm-ghost", "移除");
        rm.type = "button";
        rm.title = "从该房间的工具集中移除 " + x.name;
        rm.addEventListener("click", function () {
          rm.disabled = true;
          chatroomJson("/chatroom/rooms/" + encodeURIComponent(r.id) + "/toolset/" + encodeURIComponent(x.name), { method: "DELETE" }).then(function (nb) { render(nb); })
            .catch(function (e) { rm.disabled = false; mmToast("移除失败：" + ((e && e.message) || e), "err"); });
        });
        row.append(txt, rm);
        box.append(row);
      });
      listHost.append(box);
    });
  }
  function load(fill) {
    return chatroomJson("/chatroom/tools").then(function (b) { render(b, fill); }).catch(function (e) { msg.textContent = "读取失败：" + ((e && e.message) || e); });
  }
  save.addEventListener("click", function () {
    var out = {};
    FIELDS.forEach(function (f) {
      if (f.type === "switch") out[f.key] = !!inputs[f.key].checked;
      else if (f.type === "number") { if (inputs[f.key].value !== "") out[f.key] = Number(inputs[f.key].value); }
      else out[f.key] = String(inputs[f.key].value || "").trim();
    });
    save.disabled = true;
    chatroomJson("/chatroom/config", { method: "PUT", body: JSON.stringify({ tools: out }) }).then(function () { mmToast("工具设置已保存", "info"); return load(true); })
      .catch(function (e) { mmToast("保存失败：" + ((e && e.message) || e), "err"); }).then(function () { save.disabled = false; });
  });
  var timer = setInterval(function () { if (!host.isConnected) { clearInterval(timer); return; } load(); }, 15000);
  load();
}

// ── 聊天室「附件与语音」分组：附件开关、非视觉成员的图片描述、语音转写（Gemini）与转写密钥 ──
function buildChatroomAttachPanel(host) {
  host.append(el("div", "mm-group", "附件与语音"));
  host.append(el("p", "mm-sub", "开启后，您可以在聊天室输入框中添加图片、文件或语音（也可粘贴或拖入），绑定的 Telegram 群中发送的图片、文件、语音、音频与视频也会进入房间。单个附件不超过 25 MB，总量不设上限，附件永久保存在房间目录中。支持图片的成员每次最多看到最新的 9 张图片，更早的图片以一行说明代替，需要时可自行调出；所有成员都可以读取文本类文件，并可把图片或文件发到房间及 Telegram 群。"));
  var warn = el("div", "mm-warn");
  warn.style.display = "none";
  host.append(warn);
  var FIELDS = [
    { key: "enabled", label: "启用附件", type: "switch", desc: "关闭后不再接收新的附件，成员也不再获得 view_attachment / read_attachment / send_attachment；已保存的附件保留。" },
    { key: "describe", label: "为不支持图片的成员生成图片描述", type: "switch", desc: "由房间中能识图的成员所用模型为每张图片生成简短描述，放在图片说明行中；没有能识图的成员时改用 Vision Router 插件。不支持图片的成员调用 view_attachment 时也会得到该描述。" },
    { key: "transcribe", label: "语音转写", type: "switch", desc: "语音与音频消息经 Google Gemini 转写为文字，作为该消息的正文；原始音频保留为附件。转写失败时房间内会给出说明。访问 Gemini 时沿用聊天室的 Telegram 代理设置。" },
    { key: "model", label: "转写模型", type: "text", placeholder: "gemini-3.5-transcribe", desc: "默认 gemini-3.5-transcribe（Gemini API generateContent）。" },
    { key: "mode", label: "转写模式", type: "select", options: [{ value: "SMART", label: "智能整理（去除口头语、整理格式）" }, { value: "VERBATIM", label: "逐字" }], desc: "默认智能整理。" },
    { key: "languages", label: "语言提示", type: "text", placeholder: "留空为自动识别，例如 cmn-Hans-CN, ja-JP", desc: "BCP-47 语言代码，逗号分隔；留空时自动识别并支持混说。" }
  ];
  var inputs = {};
  FIELDS.forEach(function (f) {
    var wrap = el("div", "mm-field");
    wrap.setAttribute("data-mm-key", f.key);
    var id = "cr-attach-" + f.key + "-" + Math.random().toString(36).slice(2, 7);
    var label = el("label", undefined, f.label);
    label.htmlFor = id;
    var input;
    if (f.type === "select") {
      input = el("select", "mm-input");
      f.options.forEach(function (o) { var op = el("option", null, o.label); op.value = o.value; input.append(op); });
    } else {
      input = el("input", f.type === "switch" ? undefined : "mm-input");
      if (f.type === "switch") { input.type = "checkbox"; input.style.accentColor = "var(--mm-accent)"; input.style.width = "16px"; input.style.height = "16px"; }
      else { input.type = "text"; if (f.placeholder) input.placeholder = f.placeholder; }
    }
    input.id = id;
    inputs[f.key] = input;
    if (f.type === "switch") {
      var line = el("div", "mm-row");
      line.style.marginTop = "0";
      line.append(input, label);
      wrap.append(line);
    } else wrap.append(label, input);
    wrap.append(el("div", "mm-desc", f.desc));
    host.append(wrap);
  });
  // 视频理解已独立为「多模态 › 视频理解」组件：这里只显示状态
  var videoNote = el("div", "mm-note");
  videoNote.style.overflowWrap = "anywhere";
  videoNote.textContent = "视频理解：设置已移到「多模态 › 视频理解」。";
  host.append(videoNote);
  // 转写密钥（掩码输入；只写入 DSH 凭据，不回显）
  var keyWrap = el("div", "mm-field");
  var keyId = "cr-attach-key-" + Math.random().toString(36).slice(2, 7);
  var keyLabel = el("label", undefined, "Gemini 转写密钥");
  keyLabel.htmlFor = keyId;
  var keyInput = el("input", "mm-input");
  keyInput.id = keyId;
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.placeholder = "留空则沿用 Gemini 成员所用服务商的密钥";
  var keyRow = el("div", "mm-row");
  keyRow.style.marginTop = "6px";
  var keySave = el("button", "mm-btn mm-ghost", "保存密钥");
  var keyClear = el("button", "mm-btn mm-ghost", "清除已保存的密钥");
  keySave.type = keyClear.type = "button";
  var keyMsg = el("span", "mm-msg");
  keyMsg.setAttribute("aria-live", "polite");
  keyRow.append(keySave, keyClear, keyMsg);
  keyWrap.append(keyLabel, keyInput, keyRow, el("div", "mm-desc", "可选。默认使用 DSH「设置 › 模型」中 Gemini（google）服务商的密钥；如需单独的密钥，可在此填写。密钥保存在 DSH 的凭据存储中，不会显示或写入日志。"));
  host.append(keyWrap);
  var srow = el("div", "mm-row");
  var save = el("button", "mm-btn", "保存附件设置");
  save.type = "button";
  save.disabled = true;
  var msg = el("span", "mm-msg");
  msg.setAttribute("aria-live", "polite");
  srow.append(save, msg);
  host.append(srow);
  var filled = false;
  var toasted = "";
  function render(b, fill) {
    var s = b.settings || {};
    if (fill || !filled) FIELDS.forEach(function (f) {
      var v = s[f.key];
      if (f.type === "switch") inputs[f.key].checked = v !== false;
      else inputs[f.key].value = v == null ? "" : String(v);
    });
    filled = true;
    save.disabled = false;
    var vs = b.video || null;
    videoNote.textContent = "视频理解：" + (!vs ? "设置已移到「多模态 › 视频理解」。" : vs.enabled ? "已启用（模型 " + (vs.model || "gemini-3.8-flash") + "；YouTube " + (vs.youtube === false ? "关" : "开") + "，哔哩哔哩 " + (vs.bilibili === false ? "关" : "开") + "）。开关与模型在「多模态 › 视频理解」中设置，密钥沿用下方的转写密钥。" : "未启用：视频不会被描述，成员也没有 watch_video 与视频输入。可在「多模态 › 视频理解」中开启。");
    var k = b.key || {};
    keyClear.disabled = !b.keySaved;
    keyMsg.className = "mm-msg" + (k.ready ? "" : " err");
    keyMsg.textContent = k.ready
      ? (k.via === "setting" ? "转写密钥：使用此处保存的密钥" : "转写密钥：沿用 DSH 凭据 " + k.ref + (k.seat ? "（成员 " + k.seat + "）" : ""))
      : "未找到可用的 Gemini 密钥";
    var problem = s.enabled !== false && s.transcribe !== false && !k.ready ? (k.problem || "未找到可用的 Gemini 密钥") : "";
    warn.textContent = problem ? "语音转写暂不可用：" + problem : "";
    warn.style.display = problem ? "" : "none";
    if (problem && problem !== toasted) { toasted = problem; mmToast("聊天室语音转写暂不可用 — " + problem, "err"); }
    if (!problem) toasted = "";
    msg.textContent = s.enabled === false || s.describe === false ? "" : (b.describerSeat ? "图片描述将由成员「" + b.describerSeat + "」所用模型生成。" : b.describer ? "房间中没有能识图的成员，图片描述将改用 Vision Router 生成。" : "房间中没有能识图的成员，也未检测到 Vision Router：不支持图片的成员只能看到图片的文件名与时间。");
  }
  function load(fill) {
    return chatroomJson("/chatroom/attach").then(function (b) { render(b, fill); }).catch(function (e) { msg.textContent = "读取失败：" + ((e && e.message) || e); });
  }
  save.addEventListener("click", function () {
    var out = {};
    FIELDS.forEach(function (f) {
      if (f.type === "switch") out[f.key] = !!inputs[f.key].checked;
      else out[f.key] = String(inputs[f.key].value || "").trim();
    });
    save.disabled = true;
    chatroomJson("/chatroom/config", { method: "PUT", body: JSON.stringify({ attach: out }) }).then(function () { mmToast("附件设置已保存", "info"); return load(true); })
      .catch(function (e) { mmToast("保存失败：" + ((e && e.message) || e), "err"); }).then(function () { save.disabled = false; });
  });
  function putKey(key) {
    keySave.disabled = keyClear.disabled = true;
    return chatroomJson("/chatroom/transcribe-key", { method: "PUT", body: JSON.stringify({ key: key }) }).then(function (b) {
      keyInput.value = "";
      mmToast(key ? "转写密钥已保存" : "已清除转写密钥", "info");
      render(b);
    }).catch(function (e) { mmToast("保存密钥失败：" + ((e && e.message) || e), "err"); }).then(function () { keySave.disabled = false; });
  }
  keySave.addEventListener("click", function () {
    var v = keyInput.value.trim();
    if (!v) { mmToast("请先输入密钥", "info"); return; }
    putKey(v);
  });
  keyClear.addEventListener("click", function () {
    notesDialog({ title: "清除转写密钥", okText: "清除", view: "清除后将改用 Gemini 成员所用服务商的密钥。确定清除吗？", onSubmit: function () { return putKey(""); } });
  });
  var timer = setInterval(function () { if (!host.isConnected) { clearInterval(timer); return; } load(); }, 30000);
  load();
}

// ── 房间会话 ↔ 右侧停靠窗：当前显示的 DSH 会话（经 conversation.input.right 插槽得知）若是某个房间的会话，停靠窗显示该房间。──
var chatroomActiveSession = { id: null, listeners: [] };
var chatroomSessionMap = { at: 0, map: {}, loading: null };
function chatroomSetActiveSession(id) {
  var next = id ? String(id) : null;
  if (chatroomActiveSession.id === next) return;
  chatroomActiveSession.id = next;
  chatroomActiveSession.listeners.slice().forEach(function (fn) { try { fn(next); } catch (e) {} });
}
function chatroomRoomForSession(id) {
  if (!id) return Promise.resolve(null);
  var fresh = Date.now() - chatroomSessionMap.at < 3000;
  if (fresh || chatroomSessionMap.loading) return Promise.resolve(chatroomSessionMap.map[id] || null);
  chatroomSessionMap.loading = fetchJson("/chatroom/sessions").then(function (b) {
    chatroomSessionMap.map = (b && b.ok && b.sessions) || {};
    chatroomSessionMap.at = Date.now();
  }).catch(function () {}).then(function () { chatroomSessionMap.loading = null; });
  return chatroomSessionMap.loading.then(function () { return chatroomSessionMap.map[id] || null; });
}
/** 不渲染任何内容，只上报当前会话编号。 */
function ChatroomSessionProbe(props) {
  var sessionId = props.sessionId ? String(props.sessionId) : null;
  React.useEffect(function () {
    chatroomSetActiveSession(sessionId);
    return function () { if (chatroomActiveSession.id === sessionId) chatroomSetActiveSession(null); };
  }, [sessionId]);
  return null;
}

function buildBoardsPanel(host) {
  var box = el("div");
  box.style.marginTop = "12px";
  var note = el("p", "mm-sub", "按棋类分别下载。一类里有多份项目时会一起下载。下载完成后，AI 调用 board_open 时会直接装载。棋盘下载完成后，可另行下载该棋类的辅助引擎；辅助引擎不随棋盘下载。");
  var list = el("div");
  var toasts = {};
  var pollTimer = null;
  var disposed = false;

  function licenseText(a) {
    if (a.license === "MIT") {
      return "MIT 许可" + (a.netLicense ? "，网络权重采用" + a.netLicense : "") + "。以独立进程运行，按需从官方发布页下载。";
    }
    return a.license + " 许可。以独立进程运行，按需从官方发布页下载，不随本插件分发。";
  }

  function assistRow(item) {
    var a = item.assist;
    var row = el("div", "mm-row");
    row.style.marginLeft = "1em";
    row.style.flexWrap = "wrap";
    var label = el("span", null, "辅助引擎：");
    var link = el("a", "mm-ext", a.name);
    link.href = a.repo;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "打开上游：" + a.repo;
    label.append(link);
    label.style.minWidth = "10em";
    var job = a.job || null;
    var running = job && job.state === "running";
    var msg = el("span", "mm-msg");
    row.append(label);
    if (!a.supported) {
      msg.textContent = "本机平台没有官方构建";
      row.append(msg);
    } else if (a.installed) {
      var state = el("span", "mm-msg ok", "已安装 · " + a.version);
      var remove = el("button", "mm-btn mm-ghost", "移除");
      remove.type = "button";
      remove.addEventListener("click", function () {
        scConfirm("移除辅助引擎「" + a.name + "」？", { title: "移除「" + a.name + "」", body: "将删除数据目录 boards/assist/ 中的 " + a.name + " 程序与权重文件；棋盘与存档不受影响。之后 AI 不再收到候选着法提示，可随时重新下载。", okText: "移除", cancelText: "保留" }).then(function (ok) {
          if (!ok) return;
          remove.disabled = true;
          fetchJson("/boards/assist/remove", { method: "POST", body: JSON.stringify({ game: item.id }) }).then(function (body) {
            if (!body || body.ok === false) throw new Error((body && body.error) || "移除失败");
            mmToast("已移除 " + a.name, "ok");
            render(body.games);
          }).catch(function (e) {
            remove.disabled = false;
            mmToast("移除失败：" + (e.message || e), "err");
          });
        });
      });
      row.append(state, remove);
    } else {
      var btn = el("button", "mm-btn mm-ghost", running ? "正在下载…" : "下载辅助引擎");
      btn.type = "button";
      btn.disabled = !!running;
      if (job && job.state === "error") { msg.className = "mm-msg err"; msg.textContent = job.error || "下载失败"; }
      btn.addEventListener("click", function () {
        btn.disabled = true;
        fetchJson("/boards/assist/download", { method: "POST", body: JSON.stringify({ game: item.id }) }).then(function (body) {
          if (!body || body.ok === false) throw new Error((body && body.error) || "下载失败");
          render(body.games);
          startPoll();
        }).catch(function (e) {
          btn.disabled = false;
          mmToast(a.name + " 下载失败：" + (e.message || e), "err");
        });
      });
      row.append(btn, msg);
    }
    var lic = el("div", "mm-msg", licenseText(a));
    lic.style.flexBasis = "100%";
    row.append(lic);
    return row;
  }

  function syncToasts(games) {
    var anyRunning = false;
    (games || []).forEach(function (item) {
      var a = item.assist;
      var job = a && a.job;
      // 下载进度走等待层（boards-assist:<game>，全局去重）；不再用普通 toast 带进度条，避免盖住普通通知。
      var w = mmWaitHandleOf("boards-assist", item.id);
      if (job && job.state === "running") {
        anyRunning = true;
        var p = job.progress == null ? "indeterminate" : (Number(job.progress) || 0);
        toasts[item.id] = true;
        if (!w) w = mmWaitShow("正在下载辅助引擎 " + a.name, "boards-assist", item.id, { progress: p });
        if (w) {
          try {
            if (job.step) w.setText(a.name + "：" + job.step);
            w.setProgress(p);
          } catch (e) {}
        }
      } else if (w || toasts[item.id]) {
        var had = !!w;
        delete toasts[item.id];
        mmWaitClear("boards-assist", item.id);
        if (!had) return;
        if (job && job.state === "done") mmToast(a.name + " 已安装，之后 AI 走棋时会收到候选着法提示", "ok");
        else if (job && job.state === "error") mmToast(a.name + " 下载失败：" + (job.error || "未知错误"), "err");
      }
    });
    return anyRunning;
  }

  function startPoll() {
    if (pollTimer || disposed) return;
    pollTimer = setInterval(function () {
      if (!host.isConnected) { clearInterval(pollTimer); pollTimer = null; disposed = true; return; }
      fetchJson("/boards/status").then(function (body) {
        if (!body || !body.ok) return;
        render(body.games);
        if (!syncToasts(body.games)) { clearInterval(pollTimer); pollTimer = null; }
      }).catch(function () {});
    }, 700);
  }

  function render(games) {
    list.textContent = "";
    var anyRunning = false;
    (games || []).forEach(function (item) {
      var row = el("div", "mm-row");
      var label = el("span", null, item.label + (item.ready ? " · 已下载" : " · 未下载"));
      label.style.minWidth = "11em";
      var btn = el("button", "mm-btn mm-ghost", item.ready ? "已下载" : "下载");
      btn.type = "button";
      btn.disabled = !!item.ready;
      var msg = el("span", "mm-msg");
      btn.addEventListener("click", function () {
        btn.disabled = true;
        msg.className = "mm-msg";
        msg.textContent = "正在下载…";
        mmWaitShow("正在下载 " + item.label, "boards-download", item.id);
        fetchJson("/boards/download", { method: "POST", body: JSON.stringify({ game: item.id }) }).then(function (body) {
          mmWaitClear("boards-download", item.id);
          if (!body || body.ok === false) {
            btn.disabled = false;
            msg.className = "mm-msg err";
            msg.textContent = (body && body.error) || "下载失败";
            return;
          }
          render(body.games);
        }).catch(function (error) {
          mmWaitClear("boards-download", item.id);
          btn.disabled = false;
          msg.className = "mm-msg err";
          msg.textContent = String(error && error.message || error);
        });
      });
      row.append(label, btn, msg);
      list.append(row);
      // 辅助引擎：只在棋盘本体下载完成后出现
      if (item.ready && item.assist) {
        list.append(assistRow(item));
        if (item.assist.job && item.assist.job.state === "running") anyRunning = true;
      }
    });
    if (anyRunning) startPoll();
  }
  function refresh() {
    fetchJson("/boards/status").then(function (body) {
      if (body && body.ok) { render(body.games); syncToasts(body.games); }
    }).catch(function () {});
  }
  box.append(note, list);
  host.append(box);
  refresh();
}

// ── 网关核验：输入栏「核验」开关 + 每回合「用量」右侧的核验芯片与详情卡（数据：/dsh-workbench/api/trust/*）──
var TRUST_ROWS = [
  { key: "model", label: "回包模型" },
  { key: "stream", label: "流式真实性" },
  { key: "tokens", label: "Token 计数" },
  { key: "cjk", label: "中文完整性" },
  { key: "cache", label: "缓存" }
];
var TRUST_STATUS_TEXT = { pass: "通过", warn: "可疑", none: "无数据" };
var TRUST_STATUS_COLOR = {
  pass: "var(--dsw-alias-state-success-primary, #2f9e44)",
  warn: "var(--dsw-alias-state-error-primary, #d9480f)",
  // 「无数据」与「可疑」同为红色：无法核验本身就是需要注意的结果。用主题变量，明暗主题自动切换。
  none: "var(--dsw-alias-state-error-primary, #d9480f)"
};
var TRUST_ICON_PATH = '<path d="M12 3.5l7 2.6v5.4c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6.1z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>';
function trustIcon(size) {
  return h("svg", {
    viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true",
    fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
    dangerouslySetInnerHTML: { __html: TRUST_ICON_PATH }
  });
}
var TRUST_CSS_TAG = "dsh-workbench-trust";
// 与官方「用量」芯片（TurnUsagePanel）和统计卡（stat-dialog）同一套变量；找到官方类名时同时挂上，保证完全一致。
var TRUST_CSS = [
  ".dsw-trust-root{min-width:0;display:inline-flex}",
  ".dsw-trust-trigger{min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:6px 8px;display:inline-flex;font-family:inherit}",
  ".dsw-trust-trigger svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}",
  ".dsw-trust-trigger:hover,.dsw-trust-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}",
  ".dsw-trust-trigger[data-status=warn],.dsw-trust-trigger[data-status=none]{color:var(--dsw-alias-state-error-primary,#d9480f)}",
  ".dsw-trust-trigger[data-status=warn]:hover,.dsw-trust-trigger[data-status=none]:hover,.dsw-trust-trigger[data-status=warn][aria-expanded=true],.dsw-trust-trigger[data-status=none][aria-expanded=true]{color:var(--dsw-alias-state-error-primary,#d9480f)}",
  ".dsw-trust-label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
  "@media (width<=480px){.dsw-trust-trigger{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}.dsw-trust-trigger .dsw-trust-label{display:none}}",
  ".dsw-trust-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}",
  ".dsw-trust-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
  ".dsw-trust-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}.dsw-trust-title-label svg{flex:none;width:14px;height:14px}",
  ".dsw-trust-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
  ".dsw-trust-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
  ".dsw-trust-details dt,.dsw-trust-details dd{min-width:0;margin:0}",
  ".dsw-trust-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}",
  ".dsw-trust-note{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
  ".dsw-trust-foot{margin-top:10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}"
].join("");

/** 官方 CSS 模块类名带构建哈希：从已注入的 style 标签里读出前缀（读不到时只用本插件的同款样式）。 */
function officialCssPrefix(tagSuffix, probe) {
  try {
    var tags = document.querySelectorAll("style[data-plugin-css]");
    for (var i = 0; i < tags.length; i++) {
      var id = tags[i].getAttribute("data-plugin-css") || "";
      if (id.indexOf(tagSuffix) < 0) continue;
      var m = new RegExp("\\.(\\w+)_" + probe + "\\{").exec(tags[i].textContent || "");
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}
function withOfficial(own, prefix, name) { return prefix ? own + " " + prefix + "_" + name : own; }

// 每会话一份：{ state: {installed, available, reason, enabled, loaded}, turns: {}, listeners }
var trustSessions = new Map();
// 设置页最近一次读到的安装状态（null = 尚未读取），仅用于设置卡片摘要。
var trustBenchKnown = null;
var trustLastRefreshAll = 0;
/**
 * 重新读取所有正在显示的会话的 /trust/state：设置页下载完成时（force）立即执行；
 * 窗口重新获得焦点 / 页面重新可见时最多每 15 秒一次，避免请求风暴。
 */
function trustRefreshAll(force) {
  var now = Date.now();
  if (!force && now - trustLastRefreshAll < 15000) return;
  trustLastRefreshAll = now;
  trustSessions.forEach(function (e, sid) { if (e.listeners.size) void trustFetchState(sid); });
}
if (typeof window !== "undefined") {
  window.addEventListener("focus", function () { trustRefreshAll(false); });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") trustRefreshAll(false); });
}
function trustEntry(sessionId) {
  var e = trustSessions.get(sessionId);
  if (!e) {
    e = { state: { loaded: false, installed: false, available: false, enabled: false, reason: "" }, turns: {}, version: 0, listeners: new Set(), timer: null, inflight: null, lastTurns: 0 };
    trustSessions.set(sessionId, e);
  }
  return e;
}
function trustBump(e) { e.version += 1; e.listeners.forEach(function (fn) { try { fn(); } catch (_) {} }); }
// 订阅函数按会话缓存、保持同一引用：每次渲染都换新函数会让 React 先退订全部再重订，
// 监听数短暂归零 → 停表 → 重启时立即再拉 /trust/state → 拉到后 bump → 再次重渲染……形成请求风暴。
function trustSubscribe(sessionId) {
  var e = trustEntry(sessionId);
  if (!e.subscribe) {
    e.subscribe = function (fn) {
      e.listeners.add(fn);
      if (e.stopTimer) { clearTimeout(e.stopTimer); e.stopTimer = null; }
      trustStartPolling(sessionId);
      return function () {
        e.listeners.delete(fn);
        if (!e.listeners.size && !e.stopTimer) {
          // 延迟停表：切换会话或虚拟列表换行时不反复启停。
          e.stopTimer = setTimeout(function () { e.stopTimer = null; if (!e.listeners.size) trustStopPolling(e); }, 3000);
        }
      };
    };
    e.getSnapshot = function () { return e.version; };
  }
  return e;
}
var trustNoopSubscribe = function () { return function () {}; };
var trustZero = function () { return 0; };
function useTrust(sessionId) {
  var e = sessionId ? trustSubscribe(sessionId) : null;
  React.useSyncExternalStore(e ? e.subscribe : trustNoopSubscribe, e ? e.getSnapshot : trustZero, trustZero);
  return e;
}
async function trustFetchState(sessionId) {
  var e = trustEntry(sessionId);
  if (e.stateInflight) return e.stateInflight;
  e.stateInflight = (async function () {
    try {
      var r = await fetch(API + "/trust/state?sessionId=" + encodeURIComponent(sessionId));
      var j = await r.json();
      if (j && j.ok) {
        var next = { loaded: true, installed: !!j.installed, available: !!j.available, enabled: !!j.enabled, reason: String(j.reason || ""), dir: String(j.dir || "") };
        var changed = JSON.stringify(next) !== JSON.stringify(e.state);
        e.state = next;
        if (changed) trustBump(e);
      }
    } catch (_) {}
    e.stateInflight = null;
  })();
  return e.stateInflight;
}
async function trustFetchTurns(sessionId) {
  var e = trustEntry(sessionId);
  if (e.inflight) return e.inflight;
  e.inflight = (async function () {
    try {
      var r = await fetch(API + "/trust/turns?sessionId=" + encodeURIComponent(sessionId));
      var j = await r.json();
      if (j && j.ok) {
        var before = JSON.stringify(e.turns);
        e.turns = j.turns || {};
        e.lastTurns = Date.now();
        if (JSON.stringify(e.turns) !== before) trustBump(e);
      }
    } catch (_) {}
    e.inflight = null;
  })();
  return e.inflight;
}
function trustStartPolling(sessionId) {
  var e = trustEntry(sessionId);
  if (e.timer) return;
  void trustFetchState(sessionId).then(function () { return trustFetchTurns(sessionId); });
  var tick = 0;
  e.timer = window.setInterval(function () {
    tick += 1;
    // 开启时每 4 秒刷新结果；其余情况每 60 秒确认一次状态（可能刚在设置页下载完成）。
    if (e.state.enabled && e.state.available) void trustFetchTurns(sessionId);
    if (tick % 15 === 0 || !e.state.loaded) void trustFetchState(sessionId);
  }, 4000);
}
function trustStopPolling(e) { if (e.timer) { window.clearInterval(e.timer); e.timer = null; } }

/** 输入栏开关，样式与 dsh-vision-router 的「识图」按钮一致（同一组 dsw 变量，随明暗主题变化）。 */
function TrustToggle(props) {
  var sessionId = props._sid || props.sessionId;
  var e = useTrust(sessionId);
  var busyState = React.useState(false);
  var busy = busyState[0], setBusy = busyState[1];
  if (!sessionId || !e) return null;
  var st = e.state;
  // 未读到状态或未下载 llm-gateway-bench 时不显示开关；下载完成后经 /trust/state 刷新自动出现。
  if (!st.loaded || !st.installed) return null;
  var active = !!st.enabled;
  var unavailable = !st.available;
  var disabled = busy || !st.loaded || (unavailable && !active);
  var title = !st.loaded ? "正在读取网关核验状态…"
    : unavailable && !active ? "llm-gateway-bench 无法加载" + (st.reason ? "：" + st.reason : "") + "。请在「设置 › 工作组件 › 网关核验」中重新安装。"
    : busy ? "正在切换网关核验…"
    : active ? "关闭网关核验" : "开启网关核验：此后每轮回复将核对回包模型、流式真实性、Token 计数、中文完整性与缓存";
  var style = {
    appearance: "none", minHeight: 28, display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 8,
    border: "1px solid " + (active ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l2)"),
    background: active ? "color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)" : "transparent",
    color: active ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-label-secondary)",
    boxShadow: active ? "inset 0 0 0 1px var(--dsw-alias-brand-primary)" : "none",
    font: "inherit", fontSize: 12, lineHeight: 1.4, fontWeight: active ? 650 : 500,
    cursor: disabled ? "default" : "pointer", opacity: disabled && (unavailable || !st.loaded) ? 0.45 : 1, whiteSpace: "nowrap"
  };
  return h("button", {
    type: "button",
    "data-dsh-workbench-trust-toggle": "true",
    "aria-pressed": active,
    "aria-label": title,
    title: title,
    disabled: disabled,
    style: style,
    onClick: function () {
      if (disabled) return;
      setBusy(true);
      scPost("/trust/toggle", { sessionId: sessionId, enabled: !active }).then(function (j) {
        e.state = { loaded: true, installed: !!j.installed, available: !!j.available, enabled: !!j.enabled, reason: String(j.reason || ""), dir: String(j.dir || "") };
        trustBump(e);
      }).catch(function (err) {
        scAlert("网关核验", String(err && err.message || err));
        void trustFetchState(sessionId);
      }).finally(function () { setBusy(false); });
    }
  },
    h("span", { "aria-hidden": "true", style: { display: "inline-flex", lineHeight: 1 } }, trustIcon(13)),
    h("span", null, "核验"),
    active ? h("span", { "aria-hidden": "true", style: { fontSize: 12, lineHeight: 1, fontWeight: 800, marginLeft: 1 } }, "✓") : null
  );
}

var TRUST_INLINE_AFTER_MS = 1500;
/** 「用量」芯片：官方 TurnUsagePanel 的根节点（类名带哈希，按结构找）。 */
function findUsageRoot(tail) {
  var prefix = officialCssPrefix("TurnUsagePanel", "root");
  if (prefix) {
    var el = tail.querySelector("." + prefix + "_root:not([data-dsw-trust])");
    if (el) return el;
  }
  var buttons = tail.querySelectorAll('button[aria-haspopup="dialog"]');
  for (var i = 0; i < buttons.length; i++) {
    var t = (buttons[i].textContent || "").trim();
    if (/^(用量|Usage)[\s\u00a0\u202f]/.test(t) && buttons[i].parentElement && !buttons[i].parentElement.hasAttribute("data-dsw-trust")) return buttons[i].parentElement;
  }
  return null;
}

function TrustCard(props) {
  var result = props.result;
  var pos = props.pos;
  var p = officialCssPrefix("stat-dialog", "panel");
  var overall = result ? result.overall : "none";
  var rows = [];
  for (var i = 0; i < TRUST_ROWS.length; i++) {
    var def = TRUST_ROWS[i];
    var r = result && result.rows ? result.rows[def.key] : null;
    var status = r && r.status ? r.status : "none";
    rows.push(h("dt", { key: def.key + ":t" }, def.label));
    rows.push(h("dd", { key: def.key + ":d" },
      h("span", { style: { color: TRUST_STATUS_COLOR[status], fontWeight: status === "pass" ? 500 : 600 } }, TRUST_STATUS_TEXT[status] || "无数据"),
      r && r.value ? h("span", null, " · " + r.value) : null,
      r && r.note ? h("span", { className: "dsw-trust-note" }, r.note) : null
    ));
  }
  var foot = !result ? "本回合未产生核验数据（开关开启前的回合或调用尚未结束）。"
    : "共 " + result.calls + " 次模型调用，每项取最不利的一次。" + (result.models && result.models.length ? "回包模型：" + result.models.join("、") + "。" : "") + "判定规则来自 llm-gateway-bench，仅作参考。";
  return h("div", {
    ref: props.panelRef,
    className: withOfficial("dsw-trust-panel", p, "panel"),
    role: "dialog",
    "aria-label": "网关核验",
    style: pos,
    onMouseEnter: props.onEnter,
    onMouseLeave: props.onLeave
  },
    h("div", { className: withOfficial("dsw-trust-title", p, "title") },
      h("span", { className: withOfficial("dsw-trust-title-label", p, "titleLabel") }, trustIcon(14), "网关核验"),
      h("span", { style: { color: TRUST_STATUS_COLOR[overall], fontVariantNumeric: "tabular-nums" } }, TRUST_STATUS_TEXT[overall])
    ),
    h("div", { className: withOfficial("dsw-trust-rule", p, "titleRule"), "aria-hidden": true }),
    h("dl", { className: withOfficial("dsw-trust-details", p, "details") }, rows),
    h("div", { className: "dsw-trust-foot" }, foot)
  );
}

function TrustChip(props) {
  var result = props.result;
  var openState = React.useState(false);
  var open = openState[0], setOpen = openState[1];
  var pinState = React.useState(false);
  var pinned = pinState[0], setPinned = pinState[1];
  var posState = React.useState(null);
  var pos = posState[0], setPos = posState[1];
  var btnRef = React.useRef(null);
  var panelRef = React.useRef(null);
  var hideTimer = React.useRef(null);
  var tp = props.classes || {};
  var overall = result ? result.overall : "none";

  function show() { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } setOpen(true); }
  function hideSoon() {
    if (pinned) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(function () { setOpen(false); }, 160);
  }
  React.useLayoutEffect(function () {
    if (!open || !btnRef.current) return;
    var rect = btnRef.current.getBoundingClientRect();
    var w = panelRef.current ? panelRef.current.offsetWidth : 320;
    var hgt = panelRef.current ? panelRef.current.offsetHeight : 200;
    var left = Math.max(12, Math.min(rect.left, window.innerWidth - w - 12));
    var top = rect.top - hgt - 8;
    if (top < 12) top = rect.bottom + 8;
    setPos({ left: left, top: top });
  }, [open, result]);
  React.useEffect(function () {
    if (!open || !pinned) return;
    function onDown(ev) {
      if (btnRef.current && btnRef.current.contains(ev.target)) return;
      if (panelRef.current && panelRef.current.contains(ev.target)) return;
      setPinned(false); setOpen(false);
    }
    function onKey(ev) { if (ev.key === "Escape") { setPinned(false); setOpen(false); } }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return function () { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [open, pinned]);
  React.useEffect(function () { return function () { if (hideTimer.current) clearTimeout(hideTimer.current); }; }, []);

  var label = "核验 " + TRUST_STATUS_TEXT[overall];
  return h(React.Fragment, null,
    h("button", {
      ref: btnRef,
      type: "button",
      className: "dsw-trust-trigger" + (tp.trigger ? " " + tp.trigger : ""),
      "data-status": overall,
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      title: "网关核验：" + TRUST_STATUS_TEXT[overall],
      onMouseEnter: show,
      onMouseLeave: hideSoon,
      onClick: function () { if (pinned) { setPinned(false); setOpen(false); } else { setPinned(true); setOpen(true); } }
    },
      trustIcon(15),
      h("span", { className: "dsw-trust-label" + (tp.label ? " " + tp.label : "") }, label)
    ),
    open && createPortal ? createPortal(h(TrustCard, {
      result: result,
      pos: pos || { left: -9999, top: -9999, visibility: "hidden" },
      panelRef: panelRef,
      onEnter: show,
      onLeave: hideSoon
    }), document.body) : null
  );
}

function trustTurnNumber(t) {
  if (typeof t === "number") return Number.isSafeInteger(t) ? t : null;
  if (typeof t === "string" && /^\d+$/.test(t)) return Number(t);
  if (t && typeof t === "object") {
    if (Number.isSafeInteger(t.turn)) return t.turn;
    var sd = t.start && (t.start.data || (t.start.event && t.start.event.data));
    if (sd && Number.isSafeInteger(sd.turn)) return sd.turn;
    if (typeof t.id === "string" && /^\d+$/.test(t.id)) return Number(t.id);
  }
  return null;
}

/** conversation.chat.turnTail：只放一个隐藏锚点，芯片挂到同一回合「用量」芯片的右侧。 */
function TrustTurnTail(props) {
  var sessionId = props._sid || props.sessionId;
  // 宿主传入的 props.turn 是回合对象（{ turn, data, end, status, … }，见 ChatNodeSeat turnOf），不是回合号；
  // 服务端按回合号记账，这里取 turn.turn，否则 e.turns["[object Object]"] 永远为空，芯片不出现。
  var turn = trustTurnNumber(props.turn);
  var e = useTrust(sessionId);
  var anchorRef = React.useRef(null);
  var hostState = React.useState(null);
  var host = hostState[0], setHost = hostState[1];
  var classesState = React.useState(null);
  var classes = classesState[0], setClasses = classesState[1];
  var result = e && turn != null ? e.turns[String(turn)] || null : null;
  var show = !!(e && turn != null && result && e.state.available);

  React.useLayoutEffect(function () {
    if (!show || !anchorRef.current) { setHost(null); return; }
    var el = document.createElement("span");
    el.setAttribute("data-dsw-trust", String(turn));
    el.className = "dsw-trust-root";
    var alive = true;
    var started = Date.now();
    function place() {
      if (!alive || !anchorRef.current) return;
      var tail = anchorRef.current.closest("[data-turn-tail]");
      var usage = tail ? findUsageRoot(tail) : null;
      if (!usage) {
        // 找不到官方「用量」芯片（结构变化、未显示用量等）时不丢结果：稍候退回到本回合尾部直接显示。
        if (Date.now() - started >= TRUST_INLINE_AFTER_MS && (!el.isConnected || el.previousElementSibling !== anchorRef.current)) {
          anchorRef.current.insertAdjacentElement("afterend", el);
          el.setAttribute("data-dsw-trust-inline", "true");
          el.className = "dsw-trust-root";
          setClasses({ trigger: "", label: "" });
        }
        return;
      }
      el.removeAttribute("data-dsw-trust-inline");
      {
        if (el.previousElementSibling !== usage || !el.isConnected) {
          usage.insertAdjacentElement("afterend", el);
          var btn = usage.querySelector("button");
          var lab = btn && btn.querySelector("span");
          if (usage.className && el.className.indexOf(usage.className) < 0) el.className = "dsw-trust-root " + usage.className;
          setClasses({ trigger: btn ? btn.className : "", label: lab ? lab.className : "" });
        }
      }
    }
    place();
    setHost(el);
    var inlineTimer = setTimeout(place, TRUST_INLINE_AFTER_MS + 50);
    var root = document.querySelector("[data-conversation-scroll]") || document.body;
    var queued = false;
    var obs = new MutationObserver(function () {
      if (queued || (el.isConnected && el.previousElementSibling && el.previousElementSibling !== anchorRef.current)) return;
      queued = true;
      window.requestAnimationFrame(function () { queued = false; place(); });
    });
    obs.observe(root, { childList: true, subtree: true });
    return function () { alive = false; clearTimeout(inlineTimer); obs.disconnect(); if (el.parentNode) el.parentNode.removeChild(el); };
  }, [show, turn]);

  return h(React.Fragment, null,
    h("span", { ref: anchorRef, "data-dsw-trust-anchor": turn == null ? "" : String(turn), style: { display: "none" } }),
    host && createPortal ? createPortal(h(TrustChip, { result: result, classes: classes }), host) : null
  );
}

function apply(ctx) {
  // 插件加载即挂载通知宿主，并开始连接观察与启动时检查更新（不必先打开设置页）
  ctx.effect(function () {
    startMmBackgroundWatch();
    return function () { /* 通知堆留在 body；进程退出即消失 */ };
  }, "dsh-workbench: toast host + conn/update watch");

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
  // mm_send_image / mm_send_file 不注册自定义 toolview：走宿主标准面板（输入 JSON / 输出 + 查看），
  // 与 image_generate 一致；MmCard 仍由 turnTail 单独显示。
  ctx.slots.inject("tool.call.toolview", function () {
    var offSend = null;
    var offFile = null;
    var offMap = ctx.slots.register({ name: "tool.call.toolview", key: "map_card" }, MmToolRow);
    var offRoute = ctx.slots.register({ name: "tool.call.toolview", key: "route" }, MmToolRow);
    var offCalendar = ctx.slots.register({ name: "tool.call.toolview", key: "calendar_show" }, MmToolRow);
    return function () {
      if (offSend) offSend();
      if (offFile) offFile();
      if (offMap) offMap();
      if (offRoute) offRoute();
      if (offCalendar) offCalendar();
    };
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

  // 网关核验：样式、输入栏开关（「识图」之后、模型选择器之前）、回合芯片。
  ctx.effect(function () {
    var styleEl = null;
    if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="' + TRUST_CSS_TAG + '"]')) {
      styleEl = document.createElement("style");
      styleEl.dataset.plugin = "dsh-workbench";
      styleEl.dataset.pluginCss = TRUST_CSS_TAG;
      styleEl.textContent = TRUST_CSS;
      document.head.appendChild(styleEl);
    }
    return function () { if (styleEl) styleEl.remove(); };
  }, "dsh-workbench: gateway-trust styles");

  ctx.effect(function () {
    return ctx.slots.inject("conversation.input.right", function () {
      return ctx.slots.register({
        name: "conversation.input.right",
        id: "dsh-workbench-trust-toggle",
        order: 41,
        inject: function (sessionId) { return { _sid: sessionId }; }
      }, TrustToggle);
    });
  }, "dsh-workbench: gateway-trust toggle");

  ctx.effect(function () {
    return ctx.slots.inject("conversation.chat.turnTail", function () {
      return ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: "dsh-workbench-trust-chip",
        order: 90,
        inject: function (sessionId) { return { _sid: sessionId }; }
      }, TrustTurnTail);
    });
  }, "dsh-workbench: gateway-trust chip");

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

  ctx.effect(function () {
    return ctx.slots.inject("conversation.input.right", function () {
      return ctx.slots.register({
        name: "conversation.input.right",
        id: "dsh-workbench-chatroom-session-probe",
        order: 99
      }, ChatroomSessionProbe);
    });
  }, "dsh-workbench: chatroom session probe");

  ctx.effect(function () {
    var host = document.createElement("div");
    host.id = "dsh-boards-dock";
    host.style.cssText = "display:none;position:fixed;top:0;right:0;width:min(440px,46vw);height:100vh;z-index:30;box-sizing:border-box;background:#1b1714;border-left:1px solid #3b2f27;flex-direction:column";
    var dockStyle = document.createElement("style");
    dockStyle.id = "dsh-boards-dock-style";
    dockStyle.textContent = "html[data-dsh-boards-open] :has(> [data-rightbar-col]){grid-template-columns:var(--dsh-boards-sidebar,280px) minmax(0,1fr) var(--dsh-boards-dock,440px)!important}#dsh-boards-dock .dsh-boards-resize{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:3;touch-action:none}#dsh-boards-dock .dsh-boards-resize:hover,#dsh-boards-dock[data-resizing] .dsh-boards-resize{background:rgba(255,255,255,.22)}html[data-dsh-boards-resizing],html[data-dsh-boards-resizing] *{cursor:col-resize!important}html[data-dsh-boards-resizing]{user-select:none!important}";
    document.head.appendChild(dockStyle);
    var iframe = document.createElement("iframe");
    iframe.title = "棋盘";
    iframe.style.cssText = "flex:1;border:0;width:100%;height:100%;background:#1b1714";
    host.appendChild(iframe);
    var roomHost = document.createElement("div");
    roomHost.className = "mm-page cr-dock-root";
    roomHost.style.display = "none";
    host.appendChild(roomHost);
    var roomShown = null;
    var roomPanel = null;
    function showRoom(roomId) {
      if (roomShown === roomId) return;
      hideRoom();
      roomShown = roomId;
      roomHost.style.display = "flex";
      iframe.style.display = "none";
      host.style.background = "var(--dsw-alias-bg-layer-1,Canvas)";
      host.style.borderLeftColor = "var(--dsw-alias-border-l2,rgba(127,127,127,.3))";
      try { roomPanel = buildChatroomPanel(roomHost, { roomId: roomId, dock: true }); } catch (e) { roomHost.textContent = "聊天室加载失败：" + ((e && e.message) || e); }
    }
    function hideRoom() {
      if (roomPanel && roomPanel.dispose) { try { roomPanel.dispose(); } catch (e) {} }
      roomPanel = null;
      roomShown = null;
      roomHost.textContent = "";
      roomHost.style.display = "none";
      iframe.style.display = "";
      host.style.background = "#1b1714";
      host.style.borderLeftColor = "#3b2f27";
    }
    var handle = document.createElement("div");
    handle.className = "dsh-boards-resize";
    handle.title = "拖拽调整宽度";
    host.appendChild(handle);
    document.body.appendChild(host);
    var seen = "";
    var preferredWidth = null;
    var SEND_LABEL = /^(发送消息|排队发送|插话发送|send message|queue message|steer message)$/i;
    function composerText(input) {
      return String(input.innerText || input.textContent || "").replace(/\u00a0/g, " ").replace(/\n+$/g, "");
    }
    function selectAll(input) {
      var selection = window.getSelection();
      if (!selection) return;
      var range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    function writeComposer(input, text) {
      input.focus();
      if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
        var proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      selectAll(input);
      var inserted = false;
      try { inserted = document.execCommand("insertText", false, text); } catch (e) { inserted = false; }
      var got = composerText(input);
      if (!inserted || got.indexOf(text + text) !== -1) {
        selectAll(input);
        try { document.execCommand("insertText", false, text); } catch (e) {}
      }
    }
    function findSend(input) {
      var root = input;
      for (var i = 0; i < 20 && root; i++) {
        var buttons = root.querySelectorAll("button");
        for (var j = buttons.length - 1; j >= 0; j--) {
          var label = (buttons[j].getAttribute("aria-label") || "").trim();
          if (SEND_LABEL.test(label)) return buttons[j];
        }
        root = root.parentElement;
      }
      return null;
    }
    function deliverPrompt(text, done) {
      var gate = window.__dshBoardsPromptGate || (window.__dshBoardsPromptGate = { text: "", at: 0 });
      var now = Date.now();
      if (gate.text === text && now - gate.at < 1000) { done(true); return; }
      gate.text = text;
      gate.at = now;
      var nodes = Array.prototype.slice.call(document.querySelectorAll("textarea, [contenteditable='true']"));
      var input = null;
      var best = -1;
      nodes.forEach(function (node) {
        var rect = node.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 16) return;
        if (rect.bottom < window.innerHeight * 0.4) return;
        var score = rect.width * rect.height;
        if (score > best) { best = score; input = node; }
      });
      if (!input) { gate.at = 0; done(false); return; }
      try { writeComposer(input, text); } catch (e) { gate.at = 0; done(false); return; }
      var tries = 0;
      function attempt() {
        var send = findSend(input);
        var blocked = !send || send.disabled || send.getAttribute("aria-disabled") === "true";
        if (blocked && tries < 24) {
          tries++;
          window.setTimeout(attempt, 50);
          return;
        }
        if (!send || send.disabled || send.getAttribute("aria-disabled") === "true") { done(false); return; }
        send.click();
        done(true);
      }
      window.setTimeout(attempt, 0);
    }
    function onMessage(ev) {
      if (ev.origin !== location.origin) return;
      if (!ev.data || ev.data.source !== "dsh-boards") return;
      if (ev.data.roomId) {
        if (ev.source && ev.source.postMessage) {
          try { ev.source.postMessage({ source: "dsh-boards-ack", ok: true }, ev.origin); } catch (e) {}
        }
        return;
      }
      var text = String(ev.data.prompt || "");
      deliverPrompt(text, function (ok) {
        if (ev.source && ev.source.postMessage) {
          try { ev.source.postMessage({ source: "dsh-boards-ack", ok: ok }, ev.origin); } catch (e) {}
        }
      });
    }
    window.addEventListener("message", onMessage);
    function officialTrack(frame, pattern) {
      var template = frame.style.gridTemplateColumns || "";
      var found = template.match(pattern);
      return found ? parseFloat(found[1]) : 0;
    }
    function layoutDock(open) {
      var root = document.documentElement;
      if (!open) {
        root.removeAttribute("data-dsh-boards-open");
        root.style.removeProperty("--dsh-boards-sidebar");
        root.style.removeProperty("--dsh-boards-dock");
        return;
      }
      var rightbar = document.querySelector("[data-rightbar-col]");
      var center = rightbar && rightbar.previousElementSibling;
      var sidebar = center && center.previousElementSibling;
      var frame = rightbar && rightbar.parentElement;
      if (!rightbar || !center || !sidebar || !frame) return;
      var frameRect = frame.getBoundingClientRect();
      var centerRect = center.getBoundingClientRect();
      var sidebarWidth = officialTrack(frame, /^([\d.]+)px/);
      var reserved = officialTrack(frame, /minmax\(\s*0px\s*,\s*([\d.]+)px\s*\)\s*$/);
      var maxDock = Math.max(0, frameRect.width - sidebarWidth - 240);
      var minDock = Math.min(240, maxDock);
      var fallback = Math.min(440, frameRect.width * 0.46);
      var target = preferredWidth == null ? fallback : preferredWidth;
      var dock = Math.round(Math.min(maxDock, Math.max(minDock, target)));
      host.style.top = Math.max(0, Math.round(centerRect.top)) + "px";
      host.style.height = Math.max(0, Math.round(centerRect.height)) + "px";
      host.style.width = dock + "px";
      host.style.right = Math.max(0, Math.round(window.innerWidth - frameRect.right)) + "px";
      var painted = Math.round(host.getBoundingClientRect().width);
      if (painted > 0) dock = painted;
      if (preferredWidth != null) preferredWidth = dock;
      if (reserved + 1 >= dock) {
        root.removeAttribute("data-dsh-boards-open");
        return;
      }
      root.style.setProperty("--dsh-boards-sidebar", sidebarWidth + "px");
      root.style.setProperty("--dsh-boards-dock", dock + "px");
      root.setAttribute("data-dsh-boards-open", "");
    }
    var dragListeners = [];
    function clearDrag() {
      host.removeAttribute("data-resizing");
      document.documentElement.removeAttribute("data-dsh-boards-resizing");
      iframe.style.pointerEvents = "";
      dragListeners.forEach(function (off) { off(); });
      dragListeners = [];
    }
    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || host.style.display === "none") return;
      e.preventDefault();
      clearDrag();
      var startX = e.clientX;
      var startWidth = host.getBoundingClientRect().width;
      host.setAttribute("data-resizing", "");
      document.documentElement.setAttribute("data-dsh-boards-resizing", "");
      iframe.style.pointerEvents = "none";
      function onMove(ev) {
        preferredWidth = startWidth + (startX - ev.clientX);
        layoutDock(true);
      }
      function onUp() { clearDrag(); }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      dragListeners.push(function () {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      });
    });
    function syncDock() {
      var active = chatroomActiveSession.id;
      chatroomRoomForSession(active).then(function (roomId) {
        if (roomId && chatroomActiveSession.id === active) {
          showRoom(roomId);
          host.style.display = "flex";
          layoutDock(true);
          return;
        }
        if (roomShown) hideRoom();
        syncBoards();
      });
    }
    chatroomActiveSession.listeners.push(syncDock);
    function syncBoards() {
      var sid = chatroomActiveSession.id || "";
      var q = sid ? ("?session=" + encodeURIComponent(sid)) : "";
      fetchJson("/boards/session" + q).then(function (body) {
        var session = body && body.ok && body.open ? body.session : null;
        if (!session) {
          host.style.display = "none";
          if (iframe.getAttribute("src")) iframe.removeAttribute("src");
          seen = "";
          layoutDock(false);
          return;
        }
        host.style.display = "flex";
        if (seen !== session.id) {
          seen = session.id;
          var key = session.key ? ("&key=" + encodeURIComponent(session.key)) : "";
          iframe.src = "/dsh-workbench/boards/play?id=" + encodeURIComponent(session.id) + key;
        }
        layoutDock(true);
      }).catch(function () {});
    }
    syncDock();
    var timer = window.setInterval(syncDock, 1000);
    var resizeObserver = new ResizeObserver(function () {
      if (host.style.display !== "none") layoutDock(true);
    });
    resizeObserver.observe(document.documentElement);
    return function () {
      window.clearInterval(timer);
      chatroomActiveSession.listeners = chatroomActiveSession.listeners.filter(function (fn) { return fn !== syncDock; });
      hideRoom();
      resizeObserver.disconnect();
      clearDrag();
      window.removeEventListener("message", onMessage);
      layoutDock(false);
      dockStyle.remove();
      host.remove();
    };
  }, "dsh-workbench: boards preview");

  ctx.effect(function () {
    var host = document.createElement("div");
    host.id = "dsh-cards-dock";
    host.style.cssText = "display:none;position:fixed;top:0;right:0;width:min(440px,46vw);height:100vh;z-index:31;box-sizing:border-box;background:#0c241c;border-left:1px solid #1e4a38;flex-direction:column";
    var dockStyle = document.createElement("style");
    dockStyle.id = "dsh-cards-dock-style";
    dockStyle.textContent = "html[data-dsh-cards-open] :has(> [data-rightbar-col]){grid-template-columns:var(--dsh-cards-sidebar,280px) minmax(0,1fr) var(--dsh-cards-dock,440px)!important}#dsh-cards-dock .dsh-cards-resize{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:3;touch-action:none}#dsh-cards-dock .dsh-cards-resize:hover,#dsh-cards-dock[data-resizing] .dsh-cards-resize{background:rgba(255,255,255,.22)}html[data-dsh-cards-resizing],html[data-dsh-cards-resizing] *{cursor:col-resize!important}html[data-dsh-cards-resizing]{user-select:none!important}";
    document.head.appendChild(dockStyle);
    var iframe = document.createElement("iframe");
    iframe.title = "牌桌";
    iframe.style.cssText = "flex:1;border:0;width:100%;height:100%;background:#0c241c";
    host.appendChild(iframe);
    var handle = document.createElement("div");
    handle.className = "dsh-cards-resize";
    handle.title = "拖拽调整宽度";
    host.appendChild(handle);
    document.body.appendChild(host);
    var seen = "";
    var preferredWidth = null;
    function officialTrack(frame, pattern) {
      var template = frame.style.gridTemplateColumns || "";
      var found = template.match(pattern);
      return found ? parseFloat(found[1]) : 0;
    }
    function layoutDock(open) {
      var root = document.documentElement;
      if (!open) {
        root.removeAttribute("data-dsh-cards-open");
        root.style.removeProperty("--dsh-cards-sidebar");
        root.style.removeProperty("--dsh-cards-dock");
        return;
      }
      var rightbar = document.querySelector("[data-rightbar-col]");
      var center = rightbar && rightbar.previousElementSibling;
      var sidebar = center && center.previousElementSibling;
      var frame = rightbar && rightbar.parentElement;
      if (!rightbar || !center || !sidebar || !frame) return;
      var boards = document.getElementById("dsh-boards-dock");
      var boardsOpen = !!(boards && boards.style.display !== "none");
      var boardsWidth = boardsOpen ? Math.round(boards.getBoundingClientRect().width) : 0;
      var frameRect = frame.getBoundingClientRect();
      var centerRect = center.getBoundingClientRect();
      var sidebarWidth = officialTrack(frame, /^([\d.]+)px/);
      var reserved = officialTrack(frame, /minmax\(\s*0px\s*,\s*([\d.]+)px\s*\)\s*$/);
      var maxDock = Math.max(0, frameRect.width - sidebarWidth - boardsWidth - 240);
      var minDock = Math.min(240, maxDock);
      var fallback = Math.min(440, frameRect.width * 0.46);
      var target = preferredWidth == null ? fallback : preferredWidth;
      var dock = Math.round(Math.min(maxDock, Math.max(minDock, target)));
      var frameGap = Math.max(0, Math.round(window.innerWidth - frameRect.right));
      host.style.top = Math.max(0, Math.round(centerRect.top)) + "px";
      host.style.height = Math.max(0, Math.round(centerRect.height)) + "px";
      host.style.width = dock + "px";
      host.style.right = (boardsWidth + frameGap) + "px";
      var painted = Math.round(host.getBoundingClientRect().width);
      if (painted > 0) dock = painted;
      if (preferredWidth != null) preferredWidth = dock;
      var total = dock + boardsWidth;
      if (reserved + 1 >= total) {
        root.removeAttribute("data-dsh-cards-open");
        return;
      }
      root.style.setProperty("--dsh-cards-sidebar", sidebarWidth + "px");
      root.style.setProperty("--dsh-cards-dock", total + "px");
      root.setAttribute("data-dsh-cards-open", "");
    }
    var dragListeners = [];
    function clearDrag() {
      host.removeAttribute("data-resizing");
      document.documentElement.removeAttribute("data-dsh-cards-resizing");
      iframe.style.pointerEvents = "";
      dragListeners.forEach(function (off) { off(); });
      dragListeners = [];
    }
    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || host.style.display === "none") return;
      e.preventDefault();
      clearDrag();
      var startX = e.clientX;
      var startWidth = host.getBoundingClientRect().width;
      host.setAttribute("data-resizing", "");
      document.documentElement.setAttribute("data-dsh-cards-resizing", "");
      iframe.style.pointerEvents = "none";
      function onMove(ev) {
        preferredWidth = startWidth + (startX - ev.clientX);
        layoutDock(true);
      }
      function onUp() { clearDrag(); }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      dragListeners.push(function () {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      });
    });
    function syncDock() {
      fetchJson("/cards/session").then(function (body) {
        var session = body && body.ok && body.open ? body.session : null;
        if (!session) {
          host.style.display = "none";
          if (iframe.getAttribute("src")) iframe.removeAttribute("src");
          seen = "";
          layoutDock(false);
          return;
        }
        host.style.display = "flex";
        if (seen !== session.id) {
          seen = session.id;
          iframe.src = "/dsh-workbench/cards/play?id=" + encodeURIComponent(session.id);
        }
        layoutDock(true);
      }).catch(function () {});
    }
    syncDock();
    var timer = window.setInterval(syncDock, 1000);
    var resizeObserver = new ResizeObserver(function () {
      if (host.style.display !== "none") layoutDock(true);
    });
    resizeObserver.observe(document.documentElement);
    return function () {
      window.clearInterval(timer);
      resizeObserver.disconnect();
      clearDrag();
      layoutDock(false);
      dockStyle.remove();
      host.remove();
    };
  }, "dsh-workbench: cards preview");
}

exports.inject = inject;
exports.apply = apply;
exports.name = "dsh-workbench-client";
		return module.exports;
	}
});
