# vendor/wsz987

打过补丁的 `@wsz987/channel-core`、`@wsz987/channel-harness`、`@wsz987/channel-telegram` 0.5.1（MIT，https://github.com/wsz987/dsh-channels）。
**不要手改**：由 `npm run vendor:channels` 从 node_modules 里的 npm 原包 + `patches/*.patch` 重新生成；`npm run check` 会校验一致。

- `patches/@wsz987__channel-telegram@0.5.1.patch`：长轮询防卡死（请求超时、看门狗、重连）——与 dsh-telegram-temp 相同。
- `patches/@wsz987__channel-harness@0.5.1.patch`：流式正文去重、新消息插队（inboundPreempt）——与 dsh-telegram-temp 当前补丁相同。
- `patches/@wsz987__channel-harness@0.5.1+tool-result-images.patch`：把通道会话里工具结果中的图片（如 mm_send_image）转发到通道。

应用顺序：同一包先打 `<包>@<版本>.patch`，再按文件名顺序打 `<包>@<版本>+<名称>.patch`。升级上游版本时先改 devDependencies，再逐个确认补丁仍能打上。

- `patches/@wsz987__channel-harness@0.5.1+z-interleaved-segments.patch`：按步骤拆分过程段（可展开引用块：思考 + 工具一行摘要）与正文段；桌面非通道会话不受影响。
- `patches/@wsz987__channel-telegram@0.5.1+draft-stream.patch`：私聊 `sendMessageDraft` 流式、HTML 增量渲染、编辑限速与 429 退避、约 3800 字分段。
