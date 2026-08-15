import { useMemo, useState } from "react"

import { platform } from "@/platform"
import { formatTime, usePlayer } from "@/store/player"

/** L4 播放列表抽屉。默认收起，不占画面。 */
export default function Playlist({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const scanning = usePlayer((s) => s.scanning)
  const playAt = usePlayer((s) => s.playAt)
  const removeAt = usePlayer((s) => s.removeAt)
  const addFiles = usePlayer((s) => s.addFiles)
  const [filter, setFilter] = useState("")

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return queue
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
  }, [queue, filter])

  if (!open) return null

  return (
    <div className="drawer" role="dialog" aria-label="播放列表">
      <header>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`搜索 ${queue.length} 首`}
          aria-label="搜索曲目"
        />
        <button onClick={() => void platform.pickAudioFiles().then(addFiles)}>添加文件</button>
        <button onClick={() => void platform.pickAudioFolder().then(addFiles)}>添加文件夹</button>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      {scanning && (
        <div className="drawer-progress">
          正在导入 {scanning.done} / {scanning.total}
          <span style={{ width: `${(scanning.done / scanning.total) * 100}%` }} />
        </div>
      )}

      <ol>
        {rows.map(({ t, i }) => (
          <li key={t.id} data-active={i === index} data-missing={t.missing}>
            <button className="row" onDoubleClick={() => void playAt(i)} onClick={() => void playAt(i)}>
              <b>{t.title}</b>
              <span>{t.artist}</span>
              <em>{formatTime(t.duration)}</em>
            </button>
            <button className="row-remove" onClick={() => removeAt(i)} aria-label={`移除 ${t.title}`}>
              ✕
            </button>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="drawer-empty">
            {queue.length === 0 ? "还没有曲目，点上面的按钮导入" : "没有匹配的曲目"}
          </li>
        )}
      </ol>
    </div>
  )
}
