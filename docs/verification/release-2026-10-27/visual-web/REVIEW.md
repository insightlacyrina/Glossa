# Web / Android viewport visual review

Reviewed the warm paper, dark ink and grey plum direction against VISUAL-REFRESH.md and BRANDING.md. All data came from isolated Chrome contexts and synthetic fixtures. No user library was read or modified. No product code was changed.

Main audit: 72 PNG screenshots, 76 metrics records (four error summaries), four viewports: Android tablet 1280×900 / 800×1100 and phone 390×844 / 360×640. Zero page errors and no document horizontal overflow. This verifies Chrome rendering with an Android bridge stub, not an installed Android WebView or physical stylus.

Covered: empty paper/review/proof/activity, populated library, original A / structured B / comparison, revision history, populated review/proof/activity, all four settings tabs, export/recovery. Long Chinese title and revised paragraph were included. Supplementary extra.mjs covers a genuine generated recognition candidate, proofreading dialog, selected-stroke glyph learning dialog at desktop and narrow widths, and model-check failure. Native recognition output itself is simulated.

## Findings

- P2: 800px tablet comparison remains side by side with the sidebar visible. The structured panel is approximately 233px wide; its header reserves space for history and review controls, leaving the title only a few Chinese glyphs per line. Formula dx also breaks to another line. Evidence: tablet-portrait-07-mode-2.png. Minimum change: switch Android comparison to a stacked layout at a wider breakpoint (around 1000px), or use available workspace width; alternatively wrap header controls onto their own row.
- P2: Settings explanatory body text uses `.dialog-stack > p { color: #8c726f; font-size:14px }` against modal #f9f5ed, computed contrast 4.06:1. Evidence: tablet-landscape-12-settings-识别与仿手写.png and phone-narrow-12-settings-识别与仿手写.png. Minimum change: deepen only this foreground to #7d6462 (4.99:1), retaining the palette. Android --muted #746462 already yields 5.16:1 against the modal, so changing the variable alone does not fix the hardcoded paragraph color. Main ink #3b343e is 11.06:1.
- P3: Phone recognition settings explain learning a glyph by selecting strokes without naming the tablet. Phone has no learning operation, so the explanation may imply a missing action. Evidence: phone-narrow-12-settings-识别与仿手写.png; RecognitionSettings.tsx final explanatory paragraph. Minimum change: say “在平板的纸张上框选…”.

No P1 found in the observed views. Typography, paper surfaces, primary actions and new recognition/glyph dialogs remain stylistically consistent. Narrow settings tabs scroll horizontally and can expose each selected tab; full-page screenshots naturally include page content below the viewport while the fixed modal scrim covers only the visible viewport.

Coverage limits: no real Android keyboard/IME, accessibility font scaling, physical-device safe areas, actual download/service outages, long unbroken URL stress or exhaustive settings validation combinations. Synthetic model failure covers message layout and retry affordance only.

## Post-fix verification

Root applied the three minimum fixes, then after-audit.mjs generated 108 new screenshots at 360, 390, 800, 1100, 1101 and 1280px. Original screenshots are retained; all new evidence has an after- prefix. after-metrics.json has 114 records including six error summaries, zero page errors and zero document horizontal overflow. after-extra.mjs regenerated four additional dialog screenshots.

Visual inspection confirms: 800px and 1100px comparison now stacks A above B, keeping block headings and the sample integral on a single line. At 1101px it switches to side-by-side: headings use sensible two-line wraps and the sample formula remains intact; 1280px retains the spacious side-by-side layout. Phone 360/390 remains stacked and usable. The exact breakpoint changes sidebar padding too, so visible density changes across 1100/1101 are expected, without overlap or clipping in the tested fixture.

Settings explanatory paragraphs now use #7d6462 against #f9f5ed, 4.99:1, and remain visually within the grey/plum palette. Phone text explicitly says “在平板原稿上框选”. The prior two P2 findings and P3 wording finding are resolved in this evidence. Stable recognition candidate, selected-glyph and narrow glyph dialogs retain their layout (after-extra-proof-candidate.png, after-extra-glyph.png, after-extra-glyph-narrow.png); synthetic model failure still exposes the retry action within the internally scrolling modal.

No new P1/P2 was found in the post-fix inspection. Device limitations and stress-state omissions above remain unchanged.
