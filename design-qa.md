# Design QA — 标题区与本轮四项修改

## Comparison target

> **截图证据未随仓库保留。** 本轮比对用到的参考图与实现截图都只存在于当时的
> 工作机上：参考图在 `design-ref/`（按 §4 约定不入库），实现截图在 `artifacts/`
> （同上），用户当轮补充的那张来自系统剪贴板临时目录，早已随系统清理消失。
> 这些文件曾以绝对路径写在本文件里，对任何 clone 下来的人都是死链，因此改为
> 只记录**比对了什么、结论是什么**。下面的结论已是定稿，不依赖截图复现。

- Source visual truth：`design-ref/` 里的目标稿（标题、品牌行、年份与黑色署名条的
  原始比例和坐标），外加用户本轮提供的一张参考图。
- Initial native implementation：改动前的标题区，以及排序弹层的收起态与展开态。
- Previous native implementation：最终 64 px / `117` 两处调整之前的标题区。
- Previous focused comparison evidence：参考图与实现的标题区叠放对比。
- The final two-token adjustment is source-, test- and release-build-verified; no replacement screenshot was captured before packaging.

## Capture normalization

- Application: Tauri development executable with the current working-tree implementation and real library state.
- Native window capture: 1431 × 792 physical pixels.
- Source title crop: 600 × 200 pixels from the 1536 × 688 reference, after excluding the left letterbox.
- Implementation title crop: 1200 × 400 physical pixels normalized to 600 × 200 because WebView `PrintWindow` output is double-density for this display.
- State: playing `【FREE】 lucky`, artist `FuGa pang`; the source uses decorative copy, so comparison targets position, hierarchy, typography and truncation behavior rather than literal track text.
- The full app states were inspected separately; the focused stacked comparison is used for the title because that is the only region expected to match the supplied reference in this task.

## Required fidelity surfaces

- Fonts and typography: passed. Song titles now use one fixed 64 px display size. `MYRIAD AUDIO` is fixed at 33 px, `117` at 18 px and the artist label at 10 px. Long titles use a single-line ellipsis instead of dynamic font shrinking.
- Spacing and layout rhythm: passed. The title group is restored to the reference anchors (`26/2`, subtitle at 115 px, year at 149 px, byline at `165/152`). The byline is again a sibling component so custom layout can move it independently.
- Colors and visual tokens: passed. Main-stage text continues to use the skin accent; the artist remains white on a flat black label. The sort menu uses the existing warm-black/gold panel tokens.
- Image quality and asset fidelity: passed. No image assets were replaced or generated; existing background and record artwork remain unchanged.
- Copy and content: passed. The second line is always `MYRIAD AUDIO`; fallback content is `歌名` and `歌手名`, while real track title and artist replace those fallbacks during playback.
- Symbols and truncation: passed. Leading paired tags such as `【FREE】`, `[Live]`, `（纯享版）` and `《翻唱》` keep both delimiters visible. The following title text is ellipsized independently. Full-width brackets receive optical sizing and side-bearing correction without changing the fixed title size.
- Settings consistency: passed. The former editable skin-copy fields no longer present controls that cannot affect the now-fixed title contract; the tab shows the live title mapping and keeps automatic color control available.

## Other requested changes

- Sidebar component gap: passed. The actual rail layout uses `gap: 5px`.
- Quick background switcher: passed. The visible control is a 10 × 10 px hollow circle (one third of the former 30 px size) with a 26 px effective hit area and explicit keyboard focus feedback.
- Playlist sort control: passed. The closed state is a hollow circle; clicking opens the frameless, warm-black/gold option list. The popup stayed inside the drawer, selection styling matched the theme, and the original sort-direction control remained independent.
- Sort accessibility: passed. The popup is exposed as a labeled button group rather than an incomplete ARIA menu; the active option uses `aria-pressed`, Escape closes the popup, and focus returns to the trigger after selection.

## Comparison history

1. P1: the pending implementation replaced the original absolute composition with a 46 px flex column. This materially reduced the title and changed all vertical relationships. Fixed by restoring the reference anchors and a fixed type scale; the final user-approved title size is 64 px.
2. P2: the artist label was nested inside the masthead, causing the custom-layout masthead offset to move the artist label too. Fixed by restoring the byline as a sibling with its own `data-part="byline"` offset.
3. P2: a fixed-size title could truncate `【FREE】 lucky` as `【FREE…`, losing the closing symbol. Fixed by parsing a leading paired tag into a protected visual unit and ellipsizing the remaining title separately.
4. P2: full-width opening brackets carried a large left side-bearing at display size, making the title appear shifted right. Fixed with punctuation-only optical sizing and a side-bearing correction; the final focused comparison aligns the visible title edge with the reference.
5. P2: the custom sort popup used `role="menu"` without the corresponding complete menu interaction contract. Fixed by retaining native buttons in a labeled group and adding Escape/focus-return behavior.
6. P2: the skin “文案” tab still exposed four editable values after the title contract became fixed, creating controls with no visible effect. Fixed by replacing those inputs with a read-only mapping of current song, brand line and current artist; stored legacy skin data remains untouched for compatibility.

## Verification

- `npm test` → 28 test files, 341 tests passed.
- `npm run build` → intentionally blocked by the repository guard because `src/source/builtin/qdy.js` is present.
- `$env:VINYL_BUNDLE_SOURCE='1'; npm run build` → passed; 772 modules transformed (local-source build check only).
- Temporarily excluding the ignored local `qdy.js`, then `npm run tauri build` → passed; 771 modules transformed and the NSIS x64 installer was produced without bundling the private source script.
- `git diff --check` → passed.
- Build produced only the existing large-chunk warning and browser `vm` externalization warning; neither failed the build.

## Follow-up polish

- P3: the live title differs from the reference word `FASHION`, so exact glyph widths cannot match; the fixed type scale, left edge and four-level vertical rhythm are the fidelity targets.

final result: passed
