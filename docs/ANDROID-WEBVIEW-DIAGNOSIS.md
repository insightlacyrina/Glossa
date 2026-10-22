# Android WebView 启动故障：证据与边界

日期：2026-10-22。这里记录失败链路的定位，不改变 Android 独立编辑、真实纸张操作和系统 SAF 的已确认验收目标。所有通过数以实际运行日志为准；旧通过套件没有重跑。

## 原始环境与精确身份

当前执行机器没有 `/dev/kvm`，使用 Android API 35 x86_64 镜像、软件 TCG 与 Android Emulator 37.2.12。原始 WebView 为 `124.0.6367.219`。库 SHA-256、GNU Build ID、快照 SHA-256 和对照版本下载来源见[来源记录](verification/webview-provider-provenance.json)。

原有 `SIGTRAP` 的库相对 PC 为 `0x17971cc`，前一字节 `0x17971cb` 为 `int3`。固定版本 V8 源码、分支和寄存器对照将它定位到 `Snapshot::Initialize` 的 `CHECK(VerifyChecksum(blob))` 路径；这是机器码与固定源码对应分析，不冒充完整调试符号回溯。详见[快照校验分析](verification/snapshot-check-analysis.md)。

快照文件 74,109 字节，校验载荷为 `[12:]` 的 74,097 字节，头部偏移 8 的校验值为 `0x882b7eae`。此版本使用 Adler 初值 **0**，不能用 zlib 默认初值 1 得到的差异判断文件损坏。

## 新增的可执行诊断

| 同一载荷与初值 0 | 实际 Adler 值 |
| --- | --- |
| 快照头、宿主机 zlib、宿主机标量、Android Java 标量 | `0x882b7eae` |
| Android 原库 `0x3f8f260` 一次处理完整载荷 | `0xb2987c76` |
| 同一原库函数，每次至多 32 字节、滚动初值 | `0x882b7eae` |
| 同一 ELF 中实际 SIMD 叶函数 `0x1797790` 在宿主 CPU 执行 | `0x882b7eae` |

原生研究探针只进入 androidTest APK，并以精确 ELF SHA、Build ID 和映射范围作为调用前置条件。客户端没有载入此研究 JNI，没有修改 WebView、校验开关、V8 功能或产品权限。整段与短段调用的[原始记录](verification/android-bundled-adler-chunked.log)单列为诊断，不计产品通过断言。

宿主机执行前验证该叶函数的 144 条指令、所有分支、3 处只读常量、412,805 项重定位中不存在相关依赖，并要求 SSSE3 与 SSE4.1。它在隔离子进程中映射原始 PT_LOAD 字节；不 dlopen Android 库、不运行其构造器、不改原文件。错误候选地址 `0x1798a90` 经静态检查排除，从未执行。见[执行方法与限制](verification/host-simd-adler-analysis.md)、[结果](verification/host-simd-adler.json)及[反汇编](verification/host-simd-static-disassembly.txt)。

这些结果强烈指向当前 TCG 环境执行优化计算路径时的异常，尚未确定具体出错指令或翻译步骤，也未排除全部运行时破坏可能。不能据此宣称其他版本、真机或完整应用一定通过。旧 Crashpad 转储虽可部分解析，其压缩校验未通过，仍作为未验证材料留在构建目录，不提升为可信堆栈证据。

## 对照实验必须保留失败结果

- 最小内联 WebView 探针在 45 秒内未取得成功页面回调：[日志](verification/webview-minimal-probe.log)。它绕开产品首页，只用于缩小问题；不能代替真实交互。
- WebView 124 的真实打包首页 app-bridge 场景在恢复窗口出现后失败：[日志](verification/app-bridge-webview124.log)。未取得生产 JS→原生读写→DOM 回调的成功断言。
- 从固定 AOSP 提交取得 WebView `128.0.6613.88`，验证 Git blob 和 SHA 后，仅为隔离 SDK 模拟器用公开 AOSP testkey 重新签名。该版本同样发生浏览器进程 fatal：[场景](verification/app-bridge-webview128.log)、[崩溃摘要](verification/webview128-crash-summary.log)。随后卸载系统更新，恢复原始 124；不将更换提供者写成产品修复。提供者和测试密钥均不进入工程交付。
- 另一次仅测试环境的 `-cpu android64,-ssse3` 实验在约 11 分钟内未取得完整启动或可用 ADB，停止并保留 AVD 数据：[配置与结果](verification/webview-scalar-cpu-context.json)、[运行日志](verification/webview-scalar-cpu-emulator.log)。未确认失败原因；屏蔽 Android 基线 CPU 特征不是交付方案。
- 隔离下载官方旧版 Emulator 35.2.10，下载 SHA 与官方归档一致：[来源](verification/emulator35-provenance.json)。使用同一 API 35 AVD、正常 CPU 配置实际完成启动，SSSE3/SSE4.1 保留，WebView 恢复为 124：[设备记录](verification/webview-emulator35-final-device.log)。请求 1536MiB，运行器实际提升到 2048MiB。
- 旧版模拟器首次 app-bridge 输出 `Process crashed`：[场景](verification/app-bridge-emulator35-webview124.log)。[系统记录](verification/webview-emulator35-provider-timeout.log)显示冷启动测试 provider 发布超时，应用因依赖进程死亡被停止；不能将这次失败归为 WebView 校验 SIGTRAP。通过独立 `content call` 预热测试 provider 后，只重试该失败场景：[输出](verification/app-bridge-emulator35-webview124-warm.log)。主页 45 秒内未 ready，最后 progress 10、窗口仍挂载，成功桥断言为 0。此环境未重新执行校验研究，也不能宣称与 37.2.12 已确定具有相同错误计算。

旧版模拟器仍未解除真实首页阻塞，因此系统 SAF 两阶段尚未运行。运行上下文、检查范围和产物身份见[阶段记录](verification/webview-phase-run-context.json)。这些环境试验没有清空数据、跳过快照校验或把静态页面替代真实产品首页。

最后请求 SIGTERM 后，宿主模拟器在退出时段错误（shell exit 139），见[退出记录](verification/webview-emulator35-shutdown.json)。这属于环境退出故障，不能称为干净关机，也不能自动归为 Android 应用崩溃。

## 已交付的故障观测

生产 `NativeRuntimeDiagnostics` 持久保存最近 8 次可捕获的 renderer-exit 元数据，损坏记录保留、不能覆盖为空。界面入口为“运行状态 → 窗口记录”。新增原生持久化 4 项和模拟桥 UI 2 项各通过一次，见[原生日志](verification/runtime-diagnostics-android.log)、[界面日志](verification/runtime-diagnostics-browser.log)。另有一条自然发生的[实际渲染器退出记录](verification/runtime-diagnostics-renderer-event.json)。

后续协议修复只运行了[1 项新增检查](verification/runtime-diagnostics-protocol-browser.log)：成功回复缺失数组或类型错误均保留为错误，合法空数组正常显示。旧 2 项未重跑。

整进程 fatal、断电或队列提交前退出未必经过此回调；记录为空不证明没有发生故障。该功能不收集正文、URI、令牌或安装 ID，不改变 A/B 数据或客户端权限。真实主页、系统选择器、持久授权、真机压感/倾斜和长周期故障恢复仍须分别取得证据。
