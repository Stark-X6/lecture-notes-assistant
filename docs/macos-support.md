# Windows / macOS 统一版本

基线：master 的 v0.3.1（c073ffc）。本次保留版本号与数据库结构，共用课程空间、课堂记录、笔记、转录和模型逻辑；平台差异仅在系统权限、窗口行为和打包配置。

## 改动

- macOS 录音前检查并请求系统麦克风权限。拒绝时给出系统设置入口；授权等待期间关闭/退出会取消启动，删除课程/课堂被阻止，防止隐藏录音。Windows 跳过这项 macOS 原生检查。
- macOS 关闭空闲主窗口后保留 Dock 入口，再次点击重建窗口；Command+Q 退出并走原有录音/云任务清理。Windows 保留最后一个窗口关闭即退出的行为。录音中关闭仍要求先确认结束并保存。
- 录音位置按累计样本换算整数毫秒；恢复旧录音时先归一化旧的小数起点，写盘与字幕使用同一基准。
- Mac 应用声明麦克风用途与音频权限，使用本地临时签名及必要的 JIT/原生库权限；没有使用开发者证书或 Apple 公证。
- 本地 ASR 的平台原生库（含 dylib / DLL）随应用解包到 app.asar.unpacked；识别仍在独立进程执行，录音、模型和课程数据继续放在用户目录。
- 补充系统字体和等宽字体，去除设置页仅适用于 Windows 的密钥说明。Windows 交付脚本也包含 Mac 构建需要的 build/*.plist 源码资源。

## 开发和打包

Node.js >=22.12.0。`npm ci` 后，必要时执行 `node node_modules/electron/install.js`。

| 命令 | 用途 |
| --- | --- |
| npm start | 构建并运行开发版 |
| npm run pack / npm run dist | 当前系统的应用目录 / 分发包 |
| npm run pack:win / npm run dist:win | Windows x64 应用目录 / NSIS |
| npm run pack:mac / npm run dist:mac | 当前 Mac 架构应用目录 / DMG 和 ZIP |
| npm run dist:mac:x64 | Intel Mac 包，待实机验证 |

默认输出目录为 release-v0.3.1。Apple Silicon 应用路径为 mac-arm64/听课笔记助手.app；DMG 名称含 mac-arm64，Windows 安装器继续使用 LectureNotes-Setup-0.3.1.exe。请在对应系统构建正式分发包。

Mac 首次录音应在系统弹窗中允许麦克风访问；已拒绝则在“系统设置 → 隐私与安全性 → 麦克风”打开权限并重新启动。开发运行的权限主体为 Electron。API 密钥继续使用 Electron safeStorage，不提供明文回退；真实钥匙串不可用时拒绝保存密钥。本地临时签名版本未公证，不能当作已完成公开发行签名的版本。

## 验证方式与限制

所有自动化使用 LECTURE_DATA_DIR 隔离数据库，不打开现有课程资料。macOS 权限边界使用测试替身，音频为 Chromium 模拟设备；听悟调用是协议桩。Playwright 使用模拟钥匙串，听悟桌面测试在 tests/helpers 中只接受 fixture 开头的假凭据，不访问真实系统凭据。生产代码不包含这些替身。

- npm test：原 46 项核心回归。
- npm run test:audio：90 分钟等效 PCM 写盘、ENOSPC 注入；不是 90 分钟真实录音。
- npm run test:desktop / test:study / test:tingwu：原课堂、课程空间、听悟协议和界面流程。
- npm run test:mac：拒绝/受限/首次授权、录音尾样本、授权等待中的删除/关闭、Dock 重开，以及旧小数起点恢复。
- npm run test:asr-runtime：真实 Electron 识别子进程加载原生库；稀疏占位文件只通过安装门槛，不用于识别，也不代表 Qwen 模型质量通过。

测试打包应用时设置 LECTURE_EXECUTABLE 为 .app/Contents/MacOS/听课笔记助手 的绝对路径。另用已校验的公开 SenseVoice 模型及随附中文样例执行 scripts/verify-local-asr-app.cjs：LECTURE_TEST_MODEL_ROOT 指向包含 sensevoice-small-int8 的目录；验证模型识别、导入补转写、模拟录音收尾和设置显示。模型未随安装包或 Git 分发。

本轮目标机器为 macOS 27 / arm64。Windows x64 运行与安装、Intel Mac、真实麦克风授权弹窗及连续 90 分钟、真实听悟/文本 API、系统钥匙串实际读写和公开发行公证均不在本机自动化结果内。原有课堂内容质量限制继续有效。具体本轮结果见 [验收记录](acceptance.md)。

平台依据：[Electron 麦克风权限 API](https://github.com/electron/electron/blob/main/docs/api/system-preferences.md)、[electron-builder v26 Mac 配置](https://www.electron.build/v26/docs/mac/)、[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。依赖仍锁定 Electron 45.2.3，未借适配升级依赖。
