# macOS 适配说明

日期：2026年11月6日。基于通义听悟分支 608e6f3，适配范围为麦克风权限、桌面生命周期、跨平台界面说明与本机打包。

## 适配与验证计划

- 在录音初始化之前检查 macOS 麦克风授权；拒绝或受限时不创建采集进程与云转写任务。首次授权完成后才开始原有录音流程。
- Mac 关闭最后一个窗口保留后台应用，Dock 激活时重新创建窗口并恢复本地资料；退出时沿用云任务清理逻辑。
- 生成含麦克风用途说明、音频输入与 V8 JIT 权限（本机 ad-hoc 包同时放宽框架库校验）的本机 ad-hoc 签名 .app、DMG、ZIP。默认按当前机器架构打包，Intel 可使用显式脚本。
- Windows 的 NSIS 打包入口保留；通义听悟的认证、推流、补传协议复用原实现。

## 回归方法

`npm test` 验证核心和听悟协议；`npm run build` 检查 TypeScript 与前端构建；`npm run test:desktop` 验证模拟课堂流程；`npm run test:tingwu` 使用模拟云服务验证凭据与听悟推流；`npm run test:mac` 验证系统授权分支及关闭后从 Dock 恢复。

Mac 回归只在测试进程中替换系统权限回答，并使用 Chromium 模拟麦克风；生产应用仍调用真实 macOS 授权接口。测试数据使用 LECTURE_DATA_DIR 指定的独立目录。

打包后可设置 LECTURE_EXECUTABLE 为 .app/Contents/MacOS/听课笔记助手，重复桌面回归。自动测试不能代替真实麦克风、真实阿里云账号、90分钟课程和 Apple 公证验收。实测结果见下节。

## 构建产物与数据

`npm run pack:mac` 生成 release/mac-arm64/听课笔记助手.app（Intel 为 mac 目录）。`npm run dist:mac` 生成名称带 mac 和架构的 DMG/ZIP。包内不包含课程数据库、录音或用户密钥。

开发运行与打包运行可能使用不同应用名称及数据目录；请在目标应用中重新配置并授权课程。不要将 Windows 密文直接复制到 Mac。对外分发需另配签名证书及公证；本次不申请、读取或上传开发者证书。

## 本机验证结果

验证环境：macOS 27.0.1、Apple Silicon arm64、Node.js 25.9.0、Electron 45.2.3。

- `npm test`：35 项通过。
- `npm run build`：TypeScript 与 Vite 构建通过。
- 开发运行的桌面烟测、模拟听悟测试及 macOS 专项回归通过。
- 最终 `release/mac-arm64/听课笔记助手.app` 重复通过 `test:desktop`、`test:tingwu`、`test:mac` 三组桌面回归。
- 专项回归覆盖已拒绝、受限制、首次同意/拒绝、已授权麦克风；录音尾样本的整数毫秒定位；等待授权期间删除课程和关闭窗口；Dock 重新打开。
- 听悟桌面回归验证了系统凭据加密后不回传、两次任务创建与收尾、临时/正式转录及暂停后定位。云端接口为测试夹具，不调用真实阿里云账户。
- `codesign --verify --deep --strict` 通过，包内麦克风用途说明存在；DMG 经 `hdiutil verify` 校验通过。
- 真实麦克风授权/采集、真实听悟账户、90分钟长课、Intel设备运行及 Apple 公证仍需现场验收。

修复了三类行为问题：权限等待在采集初始化之前完成；等待授权时关闭窗口会取消启动、课程删除与录音启动互斥；采集毫秒从累计样本数推导后统一取整，避免 Mac 尾帧的小数毫秒与持久化位置不一致。
