# 笺注 · Glossa

本地优先的固定纸张笔记系统，当前版本为 **0.1.5 工程验证版**。界面以暖纸、深墨和灰紫为主，支持炭黑主题，默认进入原稿纸张。

这不是全部需求的最终完成版。当前交付包含可操作的客户端、Android 原生工程、Mac 自托管同步服务、可恢复数据内核和自动验收。**支持端侧文字识别和基于已确认字形的矢量仿手写修订；缺字时保留印刷文字。** Office、Keynote、Numbers 未实现，不能把文本往返或 PDF 截图算作这些格式的兼容。

## 下载

- Android 0.1.5 支持手机原稿缩放与平移、竖屏段落对照，以及更紧凑的平板书写界面。平板与手机共用调试签名 APK，按设备自动区分权限。[GitHub 工程预发布](https://github.com/insightlacyrina/Glossa/releases/tag/v0.1.5)
- Apple Silicon Mac 0.1.5 精简笔记库并统一工程导入流程。安装包使用本地 ad-hoc 签名。[GitHub 工程预发布](https://github.com/insightlacyrina/Glossa/releases/tag/v0.1.5)

同步含快捷撤销记录的工程前，请先将相连的客户端更新到 0.1.4 或更新版本。

## 启动

需要 Node.js **24**（服务端使用内置 SQLite）。

```sh
npm ci
npm run dev
```

打开终端显示的本地地址（默认 `http://localhost:5173`）。开发服务默认提供明确标注的“开发平板工作台”，用于鼠标、触控笔和自动验收。`?device=phone`、`?device=mac` 可验证只读原稿和已有 B 编辑权限；这些参数只在开发构建有效。

**生产构建的浏览器是阅读/轻编辑端**；不能用放大窗口或 URL 参数解锁平板功能。完整创建端由 Android 原生桥提供固定角色。

```sh
npm run build
npm run preview
```

生产浏览器首次打开为空。可导入 `examples/变化与积累.glossa` 查看、修改已有 B 和复习；完整新建与原稿编辑请安装 Android APK。生产 Service Worker 预缓存本轮所有静态资产，API 不进入缓存；Android 直接从 APK 资产启动，不依赖 Service Worker 或开发服务器。

## Android

构建：

```sh
npm run build
export ANDROID_SDK_ROOT=/path/to/android-sdk
./android/gradlew -p android :app:assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

构建产物为 `android/app/build/outputs/apk/debug/app-debug.apk`。安装包是调试验收包，正式发布签名、设备矩阵和升级迁移仍需后续验证。角色来自原生物理显示信息，600dp 较短边区分平板/手机是当前实现假设，折叠屏等须专门验收。

Android 使用系统 WebView 的 Pointer Events 保存真实采样，并通过 SAF 独立读写 Markdown/LaTeX。SAF、原生历史、待写回及编译细节见 [Android 文档](docs/ANDROID.md)。APK 编译、模拟器运行和真实触控笔验证是不同证据，最终结果见 [交付报告](docs/DELIVERY.md)。

0.1.1 的 Android 生产文件层已在 API 35 模拟器通过 71 项新增断言，覆盖文本往返、双版本冲突保护、强制停止后的待写恢复与错误分类。测试使用真实 ContentResolver 和专用文件提供者，不代表系统文件选择器、持久授权或真实触控笔已验。0.1.2 的本机视觉验收安装包保留在 `releases/visual-refresh-20261022/`。

0.1.2 新增“运行状态 → 窗口记录”：Android 持久保存最近 8 次可捕获的渲染器退出元数据，不记录笔记正文、文件 URI 或令牌。原生持久化 4 项、模拟桥界面 2 项及后续 1 项协议检查的既有证据沿用。云端 x86 软件模拟器阶段曾因 WebView 快照校验及首页超时未通过主页桥与 SAF；原失败日志与 [Android 诊断](docs/ANDROID-WEBVIEW-DIAGNOSIS.md) 保留。

2026-10-22 迁移到 Apple Silicon Mac 后，API 35 ARM64 硬件加速模拟器通过真实打包首页 `app-bridge` 9 项、系统 SAF `prepare` 7 项、显式停止后 `resume` 8 项及取消/撤权/源离线/只读失败专项 31 项。真实 React 界面已完成 Markdown/LaTeX 经系统 SAF 导入、对象插入纸张、修订已有 B、写回并按 SHA/长度核对，以及源冲突预览和离线待写保留；已保存及未完成检查点的合成笔迹均在 force-stop 后经真实 UI 恢复；工程包真实系统导出/导入保留 A/B、源快照与历史，较新当前另存为可见恢复副本。未连接实体平板或触控笔，真实笔感、掌触与物理延迟仍未验。详细设备矩阵、恢复范围与证据见 [本机增量验收](docs/LOCAL-VALIDATION.md)。

## Swift 原生 Mac 客户端

`swift/` 提供 macOS 14+ 的 SwiftUI/AppKit 客户端：A/B 对照阅读、修订已有 B 文字和公式、管理笔记与文件夹、离线复习、冲突预览、工程导入/导出、恢复副本及普通/E2EE 自托管同步。遵循现有 Mac 权限，不创建笔记、页或知识块。

```sh
npm run build:macos
open releases/macos/Glossa.app
npm run test:swift
```

本机桌面已放置 `启动笺注.command`，双击即可打开上述应用。仓库中的通用启动入口为 `scripts/launch-macos.sh`。

界面、纸张绘制、编辑器、文件与网络均使用原生 API；JavaScriptCore 只复用已有数据规则，不加载 WebView。原生自动测试覆盖工程兼容、权限、实际范围编辑、修订层、复习、耐久恢复与真实 HTTP 普通/E2EE 互通。构建后的应用位于 `releases/macos/Glossa.app`。构建与验证边界见 [Mac 文档](docs/MACOS.md)。本机 ad-hoc 签名尚未做 Developer ID 公证；跨公网与另一台实体设备仍待验。

## Mac 自托管服务

客户端与服务器是两个职责：阅读客户端可关闭，服务端仍可作为后台进程运行。

**原生入口：设置 → 管理这台 Mac 上的服务器。** 安装包内置独立 Node/SQLite 运行时，可初始化、启停、查看工程、配置登录启动、自动/手动备份、校验并恢复。新服务保存在 `~/Library/Application Support/GlossaServer/`，不会接管旧 `server-data/`。使用步骤和临时 AI 授权见 [Mac 服务器管理](docs/MACOS-SERVER.md)。

开发者也可沿用命令行服务：

```sh
npm run build
export GLOSSA_TOKEN='替换为至少24字符的随机访问令牌'
npm run server
```

默认仅监听 `127.0.0.1:8787`，数据库在 `server-data/`。真实客户端在“设置 → Mac 同步”填写 HTTPS 地址、令牌及相同工程标识。空阅读端可以通过工程标识拉取既有工程；已有不同工程须先导入正确工程。端到端加密口令只保留当前客户端会话，重启需解锁；服务器拒绝混合模式与错误密钥。

局域网、互联网 HTTPS、Tailscale、Caddy 与旧式命令行部署见 [同步文档](docs/SYNC.md)。已在 Mac 独立 Node/SQLite 服务和真实 Chrome 隔离上下文验证普通同步、端到端加密各 3 组：离线重载、非重叠编辑合并、旧备份恢复及新客户端完整重建。新增原生临时 AI 代理仅在选择对象并逐次明确授权后发送，支持短期密钥、撤销、到期和候选预览；模型调用已用真实 HTTP mock 验证，真实模型准确性未验。实体移动端、局域网和公网 HTTPS 仍未验。

## 当前操作闭环

- 平板“一张新纸”即创建固定纸张，无需先建知识块。支持 A4/B5/自定义比例、横竖、点阵/横线/方格/空白，手动加页。
- 钢笔保存位置、压力、倾斜、时间与图层；框选移动、局部橡皮、键盘文字/公式和图片可以混排。长按已有对象查看对应 B；B 菜单跳转至当前有效 A 修订。
- 停笔/离开笔记按变化对象增量整理。Android 用 ML Kit 数字笔迹模型识别同页成组笔画、内置中英文 OCR 识别图片；手写模型首次下载后离线使用。可选外部视觉模型发送真实裁切图像，需当前会话授权。所有识别候选先校对，不推测字符与笔画的精确对应。已有键盘文字可确定性提取。
- 已有 B 文字/公式以真实选区和稳定字符身份编辑，保存到操作日志。非重叠字符编辑合流，同一内容争用进入校对中的冲突预览。
- 框选单字全部笔画后“学习选中字形”，B 修订可在原位置生成保留压力与倾斜的可编辑矢量笔迹。缺字、空间不足或公式保留印刷层；补齐字形后自动重试，人工改动过的修订需显式重试。平板“修订与历史”支持独立撤销和确认后合并。使用方式与证据见 [文字识别与仿手写](docs/RECOGNITION.md)。
- 复习按知识块离线排期，可切 A/B/对照、自评“会了/还不会”，固定间隔与可插拔自适应算法均可运行。当前 adaptive 是 FSRS 启发式，不是经过验证的完整 FSRS 模型。
- 原生 Markdown/LaTeX 可选择源对象插入纸张，并保留完整源快照、历史和待写队列；未经证明的源对象重定位进入人工确认，不能靠坐标或文件名猜。
- 导出完整 `.glossa` 工程恢复原始 A/B、映射、对象/版本、知识关系、复习及源快照。Markdown/独立 HTML 是另行提供的 B 阅读快照，不能替代完整恢复包。

## 验证

```sh
npm test
npm run build
```

浏览器验收默认使用 `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指向本机浏览器。统一脚本会自行启动独立、禁热更新的本地测试服务并在结束时关闭，避免验收被开发时的文件变化中断。

```sh
npm run test:browser
npm run test:offline
```

Android 原生往返使用单独 instrumentation APK，命令见 [Android 文档](docs/ANDROID.md)。早期交付见 [交付报告](docs/DELIVERY.md)；0.1.3 的构建、测试和发布前视觉审查见 [本轮验收](docs/verification/release-2026-10-27/README.md)。

## 数据边界与后续开发

- [已确认需求—实现状态—证据表](docs/REQUIREMENTS.md)
- [架构与实现决策](docs/ARCHITECTURE.md)
- [人工验收与后续任务](docs/ACCEPTANCE.md)
- [原生格式覆盖表](docs/FORMAT-COVERAGE.md)
- [B 导出边界](docs/EXPORT.md)

必须保留的高风险目标包括：真实手写字符/符号到 A 笔迹的可验证映射、风格仿写、多设备真机手感/掌触/故障恢复、复杂原生格式完整往返、真实 Mac 公网同步、跨页人工定位、系统通知和桌面小组件。详细缺口逐项记录，不以“已支持笔记/同步/Office”等概括替代。

当前手机/Mac 客户端仍同步完整工程操作日志；已有独立 B 阅读快照，但尚未完成只拉取 B/局部预览的轻量网络通道。当前原生文本读写上限为每文件 16 MiB，图片导入覆盖 PNG/JPEG/WebP 且单张 10 MiB；完整工程导出另走持久分块流，不沿用源文本的 16 MiB 上限。附件分块同步和超大原生历史的单操作拆分仍是后续任务，容量边界见同步文档。

平板知识块可按已有段落拆分、合并及跨笔记关联，保留旧块身份的别名和结构档案；段内进一步切分和跨页人工落点仍需扩展。实现与验证见 [知识块管理](docs/BLOCKS.md)、[书写渲染测量](docs/ink-performance.md)。

源码按数据内核、持久化、自动化、复习、同步、格式、导出、原生适配与交互模块分开。新增格式/算法应加真实往返/行为证据，优先保护原稿和可迁移性。

命名与原地升级兼容约定见 [笺注 / Glossa 命名变更](docs/BRANDING.md)。旧 `.quietpaper` 工程仍可导入；数据库与加密身份保持兼容。

2026-10-22 界面视觉优化已在保留平台权限的前提下完成，空状态、导航、工具栏与排版调整见 [视觉变更说明](docs/VISUAL-REFRESH.md)。
