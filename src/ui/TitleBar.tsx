import { platform } from "@/platform"
import VolumeControl from "./VolumeControl"

/** E15：无边框窗口的自绘控制条。悬停才显现，不打扰画面。 */
export default function TitleBar({
  onOpenPlayback,
  onOpenSkin,
}: {
  onOpenPlayback?: () => void
  onOpenSkin?: () => void
}) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <VolumeControl />
      <button className="tb-tool" onClick={onOpenPlayback} aria-label="播放设置" title="播放设置 (E)">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            d="M4 7h10M18 7h2M4 12h3M11 12h9M4 17h8M16 17h4"
          />
          <circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="14" cy="17" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      <button className="tb-tool" onClick={onOpenSkin} aria-label="皮肤设置" title="皮肤设置 (S)">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            d="M4 16.5 13 7.5l3.5 3.5-9 9H4z"
          />
          <path fill="none" stroke="currentColor" strokeWidth="1.6" d="m15 5.5 3.5 3.5" />
        </svg>
      </button>
      <span className="titlebar-spacer" data-tauri-drag-region />
      <button onClick={() => void platform.window.minimize()} aria-label="最小化">
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path stroke="currentColor" strokeWidth="1" d="M2 6h8" />
        </svg>
      </button>
      <button onClick={() => void platform.window.toggleMaximize()} aria-label="最大化">
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button className="close" onClick={() => void platform.window.close()} aria-label="关闭">
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path stroke="currentColor" strokeWidth="1" d="m2.5 2.5 7 7m0-7-7 7" />
        </svg>
      </button>
    </div>
  )
}
