# 原生 Mac 界面微调

参考 Apple 官方 [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)、[Typography](https://developer.apple.com/design/human-interface-guidelines/typography)、[Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[Motion](https://developer.apple.com/design/human-interface-guidelines/motion)。保留既有暖纸视觉、隐藏标题栏及透明同步设置，未引入新的主界面装饰。

- 调整标题、正文、辅助文字与留白，主要阅读和设置辅助文字至少 11pt；次要文字在三个基础底色上的计算对比度为 4.56–5.20。
- 侧栏与复习内容有明确选中反馈，打开笔记时保留所属栏目；顶部显示当前文件夹名称。
- 原生分段控件保留；阅读工具栏提供文字与图标两种适应宽度的布局。
- 动画限于 0.10–0.16 秒的反馈和定位，读取系统减少动态效果设置。纸张没有新增全局动画。
- 普通打开清理旧知识块焦点；关联跳转后返回保留列表上下文；导入、恢复成功后重置旧导航条件。

本轮在 `/private/tmp/glossa-native-hig-20261023` 独立资料库导入仓库示例，实际使用原生窗口检查：

1. 数学文件夹搜索“积累”，打开笔记并跳转关联知识块，`⌘[` 返回后仍是数学文件夹及原关键词。
2. `⌘F` 后可直接输入；`⌘2` 进入温故且侧栏同步高亮。
3. 修订弹窗内输入临时草稿，再按 `⌘1`、`⌘2`、`⌘F`、`⌘[`，弹窗和草稿保持；撤销临时输入后取消，未保存正文变更。
4. 通过系统窗口菜单缩至应用最小宽高，阅读工具栏和温故的两枚 100×38 自评按钮完整可见。
5. 显示菜单可隐藏和恢复边栏；最终版的 `⌃⌘S` 也已实际确认可以双向切换。

release 构建、应用签名校验通过。Android 与共享前端的 59 个受跟踪文件通过修改前后 SHA-256 比对，且与当前 Git HEAD 无差异。本轮未重跑此前文件桥、SAF、同步及真实手写验证；减少动态效果分支按实现核查，未更改用户系统设置；不据此声称整应用所有辅助功能或所有窗口尺寸已经完整验收。
