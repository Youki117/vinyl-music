import { useEffect, useRef, useState } from "react"

import { engine } from "@/audio/engine"
import { formatTime } from "@/lib/format"
import { useLibrary } from "@/store/library"
import { usePlayer } from "@/store/player"
import { IconNext, IconPause, IconPlay, IconPrev } from "./icons"

/**
 * 迷你模式的界面。**不是把主界面缩小**，是另一套版式。
 *
 * 主舞台是 1243×688 的固定设计坐标系，整体 scale 到窗口大小 —— 缩到 380px 宽的话
 * 字号会掉到 4px，等于什么都看不见。所以迷你模式换成一条：封面 + 歌名 + 三个键，
 * 主流播放器的迷你窗都是这个形状。
 *
 * 窗口那一侧（尺寸、置顶、禁缩放、最小尺寸下限）全在 `platform.window.setMini` 里，
 * 这里只管画。
 */
export default function MiniPlayer({ onExit }: { onExit: () => void }) {
  const status = usePlayer((s) => s.status)
  const track = usePlayer((s) => s.current())
  const { toggle, next, prev } = usePlayer.getState()
  const playing = status === "playing"

  // 封面从曲库读，理由与 Disc 相同：曲库是唯一来源，它按 LRU 淘汰并 revoke 时
  // 这里会跟着变 null，而队列里那份副本会留下一个死 URL
  const cover = useLibrary((s) => (track ? (s.byId(track.id)?.cover ?? null) : null))

  /*
   * 进度。**底边那条线直接写 DOM，不进 state** —— 进度每秒变化几十次，
   * 每次都 setState 就是每秒重渲染几十次（engine.onProgress 的注释里写着这条原则，
   * 主界面的进度条也是这么做的）。时间文字只在整秒变了才更新，一秒一次。
   */
  const barRef = useRef<HTMLDivElement>(null)
  const [clock, setClock] = useState({ at: engine.currentTime, of: engine.duration })
  useEffect(() => {
    let lastSecond = -1
    return engine.onProgress((at, of) => {
      const pct = of > 0 ? Math.min(100, (at / of) * 100) : 0
      if (barRef.current) barRef.current.style.width = `${pct}%`
      const second = Math.floor(at)
      if (second !== lastSecond) {
        lastSecond = second
        setClock({ at, of })
      }
    })
  }, [])

  return (
    <div className="mini" data-tauri-drag-region>
      <div className="mini-art" data-tauri-drag-region>
        {cover ? <img src={cover} alt="" draggable={false} /> : <span className="mini-art-empty" />}
      </div>

      <div className="mini-meta" data-tauri-drag-region>
        <b title={track?.title}>{track?.title ?? "没有在放的曲目"}</b>
        <span title={track?.artist}>{track?.artist || (track ? "未知艺术家" : "")}</span>
        <span className="mini-time">
          {clock.of > 0 ? `${formatTime(clock.at)} / ${formatTime(clock.of)}` : ""}
        </span>
      </div>

      <nav className="mini-controls" aria-label="播放控制">
        <button onClick={() => void prev()} aria-label="上一首">
          <IconPrev size={16} />
        </button>
        <button className="play" onClick={toggle} aria-label={playing ? "暂停" : "播放"}>
          {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
        </button>
        <button onClick={() => void next()} aria-label="下一首">
          <IconNext size={16} />
        </button>
        <button className="mini-exit" onClick={onExit} aria-label="退出迷你模式" title="退回主界面 (Ctrl+M)">
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              d="M1.5 4.5v-3h3m3 0h3v3m0 3v3h-3m-3 0h-3v-3"
            />
          </svg>
        </button>
      </nav>

      {/* 进度是条底边细线，不占高度 —— 380×104 里每一像素都要省着用 */}
      <div ref={barRef} className="mini-progress" />
    </div>
  )
}
