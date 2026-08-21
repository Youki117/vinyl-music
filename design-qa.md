# Design QA

## Comparison target

- Source visual truth:
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-0ad50b27-fc8e-4faf-bdf2-3d7b7c4c4756.png`（抽屉约占右侧三分之一）
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-af9c054e-ddb7-49a3-8a52-2a1aff6fb602.png`（曲目编号列）
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-84da495c-5c76-43ca-a10d-6a42beb3e46f.png`（原音质弹层）
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-0e517d2e-cb79-4395-973d-761561c0e73b.png` 与 `codex-clipboard-95106623-8100-4d99-ba73-79c4feb8f791.png`（曲库去重、排序与歌单工具）
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-30132aa7-6139-4271-9463-d3241dd3f35b.png`（底图选择与文案）
- Rendered native release implementation:
  - `artifacts/ui-library-tracks-final.png`
  - `artifacts/ui-library-toolbar-refined-final.png`
  - `artifacts/ui-skin-backdrop-history-final.png`
  - `artifacts/ui-quality-vertical-final.png`
- Combined comparison evidence:
  - `artifacts/qa-library-refined.png`
  - `artifacts/qa-skin-refined.png`
  - `artifacts/qa-quality-vertical.png`

## Capture normalization

- Application: native Tauri release executable, not a static HTML mock.
- Configured CSS viewport: 1280 × 708 logical px.
- Native WebView capture: 1723 × 953 physical px, approximately 1.346 device density.
- Source pixels: library 485 × 691, skin 536 × 671, quality 399 × 264.
- Combined evidence preserves each image's aspect ratio and normalizes to a common 700 px height (quality: 600 px). The source screenshots are annotated intent references rather than identical full-window states, so focused regions are compared by component proportion and hierarchy rather than false 1:1 pixel claims.
- States: populated “全部音乐” list with active row; saved-playlist empty state; background-image tab; open quality menu.

## Required fidelity surfaces

- Fonts and typography: passed. Existing CJK serif panel titles and sans-serif controls remain consistent. Search text, sort label, metadata, icon labels, and compact quality details remain legible without new wrapping regressions.
- Spacing and layout rhythm: passed. Drawers occupy the intended right-side band rather than full screen. Numbering uses a 20 px track instead of 42 px, the repeated current-view heading is gone, and the search/sort line has one compact rhythm. Four built-in backgrounds plus the choose tile share one five-column row.
- Colors and visual tokens: passed. New line icons, borderless sort controls, background picker, history thumbnails, and quality menu reuse the existing warm-black/gold token system.
- Image quality and asset fidelity: passed. Built-in backgrounds and focal preview retain original assets. Custom history stores a 160 × 100 JPEG thumbnail for the chooser while the stage continues loading the original image path.
- Copy and content: passed. “这里设的图” is now “背景图片”. Duplicate “全部音乐 / 当前歌单名” heading and the three repeated action buttons are removed; search placeholder still identifies the selected list.

## Interaction verification

- Native UI automation opened the right-rail library, skin, and quality states and the process remained responsive.
- Library search placeholder followed the selected list after the separate heading was removed.
- Import, create, and per-playlist export remain real buttons with accessible names and tooltips. Final native accessibility bounds show the playlist-name control taking the flexible width and the export icon remaining approximately 31 × 32 physical px instead of stretching to the full row.
- The duplicated “加文件 / 加文件夹 / 导出当前列表” buttons are absent. Folder import, playlist import/create/export, drag/drop, and store/platform actions remain in code.
- Quality menu expands as a 96 px CSS-wide vertical list and is centered over its trigger.
- Custom-background history parsing, de-duplication, newest-first order, invalid-entry filtering, and 12-item bound are covered by unit tests. AI-generated automatic artwork explicitly bypasses the manual-history list.
- Full verification: `npm test -- --run` → 26 files, 330 tests passed; `VINYL_BUNDLE_SOURCE=1 npm run build` passed; native NSIS bundle build passed.

## Comparison history

1. Earlier pass found P1 drawer width drift: the unified override grew all panels toward full screen. Fixed with a 34vw bounded drawer width and compact internal layouts.
2. Earlier pass found P2 list density drift: 42 px numbering plus 24 px row padding consumed title space. Fixed with a 20 px number track, 12 px row padding, and 6 px column gap.
3. Earlier pass found P2 quality-panel scale and alignment drift. Fixed by changing the 286 px two-column grid to a centered 96 px single column.
4. This pass found P2 playlist export hit-area drift: the generic side-group `width: 100%` selector overrode the icon width. Fixed with explicit select/export flex sizing; final native bounds confirm the export control no longer fills the row.
5. This pass found P2 background-picker placement drift: the same-size choose tile initially wrapped below four thumbnails. Fixed by using five equal columns, placing the four built-ins and choose tile on one row; the final capture confirms alignment.

## Follow-up polish

- P3: Native select menus retain Windows' platform dropdown rendering when opened; the closed sorting control is intentionally borderless and visually aligned with the direction icon.
- P3: Reference and implementation contain different real library content, so song names and counts intentionally do not match.

final result: passed
