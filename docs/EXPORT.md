# 阅读导出与完整工程

已确认需求：B 忠实保留内容及其来源，只有 B 的设备也能阅读非文本对象；完整原生工程包另须保留可编辑 A、映射、历史和同步/复习信息。阅读导出不能代替恢复工程包。

实现决策：`src/export.ts` 提供纯函数 `exportStructuredMarkdown(note)` 和 `exportReadingHtml(note)`。两者生成当前单笔记的 **B 阅读快照**：知识块语义顺序、段落与公式原文、关系身份、note/block/segment/character/object 稳定身份，以及由已覆盖 A 对象生成的自包含 SVG 原稿引用。公式在 Markdown 中使用动态长度的 `math` 代码围栏，避免公式文本逃逸；HTML 保存为已转义公式原文，不依赖在线 TeX 渲染服务。

SVG 保留固定纸张位置，笔迹逐段使用压力换算宽度，可携带文字、公式、位图和有 points 的图形。SVG 是可读引用，**没有原始压力/倾斜/时间序列、图层操作、完整版本与同步元数据，不是可编辑 A 备份**。B 对应未验证时保留候选及“待校对”状态，不把候选认作精确映射。未知原生对象或不可接受的预览格式显示未覆盖标记，不创建不可用空链接。

安全边界：所有 HTML/SVG 文字与属性转义；颜色仅接受十六进制值；图像仅内嵌 PNG/JPEG/WebP/GIF 的 base64 data URL；未知 SVG、远程 URL、脚本和外部文件链接不作为活动资源载入。HTML 附带 CSP，禁用脚本、远程请求、表单及 base URL。该约束不改变完整原生工程包对原文件快照的保存。

已验证：`tests/export.test.ts` 五项测试覆盖稳定身份与公式保留、不同压力宽度、无 A 服务依赖的内嵌预览、未映射/未知对象、HTML/SVG 注入隔离、动态代码围栏、内嵌位图与修订层预览。

浏览器验证：`node --import tsx tests/export.browser.mjs` 在真实 Chromium 中另验证三项：文字/笔迹/位图可读，恶意标签与对象身份不会变成脚本、事件处理器、iframe、弹窗或外部请求，全部文档内源对象跳转可定位。环境策略禁止 `file:` 导航，因此测试以临时 `127.0.0.1` HTTP 仅传输这一个自包含文档；未将其写成真实文件双击打开或 Android 文件分享的验证成功。

限制与未验证目标：Markdown 查看器可能基于自己的安全策略过滤内嵌 SVG，完整离线预览应使用 HTML；HTML 公式原文尚无排版引擎；复杂化学结构、任意原生 Office/iWork 对象、录音播放、SVG 原始导入和依赖附件打包尚未覆盖。完整恢复使用 `NotebookEngine.exportProject()` / `NotebookEngine.importProject()`；它们与阅读导出是不同交付物，不能相互冒充。
