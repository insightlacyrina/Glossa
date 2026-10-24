# 2026-10-23 Mac 服务器验收

环境：Apple Silicon arm64、macOS 27.0.1（26A434）、CLT/macOS 26.5 SDK、Node 24.14.0。此次在原生客户端基础上新增服务器管理和临时 AI 代理；下列结果均为本轮实际执行，不以旧记录替代。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 全仓 Node 回归 | 159/159 通过，包含既有 145、新管理 9、AI 5 | [node-tests.log](node-tests.log) |
| Swift 原生回归 | 19/19，5 个 suite；包括管理 5、CryptoKit/Node AI 双向互通 1 | [swift-tests.log](swift-tests.log) |
| 生产构建和签名 | TypeScript/Vite、Swift release、内置 Node SQLite、ad-hoc deep/strict 签名校验通过 | [release-build.log](release-build.log) |
| 实际 launchd | 临时复制运行时、唯一任务启动、独立进程存活、在线备份、活动恢复拒绝、停服恢复、安全副本与新世代补全通过 | [launchd.log](launchd.log) |
| 打包内容 | 所有 server `.mjs` 与当前源码逐字节相同；归档和启动命令校验已保存 | [artifact-verification.json](artifact-verification.json) |
| 原生客户端退出 | 应用清单确认 `local.glossa.mac` 已退出，后台仍是 PID 74468，71 条操作可用 | [after-client-exit.json](after-client-exit.json) |

## 真实原生界面

由桌面的 `启动笺注.command` 打开最终 `.app`。验收使用 `/private/tmp/glossa-server-ui-final-20261023` 工作副本、`--server-home /private/tmp/glossa-server-home-20261023` 服务器目录及 18847 端口，未接管用户旧 `server-data/` 或实际服务器目录。

实际执行：

1. 打开“Mac 同步 → 管理这台 Mac 上的服务器”，初始化内置运行时，启动真实 launchd 服务。登录启动保持关闭。
2. 使用真实同步协议上传公开示例工程，原生工程列表显示准确身份、普通模式和 **71 条操作**。
3. 点击“立即备份”，界面显示已备份并校验；再点击校验，通过 SHA/SQLite 完整性检查。
4. 点击恢复，明确确认后停止原服务、创建恢复前安全副本、恢复所选快照并重新启动；PID 从 74370 变为 74468，列表可见两份有效快照。
5. 检查 AI 配置折叠表单，默认关闭，接口/模型/安全密钥栏及逐任务授权说明可见；未配置外部账户。
6. 点击“连接当前工程到本机”，客户端草稿填入地址、正确工程身份及掩码令牌；仍保留“保存连接”步骤。取消草稿后仍显示未连接，未向用户钥匙串写入测试连接。
7. 从应用菜单退出客户端，应用清单确认进程已退出；独立 CLI 仍返回相同 PID、工程和定时备份状态。重开客户端后原生面板再次显示相同后台进程。
8. 通过原生面板停止测试服务；独立 CLI 最终返回 `running:false, locked:false`。测试没有安装用户登录启动项。

截图：[初始化入口](server-setup.png)、[运行与工程](server-running.png)、[恢复后安全副本](server-restored.png)、[模型配置](server-ai-settings.png)。另有 [恢复后原生可访问性记录](server-restored.ax.txt)。

## 故障与协议范围

管理测试验证 0600 配置、独立管理令牌、真实回环/Origin 隔离、在线快照与保留、损坏/孤立备份证据、服务内自动调度、普通/E2EE 旧备份恢复、故障回滚、重复进程拒绝、崩溃释放租约及经符号链接调用 CLI。原生控制器测试另覆盖初始化中断后可重试、未知目录保留、外来 launchd 任务保护、明确重启与登录启动行为、恢复失败后重启原服务和密钥隔离。

AI 测试使用真实本机 HTTP mock 模型；Node WebCrypto 与 Swift CryptoKit 均验证 P-256/HKDF/AES-GCM 输入、加密候选、精确对象/版本、幂等、越界与篡改拒绝、撤销/到期中止、错误分类和不向同步档案写入临时正文。没有调用真实外部模型，没有证明识别质量或精确字形映射。

实际 launchd 验收首次发现 `/var` 与 `/private/var` 路径别名使 CLI 入口比较失败；现改为真实路径比较，并加入符号链接回归后重跑通过。最终日志对应修复后的源码和安装包。

未验：重新登录/重启后的实际自动启动、长周期休眠/网络切换、断电或磁盘硬故障、另一台实体设备、局域网/公网 HTTPS、真实模型账户与识别质量。自动备份定时逻辑采用短间隔测试，不能等同于已持续运行 24 小时。应用仍为本机 ad-hoc 签名，没有 Developer ID 公证。
