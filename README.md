# 笺注 · Glossa

本地优先的固定纸张笔记系统，当前版本为 **0.1 工程验证版**。工作区原为空，从零实现；没有复用或冒用此前 Quiet Editorial 的美术资源。界面重新设计为暖纸、深墨、灰紫工具与编辑式排版，默认进入原稿纸张。

这不是全部需求的最终完成版。当前交付包含可操作的客户端、Android 原生工程、Mac 自托管同步服务、可恢复数据内核和自动验收。**印刷文字修订层已实现；仿手写生成尚未实现。** Office、Keynote、Numbers 未实现，不能把文本往返或 PDF 截图算作这些格式的兼容。

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

## Mac 自托管服务

客户端与服务器是两个职责：阅读客户端可关闭，服务端仍可作为后台进程运行。

```sh
npm run build
export GLOSSA_TOKEN='替换为至少24字符的随机访问令牌'
npm run server
```

默认仅监听 `127.0.0.1:8787`，数据库在 `server-data/`。真实客户端在“设置 → Mac 同步”填写 HTTPS 地址、令牌及相同工程标识。空阅读端可以通过工程标识拉取既有工程；已有不同工程须先导入正确工程。端到端加密口令只保留当前客户端会话，重启需解锁；服务器拒绝混合模式与错误密钥。

局域网、互联网 HTTPS、Tailscale、Caddy、launchd、SQLite 一致性备份与恢复的完整步骤见 [同步文档](docs/SYNC.md)。这里提供的是可运行服务及部署配置；没有用户 Mac/域名访问条件时，不会把 Linux 的 HTTP 测试称作真实 Mac 公网验证。Mac 临时解密 AI 代理尚未开放。

## 当前操作闭环

- 平板“一张新纸”即创建固定纸张，无需先建知识块。支持 A4/B5/自定义比例、横竖、点阵/横线/方格/空白，手动加页。
- 钢笔保存位置、压力、倾斜、时间与图层；框选移动、局部橡皮、键盘文字/公式和图片可以混排。长按已有对象查看对应 B；B 菜单跳转至当前有效 A 修订。
- 停笔/离开笔记按变化对象增量整理。文字、公式、分类、几何、结构、复习有独立开关和状态。未配置识别服务时保留笔迹并进入校对，不会显示伪造识别结果。已有键盘文字可确定性提取。
- 已有 B 文字/公式以真实选区和稳定字符身份编辑，保存到操作日志。非重叠字符编辑合流，同一内容争用进入校对中的冲突预览。
- B 修订在原位置创建独立可编辑印刷层。平板“修订与历史”可独立撤销或明确确认不可逆合并；通用故障恢复历史仍保留。
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

Android 原生往返使用单独 instrumentation APK，命令见 [Android 文档](docs/ANDROID.md)。所有最终测试数量、通过/未执行和证据路径统一记录在 [交付报告](docs/DELIVERY.md)，避免把编译成功当作设备功能通过。

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
