# 本轮执行证据

日期：2026-10-21。执行机为 Linux x64，Node.js 24.19.0，浏览器为本机 Chromium。日志保留实际命令的输出；单测、模拟桥、Android 模拟器和真实设备是不同的证据层次。

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
