# v0.3.2 文本模型兼容修复

在 v0.3.1 Windows/macOS 统一版本（55ef744）上修复文本模型响应处理；课程数据结构不变。

- 对官方 api.deepseek.com 启用 response_format=json_object，并显式使用非思考模式，让原有输出额度用于最终笔记。其他 Chat Completions 兼容服务不附加这些参数。
- 用户的 max_tokens 上限保持原值；不自动增加费用额度，不自动重跑任务。
- 同时检查流式及非流式 finish_reason。达到长度上限、服务中断或过滤时不把部分结果当成完整笔记；区分空白最终答案、只有思考内容和非法 JSON。
- 保留来源校验、版本冲突候选和人工编辑保护；不保存或展示模型思考文本。

旧版本没有保存原始响应及结束原因，无法仅凭本次“非法 JSON”报错确认究竟是截断还是格式偏离。已定位并覆盖以上协议兼容缺口，真实供应商内容仍需用户重试验证。原始课程资料和密钥不用于本轮自动测试。

7 项协议回归覆盖 DeepSeek 参数、通用接口隔离、SSE/JSON 截断、空白/思考-only、服务异常；与原 46 项合计 53 项。离线协议模拟不能代替真实 API 内容质量与计费验收。

若之后提示输出达到上限，可在设置中自行提高单次输出上限或缩小资料范围，并重新保存文本授权后创建新任务。完成应用更新后，同配置的失败任务可重试并复用已有检查点；修改 API 配置后应新建任务。

依据：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。DeepSeek 默认启用思考；JSON 输出需显式设置 response_format，并提供格式示例和充足输出长度。
