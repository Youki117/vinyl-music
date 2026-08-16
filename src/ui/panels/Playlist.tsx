import { useState } from "react"

import { platform } from "@/platform"
import { formatTime } from "@/lib/format"
import {
  SORT_LABEL,
  VIEW_LABEL,
  VIRTUAL_VIEWS,
  useLibrary,
  type SortKey,
  type Track,
} from "@/store/library"
import { usePlayer } from "@/store/player"

const SORT_KEYS: SortKey[] = ["added", "title", "artist", "album", "duration", "playCount", "lastPlayed"]

/** L4 曲库抽屉：左边歌单，右边曲目。默认收起，不占画面。 */
export default function Playlist({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lib = useLibrary()
  const playFrom = usePlayer((s) => s.playFrom)
  const playNext = usePlayer((s) => s.playNext)
  const currentId = usePlayer((s) => s.current()?.id ?? null)
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  if (!open) return null

  const rows = lib.visible()
  const inPlaylist = !(VIRTUAL_VIEWS as readonly string[]).includes(lib.activeView)

  const importFiles = () => void platform.pickAudioFiles().then(lib.addFiles)
  const importFolder = () => void platform.pickAudioFolder().then(lib.addFiles)

  const importM3u = () =>
    void (async () => {
      const ref = await platform.pickPlaylistFile()
      if (!ref) return
      const r = await lib.importPlaylist(ref)
      setNote(
        r.playlistId
          ? `已导入 ${r.matched} 首${r.missing > 0 ? `，${r.missing} 首找不到文件` : ""}`
          : "歌单里的曲目一首都没找到",
      )
    })()

  const exportM3u = () =>
    void lib.exportPlaylist().then((ok) => setNote(ok ? "已导出" : "当前列表是空的"))

  return (
    <div className="drawer library-drawer" role="dialog" aria-label="曲库">
      <aside className="lib-side">
        <div className="lib-side-group">
          {VIRTUAL_VIEWS.map((v) => (
            <button key={v} data-on={lib.activeView === v} onClick={() => lib.setView(v)}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>

        <div className="lib-side-title">
          歌单
          <button
            onClick={() => setRenaming(lib.createPlaylist(`新建歌单 ${lib.playlists.length + 1}`))}
            aria-label="新建歌单"
            title="新建歌单"
          >
            ＋
          </button>
        </div>

        <div className="lib-side-group">
          {lib.playlists.map((p) =>
            renaming === p.id ? (
              <input
                key={p.id}
                autoFocus
                defaultValue={p.name}
                onBlur={(e) => {
                  lib.renamePlaylist(p.id, e.target.value.trim() || p.name)
                  setRenaming(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur()
                  if (e.key === "Escape") setRenaming(null)
                }}
              />
            ) : (
              <button
                key={p.id}
                data-on={lib.activeView === p.id}
                onClick={() => lib.setView(p.id)}
                onDoubleClick={() => setRenaming(p.id)}
                title={`${p.name}（${p.trackIds.length} 首，双击重命名）`}
              >
                <span>{p.name}</span>
                <em>{p.trackIds.length}</em>
              </button>
            ),
          )}
          {lib.playlists.length === 0 && <p className="lib-side-empty">还没有歌单</p>}
        </div>
      </aside>

      <section className="lib-main">
        <header>
          <input
            value={lib.filter}
            onChange={(e) => lib.setFilter(e.target.value)}
            placeholder={`在 ${VIRTUAL_VIEWS.includes(lib.activeView as never) ? VIEW_LABEL[lib.activeView as never] : lib.playlists.find((p) => p.id === lib.activeView)?.name ?? ""} 中搜索`}
            aria-label="搜索曲目"
          />
          <select
            value={lib.sort}
            onChange={(e) => lib.setSort(e.target.value as SortKey)}
            aria-label="排序方式"
            title={`排序：${SORT_LABEL[lib.sort]}${lib.sortDesc ? "（降序）" : ""}`}
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <button onClick={() => lib.setSort(lib.sort)} aria-label="切换升降序" title="切换升降序">
            {lib.sortDesc ? "↓" : "↑"}
          </button>
          <button onClick={importFiles}>加文件</button>
          <button onClick={importFolder}>加文件夹</button>
          <button onClick={importM3u} title="导入 m3u / m3u8 歌单文件">
            导入歌单
          </button>
          <button onClick={exportM3u} title="把当前列表导出为 m3u8">
            导出
          </button>
          {inPlaylist && (
            <button
              className="danger"
              onClick={() => lib.deletePlaylist(lib.activeView)}
              title="删除当前歌单（不删除文件）"
            >
              删歌单
            </button>
          )}
          <button className="drawer-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        {lib.scanning && (
          <div className="drawer-progress">
            正在导入 {lib.scanning.done} / {lib.scanning.total}
            <span style={{ width: `${(lib.scanning.done / lib.scanning.total) * 100}%` }} />
          </div>
        )}

        {note && (
          <p className="lib-note" onClick={() => setNote(null)}>
            {note}
          </p>
        )}

        <ol onClick={() => setMenu(null)}>
          {rows.map((t, i) => (
            <li key={t.id} data-active={t.id === currentId} data-missing={t.missing}>
              <button
                className="row"
                onDoubleClick={() => void playFrom(rows, i)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ track: t, x: e.clientX, y: e.clientY })
                }}
              >
                <b>{t.title}</b>
                <span>{t.artist}</span>
                {t.playCount > 0 && <i title="播放次数">{t.playCount}</i>}
                <em>{formatTime(t.duration)}</em>
              </button>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="drawer-empty">
              {lib.tracks.length === 0 ? "还没有音乐，把文件拖进窗口，或点上面的按钮" : "这里是空的"}
            </li>
          )}
        </ol>
      </section>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={() => setMenu(null)}>
          <button onClick={() => void playFrom(rows, rows.indexOf(menu.track))}>播放</button>
          <button onClick={() => playNext(menu.track)}>下一首播放</button>
          <button onClick={() => lib.toggleLike(menu.track.id)}>
            {menu.track.liked ? "取消收藏" : "收藏"}
          </button>
          <hr />
          {lib.playlists.map((p) => (
            <button key={p.id} onClick={() => lib.addToPlaylist(p.id, [menu.track.id])}>
              加入「{p.name}」
            </button>
          ))}
          {inPlaylist && (
            <button onClick={() => lib.removeFromPlaylist(lib.activeView, menu.track.id)}>
              从本歌单移除
            </button>
          )}
          <hr />
          <button className="danger" onClick={() => lib.removeTracks([menu.track.id])}>
            从曲库移除（不删文件）
          </button>
        </div>
      )}
    </div>
  )
}
