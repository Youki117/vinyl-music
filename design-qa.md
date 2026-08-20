# Design QA

## Comparison target

- Source visual truth:
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-2c7aa449-0578-48dc-94db-76db3c650c1f.png` (online search)
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-21699cc9-b668-4245-b463-3379e8002a60.png` (playback settings)
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-68ea0aaf-fc6a-4f82-950f-b0dbd0b429aa.png` (mixer)
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-3ff5aa18-cbeb-4a25-b2b0-94403808b985.png` (skin editor)
  - `C:/Users/mstanjw/AppData/Local/Temp/codex-clipboard-d2ebe1fb-66c5-4fcb-ab00-de9e8f12e136.png` (library)
- Rendered implementation:
  - `artifacts/ui-online-results.png`
  - `artifacts/ui-settings-full.png`
  - `artifacts/ui-mix-full.png`
  - `artifacts/ui-skin-full.png`
  - `artifacts/ui-library-full.png`
  - `artifacts/ui-sidebar-full.png`
  - `artifacts/ui-quality-live.png`
- Combined comparison evidence: `artifacts/qa-search.png`, `artifacts/qa-settings.png`, `artifacts/qa-mix.png`, `artifacts/qa-skin.png`, `artifacts/qa-library.png`.

## Capture normalization

- Application: native Tauri development window.
- Configured viewport: 1280 × 708 logical px. The current monitor constrained the visible content to approximately 1280 × 630 logical px.
- Native WebView backing capture: 1920 × 945 px, normalized to 1280 × 630 px (1.5 density) for inspection.
- State: dark warm-gold theme; live online search results; actual current library; current track loaded; quality popover and right rail captured separately.
- The supplied references use narrow portrait drawer crops. Per the approved brief, only the drawer's internal visual language is authoritative; the existing landscape main stage and its component positions intentionally remain unchanged.

## Required fidelity surfaces

- Fonts and typography: passed. All drawer titles and section headings share the same CJK serif stack; controls and metadata share one UI sans stack with consistent weight hierarchy.
- Spacing and layout rhythm: passed. Headers, 18/24 px section padding, section separators, four-pixel radii, list-row height, and control grids are consistent across all drawers.
- Colors and visual tokens: passed. Every drawer, popover, context menu, sidebar tool, volume flyout, and layout editor uses the same warm-black, muted-text, gold-accent, border, active, and danger tokens.
- Image quality and asset fidelity: passed. Existing packaged backdrops are preserved at native quality; preview crops and focal-point behavior remain functional. No placeholder artwork was introduced.
- Copy and content: passed. Static mock values were replaced with real device, source, track, library, timer, EQ, AI, and error states. Existing functionality omitted by the mock remains available.

## Interaction verification

- Right rail hover exposed seven controls in the approved order.
- Search for `Sinos` returned 20 of 340 live results.
- Double-clicking the first online result loaded and played it; the row became active and the played item entered the library as designed. Playback was muted for the smoke test and paused afterward.
- Online quality changed from Standard to High while paused; the trigger updated to `高品` and the position remained at about 6 seconds.
- Keyboard navigation opened search, settings, mixer, skin, and library panels.
- Native development terminal showed no runtime error during these checks.

## Comparison history

1. Initial pass found a P2 header-width mismatch in tabbed and mixer drawers: the close control did not consistently align to the far right.
2. Fixed by making `.panel-header` explicitly stretch to full width and assigning automatic left margin to the close control.
3. Post-fix captures `ui-online-results.png` and `ui-mix-full.png` show the close control aligned with the common right edge. No actionable P0/P1/P2 findings remain.

## Follow-up polish

- P3: The implementation is intentionally wider and denser than the portrait mock because it preserves full EQ, playlist, mixer, and source-management capabilities in the real desktop viewport.
- P3: Search and library captures use real user data, so row copy and counts differ from the mock data.

final result: passed
