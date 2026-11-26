# 会话采样参数（temperature / top_p）

宿主核对对象：`C:\Users\10917\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（0.2.1-rc.5）。只读解析：JSON 长度在偏移 12，数据区起点是 `8 + readUInt32LE(4)`。本轮没有改 asar，没有重启 DSH、ToDesk 或本机，没有发 Telegram，没有 git reset / clean / commit / push。

## 行为

- 输入栏「采样」按钮走官方槽 `conversation.input.right`，`id: dsh-workbench-sampling`，`order: 1000`。宿主 InputBar 先按 order 升序画这个 list，再画 `conversation.input.model`，所以按钮在模型选择左侧并紧挨它。`conversation.input.activity` 是 single，且已被语音输入占用，没有使用。`conversation.input.model.label` 是不可交互标签，没有使用。
- 不挂在实验开关 `sessionControlsEnabled` 上。没有会话 id 时按钮禁用，文案是「会话尚未创建，发送一条消息后再设置采样参数」；对应 API 返回 409。宿主在没有会话时本来也不渲染这一行。
- 每个会话一份覆盖，存在数据目录 `sampling-overrides.json`（`{version:1, sessions:{...}}`，临时文件写完再改名）。选择“使用默认”或通过 API 传 `null` 删除该项；两项都空则删掉该会话。恢复默认立刻提交两个 `null`。temperature 含 0，范围 0 到 2；top_p 不含 0，范围大于 0 到 1。前后端都只接受有限十进制数，拒绝科学计数、布尔、对象、NaN、Infinity。写盘失败不改内存。
- 注入只走 `ctx.inject(['deepseekLlmApiExtensions'])` 后的 `register('temperature'|'top_p', {prepare})`。服务不存在或 `inject` 抛错时，插件照常挂载，只是不注册字段。插件卸载时释放字段。没有改全局 `fetch`。
- 只注入普通对话：`sessionId` 为非空字符串，且请求上没有 `purpose`。这对应 agent-loop 的 `buildRequest`（带 `sessionId`，不带 `purpose`）。`purpose: "compaction"` 与 `purpose: "session-title"` 不注入。自动审查没有 `sessionId`，并且自带 `temperature: 0`，不注入。请求体里已经有同名字段时返回 `undefined`，保留原值，避免适配器因 “collides with the base request” 让整次请求失败。
- 真正调用 `prepareExtensions` 的供应商是 `deepseek-official` 与 `deepseek-account`。按钮旁始终说明：部分模型和思考模式会忽略这些参数，一般只调整其中一个。当前模型不是 DeepSeek、模型尚未识别或连接不支持时禁用按钮。跟踪模型切换，切换为不支持的模型会关闭弹窗，保存前再次核对。后端按 request.body.model 再次过滤。

## 改动文件

- `src/session-controls/sampling.mjs`（新建：校验、持久化、扩展注册、与宿主合并方式一致的最终 body）
- `src/session-controls/sampling.test.mjs`（新建）
- `src/session-controls/index.mjs`（`GET/POST /session/sampling`，挂载与释放）
- `src/index.mjs`（把 sampling store 传给会话 API；注释说明注入范围）
- `lib/index.mjs`、`lib/index.mjs.map`（按 `scripts/build.mjs` 第一段 esbuild 重新打包；`lib/client.js` 不在构建产物里）
- `lib/client.js`（手写入口：按钮、对话框、槽注册。遮罩点击不关闭）
- `scripts/check.mjs`（检查时跑 sampling 测试）
- `README.md`（会话控制表、API、落盘与槽说明）
- `docs/sampling-controls-result.md`（本文件）

未改 GameBot、Gmail 源码，未改 app.asar。临时探测脚本 `scripts/_tmp-asar-scan.mjs` 与一次性打包脚本 `scripts/_tmp-build-index.mjs` 已删除。

## 验证

```text
node --check lib/client.js
node --check src/session-controls/sampling.mjs
node --check src/session-controls/index.mjs
node --test src/session-controls/sampling.test.mjs
```

语法检查通过。测试 9 项全部通过（约 107 ms，exit 0）：

- 两个字段进入模拟后的 `/messages` body；留空省略；底稿对象不被改写
- 已有 `temperature: 0` 保留，同时普通对话仍可加 `top_p`；无 sessionId 的审查请求、`compaction`、`session-title`、其他会话都不写入
- 同名字段冲突抛出与宿主相同的 “collides with the base request”
- 新 store 能读回；非法文件项丢弃；会话互不污染
- 非法数值拒绝；把存储路径换成目录使改名失败后，内存仍是旧值
- HTTP：无会话 409、非法值 400 且另一项不变、保存后换会话读到空、重开 store 能恢复、两项都清空后文件不再含该会话、跨站 403。`sessionControlsEnabled: false` 时采样接口仍可用
- 扩展服务缺失或 `inject` 抛错不拖垮挂载；卸载后不再注入；卸载后再进来的回调不注册
- 客户端校验与服务端一致，并按供应商写出「不会写入 / 尚未生效」
- 只清空 temperature 时 top_p 仍在

打包命令与 `scripts/build.mjs` 第一段相同（esbuild，`src/index.mjs` → `lib/index.mjs`，target node22，banner 与 `@dsh/define-tool` alias 一致）。结果：

```text
lib\index.mjs      3.9mb
lib\index.mjs.map  7.1mb
Done in 89ms
```

产物里能找到 `deepseekLlmApiExtensions`、`prepareField` 与 `sampling-overrides.json`。没有跑完整 `npm run build`：后面还会重打 Telegram、QQ、Gmail 和桌面端，与这次采样改动无关。

## 宿主要不要重启

要。正在运行的 DeepSeek Harness 仍是启动时加载的旧 bundle。要看到按钮并让 `/messages` 带上覆盖值，需要重新加载本插件（通常是重启 DSH）。本轮没有重启。

## 未完成

- 没有在正在运行的宿主里点开对话框，也没有对真实 DeepSeek 接口抓最终 HTTP body。槽的位置和适配器合并方式来自 0.2.1-rc.5 asar 源码，最终 body 由本地模拟覆盖。
- 对话框样式沿用现有 `dsw-sc-modal`，没有单独做浏览器截图。这不是独立网页，按钮只有宿主加载新的 `lib/client.js` 之后才会出现。


## 本轮调整：DeepSeek 模型限制与范围滑块

- 用户授权本会话直接修改，未再次委派 Cursor。
- 两个参数均使用 type=range，旁边只读显示数值；各有“使用默认”复选框，默认时滑块禁用、保存为 null。temperature 为 0..2，top_p 为 0.01..1，常规步长 0.01。已有更小/更精细的合法数值动态适配下限和步长，未调整时原样保存。
- 依据模型选择器的 data-model-id / data-provider-id 判断可用性，使用 MutationObserver 实时跟踪切换；非 DeepSeek 或连接不支持时禁用按钮并关闭弹窗，保存前再次核对。后端同时校验请求模型，旧配置保留但不用于其他模型。
- 35 项会话控制回归测试通过（采样 12 项）。组件事件测试覆盖两个 range、无文本/number 输入框、默认/自定义保存、temperature=0、精细值、恢复默认、切换模型关闭弹窗与按钮禁用。语法检查通过。
- 服务端按 scripts/build.mjs 首段重新生成 lib/index.mjs 和 map。未重启 DSH、ToDesk 或电脑，未改 app.asar。运行中的旧宿主尚未验收新滑块，重载插件后可见。


## 联动词语示例

- 移除弹窗上方两段重复说明，改为猫 50%、狗 30%、兔子 15%、鲸鱼 5% 的互动示例。
- 使用当前滑块值先调整 temperature 权重，再按累计概率 top_p 保留候选并重新归一化。最可能词加光晕，已排除词变灰；概率随设置实时更新。temperature=0 特判为最高概率词，避免除零。默认项按 1 演示，标明“示意 · 非模型预测”。
- temperature=1 / top_p=0.8 时仅猫和狗参与，归一化后为 62.5% / 37.5%。temperature=0 时只有猫参与。
- 14 项采样测试通过。静态排版预览由实际组件渲染结果和样式生成，位于 Downloads/dsh-output/sampling-example-preview.png；不是运行中 DSH 截图。运行中的宿主仍需重新加载客户端。
