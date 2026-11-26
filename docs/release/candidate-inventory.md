# 候选发布清单

生成时间：2026-11-25T14:40:11.714Z

基线是当前工作区，不是仅公开 main。纳入项进入候选快照；排除项只不进快照和发布提交建议，不删除本地原件。
`lib/client.js` 是手写源码，快照必须原样保留。其余 `lib/*.mjs` 由候选源码重新构建。

## 纳入

| 路径 | 理由 |
| --- | --- |
| `.github/workflows/ci.yml` | 已跟踪的改动，属于当前功能集合 |
| `.github/workflows/publish.yml` | 已跟踪的改动，属于当前功能集合 |
| `.gitignore` | 已跟踪的改动，属于当前功能集合 |
| `README.md` | 已跟踪的改动，属于当前功能集合 |
| `lib/channel-qq.mjs` | 已跟踪的改动，属于当前功能集合 |
| `lib/client.js` | 已跟踪的改动，属于当前功能集合 |
| `package-lock.json` | 已跟踪的改动，属于当前功能集合 |
| `package.json` | 已跟踪的改动，属于当前功能集合 |
| `scripts/build-desktop.mjs` | 已跟踪的改动，属于当前功能集合 |
| `scripts/check.mjs` | 已跟踪的改动，属于当前功能集合 |
| `scripts/prepare.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/channels/cross-session-memory-write.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/channels/cross-session-memory.test.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/channels/person-memory-inject.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/channels/qq/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/channels/telegram/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/chatroom/attachments.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/chatroom/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/chatroom/video.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/chatroom/video.test.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/desktop/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/README.md` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/fields.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/mc-control.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/mc-host.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/mc-mirror.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/mc-phases.test.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/mc-profile.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/mc-public-channel.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/members-tools.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/members.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/members.test.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/build.gradle` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/gradle.properties` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/action/InteractionRay.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/action/MovementGeometry.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/action/PlacementService.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/action/ServerActionDispatcher.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/command/AgentCommands.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/config/CommonBridgeConfig.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/entity/AgentEntity.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/entity/AgentRegistry.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/observation/ServerSnapshotService.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/protocol/Validators.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/server/ServerLifecycle.java` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/resources/META-INF/neoforge.mods.toml` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/adapters/minecraft/adapter.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/adapters/minecraft/minaret.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/adapters/minecraft/protocol.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/adapters/minecraft/providers.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/adapters/minecraft/wire.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/api/members.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/contracts/capabilities.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/src/gamebot/members.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gamebot/tests/test_member_backend.py` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gmail/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/components/gmail/mail.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/session-controls/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/session-history/companion-compaction.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/session-history/companion-compaction.test.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/session-history/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/tools.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/updater.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/video/index.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/video/tools.mjs` | 已跟踪的改动，属于当前功能集合 |
| `src/video/video.test.mjs` | 已跟踪的改动，属于当前功能集合 |
| `CHANGELOG.md` | 发布文档 |
| `PRIVACY.md` | 发布文档 |
| `SECURITY.md` | 发布文档 |
| `docs/compatibility.md` | 产品源码、测试、文档或工作流 |
| `docs/cross-session-memory-disable-fix.md` | 产品源码、测试、文档或工作流 |
| `docs/release/CHANGELOG-0.4.4.md` | 产品源码、测试、文档或工作流 |
| `docs/release/about-suggestion.md` | 产品源码、测试、文档或工作流 |
| `docs/release/candidate-inventory.md` | 产品源码、测试、文档或工作流 |
| `docs/release/host-not-run.md` | 产品源码、测试、文档或工作流 |
| `docs/release/market-readiness.md` | 产品源码、测试、文档或工作流 |
| `docs/release/verification-log.md` | 产品源码、测试、文档或工作流 |
| `docs/sampling-controls-result.md` | 产品源码、测试、文档或工作流 |
| `docs/video-segmentation-result.md` | 产品源码、测试、文档或工作流 |
| `scripts/make-release-snapshot.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-autonomy-live.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-baseline.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-faults.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-model.py` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-presets.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-presets.test.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-record.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-recovery.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-summary.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/mc-live-watchdog.ps1` | 产品源码、测试、文档或工作流 |
| `scripts/mc_live_model_test.py` | 产品源码、测试、文档或工作流 |
| `scripts/pack-release.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/release-inventory.mjs` | 产品源码、测试、文档或工作流 |
| `scripts/verify-package.mjs` | 产品源码、测试、文档或工作流 |
| `src/channels/cross-session-runtime-state.mjs` | 产品源码、测试、文档或工作流 |
| `src/channels/cross-session-runtime.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/channels/message-identity.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/desktop/broker-install.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/desktop/broker-install.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/desktop/broker-manifest.json` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/mc-action-verification.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/mc-action-verification.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/mc-autonomy.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/mc-memory.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/mc-runtime-state.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/mc-runtime-state.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/action/NavigationTasks.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/action/ResourceActions.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/observation/SemanticPerception.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/main/java/com/trix/gamebot/bridge/protocol/PlayerPrivateChat.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/test/java/com/trix/gamebot/bridge/action/InteractionRayTest.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/test/java/com/trix/gamebot/bridge/action/NavigationTasksTest.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/test/java/com/trix/gamebot/bridge/action/ResourceActionsTest.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/test/java/com/trix/gamebot/bridge/action/StandingSurfaceTest.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/test/java/com/trix/gamebot/bridge/entity/WorldIdentityTest.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/test/java/com/trix/gamebot/bridge/observation/SemanticPerceptionTest.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/minecraft-neoforge-bridge/src/test/java/com/trix/gamebot/bridge/protocol/PlayerPrivateChatTest.java` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/tests/test_autonomy.py` | 产品源码、测试、文档或工作流 |
| `src/components/gamebot/tests/test_persistent_tasks.py` | 产品源码、测试、文档或工作流 |
| `src/download-integrity.mjs` | 产品源码、测试、文档或工作流 |
| `src/download-integrity.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/plugin-compatibility.mjs` | 产品源码、测试、文档或工作流 |
| `src/plugin-compatibility.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/session-controls/replaced-hide.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/session-controls/sampling.mjs` | 产品源码、测试、文档或工作流 |
| `src/session-controls/sampling.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/settings-mask.mjs` | 产品源码、测试、文档或工作流 |
| `src/settings-mask.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/update-integrity.mjs` | 产品源码、测试、文档或工作流 |
| `src/update-integrity.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/video/browser-video.mjs` | 产品源码、测试、文档或工作流 |
| `src/video/browser-video.test.mjs` | 产品源码、测试、文档或工作流 |
| `src/video/segment.mjs` | 产品源码、测试、文档或工作流 |
| `src/video/segment.test.mjs` | 产品源码、测试、文档或工作流 |

## 排除

| 路径 | 理由 |
| --- | --- |
| `SAMPLING-SLIDERS-TASK.md` | 代理任务稿，不是产品源码或用户文档 |
| `SAMPLING-TASK.md` | 代理任务稿，不是产品源码或用户文档 |
| `VIDEO-SEGMENTATION-TASK.md` | 代理任务稿，不是产品源码或用户文档 |
| `docs/video-segmentation-samples/cache/6b49db78ebccae05/aa4e6f2a6ac5888092b2.json` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `docs/video-segmentation-samples/cache/6b49db78ebccae05/aa4e6f2a6ac5888092b2/p000.mp4` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `docs/video-segmentation-samples/cache/6b49db78ebccae05/aa4e6f2a6ac5888092b2/p001.mp4` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `docs/video-segmentation-samples/cache/6b49db78ebccae05/aa4e6f2a6ac5888092b2/p002.mp4` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `docs/video-segmentation-samples/cache/6b49db78ebccae05/source.json` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `docs/video-segmentation-samples/douyin-plan.json` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `docs/video-segmentation-samples/segments.json` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `docs/video-segmentation-samples/synthetic-20s.mp4` | 分段实验的媒体缓存和样例视频，不是产品源码 |
| `scripts/__pycache__/mc-live-model.cpython-310.pyc` | Python 字节码缓存 |
| `scripts/__pycache__/mc_live_model_test.cpython-310-pytest-9.1.1.pyc` | Python 字节码缓存 |
| `src/components/gamebot/minecraft-neoforge-bridge/.eclipse/configurations/Client.launch` | IDE 本地配置 |

## 待确认

| 路径 | 理由 |
| --- | --- |
