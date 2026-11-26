# 长视频自动分段：验收修复结果

工作目录 `S:\TRIX\dsh-workbench`。这一轮修验收指出的三处问题，补了真实文件回归，并重新生成了样本。没有调用计费 Gemini，没有改 `app.asar`，没有重启宿主或本机，没有提交或推送。1.43 GB 的抖音文件和 1210 秒的证明文件都没有改写。

## 三处修复

1. 时间切片改为精确重编码。`ffmpegCut` 不再使用 `-c copy`。`-ss` 放在 `-i` 之前，并打开 `-accurate_seek`，把上一关键帧到请求起点之间的画面丢掉。视频用 libx264 veryfast、crf 30、`-tune zerolatency -bf 0`，避免 1 秒 1 帧的片源把编码器延迟写成 2 秒起点。输出起点用 `-avoid_negative_ts make_zero` 收到 0 附近。切完用旁边的 ffprobe 复核：实际时长比请求长出 1.5 秒以上，或容器起点晚于 1.5 秒，就删除该文件并停止，不上传。缓存参数和清单带上算法版本 `algo: 2`、`version: 2`。旧的流复制切片目录对不上这个键，不会被复用。

2. 补切缺失片段时，新文件名从清单和目录里已有的最大 `pNNN` 再加 1，不再从 `p000` 重新编号。缺了中间一段时，首尾原文件保持原名和原字节，新段不会覆盖它们。同一次缓存键上的 `runSegmented` 串行执行：后一个调用等前一个写完清单再读，不会同时写 `.part` / `.tmp`。

3. 只要给了探测函数，小于 8 MB 的文件也会探测时长。时长超过分段窗口就分段。探测失败且文件不超过上传上限时，仍走原来的单次上传，假 mp4 测试不依赖能解码的视频。探测发现没有 FFmpeg、且文件已经超过上传上限时，仍返回原来的中文缺程序说明，不启动外部程序。会话工具 `describe_video` / `watch_video` 不传入已知时长，本机文件会自己探测。聊天室原生视频输入同样先探测，超长的小文件不再整段塞进请求。

## 行为（与上一轮一致的部分）

长视频默认自动分段。设置在「多模态 › 视频理解」：

| 设置 | 默认 | 范围 |
|---|---|---|
| `videoAutoSegment` | 开 | 开关 |
| `videoSegmentSeconds` | 600 秒 | 30–3600；压到上传上限时实际切片不会短于 8 秒 |
| `videoSegmentOverlapSeconds` | 5 秒 | 0–120，且小于每段时长 |
| `videoDownloadMaxMb` | 4096 MB（4 GiB） | 25–8192 |

上传给 Gemini 的每一段仍守入口上限：会话 200 MB，哔哩哔哩与聊天室 25 MB，服务账号未配置 Cloud Storage 桶时 20 MB。聊天室普通附件上限仍是 25 MB。YouTube 公开链接仍直接交给 Gemini，不下载、不分段。

同时进行的 Gemini 请求最多 2 个。原文件指纹只读大小、修改时间、开头 64 KB 和结尾 64 KB。FFmpeg 调用使用 `execFile` 参数数组、`windowsHide: true`，不经过 shell。

## 验证

| 命令 | 结果 |
|---|---|
| `node --test src/video/segment.test.mjs` | 16/16 通过。含真实 FFmpeg 时长与画面、缺中间段重切、同键并发、以及不带已知时长的 1210 秒会话工具 |
| 同一文件里的 1210 秒用例单独再跑一次 | 通过，并写出 `long-1210-submit.json` |
| `node --test src/video/video.test.mjs` | 8/8 通过。2048 字节的假 mp4 仍走单次内联 |
| `node --test --test-concurrency=1 src/chatroom/video.test.mjs` | 19/19 通过 |
| `npm run build` | 成功。`lib/index.mjs` 4.0 MB，其中切片参数含 `-accurate_seek`。脚本还重写了 `lib/channel-telegram.mjs`、`lib/channel-qq.mjs`、`lib/gmail-server.mjs`；这是构建脚本的固定步骤，本轮没有为分段去改那些业务 |

没有真实 Gemini 计费请求。Gemini 一律是测试替身，替身拿到的是实际上传的分段字节，再用 ffprobe 量这些字节。

新增或改过的回归：

- 20 秒合成片按 8 秒窗口、1 秒重叠切成三段。ffprobe 时长必须接近 8、8、6 秒，起点接近 0。源片 GOP 拉到 240 帧，7 秒处不是关键帧。第 2 段 0.4 秒处的画面与原片 7.4 秒的相似度高于与原片 0.4 秒的相似度。
- 同一原片上 `watch` 7–15 秒只产生一段，时长接近 8 秒，画面对上 7.4 秒而不是片头。
- 删掉中间缓存文件后再跑：首尾文件名和字节不变，新段名字不与它们重复，文件内容对应 7 秒起点。
- 两个相同缓存键的调用同时进入：描述次数等于段数，切割峰值是 1，不留下 `.part` / `.tmp`。
- `C:\Users\10917\AppData\Local\Temp\dsh-video-segmentation-proof\long-1210s.mp4`（1210 秒，4129361 字节，小于 8 MB）经 `describe_video` 进入，调用方不传时长。默认 600 秒 / 5 秒重叠得到 3 段。`watch_video` 的 100–130 秒只上传覆盖该范围的一段。

## 真 FFmpeg 样本

20 秒、320×180、12 fps、440 Hz 蜂鸣，关键帧间隔 240 帧。按 8 秒一段、重叠 1 秒重编码成 3 段。清单：

`S:\TRIX\dsh-workbench\docs\video-segmentation-samples\segments.json`

原片：`S:\TRIX\dsh-workbench\docs\video-segmentation-samples\synthetic-20s.mp4`（304960 字节，时长 20 秒）。

| 计划范围 | 文件 | ffprobe 时长 | 起点 | 大小 |
|---|---|---|---|---|
| 0–8 秒 | `S:\TRIX\dsh-workbench\docs\video-segmentation-samples\cache\6b49db78ebccae05\35a9270a1d1c4a09e7a0\p000.mp4` | 8.023275 秒 | 0 | 130766 字节 |
| 7–15 秒 | `S:\TRIX\dsh-workbench\docs\video-segmentation-samples\cache\6b49db78ebccae05\35a9270a1d1c4a09e7a0\p001.mp4` | 8.023275 秒 | 0 | 131235 字节 |
| 14–20 秒 | `S:\TRIX\dsh-workbench\docs\video-segmentation-samples\cache\6b49db78ebccae05\35a9270a1d1c4a09e7a0\p002.mp4` | 6.023275 秒 | 0 | 99404 字节 |

这三行时长是 ffprobe 直接读成品的结果，不是清单里的计划起止。上一轮流复制的成品是 8.189887、15.189887、20.023220 秒，中间段和末段把范围外的画面留在文件里；那一版缓存目录已经清掉。

## 小于 8 MB 的 1210 秒片

`C:\Users\10917\AppData\Local\Temp\dsh-video-segmentation-proof\long-1210s.mp4`

- 大小 4129361 字节，修改时间 `2026-11-25T12:13:27.312Z`。测试前后一致，没有改写。
- 入口是 `describe_video` / `watch_video`，没有预先传入时长。
- 替身收到的三段上传，ffprobe 时长为 600.064、600.128、20.128 秒，起点都是 0。字节数 2230503、2844569、99375。
- 100–130 秒的问答只上传一段，ffprobe 时长 30.128 秒，起点 0，145273 字节，小于原片。
- 记录在 `S:\TRIX\dsh-workbench\docs\video-segmentation-samples\long-1210-submit.json`。

## 只读抖音样本

`C:\Users\10917\AppData\Local\Temp\dsh-douyin-trial\7710906517213416730.mp4`

- 大小 1427577145 字节，修改时间 `2026-11-25T02:50:02.844Z`。探测前后一致，没有切割、改写或删除。
- ffprobe 时长 6968.980998 秒。
- 默认 600 秒、重叠 5 秒的规划共 12 段，最后一段 6545–6968.981 秒。
- 规划写在 `S:\TRIX\dsh-workbench\docs\video-segmentation-samples\douyin-plan.json`。

## 界限

- 单段描述仍最多 2000 字，单段问答仍最多 4000 字。合并结果本身不再被这两道上限切掉。
- 小于 8 MB 的有效视频现在也会探测。探测失败且不超过上传上限时，仍按单个短视频上传。
- YouTube 不分段。
- 服务账号没有存储桶时，每一段仍不能超过 20 MB。
- 没有用真实密钥调用 Gemini。
