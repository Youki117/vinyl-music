import { useEffect, useState } from "react"

import { platform } from "@/platform"
import { usePlayer } from "@/store/player"

/**
 * E15：无边框窗口的自绘控制条。悬停才显现，不打扰画面。
 *
 * **只放窗口控制**。应用功能一律在右侧栏（`Sidebar.tsx`）—— 一条里混着
 * "应用功能"和"窗口控制"两类东西，性质不一样。音量是最后一个搬走的：它是滑块
 * 不是按钮，当初怕塞进 44px 竖栏会变形，后来做成"按钮 + 悬停飞出滑块"就解决了。
 *
 * 整条标记 data-keep-panel：点它是"调音量"或"控制窗口"，不是"点到面板外面去了"，
 * 不该触发关闭。
 */
export default function TitleBar() {
  /*
   * 全屏与最大化是**两件事**，这里两个按钮都要有。
   *
   * 最大化受"工作区"约束 —— Windows 会给任务栏留出那一条，所以最大化之后任务栏
   * 依然压在上面。真全屏（Tauri 的 setFullscreen）才会占满整块屏幕、盖住任务栏。
   * 早先只有最大化按钮，于是"全屏"这件事在界面上根本没有入口。
   */
  const [full, setFull] = useState(false)

  // 全屏也可能由 F11 或 Esc 触发（见 App.tsx），所以图标不能只跟着自己这个按钮走
  useEffect(() => {
    let alive = true
    const sync = () => {
      void platform.window
        .isFullscreen()
        .then((on) => {
          if (alive) setFull(on)
        })
        .catch(() => {})
    }
    sync()
    window.addEventListener("resize", sync)
    return () => {
      alive = false
      window.removeEventListener("resize", sync)
    }
  }, [])

  const close = () => {
    usePlayer.getState().pause()
    void platform.window.close()
  }

  return (
    <div className="titlebar" data-tauri-drag-region data-keep-panel>
      <span className="titlebar-spacer" data-tauri-drag-region />
      <button
        onClick={() => void platform.window.setFullscreen(!full).then(() => setFull(!full))}
        data-tooltip={full ? "退出全屏 F11" : "全屏 F11"}
      >
        <span className="titlebar-label">{full ? "退出全屏" : "全屏"}</span>
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          {full ? (
            // 四角向内：退出全屏
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              d="M4.5 1.5v3h-3m9 0h-3v-3m0 9v-3h3m-9 0h3v3"
            />
          ) : (
            // 四角向外：进入全屏
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              d="M1.5 4.5v-3h3m3 0h3v3m0 3v3h-3m-3 0h-3v-3"
            />
          )}
        </svg>
      </button>
      <button onClick={() => void platform.window.minimize()} data-tooltip="最小化">
        <span className="titlebar-label">最小化</span>
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path stroke="currentColor" strokeWidth="1" d="M2 6h8" />
        </svg>
      </button>
      <button onClick={() => void platform.window.toggleMaximize()} data-tooltip="最大化">
        <span className="titlebar-label">最大化</span>
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button className="close" onClick={close} data-tooltip="关闭">
        <span className="titlebar-label">关闭</span>
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path stroke="currentColor" strokeWidth="1" d="m2.5 2.5 7 7m0-7-7 7" />
        </svg>
      </button>
    </div>
  )
}
