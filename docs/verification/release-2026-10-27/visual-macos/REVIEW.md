# 原生 Mac 视觉验证（GPT-6.1 Sol）

日期：2026-10-28。对象：0.1.3 候选和当前 `swift/Sources/Glossa`。没有修改产品源码、用户笔记、同步服务或发布状态。

## 证据边界

- `01-candidate-split.png`：父任务实际运行 `releases/v0.1.3/macos/Glossa.app` 导入示例后的包截图。本审查直接检查了该截图。
- 所有 `harness-*.png`：将当前 SwiftUI 文件复制到 `/private/tmp/glossa-native-visual`，复用 release GlossaCore 静态库，以 NSApplication + NSHostingView 原生渲染。每种状态独立 `/private/tmp/glossa-audit-*` 资料库，仅导入仓库 `examples/变化与积累.glossa`。不是候选包的逐项鼠标交互证据。
- 主内容状态使用 960×640 pt 内容窗口，额外保留原生标题栏；sheet 内容单独渲染时采用产品自身固定尺寸。`harness-settings-sheet.png` 使用 ContentView 真正的 SwiftUI `.sheet`，可见 sheet 超出最小父窗边界，但当前显示器上完整可见。
- A/B 默认模式仅在临时 NoteView 副本改为环境变量控制。原始产品源码没有改变。
- 系统辅助功能不可用，因此没有声称菜单、焦点、滚动、键盘和 VoiceOver 完整通过。没有长标题、超长标签、冲突详情或窄屏显示器压力测试。

## 结论

未发现已证实的 P1/P2 视觉阻塞。暖纸底、深墨文字、灰紫操作色在实际包主界面及多数原生视图保持一致。宋体展示标题与系统正文字体层级清楚；边栏、工具栏和内容分区对齐规整。960×640 主内容状态未见固定按钮被裁切、导航遮挡、文字重叠或水平溢出。

| 检查状态 | 证据 | 观察 |
|---|---|---|
| 实际包对照阅读 | 01-candidate-split.png | 原稿与结构分栏清晰，纸页/边栏/主背景区分克制 |
| 列表 | harness-library.png | 卡片和导入操作完整，单卡留白属于内容数量所致 |
| 首次空态 | harness-empty.png | 主导入操作、说明和底部文案完整可见 |
| 搜索无结果 | harness-search.png | 视觉完整；文案有轻微上下文问题，见 P3-02 |
| 温故 | harness-review.png | 队列、卡片和底部自评操作完整，层级清楚 |
| 校对无冲突 | harness-proof.png | 空态图标、标题、说明清晰 |
| 原稿 A / 结构 B / 对照 | harness-a.png / harness-b.png / harness-note.png | 工具栏完整；长纸页纵向超出视口属于滚动内容，并非裁切故障 |
| 修订编辑器 | harness-revision.png | 文本编辑区、取消、禁用保存清晰且完整 |
| 修订历史 | harness-history.png | 分块标题、日期、正文层级可辨 |
| 管理笔记 | harness-manage.png | 功能控件完整，但 grouped Form 白底与风格不同，见 P3-01 |
| 同步设置 | harness-settings.png / harness-settings-sheet.png | 固定页头页脚完整；中部滚动容器末行部分露出提示尚有内容 |
| 恢复副本 | harness-recovery.png | 副本名称、导出、恢复操作对齐且完整 |

## 发现

### P3-01：管理笔记面板出现大片系统纯白 Form 底色

证据：`harness-manage.png`。位置：`swift/Sources/Glossa/NoteView.swift:205-212`。

在暖纸外框中，系统 grouped Form 形成大块纯白矩形；三个字段集中上方，下面留下明显空白。与设置、修订、历史面板的暖纸连续背景不一致。属于视觉精致度问题，不阻止操作。最小修复：隐藏 Form 的系统滚动背景并明确纸色，按三个字段的实际内容收紧 Form 的垂直尺寸；如需更强一致性，可复用设置页的自定义字段行。此项是源渲染证据，候选包真实 sheet 尚未手动复核。

### P3-02：全库搜索无结果沿用了文件夹空态措辞

证据：`harness-search.png`。位置：`swift/Sources/Glossa/ContentView.swift` 的 `store.filteredNotes.isEmpty` 分支。

搜索“没有匹配结果”时标题为“这里还没有笔记”，说明包含“归入这个文件夹”，但当前是“所有笔记”。视觉布局正常，状态说明容易让人误以为库为空。最小修复：在搜索字符串非空时显示“没有找到匹配的笔记”和“试试其他关键词”；保留现有空文件夹文案用于文件夹状态。

## 尚需设备侧确认

SettingsView 固定 650×720 pt，超过 640 pt 最小父窗高度。当前真实 SwiftUI sheet 会向下超出父窗且在本显示器完整显示，因此不能将“高于父窗”本身认定为裁切缺陷。仍建议在可用高度较低的显示器上检查系统是否自动调整位置，以及取消/保存是否可达；若需明确支持低可用高度，可把面板高度限制到可用屏幕高度并保留内部滚动。

## 两项 P3 修复复查（同日追加）

重新复制 root 最新 ContentView.swift 与 NoteView.swift，重新编译同一原生 harness，仅复查管理和搜索。

- **P3-01 resolved**：`harness-manage-after.png`。columns Form 按内容收紧，大片纯白容器及无内容空白消失；标题、文件夹、标签、取消、保存完整，暖纸背景连续。文本输入框仍为原生白底，符合控件辨识需要。
- **P3-02 resolved**：`harness-search-after.png`。全库搜索无结果已显示“没有找到匹配的笔记”“试试其他关键词，或检查标题、正文与标签。”，字段、导航和状态正文完整，没有观察到布局回归。

After 两图采用 NSHostingView/NSView `cacheDisplay` 直接原生视图位图输出，不含窗口标题栏/阴影，也不证明真实包交互。原因：重试窗口截图时当前桌面合成器持续返回 Space/Mission Control 风格的倾斜缩略窗口，无法用于精确布局审查；未将系统变换误报为产品故障。原始 before 窗口截图保存为 `harness-*-before.png`，原有 `harness-manage.png` / `harness-search.png` 仍保留原始 before。`AuditAfter.swift` 为 after 位图入口，`Audit.swift` 为原始窗口截图入口。替换 REPRODUCE.md 中复制的入口即可复现 after（输出名带 `-after`）。

修复后本次原生视觉审查无待处理 P1/P2/P3。低可用高度显示器的设置 sheet 设备验证限制仍保持原结论。
