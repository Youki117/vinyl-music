import { useMemo, useRef, useState } from "react"

import { platform } from "@/platform"
import { formatTime } from "@/lib/format"
import {
  SORT_LABEL,
  VIEW_LABEL,
  VIRTUAL_VIEWS,
  selectTracks,
  useLibrary,
  type SortKey,
  type Track,
} from "@/store/library"
import { usePlayer } from "@/store/player"
import { useDismiss } from "../useDismiss"

const SORT_KEYS: SortKey[] = ["added", "title", "artist", "album", "duration", "playCount", "lastPlayed"]

/** 抽屉关着时的占位。提到模块级是为了引用恒定，否则 useMemo 每次都算"变了" */
const NO_ROWS: Track[] = []

/** L4 曲库抽屉：左边歌单，右边曲目。默认收起，不占画面。 */
export default function Playlist({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 逐片订阅，不要 `useLibrary()` 订整棵树。整店订阅的代价在导入时才现形：
  // addFiles 每处理完一个文件就 set 一次 scanning，整店订阅会让这里跟着重渲染一次，
  // 而每次重渲染又重跑一遍筛选+排序 —— 面板开着导 1000 首就是 O(n²)。
  const tracks = useLibrary((s) => s.tracks)
  const playlists = useLibrary((s) => s.playlists)
  const activeView = useLibrary((s) => s.activeView)
  const sort = useLibrary((s) => s.sort)
  const sortDesc = useLibrary((s) => s.sortDesc)
  const filter = useLibrary((s) => s.filter)
  const scanning = useLibrary((s) => s.scanning)
  // 动作在 zustand 里引用恒定，订阅它们只会白白扩大重渲染面
  const {
    addFiles,
    addToPlaylist,
    createPlaylist,
    deletePlaylist,
    exportPlaylist,
    importPlaylist,
    removeFromPlaylist,
    removeTracks,
    renamePlaylist,
    reorderInPlaylist,
    setFilter,
    setSort,
    setView,
    toggleLike,
  } = useLibrary.getState()

  const playFrom = usePlayer((s) => s.playFrom)
  const playNext = usePlayer((s) => s.playNext)
  const currentId = usePlayer((s) => s.current()?.id ?? null)
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)
  // 右键菜单点哪儿都该收起来，包括抽屉内部，所以不豁免常驻区
  const menuRef = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null), false)

  // 筛选+排序是纯函数，按输入缓存即可。导入期间 tracks 直到最后才整体替换，
  // 所以这段在导入全程一次都不会重算 —— 这正是上面那条 O(n²) 的解药。
  // 关着的时候不算：抽屉默认收起，没必要为看不见的列表付筛选排序的钱。
  const rows = useMemo(
    () =>
      open ? selectTracks({ tracks, playlists, view: activeView, sort, sortDesc, filter }) : NO_ROWS,
    [open, tracks, playlists, activeView, sort, sortDesc, filter],
  )

  if (!open) return null

  const inPlaylist = !(VIRTUAL_VIEWS as readonly string[]).includes(activeView)

  const importFiles = () => void platform.pickAudioFiles().then(addFiles)
  const importFolder = () => void platform.pickAudioFolder().then(addFiles)

  const importM3u = () =>
    void (async () => {
      const ref = await platform.pickPlaylistFile()
      if (!ref) return
      const r = await importPlaylist(ref)
      setNote(
        r.playlistId
          ? `已导入 ${r.matched} 首${r.missing > 0 ? `，${r.missing} 首找不到文件` : ""}`
          : "歌单里的曲目一首都没找到",
      )
    })()

  const exportM3u = () =>
    void exportPlaylist().then((ok) => setNote(ok ? "已导出" : "当前列表是空的"))

  const exportOne = (id: string, name: string) =>
    void exportPlaylist(id).then((ok) => setNote(ok ? `已导出「${name}」` : `「${name}」没有可导出的本地曲目`))

  // 只有自建歌单里"顺序"才是用户定的；虚拟歌单与排序视图下拖动没有意义
  const canReorder = inPlaylist && sort === "added" && !filter.trim()

  /** 指针落在列表的哪个插入位（0..rows.length） */
  const dropIndexAt = (clientY: number): number => {
    const items = Array.from(listRef.current?.querySelectorAll("li") ?? [])
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return i
    }
    return items.length
  }

  /**
   * 按住拖动排序。
   *
   * 用指针事件而不是 HTML5 draggable：Tauri 开了 dragDropEnabled 接管系统级拖放，
   * 页面内的 dragstart 行为不稳；而且自己算插入位才好画落点指示线。
   *
   * 超过 4px 才认作拖动，否则会把双击播放一起吃掉。
   */
  const beginDrag = (e: React.PointerEvent, from: number) => {
    if (!canReorder || e.button !== 0) return
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
      // 落在自己原位或紧邻的下一格，位置其实没变
      if (to !== from && to !== from + 1) {
        reorderInPlaylist(activeView, from, to > from ? to - 1 : to)
      }
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", up)
  }

  return (
    <div ref={rootRef} className="drawer library-drawer" role="dialog" aria-label="曲库">
      <header className="panel-header library-header">
        <h2>音乐库与歌单</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <div className="library-layout">
      <aside className="lib-side">
        <div className="lib-side-group">
          {VIRTUAL_VIEWS.map((v) => (
            <button key={v} data-on={activeView === v} onClick={() => setView(v)}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>

        <button className="lib-local-button" onClick={importFolder}>
          <span>本地目录</span>
          <em>＋ 添加</em>
        </button>

        <div className="lib-side-title">
          <span>歌单</span>
          <div>
            <button onClick={importM3u} aria-label="导入歌单" title="导入 m3u / m3u8 歌单">
              导入
            </button>
            <button
              onClick={() => setRenaming(createPlaylist(`新建歌单 ${playlists.length + 1}`))}
              aria-label="新建歌单"
              title="新建歌单"
            >
              ＋
            </button>
          </div>
        </div>

        <div className="lib-side-group">
          {playlists.map((p) =>
            renaming === p.id ? (
              <input
                key={p.id}
                autoFocus
                defaultValue={p.name}
                onBlur={(e) => {
                  renamePlaylist(p.id, e.target.value.trim() || p.name)
                  setRenaming(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur()
                  if (e.key === "Escape") setRenaming(null)
                }}
              />
            ) : (
              <div key={p.id} className="lib-playlist-row" data-on={activeView === p.id}>
                <button
                  className="lib-playlist-select"
                  onClick={() => setView(p.id)}
                  onDoubleClick={() => setRenaming(p.id)}
                  title={`${p.name}（${p.trackIds.length} 首，双击重命名）`}
                >
                  <span>{p.name}</span>
                  <em>{p.trackIds.length}</em>
                </button>
                <button
                  className="lib-playlist-export"
                  onClick={() => exportOne(p.id, p.name)}
                  aria-label={`导出歌单 ${p.name}`}
                  title="导出此歌单"
                >
                  导
                </button>
              </div>
            ),
          )}
          {playlists.length === 0 && <p className="lib-side-empty">还没有歌单</p>}
        </div>
      </aside>

      <section className="lib-main">
        <header>
          <b className="lib-current-view">
            {VIRTUAL_VIEWS.includes(activeView as never)
              ? VIEW_LABEL[activeView as never]
              : playlists.find((p) => p.id === activeView)?.name ?? "歌单"}
          </b>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`在 ${VIRTUAL_VIEWS.includes(activeView as never) ? VIEW_LABEL[activeView as never] : playlists.find((p) => p.id === activeView)?.name ?? ""} 中搜索`}
            aria-label="搜索曲目"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="排序方式"
            title={`排序：${SORT_LABEL[sort]}${sortDesc ? "（降序）" : ""}`}
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <button onClick={() => setSort(sort)} aria-label="切换升降序" title="切换升降序">
            {sortDesc ? "↓" : "↑"}
          </button>
        </header>

        {/* 操作按钮单独一行：380px 的抽屉塞不下搜索框 + 排序 + 五个按钮，
            挤在一行会把关闭按钮挤到第二行去 */}
        <div className="lib-actions">
          <button onClick={importFiles}>加文件</button>
          <button onClick={importFolder}>加文件夹</button>
          <button onClick={exportM3u} title="把当前列表导出为 m3u8">
            导出当前列表
          </button>
          {inPlaylist && (
            <button
              className="danger"
              onClick={() => deletePlaylist(activeView)}
              title="删除当前歌单（不删除文件）"
            >
              删歌单
            </button>
          )}
        </div>

        {scanning && (
          <div className="drawer-progress">
            正在导入 {scanning.done} / {scanning.total}
            <span style={{ width: `${(scanning.done / scanning.total) * 100}%` }} />
          </div>
        )}

        {note && (
          <p className="lib-note" onClick={() => setNote(null)}>
            {note}
          </p>
        )}

        <ol ref={listRef} onClick={() => setMenu(null)}>
          {rows.map((t, i) => (
            <li
              key={t.id}
              data-active={t.id === currentId}
              data-missing={t.missing}
              data-dragging={drag?.from === i}
              data-drop-before={drag?.to === i}
              data-drop-after={drag !== null && drag.to === rows.length && i === rows.length - 1}
            >
              <button
                className="row"
                onDoubleClick={() => void playFrom(rows, i)}
                onPointerDown={(e) => beginDrag(e, i)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ track: t, x: e.clientX, y: e.clientY })
                }}
                title={canReorder ? "双击播放，按住拖动可排序" : "双击播放"}
              >
                <span className="song-index">{String(i + 1).padStart(2, "0")}</span>
                <b>{t.title}</b>
                <span>{[t.artist, t.album].filter(Boolean).join(" · ")}</span>
                {t.playCount > 0 && <i title="播放次数">{t.playCount}</i>}
                <em>{formatTime(t.duration)}</em>
              </button>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="drawer-empty">
              {tracks.length === 0 ? "还没有音乐，把文件拖进窗口，或点上面的按钮" : "这里是空的"}
            </li>
          )}
        </ol>
      </section>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={() => setMenu(null)}
        >
          <button onClick={() => void playFrom(rows, rows.indexOf(menu.track))}>播放</button>
          <button onClick={() => playNext(menu.track)}>下一首播放</button>
          <button onClick={() => toggleLike(menu.track.id)}>
            {menu.track.liked ? "取消收藏" : "收藏"}
          </button>
          <hr />
          {playlists.map((p) => (
            <button key={p.id} onClick={() => addToPlaylist(p.id, [menu.track.id])}>
              加入「{p.name}」
            </button>
          ))}
          {inPlaylist && (
            <button onClick={() => removeFromPlaylist(activeView, menu.track.id)}>
              从本歌单移除
            </button>
          )}
          <hr />
          <button className="danger" onClick={() => removeTracks([menu.track.id])}>
            从曲库移除（不删文件）
          </button>
        </div>
      )}
    </div>
  )
}
