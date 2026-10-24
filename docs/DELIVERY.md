# 笺注 0.1.2 交付报告

日期：2026-10-22。原工作区没有项目代码、需求旧稿或 Quiet Editorial 资源；云端历史工作区位于 `/workspace/quiet-paper`；本轮实际本机目录为 `/Users/zhuyongfei/Documents/ChatGPT/Glossa`。这是持续迭代的工程验证版，不是全部最终需求已完成的声明。下列旧版通过记录沿用其原始证据，0.1.2 新增验证单列，不冒充整套重跑。

## 2026-10-23 Mac 服务器增量交付

原生应用新增独立服务器初始化/启停、真实状态与工程列表、显式登录启动、在线一致性快照、自动备份轮替、校验及停服恢复。安装包内置 Node 24，不依赖阅读客户端运行或工程工作目录；本机桌面增加启动命令。临时 AI 转录逐对象/版本明确授权，使用短期双向认证加密，支持撤销、到期及候选预览，不自动修改 A/B。真实外部模型、识别准确率与公网未验。使用方式见 [Mac 服务器管理](MACOS-SERVER.md)，本轮实际测试与界面证据单列于 [服务器验收](verification/macos-server-2026-10-23/README.md)。

## 2026-10-22 本机迁移增量交付

GitHub main 已更新到指定 `2522960` 基线，本轮变更位于本地 `codex/local-android-validation`。完整当前结果、设备矩阵、边界与复现命令见[本机验收](LOCAL-VALIDATION.md)。以下旧云端结果和失败证据保留为历史，不因本机环境通过而删除。

- Apple Silicon + Hypervisor.Framework 的 API35 ARM64 模拟器：真实打包首页 `app-bridge` **9** 项、系统 SAF prepare **7** 项、显式停止后 resume **8** 项、SAF 故障专项 **31** 项通过。
- 真实 React 界面的 Markdown/LaTeX 导入→对象入纸→已有 B 修订→源写回→字节重开通过；源失联保留、外部同区域改动的预览与明确决议通过。
- 合成笔已保存笔迹和未完成检查点，在 Android force-stop 后通过真实 UI 恢复原始压力、倾斜及坐标采样。合成输入不证明硬件压感、掌触或实际延迟。
- 工程包经真实系统创建/打开选择器导出导入通过；独立核验 589,085 字节及 SHA-256；A/B/源快照/操作历史恢复一致，较新当前工程另存为可见恢复副本。
- Mac 独立 Node 服务、真实 Chrome/IndexedDB：普通同步、端到端加密各 **3** 组增量检查通过，包括离线并重载后合流、旧 SQLite 备份恢复与全新客户端完整重建。

最小产品修正：`persistentPermission` 依据实际持久读写 grant；恢复副本摘要优先显示最近修改的三篇笔记。最终生产构建、APK 编译/签名与 Web 资产逐字节核验通过。旧独立文件层、窗口诊断和浏览器套件沿用旧证据，没有宣称整套重跑。

交付位于 `releases/local-macos-20261022/`，含客户端/独立测试 APK、源码与校验表。精选原始证据见 [verification/local-macos-2026-10-22](verification/local-macos-2026-10-22/README.md)。实体平板/手机、LAN/WAN HTTPS、物理触控笔、断电与存储硬故障仍未验；仿手写、复杂原生格式和真实识别模型保持未完成。

## 已确认需求、实现决策与风险

用户本次完整提示词是最终需求基线。[逐项状态表](REQUIREMENTS.md)保留未实现要求，[架构](ARCHITECTURE.md)单独记录实现假设。

当前选择 TypeScript 共享领域内核、React 交互、IndexedDB 严格事务、Android Java/WebView/SAF 容器和独立 Node 24/SQLite 自托管服务。选择服务于离线运行、真实编辑数据、同一套身份/并发语义与可重复测试；没有把生产浏览器开放为额外完整创建端。

视觉采用重新设计的暖纸、深墨、灰紫工具与编辑式排版；没有沿用此前手机主题的资源。产品入口是原稿纸张，复习留在次级任务入口。

## 四个最高风险目标的实际结论

| 目标                 | 当前验证成功的内容                                                                                                                              | 仍未完成/未验证                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 精确 A/B 映射        | 稳定笔迹/对象、页面、块、段落、B 字符身份；对象版本校验；用户确认与确定性来源；同公式不同 B 字符合流；不确定转校对                              | 自动识别真实手写字符/符号并证明其对应 A 字形/采样区间，仍未验证；B 字符 ID 不能冒充这个结果                    |
| B→A 与独立撤销       | 原位可编辑印刷修订层；删除传播；独立撤销保留后续笔迹；依赖冲突预览；合并前不可逆确认、合并后禁止专用撤销                                        | 仿既有风格的笔迹生成尚未实现。跨页文字没有可靠逐字符落点时保原稿、显示候选并禁止合并，人工跨页定位工具仍需扩展 |
| Android 独立原生往返 | API35 ARM64 硬件加速模拟器上真实主页桥、系统 SAF、真实 React Markdown/LaTeX 对象/B/写回/冲突/失联与强制停止恢复通过；既有 71 项生产文件层断言沿用 | 实体平板、复杂 DocumentsProvider 移动/改名/云存储与物理故障未验；Office/Keynote/Numbers 未实现 |
| Mac 自托管互联网同步 | macOS 实际 Node/SQLite 和 Chrome 两种模式本机集成通过：离线、非重叠 B 合流、原始 A/源快照归档与旧备份补齐恢复；部署配置保留 | 实体平板/手机、局域网与互联网 HTTPS、休眠唤醒和网络切换未验；回环不能替代公网成功 |

## 可运行模块

- 固定纸张、压感/倾斜/时间/图层采样、框选移动、局部擦除、文字/公式/位图混排、手动加页。
- A/B 对照、现有 B 的真实选区编辑、稳定身份、未映射校对、字符/对象/依赖冲突预览及块版本记录。
- 平板按已有段落拆分、合并知识块及建立跨笔记关系；保留稳定段落身份、旧块别名和结构档案，逻辑修改不移动原稿。手机/Mac 不开放这些结构操作。
- 停笔与关闭笔记增量队列；书写时暂停后台结果发布；六阶段开关与状态。无识别服务时不伪造 OCR。外部兼容 API 仅在明确授权后发送变化对象。
- 自托管自动同步、E2EE、离线积压、源快照/复习/映射随工程事件恢复。Mac 临时 AI 代理按上方 2026-10-23 增量实现，默认关闭，授权期间服务器可读取选中明文。
- Markdown/LaTeX 源对象关联、待写队列、源版本比较、失败保留、显式删除选择、源失联冻结、源不确定时人工重新定位。
- 完整工程包与导入恢复、本地恢复副本、未完成笔迹检查点；独立 HTML/Markdown 阅读快照内嵌受支持原稿预览。
- 知识块离线复习、固定/自适应可插拔算法、每日负担、考试目标、A/B 展示和完全由用户判断的会/不会自评。独立自评事件可保留多端并行记录。
- Android 渲染器退出元数据持久记录与“运行状态 → 窗口记录”。仅保留最近 8 条时间、退出类型、优先级、系统/WebView/应用版本；不保存笔记正文、URI、令牌或安装身份。

## 启动、使用与产物

入口与命令见 [README](../README.md)。开发工作台用 `npm run dev`，生产资源用 `npm run build`，Mac 服务用配置好令牌后的 `npm run server`。生产浏览器只读 A、轻改已有 B；Android 容器才提供完整创建能力。

本机当前交付目录为 `releases/local-macos-20261022/`；安装包为调试验收包，不等同正式发布签名。`examples/变化与积累.glossa` 是保留可编辑对象的完整示例工程，另附独立 HTML 阅读快照。示例中的文字与图形是预先编写的对象，不作为 OCR 或仿手写生成证据。

| 产物                                    | 用途                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `releases/local-macos-20261022/glossa-0.1.2-local-20261022-debug.apk`       | Android 调试安装包，内置生产 Web 资源                                                |
| `releases/local-macos-20261022/glossa-0.1.2-local-20261022-androidTest.apk` | 独立原生验收包，仅测试用途，不含于客户端 APK                                         |
| `releases/local-macos-20261022/glossa-0.1.2-local-20261022-source.zip`      | 源码、锁文件、测试、文档、示例和可直接预览的生产资源；不含 SDK、依赖缓存或用户数据库 |
| `releases/local-macos-20261022/SHA256SUMS`                   | 交付文件完整性校验                                                                   |

云端阶段的 0.1.2 原始主 APK 安装标签为“笺注”、versionCode **3**，v2 签名校验通过；7 份内置 Web 资源共 **490,461 字节**，与最终 `dist` 逐字节一致。客户端 APK 不包含研究 JNI 或测试类。SHA-256：`16bef95d69fd1d048fd672ffdf31af5b050cfa8d7989e1e33078acf2df944f75`。证据：[元数据](verification/webview-phase-apk-metadata.txt)、[资源](verification/webview-phase-apk-assets.json)、[签名](verification/webview-phase-apk-signature.txt)、[打包范围](verification/webview-phase-apk-scope.json)。这些为云端原始文件的校验，保留其当时边界；当前本机 APK 的实际校验见 [本机资源校验](verification/local-macos-2026-10-22/apk-verification.json)，完整交互结果见本报告顶部。

实际界面截图：[原稿](workspace-desktop.png)、[A/B 对照](workspace-split.png)、[手机已有 B](workspace-mobile.png)。手机截图使用 390×844 视口，没有新建纸张和书写工具。

## 验证记录

更名前完整验收中，`npm run check` 通过：**141 项自动测试、零失败、零跳过**，随后 TypeScript 检查与 Vite 生产构建通过。`npm run format:check` 通过。原始输出见 [统一检查](verification/check.log) 和 [格式检查](verification/format.log)。

浏览器统一验收 `npm run test:browser` 的 8 个脚本全部通过：真实 IndexedDB 持久化与双窗口 9 项、真实字符选区 4 组、工作区恢复 5 组、模拟原生桥的源文件协调 7 项、知识块管理 7 组、千笔渲染测量、应用端到端 8 组，以及独立 HTML 阅读/安全/跳转 3 项。没有未捕获页面错误。模拟桥明确不替代 Android 原生验收；模拟 IME 不替代各系统输入法真机验收。

最终生产构建另通过 2 项断网验收：首次安装后离线重开、保留既有 B 修订，以及首次断网导出动态模块可用。开发中 SW 缓存受 `Vary: Origin` 影响的实际失败已修复后重验；仅对同源静态资源忽略该匹配差异，API 不进缓存。日志见 [浏览器验收](verification/browser.log)、[生产离线验收](verification/offline.log)。

同步恢复回归在真实 HTTP 下分别验证普通与 E2EE：Mac 从旧 SQLite 备份重启、客户端保留旧上传确认、服务已提交但响应丢失、同身份导入后游标归零，均能自动补齐；相同操作身份携带不同内容仍拒绝覆盖。服务正常重启后也会保守地完整重校验一次，这是当前实现成本，不能当作高效反熵协议已经完成。

独立 JVM 测试中，持久分块导出 7 项通过，写入、重启并重读校验 21,045,248 字节；源文件/待写版本双校验策略 9 项通过。主测试中的 JS 分块导出另验证代理对边界与异常清理。

更名前 Android `assembleDebug` / `assembleDebugAndroidTest` 通过，前次 APK v2 签名校验通过，7 份打包 Web 资源共 488,477 字节与当时 `dist` 逐字节一致，版本校验及分块导出桥已包含。**此前两轮 WebView 桥往返 instrumentation 未通过**：软件模拟器实际启动并安装两份 APK，首轮在 WebView 初始化超时，第二轮报告 `Process crashed`；两轮都未取得 Markdown/LaTeX 往返成功证据。不能把 JVM 与模拟桥通过数替代这两轮结论。实际日志见 [首轮](verification/android-instrumentation-first.log)、[文件往返重试](verification/android-instrumentation-final.log)。

崩溃日志确认 WebView 渲染进程先发生原生 SIGTRAP，容器随后因未处理渲染器退出而终止。已补 `onRenderProcessGone`：移除死窗口、显示原生“重新打开”按钮，用户主动重建窗口；不自动循环重启、不清理数据库或文件日志。原生 I/O 改为进程内统一串行，旧窗口回调和文件选择器回调有生命周期保护。修复后重新编译的 APK 已通过独立 Android 恢复专项 **6 项断言**：窗口存活、恢复入口、用户重开、安装身份及原生私有文件/导出暂存保留。日志见 [恢复专项](verification/android-renderer-recovery.log) 和 [原崩溃定位](verification/android-crash-summary.log)。渲染器 SIGTRAP 的底层原因、真实 A/IndexedDB 在各种设备故障下的恢复仍须继续验收。

收到“已通过的测试不要重复做”后，沿用已有通过证据，仅修复并执行此前尚未成功运行的恢复专项。因测试入口登记失败而修正的测试包只做了必要增量构建；没有重跑 141 项自动测试、浏览器脚本、离线用例或 JVM 测试。交付 APK 的校验针对新增恢复补丁后的新文件。

开发中实际发现并修复了并发删除吞编辑、假冲突、草稿重复、过期校对、同身份恢复串入旧响应，以及首次离线导出缓存失配等问题；对应反例保留在测试中。证据范围和复现命令见 [验证记录说明](verification/README.md)。

## 本次代号更新

中文代号改为“笺注”，英文代号改为“Glossa”。界面、加载与窗口标题、Android 安装名称、PWA 名称、导出/恢复文件名、服务标识、示例与发布包名已更新；新工程后缀为 `.glossa`，旧 `.quietpaper` 仍可导入。

本次生产构建通过，针对更名的两组浏览器检查通过，覆盖新名称、旧工程导入、新导出与阅读快照标题、移动布局及离线重开。Android 主 APK 构建通过，安装标签为“笺注”，7 份 Web 资源共 488,486 字节与新构建逐字节一致，v2 签名通过。没有重跑此前已通过的完整测试或 Android 仪器测试。

当前证据：[更名专项](verification/branding.log)、[生产构建](verification/branding-build.log)、[Android 构建](verification/branding-android-build.log)、[APK 资源](verification/branding-apk-assets.json)、[安装名称](verification/branding-apk-metadata.txt)、[签名](verification/branding-apk-signature.txt)。已有存储、协议、加密及升级身份的兼容决策见 [命名变更](BRANDING.md)。上述完整验收日志保留原始内容，不冒充本次重跑结果。

## 0.1.1 原生源文件可靠性阶段

**已确认需求**仍是 Android 独立编辑并写回原生文件、源离线保留修改、真实冲突保留双方。**实现决策**是把原有生产文件代码提取为不依赖窗口的 `NativeSourceStore`，Activity 和测试调用同一实现；没有用替代存储引擎避开失败场景。

已修复真实访问错误和内容/本地存储错误混淆、损坏待写日志遮住正常队列、旧单 SHA 决议可能替换较新 pending，以及本轮已成功读源后本地日志失败仍沿用旧离线期限的问题。本地日志使用文件同步、原子替换和父目录同步；损坏记录保留并返回逐文件诊断，未提交临时文件不当作已提交操作。旧单 SHA 决议安全拒绝，用户决议必须同时核对源与 pending。

新增 Android 文件层专项实际通过 **71 项断言**：

| 阶段           | 实际证据                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare，41 项 | Markdown/LaTeX 实际读入、修改、写回、按字节重新打开，保留 BOM/CRLF/中文/Emoji/注释/空白；幂等确认、冲突不覆盖、过期双版本决议拒绝、失败保留待写；[日志](verification/native-source-prepare.log)                               |
| resume，18 项  | 显式 `am force-stop` 后 PID **2231 → 2287**，完整待写 payload、基准 SHA、源历史保留，源恢复后写回且读回确认才清队列；[停止命令](verification/native-source-force-stop.log)、[恢复日志](verification/native-source-resume.log) |
| faults，12 项  | 非法 UTF-8、超限、元数据失败、本地日志失败、真实源不可访问分类；损坏/篡改日志不覆盖、正常队列不被遮蔽、临时文件不误认；[日志](verification/native-source-faults.log)                                                          |

新增源访问状态测试 **3 项 + 1 项**通过，分别记录在[首次新增用例](verification/native-source-access.log)和[跨调用用例](verification/native-source-access-cycle.log)。后一项只执行新增用例。没有重跑旧 141 项、浏览器套件、离线用例、JVM 测试或已通过的渲染器恢复专项。

生产构建与主/测试 APK 编译成功。0.1.1 调试 APK 标签为“笺注”，versionCode 2，v2 签名通过；包内 7 份 Web 资源共 **488,917 字节**与当时 `dist` 完全一致。SHA-256：`1f99cc461723a9d5d1ae2f39441858d45fede9024da96c85a7466e07f866c349`。证据：[生产构建](verification/native-source-build.log)、[Android 构建](verification/native-source-android-build.log)、[测试增量构建](verification/native-source-test-build.log)、[最终 Web 保护后的主包构建](verification/native-source-final-android-build.log)、[资源](verification/native-source-apk-assets.json)、[元数据](verification/native-source-apk-metadata.txt)、[签名](verification/native-source-apk-signature.txt)。最后只增加了 URI/owner 变化时忽略旧错误的 Web 保护；生产原生文件层与测试 APK 未变，没有重跑已通过专项。运行包与源码摘要见[运行上下文](verification/native-source-run-context.json)。

此前未通过的默认 WebView 桥场景本次重试仍失败：渲染线程再次 `SIGTRAP`，容器接管退出，但 JS 求值超时，尚未进入文件断言。见[失败输出](verification/native-source-webview-roundtrip.log)、[接管日志](verification/native-source-webview-logcat.log)、[崩溃摘要](verification/native-source-webview-crash-summary.log)。独立文件层成功不能改写这一失败结果。

**仍待验证的高风险目标**：以上 71 项直接调用生产文件层，不启动 WebView，不覆盖 React 格式对象抽取→纸张/B→源的完整链路或系统选择器；专用 ContentProvider 不代替真实 SAF 提供者矩阵。跨进程恢复仅覆盖已提交 pending，不证明写入途中断电、任意外部提供者原子写或真实 A/IndexedDB 全故障恢复。损坏日志已有机器可读诊断，专门的逐文件恢复界面尚未实现。复杂格式最终目标没有降低。

恢复实验的 `prepare` 正常结束本身也会退出目标进程，其后再执行显式 `force-stop`。不同 PID 与内容核验构成跨进程持久恢复证据，不将其扩大为写入进行中强杀验证。

## 0.1.2 窗口诊断与 Android 链路定位

**已确认需求**是运行故障可定位、原稿可靠保存和 Android 独立原生文件编辑，不能因当前软件模拟器失败而降低验收范围。**实现决策**是在原有恢复入口之外增加独立的本地诊断记录，串行写入、文件同步、原子替换、父目录同步，最多保存 8 条严格校验的元数据。损坏的已提交文件保留并返回恢复错误，不能当作空记录，也不能被下一次退出静默覆盖。

“运行状态 → 窗口记录”按最新优先显示退出类型、时间、应用版本、Android API 和 WebView 版本；旧原生桥没有新接口时不显示入口。该界面没有说明性小字。记录只覆盖到达 `onRenderProcessGone` 的事件，浏览器主进程直接终止等故障不保证能被记录，空记录不代表从未发生中断。

本阶段只执行新增检查及此前失败链路：

| 验证 | 实际结果与证据 |
| --- | --- |
| 原生诊断持久化 | **4 项通过一次**：[日志](verification/runtime-diagnostics-android.log)。覆盖新实例重读、允许字段、10 次保留最近 8 次、损坏保留并拒绝追加、临时文件无法写入时不误报成功。使用隔离测试目录，不覆盖用户诊断文件。 |
| 窗口记录界面 | **2 项通过一次**：[日志](verification/runtime-diagnostics-browser.log)。模拟桥配合真实界面和 IndexedDB，验证最新优先、实际元数据、390px 无横向溢出、读取失败及重试。模拟桥不替代 Android JS 桥验收；后续仅执行 [1 项新协议检查](verification/runtime-diagnostics-protocol-browser.log)，缺失/非数组回复保持错误，合法空数组正常显示，原 2 项未重跑。 |
| 自然渲染器退出 | 实际捕获并持久保存 WebView 124 的崩溃元数据：[记录](verification/runtime-diagnostics-renderer-event.json)。这是一条实际观察，不另计为测试断言。 |
| WebView 124 完整主页桥 | **未通过**：[日志](verification/app-bridge-webview124.log)。渲染器退出后快速失败，未取得主页 JS→原生文件读写→回调的成功断言。最小内联页面探针也未成功：[日志](verification/webview-minimal-probe.log)。 |
| 官方 AOSP WebView 128 对照 | **未通过**：[桥日志](verification/app-bridge-webview128.log)、[崩溃摘要](verification/webview128-crash-summary.log)。测试镜像安装官方预编译 128.0.6613.88 后仍发生浏览器进程 fatal；已执行恢复系统 124 的操作。提供者来源、摘要及仅测试镜像重签范围见 [记录](verification/webview-provider-provenance.json)。 |
| 旧版官方模拟器 35.2.10 对照 | API 35 同一数据在正常 CPU 配置成功启动，SSSE3/SSE4.1 保留，WebView 124 已恢复。[来源与摘要](verification/emulator35-provenance.json)。首次主页桥因冷启动测试文件提供者发布超时、依赖进程终止而失败：[桥输出](verification/app-bridge-emulator35-webview124.log)、[系统日志](verification/webview-emulator35-provider-timeout.log)。预热该提供者后只重试失败链路，主页 45 秒内未就绪，进度 10、窗口仍 attached，**0 项成功桥断言**：[输出](verification/app-bridge-emulator35-webview124-warm.log)。没有在此配置重测 Adler，也没有证据将这次超时定性为此前 SIGTRAP。 |

旧 141 项、既有浏览器套件、2 项断网、JVM、渲染恢复 6 项、原生源文件 71 项及源访问 4 项都未重跑；新协议保护加入后也只运行新增 1 项，先前 UI 2 项没有重跑。本阶段新增结果为 **原生 4 项 + 模拟桥 UI 2 项 + 协议 UI 1 项**。最终生产 TypeScript/Vite 与主/测试 APK 构建通过：[Web 构建](verification/webview-phase-production-build.log)、[打包 Android 构建](verification/webview-phase-packaged-android-build.log)。编译通过不补足完整应用验收。

对原始 WebView 124 的精确 ELF、BuildId、快照和固定源版本核对后，旧 SIGTRAP 分支对应 V8 `VerifyChecksum` 检查失败。快照头、主机 seed-0 Adler 和 Android 标量参考均为 `0x882b7eae`，原 Android 提供者同一 bundled Adler 整体调用却返回 `0xb2987c76`；同库分成不超过 32 字节的滚动调用恢复正确值。主机执行同一原始 ELF 的经过静态边界审查的 SIMD 叶函数也得正确值。证据见 [快照校验分析](verification/snapshot-check-analysis.md)、[整体调用](verification/android-bundled-adler.log)、[分块调用](verification/android-bundled-adler-chunked.log) 和 [主机同函数验证](verification/host-simd-adler-analysis.md)。

这些对照强烈指向原无 KVM 的 TCG 配置在优化计算路径上的执行异常，尚未定位具体错误指令或翻译规则，不能概括为 Android 或全部 WebView 有此缺陷，也不把其他 fatal 自动归于同一原因。没有跳过快照校验、篡改提供者库或在产品中关闭 V8 特性来取得假通过。额外屏蔽 SSSE3 的测试配置约 11 分钟仍无有效启动或 ADB 握手，已停止且未擦除数据，不能计为修复成功。随后隔离安装官方模拟器 35.2.10，正常 CPU/ISA 配置成功启动，但主页仍未就绪；这项新环境结果不能外推为其 Adler 同样错误或校验故障已经解决。完整诊断、配置边界及输出见 [专项报告](ANDROID-WEBVIEW-DIAGNOSIS.md) 和 [最终运行上下文](verification/webview-phase-run-context.json)。

旧版模拟器在请求 SIGTERM 后于宿主退出过程发生段错误（exit 139），[退出记录](verification/webview-emulator35-shutdown.json)单列保存；未请求清空数据，不能将其记为干净关机或 Android 应用故障。

**仍待验证的高风险目标**：完整 React 主页 JS 桥、系统 DocumentsUI 选择器、持久 URI 授权及停止进程后的重新读写仍未通过本阶段验收。新增专用 `app-bridge`、`saf-prepare`/`saf-resume` 场景用于取得这些证据；因真实主页尚未就绪，SAF prepare/resume **未执行**。场景代码存在不代表已通过。Office/Apple 原生格式、真机自然手写、真实 Mac 公网等最终目标不变。

## 交付限制与下一阶段

1. 将当前已缩小的 WebView/TCG 校验异常与真实 Android 环境隔离：定位原配置的具体错误计算路径，并分析旧官方模拟器正常 CPU 配置下的主页就绪超时；在符合 Android ISA 要求的加速模拟器/真机完成已有 `app-bridge`，再执行系统 SAF prepare/resume。不得通过跳过快照校验换取通过。真实 Android 书写设备矩阵继续覆盖压感/倾斜、掌触、长笔记延迟、系统回收/断电/磁盘失败、笔迹与工程恢复；内核或 Chromium 时间不能替代真机手感证据。
2. 接入真实本地 OCR/公式识别与 CJK 手写语料；输出不确定范围和候选；建立可验证 A 字形/采样身份，不以高置信度自动授予精确映射。
3. 仿手写生成插件、风格样本不足/失败回退、修订层合并及独立撤销矩阵；保留现有印刷文字兜底。
4. 完善跨页修订人工落点与字符校对、套索、图形/箭头识别、几何自动应用、音频和 PDF 背景。当前局部擦除保留剩余原始笔迹，但残段的知识映射仍需重新校对。
5. 原生格式按 [覆盖表](FORMAT-COVERAGE.md)逐格式推进：真实语料、对象树、母版/动画/布局/公式等可编辑语义、Android 独立写回、原应用重开；绝不以截图过关。
6. 实际 Mac HTTPS/互联网及多设备断线补全测试；附件分块、密钥轮换、临时解密 AI 授权与撤销、设备身份与钥匙串。
7. 原生系统通知/桌面小组件、完整 FSRS 实现/校准、启动时负担提示。当前应用内复习闭环可用，不能概称所有通知渠道已覆盖。
8. 大型笔记的持久化与历史投影迁至 Worker/增量对象存储，继续测持续书写帧率与备份体积；当前单笔 SVG 合成优化不代表已经验证所有长笔记性能目标。
9. 原生 macOS 客户端已新增 SwiftUI/AppKit 实现，支持现有 Mac 阅读/轻编辑权限、离线复习、完整工程与普通/E2EE 同步，原生自动测试 13 项通过，见 [Mac 交付与边界](MACOS.md)。手机/Mac 同步仍获取完整操作日志，B 专用轻量网络通道尚未实现。已有独立阅读快照不等于完成低带宽设备同步。

环境记录：首次无 KVM 模拟器与 Gradle 并发曾被 OOM 终止（exit 137），后续重启曾被自动审批系统以“使用额度上限”为由拒绝，拒绝时未执行该动作。环境恢复后，同一重启操作已重新获准；低内存软件模拟器已实际完成启动。这个历史拒绝不再是当前运行验证的阻塞原因。
