# Independent ink visual review

Environment: macOS, headless Google Chrome 156.0.8078.48, Playwright, device scale factor 1. Run `node docs/verification/release-2026-10-27/visual-ink/audit.mjs` with Vite at 127.0.0.1:5173. This fixture uses synthetic points from the failing browser assertion; it does not access user notes. No source or existing test was modified.

## Observed result

The existing failure is reproduced exactly: oldArea 789, newArea 810, threshold disagreement 21 pixels, 21/789 = 0.026615969581749048 (>0.02). `metrics.json` contains all measurements. `comparison.png` shows both 3× nearest-neighbor pixels and native 1× rendering; old.svg/current.svg/diff.svg are standalone artifacts. Red diff pixels disagree at alpha >127; gray pixels differ only in alpha without crossing that threshold.

Visual inspection finds no displaced segment, missing cap, gap, abnormal join, or interior hole. At native size the silhouettes look equivalent. The current raster has slightly darker peripheral pixels in some diagonals; this is a real raster difference, but no opaque pixel in either raster becomes fully transparent in the other. Maximum alpha difference at 1× is 67/255; total absolute alpha difference equals 25.2078 fully opaque pixels spread along the perimeter. Thus “pixel identical” would be inaccurate; “no substantive visible contour regression found in this fixture” is supported.

| Raster scale | old area | current area | disagreement | relative difference | alpha absolute difference in paper pixels |
|---|---:|---:|---:|---:|---:|
|1×|789|810|21|2.6616%|25.2078|
|2×|3505|3506|7|0.1997%|14.1412|
|4×|13381|13380|5|0.0374%|5.4395|
|8×|53522|54263|791|1.4779%|3.8689|

The non-monotonic binary counts across scales show why a thresholded low-resolution pixel area is unstable. At every scale there are zero fully opaque-vs-transparent disagreements. Scaling here increases raster resolution while keeping the same 110×110 SVG geometry; it is not an actual-device test.

## Cause and disposition

Source inspection: old renders separate round-capped SVG strokes; current represents the same constant-pressure-width segment as two parallel lines plus semicircle arcs, combines subpaths under nonzero fill, and rounds coordinates to 0.001 paper units. The analytic capsule geometry is equivalent before rounding. Differences at the boundary are consistent with SVG stroke rasterization versus filled-path rasterization, overlap compositing, and tiny coordinate rounding. The evidence does not isolate a particular Chrome version as the cause: a previous-browser baseline was not run. Calling it a proven Chrome update regression would overstate the evidence.

No ink geometry change is justified by this screenshot. This issue alone need not block an engineering prerelease if the exact existing test failure is documented and a narrowly scoped visual waiver is accepted. It DOES block claiming the unmodified complete browser suite passes. It does not certify physical pen quality or every stroke geometry.

Minimum follow-up: retain the existing failure until deliberately replacing this one binary-alpha metric with an edge-tolerant geometric/raster comparison. Check disagreement distance to the reference boundary (e.g. <=1 native pixel), separately reject interior holes/missing or translated strokes, and validate the metric with deliberately broken positive controls. A supersampled/downsampled comparison can supplement it. Do not simply change 2% to 3%, and do not alter source geometry merely to satisfy one antialiasing boundary. Pinning the CI browser also improves reproducibility, but no prior pinned passing version has been established here.

## Handwriting style and editability: static review only

`src/handwriting.ts` captures only confirmed original same-page strokes. Normalization changes x/y and width relative to glyph height; object spread preserves pressure, tiltX, tiltY and time. Composition likewise transforms only x/y and width. Rendering uses pressure-dependent width (`inkRadius`), so preserving pressure affects the visible stroke. Tilt/time remain saved channels; no tilt-sensitive nib or dynamic time-driven rendering is implemented by `strokeOutline`. Claims of visually simulated tilt or human speed would be inaccurate.

Composition preserves each supplied glyph's aspect, color, relative strokes and pressure trace. Layout is deterministic: median supplied height (clamped 8–128), 0.16-size gap, 1.35-size line height, wrapping and up to 35% uniform shrinking. It reuses one selected sample per character. It does not infer unknown glyphs, add natural baseline variation, connect neighboring glyphs, or adapt pressure across a sentence. Documentation's “confirmed glyph vector imitation” and “deterministic layout” are accurate; a broader personal-style synthesis claim is not supported. Missing glyphs/insufficient bounds fall back to editable printed text.

`src/domain.ts` exposes separate revision IDs, revision stroke splitting with residual fragments in the same revision, undo and explicit merge. This supports the wording “independent editable vector revision layer” at the data-model level. This visual task did not repeat UI editing, sync/export, or undo integration tests and does not independently claim those passed. Existing docs/RECOGNITION.md appropriately distinguishes simulated bridge evidence and remaining physical-pen/style satisfaction assessment.
