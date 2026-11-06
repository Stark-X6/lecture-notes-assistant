# 实施规则与接口

## 来源和需求变更

实现依据是用户提供的 Windows 路径下设计书 v1.0 和当前消息中的评审意见。需求 v0.2 原始 Markdown 未在本机找到，因此未声称完成对其全文逐项核验。F01—F10、F17 的功能方向不变；F11—F16 继续保留为扩展。队列、幂等、推流时序、重连定位、人工主题归属和模板起草为设计细化，不将性能目标降低为“任务已接受”。

当前实现有明确的工程简化：SQLite 保存结构化状态快照，未拆成设计书中的全部规范化表；整理队列使用异步主进程网络请求，音频采集在独立隐藏渲染进程、写盘在独立 Worker 中；模板预览以当前课次为范围，未提供复杂多主题范围选择；Markdown 图片打包尚未实现。上述限制不是对原需求的删除，见验收清单。

## 备选方案与否决理由

| 方案                          | 选择结果与原因                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Electron + React + TypeScript | 采用。便于本地资源管理、PDF、音频与桌面打包；代价是运行时体积较大。                |
| 纯网页                        | 未采用。长期录音持久化、文件权限和异常退出恢复受浏览器限制，和本地优先目标不吻合。 |
| 远程数据库与云后端            | 未采用。单机学生使用无需多租户；避免账号服务、云同步和网络依赖。                   |
| Tauri / 原生 Windows UI       | 首版未采用。减少 Rust 或原生音频适配工具链工作量；以后可替换桌面壳与音频适配器。   |
| 整节课录成单一压缩容器        | 未采用。结束前可能无法恢复完整解码；采用独立可播放 WAV 分片。                      |
| API 密钥放在前端或明文配置    | 未采用。白名单 IPC 与系统账户加密可将密钥限定在主进程。                            |

## 角色边界

学生使用者管理自己的课程、录音、材料、笔记、候选、模板与导出，并逐课程授权数据发送。本机配置维护者配置端点、协议、模型和调用额度，可能就是同一名学生；无独立教师后台、账号系统或管理员云控制台。Windows 账户边界承担本机文件访问控制。

## 队列与计时

- `live` 通道最多两个整理任务并行，`background` 通道最多一个；实时 ASR 不占整理并发。
- 课堂任务总时限 18 秒，从原始提交或自动窗口触发开始，包含等待转录及排队。超过时限明确失败，允许重试，不把接受任务等同于输出内容。
- 后台整课整理、模板起草、预览总时限 120 秒。模型结果只有通过结构与来源验证才更新笔记。SSE 提取可读 `content_md` 作为明确标注“未验证”的预览。
- `firstContentMs` 和 `finishedAt` 记录首批可读预览及最终完成时间。成功落盘前不会推进成功处理游标。
- 重试保留同一任务 ID、幂等键与冻结输入。此版采用用户显式重试，不自动重复收费请求；调用次数逐次预占。没有配置价格表和真实计费结算。
- 取消会持久修改任务状态并 AbortController 中断请求；迟到响应再次检查状态。重配置、撤销授权和删除课程同样取消在途任务。

## 幂等与版本

任务键为冻结输入的 SHA-256，包含课次、转录 ID 与修订/文本、选定材料页和快照、模板修订、提示、提供商配置版本，以及当前主题 ID、笔记内容和版本。重新生成使用新笔记基线，因此不会复用旧结果；同一提交点重复点击复用正在进行的任务。重新生成关联 `supersedes`。

AI 结果按主题 upsert。无人工编辑且基线一致时可自动应用；人工内容、转录修订变化、笔记基线变化及整课重排均生成候选。应用候选同时检查 `expected_current_version` 与候选 `baseVersion`。恢复历史追加版本。前端并发冲突保留编辑器草稿，并提供显式“将我的草稿保存为新版本”操作。

## 实时音频与重连

AudioWorklet 每 100 ms 输出 24 kHz、单声道 PCM16 音频帧。主进程将帧分别发往语音适配器和写盘 Worker；推流不等待 5 秒文件保存。语音连接初建期间短暂缓冲最多约 3 秒，超过部分仍保存在本地。端点使用客户端静音切点，最长约 2 秒提交一轮，识别完成按 `item_id` 对应已提交范围。

每条连接记录 `stream_id`、`originMs`、`confirmed[]`、提供商配置版本。全课时间为连接起点加连接相对时间。当前协议未提供词级时间，因此标记为 `chunk-range`，不冒充精确到词。重连后新建流，`originMs` 使用当前有效采集偏移。相同事件重复完成不重复写入；不同时间的相同文字允许保留。

录音使用样本数量计时，暂停不增加时间。每约 5 秒写一个独立 WAV，flush + 原子更名后登记清单；暂停和停止刷新尾块。补传计算 WAV 范围减去所有 confirmed 区间，只发送缺口；转录与确认范围在同一持久事务保存。恢复补传入口为“补转写”，不会主动启动未经课程授权的外部调用。

## 主要内部接口

接口统一经 preload 白名单 `desktop.invoke(method, args)` 调用，响应封装 `request_id` 与 `data/error`。后端确认窗口身份、课程归属、页面范围、参数及版本。

| 接口                                | 关键参数与结果                                                          |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `course.create` / `lesson.create`   | name、courseId；返回 UUID 实体                                          |
| `material.import/read/index`        | 本机文件对话框、材料 ID、按页文本；只读取应用内资源                     |
| `recording.start/pause/resume/stop` | lessonId；不依赖笔记保存或整理成功                                      |
| `audio.import/store/read/backfill`  | 选择文件、解码 PCM、受控 chunk ID、lessonId                             |
| `transcript.add/revise`             | lessonId、文本；修订需原 revision                                       |
| `topic.assign`                      | lessonId、utterance IDs、topicId；同课校验并追加修订                    |
| `submission.create`                 | lessonId、prompt、可选 uids/all；冻结输入或登记等待尾部的窗口           |
| `note.save/restore/export`          | topicId、version、body / revisionId / lessonId                          |
| `candidate.apply/reject`            | candidateId、expected version；按主题比较交换                           |
| `template.draft`                    | lessonId、preference、可选 sample；复用文本生成适配器，返回规则候选任务 |
| `template.preview/save/clone`       | 本课真实资料、规则、原版本或复制目标；不隐式改写旧笔记                  |
| `provider.configure/test`           | 端点、模型、模式、密钥输入；密钥加密后只保存密文                        |
| `task.retry/cancel` / `ai.pause`    | 任务 ID 或课次；独立于录音状态                                          |
| `course.delete`                     | courseId、完整名称确认；墓碑、取消及受控目录清理                        |

## 供应商实现参考

文本适配层位于 `electron/provider.cjs`；语音适配层位于 `electron/asr.cjs`。请求格式和字段应以供应商当前文档为准，不推断所有“兼容 API”支持语音。

核对过的官方协议资料：[Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)、[Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)。这些资料用于协议和进程安全实现，不代表完成真实供应商验收。
