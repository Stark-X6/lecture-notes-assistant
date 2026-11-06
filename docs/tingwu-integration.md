# 通义听悟实时转写接入与使用

版本：0.3.0（合并自通义听悟分支）。接入方式核对日期：2026-11-06。

已实现听悟新版任务 API、实时音频推流、字幕、暂停继续、尾句收尾及本地音频补转写。真实阿里云账户的识别质量、延迟、额度与计费仍需现场验证。

## 配置步骤

1. 在阿里云开通通义听悟实时记录服务，并在听悟控制台创建项目，取得项目 AppKey。回调可选“不设置回调主动轮询”。
2. 准备有听悟调用权限的 AccessKey ID 与 AccessKey Secret。建议使用专用 RAM 用户，权限涉及 `tingwu:CreateTask`、`tingwu:GetTaskInfo`。AppKey 与 AK 必须属于可相互访问的账户体系。
3. 启动应用，停止录音，在语音识别设置选择“云端”并保存，然后打开“API 与设置”：工作模式选择“真实 API”，语音提供商选择“阿里云 · 通义听悟”。填写项目 AppKey、AK ID、AK Secret 和识别语种，保存配置。
4. 重新勾选并保存当前课程的音频授权。
5. 可先点击“测试听悟鉴权”。该按钮创建并结束一个测试任务，验证凭据与项目权限；不发送麦克风音频，不代表识别质量验收，可能产生计费。
6. 开始录音，观察课堂转录。中间字幕会更新，完整句子保存为正式转录。笔记整理继续使用独立的文本 API，需另行配置和授权。

凭据在本机通过 Electron safeStorage 加密保存。保存后输入框留空表示保留，不返回原值。请勿把真实凭据写入源码或聊天。分发给多人并共用开发者账号时，应把 AK 移至自有后端，不能把共享密钥打包进应用。

参考：[官方入门](https://help.aliyun.com/zh/tingwu/getting-started-1)。

已被本地模型识别确认的原录音不会被“补转写”重复上传。如需用听悟重新比较，使用“重新转写原录音”，确认向当前服务发送音频后创建新讲次。原讲次内容保留。此功能需要先保存当前课程音频授权；会按实际服务规则计费。

## 录音、恢复与云端任务

- 本地录音仍保存为 24 kHz 单声道 PCM16 WAV；听悟发送支路用连续、有低通滤波的重采样转换为 16 kHz。已有录音和时间轴不需要迁移。
- 暂停会发送尾帧，等待推流完成并结束当前听悟任务。继续时创建新任务，时间从本课采集进度接续，不计入暂停时间。
- 最终停止会先确认尾帧与字幕，再关闭推流并调用云端结束接口。网络异常时继续保留本地音频和未确认范围。
- “补转写”仅回放本课尚未确认的音频区间，通过实时接口按音频原速推送，无需 OSS 或公网文件 URL。处理期间停止本课录音并保持应用打开；例如十分钟待补音频约需十分钟加连接处理时间。
- 更换 API 配置前必须停止录音。停止 AI 或撤销音频授权会取消推流并结束已创建任务。
- 云端结束请求失败会保留任务 ID，在设置中显示“重试结束云端任务”。该操作先查任务状态，再结束尚未完成的任务。更换听悟项目或凭据、删除相关课程前，需要完成遗留任务清理。
- 强制结束进程或断电可能留下未完成任务。再次启动后，在 API 设置中处理遗留任务。创建请求发出后未收到任务 ID 的网络中断，需要结合阿里云控制台及 TaskKey 排查。

## 实现位置

| 文件                                                       | 作用                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `electron/tingwu-api.cjs`                                  | 官方 SDK 签名、创建任务、查询任务及结束任务；屏蔽异常中的敏感请求内容 |
| `electron/tingwu-asr.cjs`                                  | WSS 握手、音频节奏控制、字幕事件、去重、覆盖确认及云端收尾            |
| `electron/pcm-resampler.cjs`                               | 24→16 kHz 有状态重采样，保留跨帧滤波历史                              |
| `electron/tingwu-backfill.cjs`                             | 计算未确认范围、从本地 WAV 回放补传                                   |
| `electron/main.cjs`、`electron/core.cjs`                   | 录音控制、授权、凭据加密、旧配置迁移与异常恢复                        |
| `electron/pcm-worklet.js`、`electron/recorder-preload.cjs` | 采集尾帧确认握手，避免暂停快照与实际音频进度不一致                    |
| `src/main.tsx`                                             | 听悟设置、鉴权测试和云端任务清理入口                                  |

管理接口版本为 `2023-09-30`，固定使用北京端点。创建任务为 `PUT /openapi/tingwu/v2/tasks?type=realtime`，配置 `Transcription.OutputLevel=2`，并关闭可选摘要、翻译等能力。结束任务使用 `operation=stop`。官方 SDK 已锁定版本，负责生成阿里云签名，不使用 Bearer 密钥。

WSS 使用创建接口返回的 MeetingJoinUrl，校验官方北京主机后连接。发送 StartTranscription，再等待 TranscriptionStarted 后发送音频二进制帧。TranscriptionResultChanged 替换临时字幕，SentenceEnd 保存正式文本；stash_result 只显示为下一句暂存文本。发送 StopTranscription 并收到 TranscriptionCompleted 后，才确认成功收尾的剩余音频覆盖。

会议 TaskId 与推流 header.task_id 分开处理。按本地流 ID、推流任务及句子 index 去重，不因文本相同而删除合理重复。推流地址包含授权信息，不进入界面快照或持久数据。

参考：[CreateTask](https://help.aliyun.com/zh/tingwu/api-tingwu-2023-09-30-createtask)、[推流协议示例](https://help.aliyun.com/zh/tingwu/js-push-stream)、[事件字段](https://help.aliyun.com/zh/tingwu/real-time-stream-push)、[GetTaskInfo](https://help.aliyun.com/zh/tingwu/api-tingwu-2023-09-30-gettaskinfo)。

## 费用与验证

听悟按实际服务与处理时长计费；重试或补传会增加实际处理时长，文本笔记模型另计费。单价、试用权益、额度和账单以账户控制台及[官方计费说明](https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules)为准。

本地验证入口：

```powershell
npm test
npm run build
node tests/smoke.cjs
npm run test:tingwu
```

单元测试覆盖官方 SDK 序列化参数、重采样长度与抗混叠、暂存字幕、重复事件、暂停恢复、授权撤销、连接积压、任务创建期间取消、结束失败持久化、补传缺口及旧配置迁移。桌面测试使用模拟麦克风和模拟云端，不调用真实听悟账户，也不使用正式课程库。

仍需真实凭据验证中文/中英混合课程、麦克风设备、长静音、90 分钟持续采集、真实断网、延迟与账单。首次使用请先录制一小段测试课。
