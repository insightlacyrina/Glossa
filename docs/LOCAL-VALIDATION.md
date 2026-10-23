# macOS 本地迁移与 Android 增量验收

日期：2026-10-22。GitHub `main` 已快进至 `2522960`，本轮在 `codex/local-android-validation` 记录增量修改。云端原失败证据保留于 `docs/verification/`，更新前本机部署记录保留于 `artifacts/local-migration/pre-update/`。本轮没有重跑已通过的独立文件层、窗口诊断或旧浏览器套件。

## 设备与工具矩阵

| 环境               | 实际配置                                                                                             | 验证范围                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Mac 主机           | Apple Silicon arm64，macOS 27.0.1，8 GiB RAM，Node 24.14.0，JDK 17.0.20.1                            | 实际编译、独立 Node/SQLite 服务、Chrome 浏览器集成                             |
| Android 平板模拟器 | 官方 Google APIs API35 r9 ARM64，Emulator 37.1.11，Hypervisor.Framework，2560×1600/320dpi，2 GiB RAM | 真实 APK、WebView、系统 DocumentsUI/ContentResolver/URI 授权；不等于触控笔设备 |
| WebView            | com.google.android.webview 124.0.6367.219                                                            | 真实打包 React 首页；没有替换提供者、关闭快照校验或修改 ISA                    |
| 实体平板/手机      | 未连接；本轮不要求真实平板                                                                           | 压感手感、掌触、倾斜硬件、物理延迟及设备网络切换均未验                         |
| 局域网/公网 HTTPS  | 无实体移动端或已配置的公网入口                                                                       | 未验；本机回环协议通过不能替代                                                 |

SDK Platform 35 r2、Build Tools 35 与系统镜像来自 Google 官方归档，并按官方包清单逐项核验。系统原有 `test_avd` 未改动；本轮 AVD 位于 `android/.tools/avd/Glossa_API35_ARM64.avd`。下载归档校验安装后已移除，保留 SDK/Gradle 缓存与 AVD。

## 实际结果

| 场景                        | 结果      | 实际证据与边界                                                                                                                                                                             |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-bridge`                | 9 项通过  | 真实首页 JS 同步身份桥、异步文件读写和匹配 DOM 回调；BOM/CRLF/中文/emoji/公式字节重开一致。不是系统选择器验收。                                                                            |
| `saf-prepare`               | 7 项通过  | 系统 DocumentsUI 选择 Downloads 文件，真实持久读写授权，经首页 JS 修改一个字符并完整字节重开。                                                                                             |
| `force-stop` → `saf-resume` | 8 项通过  | PID 3641→4033，新进程沿用授权再次读写，其他字节不变；resume 按设计不创建 WebView。                                                                                                         |
| `saf-faults`                | 31 项通过 | 测试 APK 的不同 UID DocumentsProvider；实际撤销全部 URI grant、取消选择、源暂不可访问和只读写失败均保留待写正文/快照；重授权后重试。                                                       |
| 普通同步                    | 3 组通过  | macOS 独立 Node 服务进程、两个真实 Chrome 隔离上下文与 IndexedDB；两客户端离线修改且其中 B 重载保留后，合并不同 B 字符；恢复旧 SQLite 后补齐，并由第三个新上下文重建完整 A/B/源快照/历史。 |
| 端到端加密同步              | 3 组通过  | 单独运行上述场景，另检查服务器库只有密文包；每模式 9 操作、无页面错误。                                                                                                                    |

本轮生产修正：原生打开文件回调的 `persistentPermission` 仅在实际持久 URI grant 同时含读、写时为真。它描述授权掩码，不代表 provider 保证可写；只读能力由真实写入结果判断，失败保留待写，不误标源失联。

测试工具自身的失败保留在 `artifacts/local-migration/`：撤权 API package 重载不覆盖 Intent 临时授权、错误假设只读能力等于只读 grant、遗留 DocumentsUI 任务导致 `startActivitySync` 等待。线程栈确认后，专项使用新 Activity 任务启动，保留应用数据。测试 provider 加入列表通知、排序和 Base64 fixture 传输；这些代码仅在独立测试 APK。

## 真实产品链路与恢复

`tests/android-product.mjs` 通过 Playwright 的 Android WebView 通道连接真实打包首页。只用界面、真实 Pointer Events 和系统 DocumentsUI 改变工程；IndexedDB 与宿主 `NotebookEngine` 仅用于只读核对，不构造工程种子、不替换原生桥、不注入系统选择结果。Wi-Fi 与移动数据显式关闭后，APK 首页与纸张仍可打开。

| 场景              | 实际通过内容                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown 与 LaTeX | 经系统选择器导入不同 UID 的测试文档，选择真实源对象插入纸张，等待 B 提取，选区修订已有 B，经 UI 检查源并写回；提供者独立 SHA-256/字节数核对 BOM、CRLF、注释、公式与未修改内容。 |
| 失联与冲突        | 来源不可用时保留纸张意图、待写和上个源快照；外部修改同一区域后要求对象确认与双方预览，决议前原文件不变，明确选择后才写回。                                                      |
| 已保存笔迹        | 合成笔 4 个采样点，pressure=0.67、tiltX=13、tiltY=-9，强制停止并重开后逐点相同。不是触控笔硬件验收。                                                                            |
| 未完成笔迹        | 笔划中途持久检查点后强制停止，孤立草稿原始采样保留；经“恢复到原纸张/原窗口已停止”确认恢复，检查点被正确消费，已有笔迹不变。                                                     |
| 工程包导出        | 真实分块导出与系统创建文件选择器，最终文件 589,085 字节，原生回读 SHA-256 与 adb pull 独立核对一致；4 条笔迹、2 份原生源关联和完整操作均保留。                                  |
| 工程包导入        | 经系统文件选择器重新选择导出文件，明确确认恢复；导入前新修改的完整工程保存在 `before-restore` 副本且在真实恢复列表可见，导入后 A/B/源快照/历史与包一致。                        |

最终包 SHA-256：`4dbaf57a3ad72d94407160998157f494e6c2c408be1e2fcbe6223f008b640f0e`。Downloads 根据 JSON MIME 自动把测试文件保存为 `.glossa.json`；应用实际重新导入了此文件，没有伪改选择结果。

恢复副本校验按不可变操作身份逐项对照，不把选择器打开前的旧快照当成事务提交时的唯一状态。最终副本保留全部 82 条原操作，并多保留 1 条界面聚焦产生的源接触时间更新；同 ID 内容、全部 A/B 笔记、源正文/快照/历史/队列、元数据与旧 epoch 均核对。额外事件仅允许已解释的 `setting.set(source:...)`，且源记录除接触时间外须一致。

实际发现并修复的另一产品问题：恢复摘要原先仅列工程中最早三篇笔记，较新笔记的修改可能无法在列表辨认。现在按最后修改时间优先显示最近三篇；最终工程包专项重新验证了真实恢复列表。旧原生文件层、诊断和浏览器套件均未因此全量重跑。

产品源文件、笔迹恢复与工程包分阶段继续执行，未重复已通过的独立专项。`GLOSSA_PRODUCT_RESUME` 可指向前一阶段 `result.json`，`GLOSSA_PRODUCT_STAGE=package` 仅继续工程包；最终结果标记继承证据来源，不把它们算作同一轮全量重跑。

## 复现入口

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools
export GRADLE_USER_HOME="$PWD/android/.tools/gradle-home"
export ANDROID_AVD_HOME="$PWD/android/.tools/avd"
# 首次下载若 Java 连接失败，使用系统既有代理的 Gradle -Dhttps.proxyHost/-Dhttps.proxyPort 参数。
npm run build
./android/gradlew -p android :app:assembleDebug :app:assembleDebugAndroidTest
/opt/homebrew/share/android-commandlinetools/emulator/emulator -avd Glossa_API35_ARM64 -accel on -no-snapshot -port 5556
adb -s emulator-5556 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5556 install -r -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5556 shell am instrument -w -e mode app-bridge local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
adb -s emulator-5556 shell am instrument -w -e mode saf-prepare local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
adb -s emulator-5556 shell am force-stop local.quietpaper
adb -s emulator-5556 shell am instrument -w -e mode saf-resume local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
adb -s emulator-5556 shell am instrument -w -e mode saf-faults local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
node --import tsx tests/android-product.mjs
node scripts/verify-local-sync.mjs
```

instrumentation 输出须检查 `PASS`/`FAIL`，不能只看 adb 退出码。完整本机临时日志、截图、样本与数据库在 `artifacts/local-migration/`；可提交的精选证据在 `docs/verification/local-macos-2026-10-22/`。

同步专项使用真实生产 `NativeDocument`/`NativeLink`/`SourceRecord` 及重命名历史作为快照载荷，并逐字段核对；它调用生产同步与存储模块，未经过 React 同步设置界面或源协调器。真实源关联界面闭环由上述 Android 产品与工程包专项另行证明。

最终模拟器已通过 `adb emu kill` 正常关闭（宿主 exit 0），AVD/应用/文件/授权数据保留。当前登录会话的 Glossa 服务已重新加载，网页、健康检查与带令牌状态接口均返回 200；地址仍为 `http://localhost:8787`。

## 保留的目标

真实触控笔压感/倾斜/掌触/连续书写延迟、物理故障与断电、实体手机/平板局域网及公网 HTTPS、复杂 provider 移动/重命名/云文档行为仍未验证。仿手写生成、复杂 Office/Keynote/Numbers 原生格式与真实识别模型继续明确未完成。
