# Swift 原生 macOS 客户端

`swift/` 提供 **macOS 14 及以上**的 SwiftUI 应用。范围遵循工程现有 Mac 权限：阅读 A 原稿、修订已有 B 文字与公式、管理已有笔记和离线复习。Mac 不创建笔记、纸张、知识块，也不修改原稿或执行拆块/合块。iPhone/iPad 应用不在本次实现中。

Mac 端视觉修改默认针对此 Swift 原生应用，除非另行指定其他界面。

界面沿用暖纸底色与宋体主标题，正文及控件优先采用系统文字层级；侧栏通过背景、字重和辅助功能选中态共同标示当前位置。阅读工具栏会随可用宽度收起文字标签，图标仍有操作提示。定位、选中和按下反馈保持简短，尊重系统“减少动态效果”。这些调整仅作用于原生 Mac 界面，Android 平板仍保留其触控笔、系统返回与文件选择方式。

Mac 快捷键：`⌘F` 返回当前笔记列表并聚焦搜索，`⌘[` 返回原文件夹与搜索结果，`⌘1/2/3` 前往所有笔记、温故、校对，`⌃⌘S` 显示或隐藏边栏。编辑及设置弹窗显示时不执行底层页面导航。

窗口、导航、搜索、编辑器、纸张绘制、系统文件选择器、本地保存和网络请求均使用原生 API。数据内核在 JavaScriptCore 中执行现有 TypeScript 领域代码，既不载入 React 界面，也不使用 WebView。复用内核是为了保留原有稳定字符身份、冲突与印刷修订层语义，避免另造不兼容的数据模型。

## 构建和运行

需要 macOS、Apple Command Line Tools 的 Swift 5.9 或更新版本、项目现有 Node/npm 依赖。构建不需要 Android SDK、运行中的同步服务器或完整 Xcode。当前 CLT 的 macOS 27 SDK 声明了新 SwiftUI 宏却未附带对应插件；脚本检测到这一组合时使用本机已安装的 macOS 26.5 SDK。`GLOSSA_MACOS_SDK` 或 `SDKROOT` 可显式选择其他完整 SDK，前者优先；不会自动安装或修改系统 SDK。

```sh
npm ci
bash scripts/build-macos.sh
open releases/macos/Glossa.app
```

脚本先构建生产阅读端和共享内核，再编译不含调试符号的 Swift release、生成原生图标，并将独立 Node 24/SQLite 服务运行时与授权文本一同组装进 `.app`。输出为：

- `releases/macos/Glossa.app`：应用显示名“笺注”，可复制到用户选择的位置运行。
- `releases/macos/Glossa-macOS-arm64.zip`：Apple Silicon 构建归档；Intel Mac 本机构建生成 `x86_64` 归档。

默认只构建当前主机架构。应用使用本机 ad-hoc 签名，构建脚本验证签名；没有 Developer ID 公证，也没有 App Store 发布。分发到另一台 Mac 的 Gatekeeper 行为仍需另行验收。

开发运行可使用 SwiftPM：

```sh
node scripts/build-swift-core.mjs
export SWIFT_MODULECACHE_PATH=/private/tmp/glossa-swift-module-cache
export CLANG_MODULE_CACHE_PATH="$SWIFT_MODULECACHE_PATH"
# 当前 CLT 27 环境需要这一项；完整 Xcode/其他正常 SDK 无需设置。
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
swift run --package-path swift \
  --disable-sandbox \
  --sdk "$SDKROOT" \
  --cache-path /private/tmp/glossa-swift-cache \
  --config-path /private/tmp/glossa-swift-config \
  --security-path /private/tmp/glossa-swift-security Glossa
```

构建脚本使用 `/private/tmp` 保存共享编译缓存，工程内的 Swift 构建结果位于 `swift/.build/`。受管环境中不支持 SwiftPM 的嵌套 `sandbox-exec`，因此命令关闭 SwiftPM 自身的构建沙盒；宿主目录与网络权限仍然生效。它不会安装、启动或停止 Node 同步服务。

## 使用与数据

初次运行显示空资料库，可通过“导入工程”选择 `.glossa`、兼容的 `.quietpaper` 或 JSON 工程包。可以手动导入 `examples/变化与积累.glossa` 体验现有示例；应用不会在空资料库自动生成示例笔记。

导入恢复的是完整现有工程身份。替换已有工程前保留恢复副本；普通编辑在本地保存成功后才更新保存状态。完整工程导出保留原始 A/B、操作日志、映射、源快照、知识关系及历史；单笔记 HTML/Markdown 导出是阅读快照，不能替代工程备份。

默认本地目录为 `~/Library/Application Support/Glossa/`，不使用浏览器 IndexedDB，也不会自动迁移浏览器资料库。浏览器/Android 数据可通过完整工程导出导入或同步转入。`workspace.json` 同时保存工程与同步确认；`Recovery/` 保存替换/恢复前的资料库副本。单写者文件锁防止两个应用进程并发改写同一资料库。

开发和验收可显式隔离目录：

```sh
releases/macos/Glossa.app/Contents/MacOS/Glossa \
  --workspace /private/tmp/glossa-macos-check \
  --import "$PWD/examples/变化与积累.glossa"
```

`--import` 仅在该资料库首次创建时导入，避免重启覆盖现有工作。请为每次独立验收使用新的隔离目录。

服务器界面验收还可传入 `--server-home /private/tmp/glossa-server-check-home`，将服务器的应用支持目录及登录启动文件定位到该临时 home 下；默认仍是当前用户 home。此参数不自动初始化或启动服务。

## 同步

桌面 `启动笺注.command` 可直接打开本机构建。应用设置内的“管理这台 Mac 上的服务器”支持初始化、启停、工程与真实状态、独立运行、显式登录启动、自动/手动备份、校验和恢复；具体步骤见 [Mac 服务器管理](MACOS-SERVER.md)。服务器与客户端使用不同数据目录，初始化不自动接管旧服务。

在应用设置中填写自托管服务地址、访问令牌、工程标识及普通/端到端加密模式。空资料库可以按指定工程标识拉取既有工程；已有工程必须匹配身份。访问令牌保存在 macOS 钥匙串；加密口令只在当前会话内使用，重启后需再次解锁。

原生客户端使用 URLSession 访问现有 `/api/status` 与 `/api/sync`，后台服务仍是独立 Node/SQLite 进程，部署方法见 [同步文档](SYNC.md)。HTTPS 之外仅允许回环开发地址。游标、服务器世代和上传确认随成功合并的工程一起提交到本地文件；失败保留本地修改，前台运行时定期重试。

服务器重启或旧备份恢复后，客户端依据新的服务器世代重新校验完整不可变操作日志。端到端加密参数沿用现有协议，不能在密码错误时降级为普通同步。Mac 不会因同步服务器离线而将原生源快照冻结。

## 验证与边界

内核、持久化和协议的自动验证入口：

```sh
npm run test:swift
```

测试需要包含 Swift Testing 的 Swift 6 工具链；当前 Command Line Tools 已提供。脚本内的 `--disable-xctest` 避免要求完整 Xcode 的 XCTest 框架。本机原生自动测试 **19 项通过**，覆盖共享内核工程往返、权限、稳定字符修订、过期输入与事务回滚、复习、原子保存/恢复，真实 Node/SQLite 普通与 E2EE 互通、分页、413 分包和旧备份恢复，以及本机服务控制器与临时 AI 双向加密。原生窗口操作的实际执行结果另记在本次交付中；自动测试不代表互联网同步或长时间耐久验证已完成。

2026-10-22 已执行原生 **13/13** 项与现有工程 **145/145** 项回归，release `.app` 构建和完整签名校验通过。真实原生窗口已验证笔记列表、A/B 对照、含 emoji 的实际选区修订、印刷修订历史、离线自评、退出重开，以及系统保存/打开面板的完整工程往返和可见恢复副本。全部交互在独立临时资料库完成。证据与范围见 [原生 Mac 验收记录](verification/macos-native-2026-10-22/README.md)。

2026-10-23 增加服务器管理和临时授权 AI 代理，新增验证单列于 [服务器验收](verification/macos-server-2026-10-23/README.md)。临时转录使用逐对象、短期、可撤销的授权，结果仅供人工预览，不证明真实模型手写识别准确性。

原生 Mac 端不补齐工程本来尚未实现的目标：经过验证的真实手写识别与精确映射、仿手写生成、Office/iWork 无损往返、系统通知、小组件或轻量 B 专用网络通道。原生纸张展示不意味着 Mac 获得原稿编辑权限。同步仍传完整操作日志，容量限制沿用现有协议。

原生文件源保持在工程快照中；本次 Mac 客户端不冒称已实现 Android SAF 的动态源文件写回。跨公网 HTTPS、另一台实体设备、休眠唤醒、长期并发和分发公证仍须按 [人工验收](ACCEPTANCE.md) 分别验证。
