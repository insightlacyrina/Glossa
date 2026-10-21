# Ink rendering measurement — 2026-10-20

Implemented in `src/ink.ts` and `src/Paper.tsx`. This is a development-browser measurement, not Android pen-latency certification.

The previous renderer created one SVG `<path>` per consecutive pair of samples. A 1,000-stroke page with 60 samples per stroke therefore used 59,000 path elements. The current renderer creates one compound path per stroke. Its closed capsule subpaths retain the previous renderer's per-segment average-pressure width and round caps. Pressure is not quantized. Display coordinates round to 0.001 paper units; all original coordinates, pressure, tilt and timestamps remain unchanged in editable A and project exports. This visual approximation does not claim mathematically lossless rendering.

`ObjectView` is memoized, and generated paths are cached through React `useMemo`. Historical stroke objects retain identity during local append, so live trail updates do not regenerate their path strings.

Measured using `node tests/ink.browser.mjs` against a running Vite app and local headless Chromium:

| Measurement                              |                                                               Observed |
| ---------------------------------------- | ---------------------------------------------------------------------: |
| Editable strokes                         |                                                                  1,000 |
| Original point samples                   |                                                                 60,000 |
| Ink path elements                        |                                                                  1,000 |
| Total SVG descendant elements            |                                                                  2,009 |
| Reduction in ink path elements           |                                                                 98.31% |
| Compound path string characters          |                                                              6,814,160 |
| Initial render after harness preparation |                                 263.8–294.6 ms in two development runs |
| Live input                               | 20 real Playwright mouse movement steps; stroke committed and rendered |
| Page exceptions                          |                                                                      0 |

A representative live input action took 682 ms including browser automation, event delivery, twenty movement steps and assertions. It is not a measured frame time or stylus latency. A separate browser raster check compares a pressure-changing, turning stroke with the previous renderer: 4 of 791 previously covered pixels differed at the 50% alpha contour (0.51%). This is a contour check at one scale, not a general image-equivalence guarantee.

The remaining path geometry is still large; device-specific Android profiling and canvas/native rendering remain worthwhile follow-up work.

The final unified browser run on 2026-10-21 measured 335.7 ms for the same initial render and 834 ms for the entire live automation action, with 1,000 ink paths and 2,009 SVG descendants. These wall times vary with the execution host and remain browser measurements, not physical pen-latency evidence. The actual output is preserved in `docs/verification/browser.log`.

Reproduce with `npm run dev` and `node tests/ink.browser.mjs`. Override `QP_TEST_URL` or `CHROMIUM_PATH` when necessary. The managed sandbox requires a browser-capable execution context for Chromium's local sockets. Geometry checks run with `node tests/ink.test.ts` or the main test command.
