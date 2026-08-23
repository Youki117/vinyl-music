import { useEffect, useRef, useState } from "react"

import { formatTime } from "@/lib/format"
import { usePlayer } from "@/store/player"
import { IconTrash } from "../icons"
import { useDismiss } from "../useDismiss"

/**
 * 播放队列抽屉。
 *
 * 队列一直是有的 —— `playNext` / `appendToQueue` 早就能往里塞歌（右键菜单里那个
 * 「下一首播放」就是），但**没有任何界面能看见它**：塞进去就找不着，既不能调顺序
 * 也不能删。`removeFromQueue` / `clearQueue` 在 store 里躺着没有一个调用方。
 * 这个面板就是补上那一半。
 *
 * 与曲库面板的分工：**曲库是「我有什么」，队列是「接下来放什么」**。同一首歌
 * 可以在曲库里只有一份，却在队列里排在第 3 位 —— 所以两边不能共用一个列表，
 * 删队列里的一条也不该动曲库。
 */
export default function Queue({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const { playAt, removeFromQueue, moveInQueue, clearQueue } = usePlayer.getState()

  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)

  /*
   * 打开时把正在放的那一行滚进视野。队列长起来之后，开面板第一眼看到的是第 1 首，
   * 而人想看的永远是"现在放到哪儿了、后面还有什么"。
   */
  useEffect(() => {
    if (!open || index < 0) return
    const row = listRef.current?.querySelectorAll("li")[index]
    row?.scrollIntoView({ block: "center" })
  }, [open, index])

  const dropIndexAt = (clientY: number): number => {
    const items = Array.from(listRef.current?.querySelectorAll("li[data-row]") ?? [])
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return i
    }
    return items.length
  }

  // 拖动排序。交互与曲库面板完全一致（按住挪 4px 才算拖，落点按行中线判定），
  // 两个列表手感不一样比没有拖动更让人别扭
  const beginDrag = (e: React.PointerEvent, from: number) => {
    if (e.button !== 0) return
    const startY = e.clientY
    const el = e.currentTarget as HTMLElement
    let active = false

    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientY - startY) < 4) return
      if (!active) {
        active = true
        el.setPointerCapture(ev.pointerId)
      }
      setDrag({ from, to: dropIndexAt(ev.clientY) })
    }
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", up)
      if (!active) return
      const to = dropIndexAt(ev.clientY)
      setDrag(null)
      // 落回原位或紧邻的下一格，位置其实没变
      if (to !== from && to !== from + 1) moveInQueue(from, to > from ? to - 1 : to)
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", up)
  }

  const total = queue.reduce((sum, t) => sum + (t.duration || 0), 0)

  return (
    <div ref={rootRef} className="drawer queue-panel" role="dialog" aria-label="播放队列">
      <header className="panel-header">
        <h2>播放队列</h2>
        <span className="queue-count">
          {queue.length > 0 ? `${queue.length} 首 · ${formatTime(total)}` : "空"}
        </span>
        <button
          className="queue-clear"
          onClick={clearQueue}
          disabled={queue.length === 0}
          title="清空队列并停止播放"
        >
          清空
        </button>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      <div className="panel-scroll">
        <ol ref={listRef}>
          {queue.map((t, i) => (
            <li
              key={`${t.id}-${i}`}
              data-row
              data-active={i === index}
              data-dragging={drag?.from === i}
              data-drop-before={drag?.to === i}
              data-drop-after={drag !== null && drag.to === queue.length && i === queue.length - 1}
            >
              <button
                className="row"
                onDoubleClick={() => void playAt(i)}
                // 这一行是 <button>，焦点走得到，那回车就得能播 —— 详见曲库面板同一处
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return
                  e.preventDefault()
                  void playAt(i)
                }}
                onPointerDown={(e) => beginDrag(e, i)}
                title="双击或回车从这里播放，按住拖动可调顺序"
              >
                <span className="song-index">{i === index ? "▶" : String(i + 1).padStart(2, "0")}</span>
                <b>{t.title}</b>
                <span>{[t.artist, t.album].filter(Boolean).join(" · ")}</span>
                <em>{formatTime(t.duration)}</em>
              </button>
              <button
                className="row-remove"
                onClick={() => removeFromQueue(i)}
                aria-label={`把《${t.title}》移出队列`}
                title="移出队列（不动曲库）"
              >
                <IconTrash size={13} />
              </button>
            </li>
          ))}
          {queue.length === 0 && (
            <li className="drawer-empty">
              队列是空的。在曲库或搜索结果里双击一首歌开始播放，
              或者右键选「下一首播放」往这里排队。
            </li>
          )}
        </ol>
      </div>
    </div>
  )
}
