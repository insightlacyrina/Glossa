# Android 容器与原生文件验证

## 已确认的产品边界

Android 平板是唯一完整创建与编辑端。Android 手机只能阅读与修改已有 B 知识块；它不能通过放宽浏览器窗口获得平板权限。原始笔迹须保留对象、坐标、压力、倾斜和图层，不能用截图替代。

## 当前实现决策

`android/app` 是无 AndroidX 依赖的 Java 原生容器，最低 Android 8（API 26），目标 API 35。它使用系统 WebView 加载 APK 内的 Vite 构建产物，并以受拦截的 HTTPS 本地地址 `https://appassets.quietpaper.local` 提供资源。启动、纸张和 IndexedDB 不需要服务器。禁止 `file://`、文件系统访问、混合内容和外部网页替换应用主页面；JavaScript 原生桥只交给打包的应用代码。

原生通过物理显示的较短边 dp 值（600dp）区分平板和手机，并向共享数据内核提供固定角色。这个启发式属于实现假设，不等于经过认证的硬件注册机制；折叠屏、外接显示器和非标准显示密度仍需产品设备矩阵验收。手机的原生文档创建/写回桥也拒绝操作。

原生使用 Storage Access Framework（SAF）打开与写回文件，保留用户授予的持久 URI 权限，不请求整盘权限。Markdown/LaTeX 编辑不需要 Mac 或第三方原生编辑应用。它保留 UTF-8 原文；无效 UTF-8、超过 16MiB 的文本会明确失败。Office、Keynote、Numbers 的二进制格式没有因为 SAF 能选择它们而得到原生编辑支持。

这个 16MiB 限制仅用于当前原生**源文档文本读写**，不用于完整工程包导出。`downloadText` 已接入分块工程导出：每块至多 256KiB，UTF-8 编码前避免切断代理对，原生将块按序持久暂存，不把整份工程一次传入桥接方法。完成后流式写入用户选择的目标，并重新读取计算 SHA-256；校验成功才清理暂存。总工程大小不设 16MiB 上限，实际受可用存储和现阶段 JSON 序列化内存约束。中途退出保留已提交偏移；块写完但清单未提交的尾部，在恢复时截回已提交位置。取消文件选择或目标写失败也不会清除原始工程。

写回先比较原文件 SHA-256，再保存旧内容历史和待写日志，随后写入并重读校验。源内容改变时返回双方内容，由用户选择结果；临时不可访问时，待写日志与本地内容继续保留。URI 是否稳定由文档提供者决定，不能假定移动和重命名后总能继续访问。UI 可调用 `readDocument` 在聚焦与定时轮询时检查源改动；只有实际源读取失败才能启动源失联计时，不能使用同步服务离线状态代替。

SAF 提供者不统一支持原子文件替换。当前先持久保存原文和待写快照，避免把单次写回失败当成成功；**这不构成对所有提供者原子写入的保证**。后续必须在 Android DocumentsProvider、Downloads、本地目录、可移除存储和云文档提供者上分别做故障注入。原生私有历史目录不是完整工程包的替代品；工程包须包含共享文件关联模块中的源快照和待写状态。

### 渲染器退出与窗口生命周期

`MainActivity` 已加入 `onRenderProcessGone`：当退出的是当前 WebView 时，先取消其文件选择器回调，移除并销毁已失效的窗口，再显示原生“书写窗口已中断”和“重新打开”按钮。用户点击后才通过 `recreate()` 重建 Activity；不会自动循环重启，也不会在这条恢复路径中清理 IndexedDB、源文件日志或工程导出暂存。处理器返回已接管退出事件，目的是避免容器因未处理渲染器退出继续终止；这项实现尚不能单凭源码证明已经通过故障验收。

原生源文件与导出操作使用**进程内共享的静态单线程 I/O 队列**。Activity 重建不会为同一批持久日志启动另一套并行写者；已经排入队列的持久化工作可以继续执行。它不是跨进程锁，也不保证进程被系统终止后未提交的任务还能运行，恢复仍须依靠已提交的日志与暂存。

异步 `emit` 在主线程再次检查 WebView 是否存在、Activity 是否正在结束或已经销毁、窗口是否仍挂载，并捕获向不可用窗口发送 JavaScript 时的异常。旧 Activity 不会把完成通知投递到重建后的新窗口。文件选择器在窗口退出和 Activity 销毁时清空并以 `null` 结束旧回调；打开/完成导出选择器之前也检查窗口生命周期。失去窗口的导出暂存继续保留，重新打开后可在恢复入口检查，而不是把丢失回调冒充导出成功。

## JavaScript 桥

`window.QuietPaperNative` 暴露以下方法；读写在串行后台线程执行，不占用书写线程。

| 方法                                                                                       | 结果                                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `getRole()` / `getDeviceId()` / `getPlatform()`                                            | 同步返回 `tablet`/`phone`、安装标识、`android`                    |
| `openDocument(requestId)`                                                                  | 用户选择已有原生文件，结果 `type: "open"`                         |
| `readDocument(requestId, uri)`                                                             | 重新读取已有 URI，结果 `type: "read"`；失败含 `unavailable: true` |
| `saveDocument(requestId, uri, text, expectedSha256)`                                       | 比较版本后写回，结果 `type: "save"`                               |
| `getPendingSource(requestId, uri)`                                                         | 明确返回 `pending: false`，或待写全文、`sha256`、`baseSha256`     |
| `saveDocumentVersioned(requestId, uri, text, expectedSourceSha256, expectedPendingSha256)` | 同时比较源与待写版本；空待写指纹要求队列中确实无此 URI 的待写操作 |
| `retryPendingWrite(requestId, uri)`                                                        | 重试已有持久待写操作，保留最初源版本作为比较依据                  |
| `resolveSourceConflict(requestId, uri, resolvedText, sourceSha256)`                        | 用户确认冲突预览后，提交选择的内容；仍会再次检查源版本            |
| `getPendingWrites(requestId)`                                                              | 返回队列元数据，不发送完整源内容到任务中心                        |
| `getSourceSnapshot(requestId, uri)`                                                        | 返回待写版本或最后有效源快照                                      |
| `exportDocument(requestId, name, mime, text)`                                              | 用户选择导出目标，结果 `type: "export"`                           |
| `beginExport(requestId, name, mime)`                                                       | 建立持久工程导出会话，返回 `sessionId`                            |
| `appendExportChunk(requestId, sessionId, sequence, base64)`                                | 顺序追加有界 UTF-8 字节块并确认持久偏移                           |
| `completeExport(requestId, sessionId)`                                                     | 校验暂存、选择目标、流式写入、重新读取并校验 SHA-256              |
| `getPendingExports(requestId)` / `discardExport(requestId, sessionId)`                     | 恢复管理界面检查暂存、继续导出或经确认显式清理                    |

所有异步结果通过 `quietpaper-native` DOM 事件传递：

```ts
window.addEventListener('quietpaper-native', (event) => {
  const result = (event as CustomEvent).detail;
  // {requestId, type, ok, uri?, name?, text?, sha256?, pending?, error?}
});
```

`source-conflict` 失败包含 `sourceText` 与 `sourceSha256`，保留待写内容。新文件名不用于识别同一源；重新定位须通过共享文件关联模块比较指纹并由用户确认。

自动恢复待写时，协调层必须同时证明待写全文就是该源关联已有 `plannedWrite` 的目标，并核对其原始源指纹；读取到一个待写 SHA 本身不构成取代其内容的授权。未知来源的待写版本进入双版预览，不能静默归档。桥接层再次比较待写指纹与实际源指纹，以阻止预览后竞争修改。旧 `saveDocument` 只允许同一全文、同一源基准的幂等重试，或显式以待写版本为基准的后继编辑。当前源全文已精确等于待写目标时，仍先验证待写版本，再确认成功，不重复写入源文件。

## 构建与安装

前置条件：JDK 17 或 21、Android SDK Platform 35、Build Tools 35、Node.js。先创建 Web 资产，再构建 APK：

```sh
npm ci
npm run build
export ANDROID_SDK_ROOT=/path/to/android-sdk
./android/gradlew -p android :app:assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

首次 `gradlew` 调用会下载官方 Gradle 8.13 分发包并核对官方 SHA-256；已有系统 Gradle 时直接使用。可设置 `QUIET_PAPER_BUILD_CACHE` 与 `GRADLE_USER_HOME` 将缓存放在可写目录。`syncWebAssets` 自动将最新 `dist/` 同步进 APK，不复制开发服务器地址，不需要网络启动。

调试 APK 只用于本轮验收；正式发布还需要独立签名、升级迁移验证与发布渠道配置。服务端配置应使用 HTTPS。应用默认禁止明文 HTTP；局域网部署也需要设备信任的证书或受信的私有网络 HTTPS 端点。

工程另含无第三方测试框架依赖的 Android instrumentation。它在真实 Android `ContentResolver` 上运行测试专用源提供者，执行 Markdown 与 LaTeX 读入、修改、写回和重新打开，检查原文、公式、注释和空白；再检查源并发冲突、显式解决，以及提供者不可访问时的持久待写和恢复。测试源提供者只存在于单独的测试 APK，不会打进客户端 APK。

```sh
./android/gradlew -p android :app:assembleDebugAndroidTest
adb install -r -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
```

本环境标准 `adb` 强制创建不可写的 `~/.android`；`android/tools/adb-direct.py` 仅用于本地无认证模拟器，以 ADB 协议执行安装和测试，避免更改 `HOME` 或写入沙箱以外路径。普通开发机器和真实设备应继续使用标准 `adb`。测试源码编译成功不代表 instrumentation 已执行成功，运行结果以交付证据为准。

原生导出暂存类还可独立在 JVM 上验收，不依赖模拟器：

```sh
mkdir -p /tmp/quiet-paper-export-tests
javac -d /tmp/quiet-paper-export-tests android/app/src/main/java/local/quietpaper/ExportStore.java android/tools/ExportStoreTest.java
java -cp /tmp/quiet-paper-export-tests local.quietpaper.ExportStoreTest
node --import tsx --test --test-isolation=none tests/native.test.ts
```

本轮已执行：Java 暂存测试 7 项通过，写入并重开校验 **21,045,248 字节**；JS 分块导出 2 项通过，覆盖超过 16MiB 的中文、Emoji、数学符号与 UTF-16 代理对边界，以及原生同步异常的监听器清理。它们证明分块和文件暂存行为，不能代替 SAF 目标提供者真机验收。

`SourceWritePolicyTest.java` 使用 APK 中同一个 `SourceWritePolicy` 类，另有 9 项 JVM 测试通过，覆盖源/待写双版本比较、待写消失或变化拒绝写入、旧基准相同全文的幂等重试，以及不同全文不能偷换待写内容。Android instrumentation 中也加入了这些情形，但必须以其实际运行日志判断是否已在 Android 上通过。

## 原生执行记录与恢复专项

源文件往返 `NativeRoundTripInstrumentation` 的两轮实际运行均**未通过**，没有取得 Android Markdown/LaTeX 读改写重开成功的证据：

| 运行   | 实际结果                               | 证据与边界                                                                                                                                                                                |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首轮   | `WebView evaluation timeout`           | [首轮日志](verification/android-instrumentation-first.log)；WebView 初始化/求值未完成，不能计作文件往返通过                                                                               |
| 第二轮 | instrumentation 报告 `Process crashed` | [第二轮日志](verification/android-instrumentation-final.log)；本轮故障定位确认渲染进程先发生原生 `SIGTRAP`，随后未接管渲染器退出导致主进程 fatal；不能以 JVM 或模拟桥测试替代这一失败结果 |

上述故障促成了窗口恢复与生命周期保护补丁。渲染器 `SIGTRAP` 的底层原因仍未解决或验证；新增恢复按钮旨在控制窗口失效后的行为，不代表已经修复渲染器本身。

`RendererRecoveryInstrumentation` 提供**独立故障注入专项**，由已登记的 `NativeRoundTripInstrumentation` 通过 `mode` 参数选择，不能用它替代源文件往返测试。专项先保存一份原生私有持久文件和已完成的导出暂存，然后终止 WebView 渲染进程，检查 Activity 和原生恢复入口仍可用；再点击“重新打开”，检查 Activity 重建、安装身份、持久文件与导出暂存保留。主动终止渲染进程的路径使用 API 29+ 的 `getWebViewRenderProcess().terminate()`。

安装本轮重新构建的客户端和测试 APK 后，单独执行：

```sh
adb shell am instrument -w -e mode renderer-recovery local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
```

**2026-10-21 专项实际通过，6 项断言成功。** 环境为 Android 15/API 35 软件模拟器：Activity 在渲染器退出后保持、原生私有持久文件保留、导出暂存保留、用户点击后重建 Activity、安装身份保持，以及重开后文件与暂存仍完整。实际输出见 [专项日志](verification/android-renderer-recovery.log)。首次专项未登记成功的问题已修正，失败输出另行保留；已通过的自动、浏览器与 JVM 测试没有重复执行。

这些直接断言只覆盖上述原生文件、导出暂存、安装身份及窗口重建；真实 A 笔迹、IndexedDB 在渲染器崩溃/整进程终止/断电下的完整恢复，以及各种设备的手写体验，仍须分别验收。源文件往返测试仍未通过，不因恢复专项成功而改写结论。

## 验收界线

当前容器提供实际 Android 编译工程与原生文件读写代码，但以下项目必须明确区分证据：

| 项目                             | 证据要求                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| APK 编译                         | `assembleDebug` 成功日志与 APK 文件；以本轮交付报告的实际结果为准                       |
| Android 独立 Markdown/LaTeX 往返 | 真机打开文件、修改、SAF 写回、另一读取程序重新打开比对；共享格式单元测试不能替代本项    |
| 压感、倾斜、掌触与延迟           | 不同触控笔/设备真机验证，当前容器保留 WebView Pointer Events 输入，不声称已验证真实笔感 |
| 源文档自动刷新                   | 真机从应用外修改同一源文件、应用聚焦/轮询读取并更新纸张                                 |
| 普通故障不丢笔迹                 | 杀进程、断电、磁盘写失败、存储撤销、写回中断后对照操作日志和工程包恢复                  |
| 平板/手机权限                    | 两类实际设备安装同一 APK，确认新建、A 编辑及结构操作边界                                |

本环境无 Android 真机、没有可用 `/dev/kvm`，不将桌面浏览器测试称为上述真机测试通过。
