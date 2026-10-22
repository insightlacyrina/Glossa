# Android 容器与原生文件验证

## 已确认的产品边界

Android 平板是唯一完整创建与编辑端。Android 手机只能阅读与修改已有 B 知识块；它不能通过放宽浏览器窗口获得平板权限。原始笔迹须保留对象、坐标、压力、倾斜和图层，不能用截图替代。

## 当前实现决策

`android/app` 是无 AndroidX 依赖的 Java 原生容器，最低 Android 8（API 26），目标 API 35。它使用系统 WebView 加载 APK 内的 Vite 构建产物，并以受拦截的 HTTPS 本地地址 `https://appassets.quietpaper.local` 提供资源。启动、纸张和 IndexedDB 不需要服务器。禁止 `file://`、文件系统访问、混合内容和外部网页替换应用主页面；JavaScript 原生桥只交给打包的应用代码。

原生通过物理显示的较短边 dp 值（600dp）区分平板和手机，并向共享数据内核提供固定角色。这个启发式属于实现假设，不等于经过认证的硬件注册机制；折叠屏、外接显示器和非标准显示密度仍需产品设备矩阵验收。手机的原生文档创建/写回桥也拒绝操作。

原生使用 Storage Access Framework（SAF）打开与写回文件，保留用户授予的持久 URI 权限，不请求整盘权限。Markdown/LaTeX 编辑不需要 Mac 或第三方原生编辑应用。它保留 UTF-8 原文；无效 UTF-8、超过 16MiB 的文本会明确失败。Office、Keynote、Numbers 的二进制格式没有因为 SAF 能选择它们而得到原生编辑支持。

这个 16MiB 限制仅用于当前原生**源文档文本读写**，不用于完整工程包导出。`downloadText` 已接入分块工程导出：每块至多 256KiB，UTF-8 编码前避免切断代理对，原生将块按序持久暂存，不把整份工程一次传入桥接方法。完成后流式写入用户选择的目标，并重新读取计算 SHA-256；校验成功才清理暂存。总工程大小不设 16MiB 上限，实际受可用存储和现阶段 JSON 序列化内存约束。中途退出保留已提交偏移；块写完但清单未提交的尾部，在恢复时截回已提交位置。取消文件选择或目标写失败也不会清除原始工程。

`MainActivity` 将源文件打开、读取、保存、待写恢复与快照查询委托给生产类 `NativeSourceStore`。该文件层直接使用 Android `ContentResolver`，不依赖 Activity、WebView 或 JavaScript 求值器；应用桥与独立文件层 instrumentation 使用同一份生产实现。

写回先校验已有待写日志和待写版本约束，再持久保存新待写日志，随后读取实际源文件并比较调用方提供的源 SHA-256 基准。源内容改变时返回双方内容并保留待写版本，由用户选择结果；源基准一致时，先保存旧源全文快照，再写回、重读校验并保存新快照，最后删除待写日志。实际源全文已经等于目标时可以确认并清理待写，不重复写源。临时不可访问时，待写日志与本地内容继续保留。

本地日志和快照先写同目录临时文件，执行文件 `fsync`，再原子替换并执行父目录 `fsync`；目录创建与待写删除也同步父目录。`NativeSourceStore` 的静态锁在进程内串行保护这些操作，包括不同实例对同一私有目录的访问。上述措施针对本地日志，不构成跨进程锁或外部源文件的原子事务。

URI 是否稳定由文档提供者决定，不能假定移动和重命名后总能继续访问。UI 在聚焦与定时轮询时读取源改动。只有实际 provider 读取失败才返回 `unavailable: true`，用于源失联计时；无效 UTF-8、超限文本、本地日志失败和写权限失败均不能冒充源不可访问。已实测源可读但后续处理失败时返回 `sourceReachable: true`，使协调层能够清除旧失联期限；本地处理失败本身不能证明源已恢复。文件名查询失败可返回 `metadataWarning`，不丢弃已读正文。Mac 同步服务离线不能启动源失联计时。

SAF 提供者不统一支持原子文件替换。当前先持久保存原文和待写快照，避免把单次写回失败当成成功；**这不构成对所有提供者原子写入的保证**。后续必须在 Android DocumentsProvider、Downloads、本地目录、可移除存储和云文档提供者上分别做故障注入。原生私有历史目录不是完整工程包的替代品；工程包须包含共享文件关联模块中的源快照和待写状态。

### 渲染器退出与窗口生命周期

`MainActivity` 已加入 `onRenderProcessGone`：当退出的是当前 WebView 时，先取消其文件选择器回调，移除并销毁已失效的窗口，再显示原生“书写窗口已中断”和“重新打开”按钮。用户点击后才通过 `recreate()` 重建 Activity；不会自动循环重启，也不会在这条恢复路径中清理 IndexedDB、源文件日志或工程导出暂存。处理器返回已接管退出事件，目的是避免容器因未处理渲染器退出继续终止；这项实现尚不能单凭源码证明已经通过故障验收。

原生源文件与导出操作使用**进程内共享的静态单线程 I/O 队列**，源文件层另由上述静态锁保护。Activity 重建不会为同一批持久日志启动另一套并行写者；已经排入队列的持久化工作可以继续执行。它不是跨进程锁，也不保证进程被系统终止后未提交的任务还能运行，恢复仍须依靠已提交的日志与暂存。

异步 `emit` 在主线程再次检查 WebView 是否存在、Activity 是否正在结束或已经销毁、窗口是否仍挂载，并捕获向不可用窗口发送 JavaScript 时的异常。旧 Activity 不会把完成通知投递到重建后的新窗口。文件选择器在窗口退出和 Activity 销毁时清空并以 `null` 结束旧回调；打开/完成导出选择器之前也检查窗口生命周期。失去窗口的导出暂存继续保留，重新打开后可在恢复入口检查，而不是把丢失回调冒充导出成功。

### 本地窗口记录

`onRenderProcessGone` 捕获 `didCrash` 与退出时优先级后，在现有后台 I/O 队列调用生产 `NativeRuntimeDiagnostics`，将最近至多 **8 条**历史写入 app-private `runtime-diagnostics.json`。每条仅含时间 `at`、`kind: "renderer-exit"`、`didCrash`、`priority`、Android API、WebView 包名/版本与应用版本；不记录笔记正文、源 URI、令牌或安装 ID，也不自动发送到外部。版本元数据不可获取时记为 `unknown`。

诊断存储采用进程内静态锁、同目录临时文件、文件 `fsync`、原子替换及父目录 `fsync`。读入时验证 UTF-8、字段白名单、类型与历史上限；已提交文件损坏时保留原字节，拒绝继续覆盖并报告 `runtime-diagnostics-invalid`/`needsRecovery`。其他读写失败同样返回明确错误，不能作为空历史或保存成功。原生目录打开使用公共 SDK 的 `O_RDONLY | O_CLOEXEC`，再以 `fstat` 验证确为目录。

应用“运行状态 → 窗口记录”按最新在前显示中断类型、时间、应用版本、Android API 与书写组件版本。读取失败或成功回复缺失有效数组时显示错误并保留本地记录，不展示“暂无窗口记录”的空成功页面；界面不增加说明性小字。此入口读取原生诊断，不能替代笔迹、工程与同步恢复记录。并非所有主进程 fatal、整进程终止或断电都会触发渲染器退出回调；回调后的进程也可能在后台提交前退出，因此没有窗口记录不能证明没有发生故障。

## JavaScript 桥

`window.QuietPaperNative` 暴露以下方法；读写在串行后台线程执行，不占用书写线程。

| 方法                                                                                       | 结果                                                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `getRole()` / `getDeviceId()` / `getPlatform()`                                            | 同步返回 `tablet`/`phone`、安装标识、`android`                                        |
| `openDocument(requestId)`                                                                  | 用户选择已有原生文件，结果 `type: "open"`                                             |
| `readDocument(requestId, uri)`                                                             | 重新读取已有 URI，结果 `type: "read"`；仅实际源读取失败标记 `unavailable: true`       |
| `saveDocument(requestId, uri, text, expectedSha256)`                                       | 比较版本后写回，结果 `type: "save"`                                                   |
| `getPendingSource(requestId, uri)`                                                         | 成功时明确返回 `pending: false`，或待写全文、`sha256`、`baseSha256`；损坏日志返回失败 |
| `saveDocumentVersioned(requestId, uri, text, expectedSourceSha256, expectedPendingSha256)` | 同时比较源与待写版本；空待写指纹要求队列中确实无此 URI 的待写操作                     |
| `retryPendingWrite(requestId, uri)`                                                        | 重试已有持久待写操作，保留最初源版本作为比较依据                                      |
| `resolveSourceConflict(requestId, uri, resolvedText, sourceSha256)`                        | 旧单 SHA 接口拒绝执行，返回 `versioned-resolution-required`；决议须使用双 SHA 接口    |
| `getPendingWrites(requestId)`                                                              | 返回有效队列元数据；损坏项另列 `diagnostics` 并设置 `needsRecovery`，不发送源全文     |
| `getSourceSnapshot(requestId, uri)`                                                        | 返回待写版本或最后有效源快照                                                          |
| `getRuntimeDiagnostics(requestId)`                                                       | 异步返回 `type: "runtime-diagnostics"`、`ok` 与 `runtime` 数组；损坏或读取失败返回错误 |
| `exportDocument(requestId, name, mime, text)`                                              | 用户选择导出目标，结果 `type: "export"`                                               |
| `beginExport(requestId, name, mime)`                                                       | 建立持久工程导出会话，返回 `sessionId`                                                |
| `appendExportChunk(requestId, sessionId, sequence, base64)`                                | 顺序追加有界 UTF-8 字节块并确认持久偏移                                               |
| `completeExport(requestId, sessionId)`                                                     | 校验暂存、选择目标、流式写入、重新读取并校验 SHA-256                                  |
| `getPendingExports(requestId)` / `discardExport(requestId, sessionId)`                     | 恢复管理界面检查暂存、继续导出或经确认显式清理                                        |

所有异步结果通过 `quietpaper-native` DOM 事件传递：

```ts
window.addEventListener('quietpaper-native', (event) => {
  const result = (event as CustomEvent).detail;
  // {requestId, type, ok, uri?, name?, text?, sha256?, pending?, error?,
  //  unavailable?, sourceReachable?, metadataWarning?, diagnostics?, needsRecovery?, runtime?}
});
```

`source-conflict` 失败包含 `sourceText` 与 `sourceSha256`，保留待写内容。新文件名不用于识别同一源；重新定位须通过共享文件关联模块验证完整原文和源区间，并由用户确认。

自动恢复待写时，协调层必须同时证明待写全文就是该源关联已有 `plannedWrite` 的目标，并核对其原始源指纹；读取到一个待写 SHA 本身不构成取代其内容的授权。未知来源的待写版本进入双版预览，不能静默归档。桥接层再次比较待写指纹与实际源指纹，以阻止预览后竞争修改。旧 `saveDocument` 只允许同一全文、同一源基准的幂等重试，或显式以待写版本为基准的后继编辑。当前源全文已精确等于待写目标时，仍先验证待写版本，再确认成功，不重复写入源文件。

已提交待写日志必须通过 URI、文件名与全文 SHA-256 校验。损坏日志返回 `pending-journal-invalid`，不能当作队列为空，也不能静默替换。队列列表逐项保留正常记录、报告损坏文件，不将未提交的 `.tmp` 当成待写记录，不自动删除损坏或临时文件。写入返回失败且 `pending: true` 时只表示仍需核验待写状态；例如原子替换与目录同步之间发生错误，调用方须重新读取 `getPendingSource`，不能凭失败响应清除本地写入计划。

`getRuntimeDiagnostics` 同样通过带原请求 ID 的 `quietpaper-native` 事件返回。生产存储内部的 `entries` 在桥上转换为 `runtime`；只有 `ok: true` 的空数组表示当前没有已提交窗口记录。`ok: false` 即使附有空数组也仍是读取失败，不能解释为无中断。

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

工程另含无第三方测试框架依赖的 Android instrumentation。`NativeRoundTripInstrumentation` 不带 `mode` 时启动完整 WebView/JavaScript 桥源文件场景；旧轮次的实际结果见后文。测试源提供者只存在于单独的测试 APK，不会打进客户端 APK。

```sh
./android/gradlew -p android :app:assembleDebugAndroidTest
adb install -r -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
```

新增 `NativeSourceScenarios` 通过同一 runner 的 `native-source-*` 模式直接调用生产 `NativeSourceStore`，在真实 Android `ContentResolver` 与文件支持的测试提供者上验证文件层，不启动 Activity 或 WebView。`prepare` 对 Markdown/LaTeX 全文读改写和字节重开进行断言，检查源/待写竞争与双 SHA 决议，再留下已提交的离线待写日志；随后必须停止目标进程，`resume` 检查不同 PID 下的日志、快照与版本恢复，源恢复后读回确认；`faults` 检查非法 UTF-8、超限、文件名查询、本地日志及真实 provider 访问失败的分类，以及损坏待写日志的保护与队列诊断。安装当前客户端及测试 APK 后，按顺序执行：

```sh
adb shell am instrument -w -e mode native-source-prepare local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
adb shell am force-stop local.quietpaper
adb shell am instrument -w -e mode native-source-resume local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
adb shell am instrument -w -e mode native-source-faults local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
```

`resume` 必须消费已完成的 `prepare` 证据，不可通过重置数据绕过未确认的待写；该顺序用于复现新增场景，实际是否通过须以各阶段日志为准。测试专用 ContentProvider 不证明系统文件选择器、持久 URI 授权、各类 DocumentsProvider 或完整 JavaScript 桥已经通过验收。跨进程恢复仅针对已提交待写，不代表写回中途终止、断电或真实 A/IndexedDB 故障恢复已经验证。这里的文本修改直接验证文件层，也不等于已在 Android 验证格式对象抽取、纸张与 B 的完整往返。

本环境标准 `adb` 强制创建不可写的 `~/.android`；`android/tools/adb-direct.py` 仅用于本地无认证模拟器，以 ADB 协议执行安装和测试，避免更改 `HOME` 或写入沙箱以外路径。普通开发机器和真实设备应继续使用标准 `adb`。测试源码编译成功不代表 instrumentation 已执行成功，运行结果以交付证据为准。

### 新增窗口诊断与桥接复现入口

以下模式复用已登记的 runner，按需要单独执行，不要求重跑已通过的文件层或旧恢复专项：

```sh
adb shell am instrument -w -e mode runtime-diagnostics local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
adb shell am instrument -w -e mode webview-probe local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
adb shell am instrument -w -e mode app-bridge local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
```

`runtime-diagnostics` 调用生产诊断存储，但以覆盖 `getFilesDir()` 和 `getApplicationContext()` 的 ContextWrapper 隔离到 app-private cache 内的 UUID 目录，不改写生产窗口历史。它检查跨实例重开与字段限制、最近 8 条保留、损坏文件拒绝覆盖，以及临时路径被目录阻塞时不误报成功。

`webview-probe` 启动仅在 `src/debug` 登记、未导出的 `MinimalWebViewProbeActivity`：只加载一次最小内联页面，观察原生页面回调、真正的 `@JavascriptInterface` 调用及一次 `evaluateJavascript` 结果，不经过产品资产拦截、MainActivity 文件桥或 SAF。此 Activity 不进入 release 构建。`app-bridge` 则启动真正的 MainActivity 和打包首页，等待实际 React/生产脚本就绪，从 JavaScript 调用同步桥及源文件异步桥，并等待 DOM 结果、比较测试提供者文件字节；它不替换首页、不改写为测试 HTML。该模式仍不等于编辑器全部交互、完整格式矩阵或系统 SAF 选择器/持久授权验收。模式存在或构建成功不代表场景已经通过。

### 仅测试 APK 的 checksum 研究入口

`adler-probe` 用于定位当前软件模拟器的 WebView 快照校验问题，不属于产品验收。C 源为 `android/tools/adler-probe.c`，可选 JNI 生成目录为 `android/app/build/generated/adler-probe/jniLibs/x86_64/`。Gradle 仅将该目录作为 `androidTest` 的 JNI 来源：生成后可进入测试 APK，客户端 APK 不包含该研究库；没有生成 JNI 时仍可构建普通客户端和其他测试场景。

在 Linux x86_64 主机上，可使用 JDK 的 JNI 头文件和主机 `cc` 生成不链接 libc 的研究库，再增量构建、安装测试 APK：

```sh
GLOSSA_JDK=/path/to/jdk
mkdir -p android/app/build/generated/adler-probe/jniLibs/x86_64
cc -m64 -shared -fPIC -O2 -ffreestanding -fno-builtin -fno-stack-protector -nostdlib \
  -I"$GLOSSA_JDK/include" -I"$GLOSSA_JDK/include/linux" \
  -Wl,--no-undefined -Wl,-z,noexecstack -Wl,-soname,libglossa_adler_probe.so \
  android/tools/adler-probe.c \
  -o android/app/build/generated/adler-probe/jniLibs/x86_64/libglossa_adler_probe.so
./android/gradlew -p android :app:assembleDebugAndroidTest
adb install -r -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e mode adler-probe local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
```

这是该 x86_64 研究场景的编译方式，不是发布版跨 ABI 的 JNI 构建方案。入口仅接受已登记的精确 WebView ELF SHA-256、映射位置与 GNU Build ID；不同版本或 ABI 必须拒绝，不能猜偏移继续运行。当前目标的 SHA-256 为 `e154b524119b6670b824d3e11a1794bf32e4a497aef18ed5d76fbe6e01d4eded`，Build ID 为 `68dabd72c6088238cbfc9a5fbfe211f916771df5`。它在应用/浏览器主进程读取提供者 APK 的 snapshot 资产，将 payload 复制到 direct buffer，比对独立标量参考与原库整段、至多 32 字节分段的 Adler 调用；这不检查沙箱渲染器实际加载的 snapshot 映射。入口不修改 WebView 库、CPU 特性标志或快照校验设置；可选地观察自然发生且已经落盘的 renderer 记录，未观察到也不能反推没有故障。

`DIAGNOSTIC complete` 仅表示研究流程完成，即使校验不一致也不能计为产品通过。已有观察显示 WebView 124 的优化 checksum 路径结果错误，而宿主机执行同一 ELF 得到正确值；WebView 128 对照也仍失败。仅测试环境的 guest `ssse3` 屏蔽对照约 11 分钟未取得完整启动或可用 ADB，已停止且保留数据；不能把该研究假设当作产品修复。全部旧失败及既有 71 项文件层证据继续保留。精确源码/机器码对应、校验和及对照来源见[故障定位记录](ANDROID-WEBVIEW-DIAGNOSIS.md)。

随后在隔离的官方 Emulator **35.2.10** 上，使用同一 API 35 AVD 和正常 CPU 配置完成启动；实际保留 SSSE3/SSE4.1，WebView 已恢复为 124。旧模拟器下载及 SHA 与官方归档对照见[来源](verification/emulator35-provenance.json)。首个 app-bridge 尝试被冷启动的测试 provider 发布超时牵连终止，日志只报告 `Process crashed`；[系统记录](verification/webview-emulator35-provider-timeout.log)表明这是依赖死亡，不能说成此次 WebView 已发生同一 SIGTRAP。只预热该测试 provider 后，重试此前失败场景仍未在 45 秒内获得首页 ready，最后 progress 10、窗口仍挂载：[输出](verification/app-bridge-emulator35-webview124-warm.log)。没有成功桥断言，也未在此环境重新计算 Adler。

`saf-prepare` / `saf-resume` 已编译，因真实首页仍未通过而未执行。它们必须经系统 DocumentsUI 选择测试文件，并验证真实文档 URI/持久读写授权与重启后的内容；不能注入假的选择结果换取通过。最后向模拟器发出 SIGTERM；宿主模拟器在退出过程中段错误，shell exit 139，不能记为干净关机：[记录](verification/webview-emulator35-shutdown.json)。没有请求清空 AVD 或应用数据。所有配置、实际运行范围和产物摘要见[本阶段上下文](verification/webview-phase-run-context.json)。

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

此前完整 WebView/JavaScript 桥源文件往返 `NativeRoundTripInstrumentation` 的两轮实际运行均**未通过**，这两轮没有取得 Android Markdown/LaTeX 读改写重开成功的证据：

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

这些直接断言只覆盖上述原生文件、导出暂存、安装身份及窗口重建；真实 A 笔迹、IndexedDB 在渲染器崩溃/整进程终止/断电下的完整恢复，以及各种设备的手写体验，仍须分别验收。完整 WebView/JavaScript 桥源文件往返仍未通过，不因恢复专项成功而改写结论。

### 0.1.1 文件层专项实际结果

同日新增专项在 API 35 软件模拟器实际通过 **71 项断言**；不依赖 Activity/WebView，调用与客户端共用的生产文件层：

| 阶段    | 断言数 | 进程 | 结果                                                                                                                                                                   |
| ------- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare | 41     | 2231 | 两种格式真实读改写与字节重开、双版本保护、失败排队；[原始日志](verification/native-source-prepare.log)                                                                 |
| resume  | 18     | 2287 | [force-stop](verification/native-source-force-stop.log) 后不同 PID，原 pending、SHA、源历史仍在，恢复写回并重开确认；[原始日志](verification/native-source-resume.log) |
| faults  | 12     | 2319 | 内容/元数据/本地存储/源不可访问区分，损坏日志诊断与保护；[原始日志](verification/native-source-faults.log)                                                             |

源访问状态新增测试分两次执行，首次 3 项、后续只选新增的跨调用用例 1 项，均通过。协调层保留本轮先前已验证的源访问事实，后续真正离线会重新计时；未知本地错误不能伪称在线。等待期间用户重新定位到不同 URI 或 owner 时，旧请求的错误状态不应用于新源。见[首次日志](verification/native-source-access.log)、[跨调用日志](verification/native-source-access-cycle.log)。

随后仅重试此前未通过的默认 WebView 桥场景，仍返回 `WebView evaluation timeout`，文件断言尚未开始。日志确认 `CrRendererMain` 的 `SIGTRAP` 与 `onRenderProcessGone` 接管；没有因此重复已通过的 71 项或旧恢复专项。见[本次桥重试](verification/native-source-webview-roundtrip.log)、[窗口日志](verification/native-source-webview-logcat.log)、[渲染器崩溃摘要](verification/native-source-webview-crash-summary.log)。根因仍待定位，不能推定增加模拟器内存就已解决。

测试时安装包身份、源码摘要与最终 Web 保护补丁的区别记录在[运行上下文](verification/native-source-run-context.json)。最终交付仅另改了 Web 的过期源错误保护，生产原生文件代码与测试 APK 未改变，因此未重跑已通过专项。新文件层证据不包含系统选择器、持久 URI 授权、真实 DocumentsProvider、完整应用格式抽取/纸张/B 链路或写回中断/断电验收。

`prepare` 的 instrumentation 正常结束也会使目标进程退出；随后显式执行 `force-stop` 确保停止，再验证不同 PID 的恢复。因此这次证明的是已提交日志跨进程保留，不是写入进行中强杀进程的故障注入。

### 0.1.2 窗口诊断专项实际结果

新增 `runtime-diagnostics` 原生专项实际通过 **4 项行为断言**：隔离文件中的记录可重开且仅有允许字段；10 次记录保留最近 8 条；损坏已提交文件保持原字节且读/写均报告恢复错误；临时目标被目录阻塞时写入失败，随后读取仍为空。见 [Android 专项日志](verification/runtime-diagnostics-android.log)。这验证生产诊断存储，不重复此前已通过的 71 项文件层或 6 项窗口恢复断言。

真实应用 UI 配合模拟原生桥的 **2 项检查通过**：最新记录在前，显示类型、时间与版本，390px 布局无横向溢出且无说明性小字；损坏读取保持错误状态，导航与重试仍可用，不显示空成功页面。见 [模拟桥 UI 日志](verification/runtime-diagnostics-browser.log)。这些 UI 检查不能替代 Android 原生回调或真实 renderer 退出验收。

随后只执行 **1 项新增协议检查**：`ok: true` 缺失 `runtime` 或返回非数组时仍报错；合法空数组显示“暂无窗口记录”，导航继续可用。见[协议检查](verification/runtime-diagnostics-protocol-browser.log)。运行命令为 `QP_RUNTIME_DIAGNOSTICS_CASE=protocol QP_TEST_SERVE=1 node tests/runtime-diagnostics.browser.mjs`，未重跑上述 2 项。

本轮也已实际从 app-private `runtime-diagnostics.json` 读回自然发生的 renderer 退出元数据，证明该真实事件经过生产回调和后台记录路径落盘，不只是手工插入测试记录。调试安装可用 `adb shell run-as local.quietpaper cat files/runtime-diagnostics.json` 检查本机记录；它不包含正文、源 URI、令牌或安装 ID。该证据不意味着所有主进程 fatal 都会有记录，也不代表 WebView 底层故障已修复。新增 CPU 对照、最小页面、实际首页桥及 SAF 场景的结果须分别追加实际日志，不能从窗口诊断成功推算通过数。

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
