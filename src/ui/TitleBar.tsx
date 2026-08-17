import { platform } from "@/platform"
import VolumeControl from "./VolumeControl"

/**
 * E15：无边框窗口的自绘控制条。悬停才显现，不打扰画面。
 *
 * 只放窗口控制与音量。三个面板入口（播放设置/皮肤/混音）已经移到右侧栏
 * （`Sidebar.tsx`）—— 一条里混着"应用功能"和"窗口控制"两类东西，性质不一样。
 * 音量留在这儿没跟着走：它是个滑块不是按钮，塞进 44px 宽的竖栏交互会变形。
 *
 * 整条标记 data-keep-panel：点它是"调音量"或"控制窗口"，不是"点到面板外面去了"，
 * 不该触发关闭。
 */
export default function TitleBar() {
  return (
    <div className="titlebar" data-tauri-drag-region data-keep-panel>
      <VolumeControl />
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
