# WebView SIGTRAP：定位到 V8 启动快照校验失败

调查时间：2026-10-22。这里只定位失败检查，尚未确定使校验失败的根因。未运行应用测试、未启动或操作模拟器；分析使用既有日志、提取的 ELF 片段及固定版本公开源码。

## 可确认的机器码事实

- 既有 Android tombstone：WebView 124.0.6367.219，x86_64，`CrRendererMain`，`SIGTRAP/SI_KERNEL`，模块相对 PC `0x17971cc`，BuildId `68dabd72c6088238cbfc9a5fbfe211f916771df5`。
- 输入 `/workspace/.quiet-paper-build/webview-fault-code.bin` 的映射起点为 `0x1796000`；`objdump -D -b binary -m i386:x86-64 --adjust-vma=0x1796000` 可复查以下指令。
- `0x17971cb` 是 `int3`，下一地址 `0x17971cc` 是 `ud2`。x86 `int3` 报告下一指令地址，与 tombstone PC 一致。这是主动失败检查的 trap，不是由缺失 AVX 直接产生的非法指令信号。
- `0x17970b3` 调用 `0x1797350`，`0x17970b8` 检查其布尔返回值，`0x17970ba` 在 false 时跳到 `0x17971cb`。
- 相邻的另一个失败分支 `0x1797132 -> 0x17971c8` 检查快照 rehashability 值是否小于 2；它不是本次 tombstone 指向的分支。

关键片段：

```text
179709f: call 37fe7b0       ; 对应 SnapshotImpl::CheckVersion(blob)
17970a7: call 17972d0       ; 对应 Snapshot::ShouldVerifyChecksum(blob)
17970ac: test al, al
17970ae: je   17970c0       ; 不需要校验则继续
17970b3: call 1797350       ; 对应 Snapshot::VerifyChecksum(blob)
17970b8: test al, al
17970ba: je   17971cb       ; 校验失败
...
17971c8: int3              ; 另一项 rehashability CHECK
17971c9: ud2
17971cb: int3              ; 本次失败 CHECK
17971cc: ud2
```

## 固定版本源码及对应关系

Chromium tag [`124.0.6367.219/DEPS`](https://github.com/chromium/chromium/blob/124.0.6367.219/DEPS) 将 `v8_revision` 固定为：

```text
1ecf7c4897c3ed68d65ac467cce5da142b495756
```

对应 V8 [`src/snapshot/snapshot.cc:176-200`](https://github.com/v8/v8/blob/1ecf7c4897c3ed68d65ac467cce5da142b495756/src/snapshot/snapshot.cc#L176)：

```cpp
bool Snapshot::Initialize(Isolate* isolate) {
  if (!isolate->snapshot_available()) return false;
  const v8::StartupData* blob = isolate->snapshot_blob();
  SnapshotImpl::CheckVersion(blob);
  if (Snapshot::ShouldVerifyChecksum(blob)) {
    CHECK(VerifyChecksum(blob));  // L182，与实际 trap 分支对应
  }
  // 接下来提取 startup/read-only/shared-heap 数据并 InitWithSnapshot。
}
```

这与上述调用顺序、返回值分支以及后面的三个快照数据提取调用完全对应。这里是源码与机器码结构对应，尚未使用该 BuildId 的完整符号文件做正式符号化。

`0x1797350` 的机器码进一步验证了校验含义：读取 `blob->data`，从其 `+8` 读取期望的 32 位校验值；将 `data+12`、`raw_size-12` 交给 `0x17973e0`，之后比较计算结果与期望值并返回布尔值。它对应 [`snapshot.cc:641-657`](https://github.com/v8/v8/blob/1ecf7c4897c3ed68d65ac467cce5da142b495756/src/snapshot/snapshot.cc#L641) 的 `GetExpectedChecksum`、`CalculateChecksum`、`VerifyChecksum`。

数据区间见 [`snapshot.cc:108-120`](https://github.com/v8/v8/blob/1ecf7c4897c3ed68d65ac467cce5da142b495756/src/snapshot/snapshot.cc#L108)。相邻函数 `0x17971d0` 用 64 字节版本字符串作比较，对应 [`snapshot.cc:164-173`](https://github.com/v8/v8/blob/1ecf7c4897c3ed68d65ac467cce5da142b495756/src/snapshot/snapshot.cc#L164) 的 `VersionIsValid`。本次实际失败分支发生在它之后的 checksum 检查。

## Adler32 的初始值与 Android 首次校验

[`src/snapshot/snapshot-utils.cc:23-26`](https://github.com/v8/v8/blob/1ecf7c4897c3ed68d65ac467cce5da142b495756/src/snapshot/snapshot-utils.cc#L23) 明确：

```cpp
adler32(0, nullptr, 0);  // 探测可用 CPU 特征。
return static_cast<uint32_t>(adler32(0, payload.begin(), payload.length()));
```

因此 host 验证应比较：

```python
expected = int.from_bytes(blob[8:12], "little")
actual = zlib.adler32(blob[12:], 0)  # 必须初始值 0，不能使用默认值 1。
```

这与 Crashpad 压缩流末尾的标准 zlib Adler 校验不同；后者仍按标准 zlib 流校验，不能用 V8 的 seed=0 去修正它。

[`src/snapshot/snapshot-external.cc:40-50`](https://github.com/v8/v8/blob/1ecf7c4897c3ed68d65ac467cce5da142b495756/src/snapshot/snapshot-external.cc#L40) 表明，Android 默认外部快照每进程首次使用时会执行一次校验。默认外部快照路径不单纯由 `verify_snapshot_checksum` flag 决定，因此不能假定关闭该 flag 就可绕开本检查，也不建议以绕开完整性检查作为产品修复。

## 尚待验证的根因

目前可以定位为“V8 在初始化 isolate 时计算出的快照校验值与快照头不同”。仍需区分：

1. APK 内快照自身损坏或与二进制不匹配。
2. APK/asset 的设备读取、映射或内存内容发生变化。
3. 本机 CPU 特征分派或 TCG 执行导致 Adler/SIMD 计算错误。

两次既有 Crashpad 日志经同版本 Base94 算法解码后，raw-deflate 可产生可解析 MDMP，但 zlib Adler 检查均失败。产物 `native-source.UNVERIFIED.dmp`、`earlier-android.UNVERIFIED.dmp` 和相应 JSON 保留了这一限制。它与 V8 失败共享 Adler 校验这一算法线索；不能据此断言两个现象一定同源，也不能把未校验 dump 当成完整可靠的崩溃证据。

TCG 启动日志关于 AVX/F16C 不可用的警告仅说明能力裁剪，尚不能直接证明 SIMD 计算错误。SwiftShader、导航竞态、应用业务逻辑也没有现有证据能解释本项快照 checksum mismatch。

### 后续取得的 host 校验证据

主代理在实际设备 APK 提取的 `assets/snapshot_blob_64.bin` 上完成 host 校验：头部期望值和 `zlib.adler32(blob[12:], 0)` 均为 `0x882b7eae`。这排除了该提取文件本身的 checksum 损坏；调查范围应转向实际运行时使用的 asset/区间、读取或映射内容与 CPU/算法执行。尚不能只凭 host 结果区分这些剩余原因。

主代理的新最小 WebView 探针只有一次 `load`，仍在 45 秒 page/report 等待超时，尚未获得 JavaScript 或 `onPageStarted/onPageFinished` 回调。这是另一条失败现象，不能在没有新 crash-PC 证据时直接认定它和旧 SIGTRAP 完全同因。

### 外部快照映射与重定位源码核查

固定 Chromium tag 的 [`gin/v8_initializer.cc:137-145`](https://github.com/chromium/chromium/blob/124.0.6367.219/gin/v8_initializer.cc#L137) 用 `MemoryMappedFile::Initialize(file, region)` 映射快照；[`memory_mapped_file.h:108-110`](https://github.com/chromium/chromium/blob/124.0.6367.219/base/files/memory_mapped_file.h#L108) 将该重载委托给 `READ_ONLY`，其 POSIX 实现 [`memory_mapped_file_posix.cc:69-95`](https://github.com/chromium/chromium/blob/124.0.6367.219/base/files/memory_mapped_file_posix.cc#L69) 使用 `PROT_READ`。

[`gin/v8_initializer.cc:71-75`](https://github.com/chromium/chromium/blob/124.0.6367.219/gin/v8_initializer.cc#L71) 把映射首地址和长度原样作为 `StartupData`，[`L488-493`](https://github.com/chromium/chromium/blob/124.0.6367.219/gin/v8_initializer.cc#L488) 传给 `SetSnapshotDataBlob`。V8 [`snapshot-external.cc:27-36`](https://github.com/v8/v8/blob/1ecf7c4897c3ed68d65ac467cce5da142b495756/src/snapshot/snapshot-external.cc#L27) 只复制这个指针/长度结构，未改写 payload；`Snapshot::Initialize` 又先校验，后解压/反序列化。

在此路径没有找到“为正常重定位而修改原始快照，随后故意使其原 checksum 失效”的步骤。正常的地址重定位/反序列化不能作为忽略本 CHECK 的理由。仍不排除错误映射区间、平台执行问题或未识别的内存破坏。

还应确认实际使用的 asset 名称：[`gin/v8_initializer.cc:84-113`](https://github.com/chromium/chromium/blob/124.0.6367.219/gin/v8_initializer.cc#L84) 区分 `snapshot_blob_64.bin` 与 `v8_context_snapshot_64.bin`；[`android_webview/lib/aw_main_delegate.cc:162-174`](https://github.com/chromium/chromium/blob/124.0.6367.219/android_webview/lib/aw_main_delegate.cc#L162) 按 `USE_V8_CONTEXT_SNAPSHOT` buildflag 注册相应文件。不能仅凭默认文件名假定实际 renderer 使用同一 asset。

## 最小下一步

1. 对实际设备 APK 的 `assets/snapshot_blob_64.bin` 在 host 比较头部 `+8` 与 `adler32(blob[12:], 0)`；保留来源、字节数与 SHA256。
2. 若 host 校验通过，优先比较实际 guest 读取字节与 host 字节，再针对同一 payload 比较 guest 标量与实际分派算法的校验值；这能区分数据问题与执行/分派问题。
3. 在已定位失败检查之前，不重复已通过的 NativeSourceStore 用例，不通过修改应用功能或关闭完整性检查伪装 WebView UI 验收通过。
