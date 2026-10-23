# macOS 本地增量证据

日期：2026-10-22。基线 `2522960`，实际环境见 [toolchain.json](toolchain.json)、[硬件加速](acceleration.txt)、[设备指纹](android-fingerprint.txt)、[WebView](webview-provider.txt)。任务是在本机继续云端未通过或未执行的场景；旧独立文件层、窗口诊断和浏览器套件没有全量重跑。汇总与边界见 [LOCAL-VALIDATION](../../LOCAL-VALIDATION.md)。

| 证据                                                                                                     | 实际范围                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [app-bridge.log](app-bridge.log)                                                                         | 真实 APK 主页 JavaScript→原生→DOM，9 项通过；BOM/CRLF/中文/emoji/公式重开一致。                                                                                                                    |
| [saf-prepare.log](saf-prepare.log)                                                                       | 真实系统 Downloads 选择器、持久读写授权与写回，7 项通过。                                                                                                                                          |
| [saf-resume.log](saf-resume.log)                                                                         | 显式 force-stop 后 PID 3641→4033，8 项通过；此阶段按设计不创建 WebView。                                                                                                                           |
| [saf-faults.log](saf-faults.log)                                                                         | 31 项通过；不同 UID 测试 DocumentsProvider，真实系统授权/撤权/重授权、取消、失联与只读写失败；本地待写及源快照完整。                                                                               |
| [product-source-ui.log](product-source-ui.log)                                                           | 真实 React UI 的 Markdown/LaTeX→对象插入→B 修订→写回/字节核对；源失联保留、外部同区域改动冲突预览及明确选择通过。该阶段随后 WebView 重连脚本失败，后续仅继续恢复阶段，未将失败删掉。               |
| [product-recovery-and-package-attempt.log](product-recovery-and-package-attempt.log)                     | 已保存合成笔 force-stop 恢复、未完成笔迹经真实 UI 恢复均通过；[原始草稿](interrupted-draft.json)。随后工程包导入副本严格等于较早快照的脚本断言失败；后台源接触记录确实多保存了一条，数据并未缺失。 |
| [product-package-final.log](product-package-final.log) / [结果](product-package-final.json)              | 最终 APK 下真实系统创建/打开选择器导出导入、完整 A/B/源快照/历史、较新当前的恢复副本及其真实 UI 可见性全部通过。包 589,085 字节，与原生回读 SHA-256、adb pull 独立核对一致。                       |
| [恢复差量](package-recovery-delta.json)                                                                  | 副本保存全部 82 条先前操作并额外保存 1 条已解释的源接触更新；全部操作身份/正文、A/B、源内容/快照/历史/队列、元数据与旧 epoch 逐项核对。                                                            |
| [最终阶段状态](product-final-stage-result.json)                                                          | `passed:true`；标明从前一阶段继承已通过的源文件和笔迹证据，非整条流水线同一轮全量重跑。                                                                                                            |
| [sync.log](sync.log)、[普通](sync-plain.json)、[E2EE](sync-e2ee.json)                                    | macOS 独立 Node 服务+真实 Chrome/IndexedDB，两模式各3组通过，旧 SQLite恢复后全新客户端完整重建；未经过真实移动设备、LAN或WAN。                                                                     |
| [Web 构建](web-build.log)、[客户端构建](android-build.log)、[测试 APK 构建](android-test-build.log)      | 最终生产构建与增量 APK 编译成功；构建不冒充行为测试。                                                                                                                                              |
| [APK 验证](apk-verification.json)、[客户端签名](apk-signature.txt)、[测试包签名](test-apk-signature.txt) | Web 资产逐字节一致，原生桥/恢复入口存在，调试签名校验。不是正式发布签名。                                                                                                                          |
| [Wi-Fi](wifi-state.txt)、[移动数据](mobile-data-state.txt)                                               | 产品 UI 验收前已显式关闭网络，首页与纸张、源文件及笔迹恢复依赖本地资产和存储。                                                                                                                     |

保留的验收脚本失败：

- [撤权调用首轮](saf-faults-harness-revoke-failure.log)：使用了只撤显式授权的 package 重载，未撤系统 Intent 临时 grant。改用 [Android 官方的全机制撤权接口](<https://developer.android.com/reference/android/content/Context#revokeUriPermission(android.net.Uri,%20int)>) 后，实际临时与持久授权均已撤，读/写正确失败。
- [只读假设首轮](saf-faults-harness-readonly-failure.log)：DocumentsUI 可能给只读能力的 provider 文档持久读写 grant；能力与授权掩码须分别验证，最终通过真实写失败/待写保留判断。
- [主动停止输出](saf-faults-interrupted-stale-task.log)和[Java 栈](saf-harness-stale-task-java.txt)：遗留系统选择器任务使 instrumentation 的 `startActivitySync` 等待。本轮主动 force-stop 结束，`Process crashed` 是停止后的输出，不能记作新一轮自然产品崩溃。专项改为新 Activity 任务启动，不清应用数据。
- 首次产品 CDP 连接、fixture 参数及屏外合成笔坐标等完整失败在项目忽略目录 `artifacts/local-migration/`，未覆盖或删除。

图片仅是对应 UI 的辅助证据；完整数据核对见日志/JSON。Android WebView 的旧 full-page 截图存在平铺捕获现象，最终[恢复界面截图](package-import-recovery.png)使用实际视口。实际触控笔、掌触与物理延迟未验证，合成压力/倾斜字段不能替代硬件体验。
