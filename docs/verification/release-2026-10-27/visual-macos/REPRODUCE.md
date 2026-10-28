# 原生源渲染复现

从仓库根目录执行。需要已构建 `swift/.build/release/libGlossaCore.a`、swiftmodule 和资源 bundle，以及当前 macOS 的 Xcode Command Line Tools。仅建立独立临时资料库。

```sh
mkdir -p /private/tmp/glossa-native-visual
cp swift/Sources/Glossa/*.swift /private/tmp/glossa-native-visual/
rm /private/tmp/glossa-native-visual/GlossaApp.swift
cp docs/verification/release-2026-10-27/visual-macos/Audit.swift /private/tmp/glossa-native-visual/
cp -R swift/.build/release/Glossa_GlossaCore.bundle /private/tmp/glossa-native-visual/
xcrun swiftc -sdk "$(xcrun --show-sdk-path)" -module-cache-path /private/tmp/glossa-visual-swiftcache -I swift/.build/release -L swift/.build/release -lGlossaCore /private/tmp/glossa-native-visual/*.swift -o /private/tmp/glossa-native-visual/audit
AUDIT_MODE=manage /private/tmp/glossa-native-visual/audit --workspace /private/tmp/glossa-audit-reproduce-manage --import "$PWD/examples/变化与积累.glossa"
```

入口输出到本机当前仓库绝对路径 `docs/verification/release-2026-10-27/visual-macos/harness-MODE.png`；其他机器需替换 Audit.swift 内截图路径。可用模式：library、empty、review、proof、search、note、settings、settings-sheet、recovery、manage、history、revision。empty 请使用新资料库且不传 `--import`。截图需可访问当前图形会话，受沙箱限制时运行失败不能视为产品失败。不要同时操作 Mission Control、切换 Space 或最小化审核窗口，否则窗口截图会捕获系统动画。

初次 A/B 截图仅在临时 NoteView.swift 中把 `@State private var mode = "split"` 替换为按 `AUDIT_MODE` 为 `a` / `b` 选择相应字符串的表达式。产品文件保持原样。最终 P3 复查重新复制了最新产品 NoteView.swift，因此所存最终 harness 入口仍可运行 a/b 路由，但须做此临时默认模式替换才能复现 A/B。

harness 是直接设置状态和原生渲染的审查工具，不是候选包自动化交互测试。
