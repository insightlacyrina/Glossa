# 本轮执行证据

2026-10-22 macOS 本机迁移的当前增量结果见 [本机证据索引](local-macos-2026-10-22/README.md)，包含真实主页桥、系统 SAF、产品文件链路、合成笔/工程包恢复及 Mac 两模式同步。以下 Linux 云端记录保留为历史，未全量重跑。

日期：2026-10-21。以下完整验收表保留更名前的原始证据；笺注 / Glossa 更名后的最小检查见 [更名专项](branding.log)、[生产构建](branding-build.log)、[Android 构建](branding-android-build.log) 与 [APK 核验](branding-apk-assets.json)，未重跑完整套件。

执行机为 Linux x64，Node.js 24.19.0，浏览器为本机 Chromium。日志保留实际命令的输出；单测、模拟桥、Android 模拟器和真实设备是不同的证据层次。

0.1.1 新增验证单独存放，**没有重跑下表旧套件**：

| 文件                                                                                                                                                                                                  | 本阶段实际范围                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [native-source-access.log](native-source-access.log) / [native-source-access-cycle.log](native-source-access-cycle.log)                                                                               | 首次新增 3 项；后续用 `--test-isolation=none --test-name-pattern='a successful read survives'` 只执行新增跨调用用例 1 项，均通过 |
| [native-source-prepare.log](native-source-prepare.log)                                                                                                                                                | Android 生产文件层，41 项实际通过；Markdown/LaTeX 读改写按字节重开、双 SHA/幂等/冲突/失败队列                                    |
| [native-source-force-stop.log](native-source-force-stop.log) / [native-source-resume.log](native-source-resume.log)                                                                                   | 显式停止进程后 PID 2231→2287；18 项实际通过，待写全文、基准与历史保留，恢复写回                                                  |
| [native-source-faults.log](native-source-faults.log)                                                                                                                                                  | 12 项实际通过，内容与源可达性分类、损坏日志/哈希校验保护、队列逐项诊断                                                           |
| [native-source-webview-roundtrip.log](native-source-webview-roundtrip.log)                                                                                                                            | 仅重试此前未通过的默认桥场景；仍失败，WebView 求值超时，未执行文件断言                                                           |
| [native-source-webview-logcat.log](native-source-webview-logcat.log) / [崩溃摘要](native-source-webview-crash-summary.log)                                                                            | 实际渲染器 SIGTRAP 与容器接管；根因待定位                                                                                        |
| [native-source-run-context.json](native-source-run-context.json)                                                                                                                                      | 实际专项运行包、源码摘要、PID 与最终仅 Web 保护补丁的区别                                                                        |
| [native-source-build.log](native-source-build.log) / [Android 编译](native-source-android-build.log) / [测试包增量](native-source-test-build.log) / [最终主包](native-source-final-android-build.log) | 对变更代码和交付文件的必要构建，非重复执行旧测试                                                                                 |
| [native-source-apk-assets.json](native-source-apk-assets.json) / [元数据](native-source-apk-metadata.txt) / [签名](native-source-apk-signature.txt)                                                   | 最终 0.1.1 APK 的资源字节、版本标签和 v2 签名核对                                                                                |

三个新原生专项合计 71 项，使用真实 ContentResolver 与测试专用文件提供者；不启动 Activity/WebView，不包含系统选择器和持久授权。已提交日志跨进程恢复不等于写回中断、断电或真实笔迹恢复通过。完整命令见 [Android](../ANDROID.md)。

| 文件                                                           | 命令及覆盖范围                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [check.log](check.log)                                         | `npm run check`：141 项自动测试、TypeScript 和生产构建；包含真实 HTTP、SQLite 备份恢复及两种同步模式                                                    |
| [browser.log](browser.log)                                     | `npm run test:browser`：8 个实际 Chromium 脚本，统一脚本启动和关闭独立本地服务                                                                          |
| [workspace-generation.log](workspace-generation.log)           | 同步恢复协议新增世代握手后，`QP_TEST_SERVE=1 node tests/workspace.browser.mjs` 重新验证 5 组恢复/旧响应隔离；源文件桥和导出恢复中的原生部分明确为模拟桥 |
| [offline.log](offline.log)                                     | 对最终 `dist` 运行 `node --import tsx tests/offline.browser.mjs`，2 项生产离线验收；可用 `npm run test:offline` 从构建开始复现                          |
| [format.log](format.log)                                       | `npm run format:check`                                                                                                                                  |
| [android-export-jvm.log](android-export-jvm.log)               | APK 同源码 `ExportStore` 的 7 项 JVM 检查，含大于 20 MiB 的实际文件、重启和完整性验证                                                                   |
| [android-source-policy-jvm.log](android-source-policy-jvm.log) | APK 同源码 `SourceWritePolicy` 的 9 项 JVM 双版本比较检查                                                                                               |

Android 最终构建另附 [编译日志](android-build.log)、[签名校验](android-signature.txt) 和 [APK 资源核验](android-apk-assets.json)。`python3 android/tools/verify-apk.py --apk releases/quiet-paper-0.1.0-debug.apk` 确认包内 7 份 Web 资源逐字节一致，版本校验与分块导出桥存在。APK 使用调试签名，不是生产发布签名。

[首轮实际 instrumentation](android-instrumentation-first.log) 在 WebView 初始化时超时，尚未执行源文件往返，不计通过；[第二轮文件往返](android-instrumentation-final.log) 返回进程崩溃，定位见 [崩溃摘要](android-crash-summary.log)。新增的 [渲染器恢复专项](android-renderer-recovery.log) 在最终 APK 上实际通过 6 项断言；它验证原生文件、导出暂存、身份与窗口重建，不替代源文件往返或真实 A/IndexedDB 恢复验收。测试入口最初登记失败的 [输出](android-renderer-registration-first.log) 也保留。

恢复补丁的编译记录见 [主包构建](android-renderer-build.log) 和 [测试入口增量构建](android-test-runner-build.log)。专项通过后未重复执行；此前已通过的测试均沿用记录。

浏览器覆盖 Pointer Events、真实选区事件、IndexedDB 与页面重载。它不能证明物理笔延迟、掌触、断电安全或所有 Android WebView 行为。IME 用例模拟 composition 事件，不能推定各系统输入法兼容。

原生桥浏览器用例中，React、领域内核和 IndexedDB 均真实运行；Android 文件选择器/提供者以模拟桥代替。原生实际执行结果、APK 签名和 Web 资源一致性应与交付报告中的独立 Android 记录一起阅读，不能用 JVM 或模拟桥的通过数替代原生往返结果。

服务在本机真实 HTTP 和真实 SQLite 上测试。HTTPS 部署配置、Tailscale/Caddy 示例和 launchd 文件没有在真实 Mac 公网执行，必须保持未验。真实外部 OCR/公式/AI 服务也尚未执行质量验收。
