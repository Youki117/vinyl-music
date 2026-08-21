# Design QA

## Comparison target

- Source visual truth:
  - `C:/Users/mstanjw/AppData/Roaming/Typora/typora-user-images/image-20260821100138764.png`（歌单标题行改为删除/新建，导入歌单位于歌单列表末尾）
  - `C:/Users/mstanjw/AppData/Roaming/Typora/typora-user-images/image-20260821091854870.png`（音源可用状态由文字改为绿点）
  - `C:/Users/mstanjw/AppData/Roaming/Typora/typora-user-images/image-20260821093510951.png`（底图轨道显示四张半并横向滚动）
  - `C:/Users/mstanjw/AppData/Roaming/Typora/typora-user-images/image-20260821092148595.png`（自动从底图取色改为开关）
  - `C:/Users/mstanjw/AppData/Roaming/Typora/typora-user-images/image-20260821094854513.png`（播放状态下标题组位置）
  - `docs/UI-REFINEMENT-BASELINE-2026-08-21.md`（编号越大越新的最终交互基线）
- Rendered native release implementation:
  - `artifacts/final-library-restored.png`
  - `artifacts/final-library-import.png`
  - `artifacts/final-online-two-tabs.png`
  - `artifacts/final-source-status-dot.png`
  - `artifacts/final-backdrop-four-half.png`
  - `artifacts/final-tint-switch.png`
- Combined comparison evidence:
  - `artifacts/qa-final-library-import-combined.png`
  - `artifacts/qa-final-source-status-combined.png`
  - `artifacts/qa-final-backdrop-combined.png`
  - `artifacts/qa-final-switch-combined.png`
  - `artifacts/qa-final-masthead-combined.png`

## Capture normalization

- Application: freshly rebuilt native Tauri release executable, not `目标效果.html` or a static web mock.
- Source pixels: library 1022 × 951, source status 449 × 683, backdrop strip 777 × 183, switch 437 × 693, masthead 774 × 722.
- Implementation pixels: final focused captures are 1289 × 714; the populated library capture is 1709 × 946.
- Combined evidence preserves aspect ratio and normalizes each pair to a common height. The user screenshots contain annotations and different app-window sizes, so comparison is by the named component, state, hierarchy and proportion rather than a false full-frame pixel match.
- States: populated library with restored custom playlists; platform-import empty state; online-search two-tab state; active-source state; backdrop tab; veil tab; playing masthead.

## Required fidelity surfaces

- Fonts and typography: passed. Existing CJK serif headings, gold display title and compact sans-serif panel copy are preserved. Playing state now puts the album in the same second-line slot as the idle subtitle; title, subtitle, third line and byline no longer collapse vertically when content is empty.
- Spacing and layout rhythm: passed. The drawer remains a bounded right-side panel. Playlist header icons share the same 24 px control size; per-row export controls are gone. The moved import form uses a full-width input followed by a compact platform/action row. The backdrop rail visibly shows four complete thumbnails plus half of the next tile.
- Colors and visual tokens: passed. Delete/new/import controls, import form, confirmation dialog, source status dot and switch all reuse the existing warm-black/gold tokens. The only new semantic color is the subdued green availability dot.
- Image quality and asset fidelity: passed. Built-in and remembered custom backgrounds continue using their real thumbnails; the stage and focal preview use the original selected image. No placeholder imagery was introduced.
- Copy and content: passed. Online retains only “在线搜索 / 音源管理”. “导入歌单” appears after the user playlists. Picker wording is “自定义” alongside the plus icon. The delete confirmation explicitly says songs and local files are not deleted.

## Interaction verification

- Keyboard shortcut `P` opened the final library build with an empty search input; `F` opened online search with an empty search input. The shortcut letter is no longer inserted into the newly focused field.
- The restored custom playlists render as “我喜欢 465” and “老歌 0”; the track library remains 471 items and the active view is “全部音乐”.
- Clicking the list-level “导入歌单” entry opens the migrated platform parser inside the library main area. Its input, automatic/manual platform selection, parse button, preview/list, play-all and import callbacks remain connected to the single online store implementation.
- Online search displays exactly two tabs. Source management displays one green availability dot instead of the old visible status text; its accessible label and CSS hover/focus tooltip retain the explanation.
- The backdrop rail is non-wrapping, hides its scrollbar, converts usable mouse-wheel movement to horizontal scrolling, and releases vertical scrolling at either end.
- “自动从底图取色” renders as the established switch control and preserves the existing checkbox state/handler underneath.
- Playlist deletion is available only when a user playlist is selected and opens an application-styled `alertdialog`; Escape/cancel close it, while confirmation calls the existing delete action. Store regression coverage verifies that deletion keeps all tracks and returns to “全部音乐”.
- During native coordinate QA, the confirmation action was accidentally activated. The 471-track library was unaffected; “我喜欢” was reconstructed from the authoritative QQ playlist `4010674675` as 465 ordered IDs, “老歌” was restored empty, and the accidentally changed like state was also restored. The final configuration was re-read after the app stopped and matched those counts.
- Verification: `npm test` → 27 files, 333 tests passed; `VINYL_BUNDLE_SOURCE=1 npm run tauri build` → release executable and NSIS installer built.

## Comparison history

1. P1: platform playlist import still lived under Online and duplicated the library task boundary. Fixed by extracting one `PlaylistImport` view, removing the Online tab, and mounting that view from the library list entry.
2. P1: playlist deletion was a direct text action and per-playlist export buttons remained. Fixed with one disabled-aware trash button in the header, an application-styled second confirmation, and removal of per-row export UI.
3. P2: the first horizontal-background implementation showed closer to four and one-quarter tiles at the narrow drawer width. Fixed with `calc(22.222% - 5.333px)`, which accounts for four 6 px gaps and yields exactly four and a half visible card widths; the final native capture confirms the half tile.
4. P2: a long source name wrapped beside the new status dot. Fixed with a flexible, ellipsized one-line source label; the final native capture keeps the dot aligned at the right edge.
5. P2: the migrated import parse action initially read as floating text. Fixed by giving it the same minimal border, background and hover states as the surrounding panel controls.
6. P2: panel shortcut keydown mounted an autofocus field before the browser default completed, inserting `p`/`f` into that field. Fixed by preventing the default for panel shortcuts; final native captures show empty fields.
7. P2: playing masthead content used a different DOM flow from the idle text and moved the album upward. Fixed with persistent DOM slots and absolute vertical anchors; the final masthead keeps the album and byline aligned with the intended reference positions.

## Follow-up polish

- P3: Native `<select>` dropdown menus still use the Windows/WebView platform popup when expanded; closed controls match the panel design.
- P3: The reference and final implementation contain different live tracks and artwork state, so names, progress and liked state in the comparison images are not fidelity targets.

final result: passed
