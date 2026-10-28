# 文字识别与 B→A 仿手写

2026-10-27。完整原稿操作由 Android 平板提供，手机与 Mac 保持已有 B 编辑、阅读及同步权限。

## 使用

1. Android 平板打开“设置 → 识别与仿手写”，选择简体中文、繁体中文或英文，首次下载对应手写模型。图片识别模型随 APK 提供。
2. 书写停笔后生成候选；同一行相邻笔画一起识别，始终保留所有源对象 ID、版本和原始采样。进入“校对”核对文字并确认。继续添笔仍会产生候选，更新已有 B 段落，不自动创建重复段落。
3. 在原稿使用“框选与移动”，选中一个字的全部原始笔画，点击“学习选中字形”，输入该字符并确认。
4. 修订已有 B 文字。如果所需字形齐全且原位置能容纳，自动生成独立矢量仿手写修订层。新笔迹可移动、局部擦除，保留压力、倾斜、时间等采样通道，并可独立撤销、合并、同步与完整导出。
5. 缺字时先保留可编辑印刷层，说明所缺字符。补齐字形后自动重试；人工改动过的印刷层不会被自动替换，可在“修订与历史”显式重试。原稿已变化或跨页落点未知时先校对来源。

## 实现选择

- 数字笔迹直接使用笔画时序与位置，采用 [ML Kit Digital Ink](https://developers.google.com/ml-kit/vision/digital-ink-recognition/android)（19.0.0）；图片采用[内置中文 Text Recognition v2](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)（16.0.1，覆盖中英文）。笔记内容不上传到 Google，首次手写模型下载需要网络。
- 可选兼容视觉 API 使用实际 PNG 裁图与多模态 `image_url`，替代此前只有坐标 JSON 的请求。密钥与授权只在当前会话使用；撤销授权/切换工程会取消请求并拒绝迟到结果。
- 仿手写从用户明确确认的真实笔迹构建字形库，确定性排版并保留矢量采样。样本连同来源版本进入操作日志，导入时核对真实来源，支持跨设备重放。该方式适合保持用户已经提供的字形风格；不宣称能从几个字推断任意未知汉字，也没有未经语料验证的“最佳准确率”承诺。
- 不用坐标接近、模型高置信度或相同文字伪造字符映射。识别确认默认是对象级映射；公式不自动纠错，也不使用普通文字字形合成公式。组合字符、缺字、溢出与未定位跨页内容保留印刷层和具体原因。

## 验证命令

```sh
npm test
npm run build
npm run test:swift
CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tests/recognition.browser.mjs
node tests/recognition-flow.browser.mjs
```

Android 原生验收（专用模拟器、测试安装包）：

```sh
adb -s emulator-5556 shell am instrument -w -e mode recognition -e ink-model true local.quietpaper.test/local.quietpaper.NativeRoundTripInstrumentation
```

浏览器原生桥使用模拟识别结果验证分组、校对与反转写交互；它与 Android 的真实模型推理证据分别记录。真实中文手写、复杂公式、实体触控笔质量和用户风格满意度仍需要专门语料和设备评估。

本轮真实模型在线 29 项、离线 27 项通过，完整核心回归 185 项、Swift 20 项通过；既有笔迹轮廓像素检查仍有一项阈值失败，详细范围、日志与安装包信息见 [本轮验收](verification/recognition-2026-10-27/README.md)。
