# Exact WebView SIMD code: host / Android TCG comparison

2026-10-22. This is a new CPU execution diagnostic for the unresolved WebView crash, not a product acceptance test. No repository, original ELF, emulator configuration, CPU flags or snapshot checks were changed.

## Results

All paths used the same 74,097 payload bytes, `snapshot_blob_64.bin[12:]`, with initial Adler value 0.

| Path | Adler32 |
| --- | --- |
| Snapshot header, little-endian offset 8 | `0x882b7eae` |
| Independent Java scalar on Android | `0x882b7eae` |
| Original Android bundled Adler, rolling seed with calls <=32 bytes | `0x882b7eae` |
| Original Android bundled Adler, whole payload | `0xb2987c76` |
| Independent Python scalar on host | `0x882b7eae` |
| Host zlib, seed 0 | `0x882b7eae` |
| Exact same Android ELF SIMD leaf machine code executed directly on host | `0x882b7eae` |

The Android values come from `/workspace/.quiet-paper-build/android-bundled-adler-chunked.log`. The host result and complete guards are recorded in `host-simd-adler.json`.

## Correct entry and static closure

The requested candidate `0x1798a90` is not the SIMD Adler entry in this exact ELF: it lies inside another inflate function and that larger function has allocation, memcpy and indirect external dependencies. It was never executed by the host diagnostic.

Actual call chain:

```text
0x3f8f260: zero-extend edx, then jump to 0x1797430
0x1797430: original Adler dispatcher
0x1797439: compare length with 64
0x1797446: compare feature global with zero
0x179744e: direct call to 0x1797790
```

The inspected SIMD function occupies `[0x1797790, 0x1797998)`. Its 144 instructions have:

- No calls, indirect branches, PLT/GOT accesses, TLS accesses, syscalls or traps.
- All branches landing on decoded instructions inside the inspected function.
- Exactly three RIP-relative read-only constants: `0xcff770` (16 bytes), `0xcfb3b0` (8 bytes) and `0xd029b0` (16 bytes).
- No relocation targeting its code or these constants, after checking all 412,805 ordinary ELF RELA entries.
- An SSE4.1 `pmovsxbw` instruction in addition to SSSE3 instructions. The host guard therefore requires both SSSE3 and SSE4.1 on every visible CPU.

The complete disassembly is `host-simd-static-disassembly.txt`.

## Execution method and hard identity guards

The portable tool `android/tools/host-simd-adler.py` first verifies:

- ELF SHA256 `e154b524119b6670b824d3e11a1794bf32e4a497aef18ed5d76fbe6e01d4eded`.
- GNU Build ID `68dabd72c6088238cbfc9a5fbfe211f916771df5`.
- Snapshot SHA256 `f10aada9cfd5446cb0036ecb879f7262189e0ddeadaaeef33e1b236d49da6d48` and size 74,109 bytes.
- ELF64, little-endian, x86_64, expected bounded PT_LOAD layout and code/constant closure.
- Host x86_64 CPU capabilities SSSE3 and SSE4.1; observed host model `INTEL(R) XEON(R) PLATINUM 8573C`.

Only after these checks does an isolated Python subprocess anonymously reserve 109,428,736 bytes, copy every PT_LOAD segment to its ELF virtual offset, retain zero-filled BSS, set segment memory protections, and call the leaf entry through `ctypes` with the System V x86_64 signature `(uint32_t, const void*, size_t) -> uint32_t`.

The Android ELF is not dlopened; its constructors and relocations are not executed. Host libc is used only for `mprotect`. No original file is modified and no global feature flag is set. The isolated child completed with exit status 0. The parent imposes a 30-second timeout and the child disables core dumps.

Reproduction:

```sh
python3 android/tools/host-simd-adler.py \
  --elf /path/to/lib/x86_64/libwebviewchromium.so \
  --apk /path/to/original-webview.apk \
  --output-dir /path/to/diagnostic-output
```

Run from the repository root on Linux x86_64 with Python 3 and GNU `objdump`. All three paths are required; the child receives the same explicit input and output paths. The ELF and APK must contain the exact guarded artifacts above. The output directory receives `host-simd-adler.json`, `host-simd-static-disassembly.txt` and `host-simd-child.stderr`; neither input file is changed. This command intentionally executes the diagnostic and was not rerun when the tool was added to the repository.

## Conclusion and limits

The exact SIMD algorithm and its static constants produce the expected checksum on the host CPU. The original bundled whole-payload call in the current Android x86_64 TCG environment produces a different checksum, while the same function's short-call path produces the expected checksum. This sharply narrows the existing startup failure to the current environment's execution of the SIMD path, rather than the snapshot file, application JavaScript or the algorithm universally returning that value.

This does not identify the precise failing emulated instruction, prove that all possible runtime code/constant corruption has been excluded, or establish that another WebView version or a physical Android device works. It also does not validate Glossa's WebView UI or convert any prior blocked UI acceptance into a pass. The natural renderer-exit observation is separate evidence and is not required for this checksum comparison.
