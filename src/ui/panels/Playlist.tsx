import { useMemo, useRef, useState } from "react"

import { platform } from "@/platform"
import { formatTime } from "@/lib/format"
import {
  SORT_LABEL,
  VIEW_LABEL,
  VIRTUAL_VIEWS,
  selectTracks,
  useLibrary,
  type Playlist as PlaylistModel,
  type SortKey,
  type Track,
  type ViewId,
} from "@/store/library"
import { usePlayer } from "@/store/player"
import { IconArrowRight, IconImport, IconPlus, IconTrash } from "../icons"
import ContextMenu from "../ContextMenu"
import { useDismiss } from "../useDismiss"
import PlaylistImport from "./PlaylistImport"

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
    removeFromPlaylist,
    removeTracks,
    renamePlaylist,
    reorderInPlaylist,
    setFilter,
    setSort,
    setView,
    toggleLike,
    toggleSortDesc,
  } = useLibrary.getState()

  const playFrom = usePlayer((s) => s.playFrom)
  const playNext = usePlayer((s) => s.playNext)
  const appendToQueue = usePlayer((s) => s.appendToQueue)
  const currentId = usePlayer((s) => s.current()?.id ?? null)
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PlaylistModel | null>(null)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)
  const sortTriggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)
  // 右键菜单点哪儿都该收起来，包括抽屉内部，所以不豁免常驻区
  const sortMenuRef = useDismiss<HTMLDivElement>(sortMenuOpen, () => setSortMenuOpen(false), false)

  // 筛选+排序是纯函数，按输入缓存即可。导入期间 tracks 直到最后才整体替换，
  // 所以这段在导入全程一次都不会重算 —— 这正是上面那条 O(n²) 的解药。
  // 关着的时候不算：抽屉默认收起，没必要为看不见的列表付筛选排序的钱。
  const rows = useMemo(
    () =>
      open && !showImport
        ? selectTracks({ tracks, playlists, view: activeView, sort, sortDesc, filter })
        : NO_ROWS,
    [open, showImport, tracks, playlists, activeView, sort, sortDesc, filter],
  )

  if (!open) return null

  const selectedPlaylist = showImport ? null : playlists.find((playlist) => playlist.id === activeView) ?? null
  const inPlaylist = selectedPlaylist !== null

  const importFolder = () => void platform.pickAudioFolder().then(addFiles)

  // 只有自建歌单里"顺序"才是用户定的；虚拟歌单与排序视图下拖动没有意义
  const canReorder = inPlaylist && sort === "added" && !filter.trim()

  /**
   * 按住拖动排序。
   *
   * 用指针事件而不是 HTML5 draggable：Tauri 开了 dragDropEnabled 接管系统级拖放，
   * 页面内的 dragstart 行为不稳；而且自己算插入位才好画落点指示线。
   *
   * 超过 4px 才认作拖动，否则会把双击播放一起吃掉。
   *
   * 行矩形在拖动激活那一刻量一次、滚动时重量（理由见队列面板同一处）：
   * pointermove 每帧全量 getBoundingClientRect 是 O(n) 强制布局，大歌单会卡。
   */
  const beginDrag = (e: React.PointerEvent, from: number) => {
    if (!canReorder || e.button !== 0) return
    const startY = e.clientY
    const el = e.currentTarget as HTMLElement
    const list = listRef.current
    let active = false

    let rows: { top: number; height: number }[] = []
    const measure = () => {
      rows = Array.from(list?.querySelectorAll("li") ?? []).map((li) => {
        const r = li.getBoundingClientRect()
        return { top: r.top, height: r.height }
      })
    }
    const onScroll = () => {
      if (active) measure()
    }
    /** 指针落在列表的哪个插入位（0..rows.length） */
    const dropIndexAt = (clientY: number): number => {
      for (let i = 0; i < rows.length; i++) {
        if (clientY < rows[i].top + rows[i].height / 2) return i
      }
      return rows.length
    }

    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientY - startY) < 4) return
      if (!active) {
        active = true
        el.setPointerCapture(ev.pointerId)
        measure()
        list?.addEventListener("scroll", onScroll)
      }
      setDrag({ from, to: dropIndexAt(ev.clientY) })
    }
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", up)
      list?.removeEventListener("scroll", onScroll)
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

  const selectView = (view: ViewId) => {
    setShowImport(false)
    setMenu(null)
    setView(view)
  }

  const createNewPlaylist = () => {
    setShowImport(false)
    setRenaming(createPlaylist(`新建歌单 ${playlists.length + 1}`))
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    deletePlaylist(pendingDelete.id)
    setNote(`已删除歌单「${pendingDelete.name}」，歌曲文件没有删除`)
    setPendingDelete(null)
    setShowImport(false)
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
            <button key={v} data-on={!showImport && activeView === v} onClick={() => selectView(v)}>
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
            <button
              onClick={() => selectedPlaylist && setPendingDelete(selectedPlaylist)}
              disabled={!selectedPlaylist}
              aria-label={selectedPlaylist ? `删除歌单 ${selectedPlaylist.name}` : "请选择要删除的歌单"}
              title={selectedPlaylist ? "删除当前歌单" : "选择一个自建歌单后才能删除"}
            >
              <IconTrash size={14} />
            </button>
            <button
              onClick={createNewPlaylist}
              aria-label="新建歌单"
              title="新建歌单"
            >
              <IconPlus size={14} />
            </button>
          </div>
        </div>

        <div className="lib-side-group">
          {playlists.map((p) =>
            renaming === p.id ? (
              <input
                key={p.id}
                autoComplete="off"
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
              <div key={p.id} className="lib-playlist-row" data-on={!showImport && activeView === p.id}>
                <button
                  className="lib-playlist-select"
                  onClick={() => selectView(p.id)}
                  onDoubleClick={() => setRenaming(p.id)}
                  title={`${p.name}（${p.trackIds.length} 首，双击重命名）`}
                >
                  <span>{p.name}</span>
                  <em>{p.trackIds.length}</em>
                </button>
              </div>
            ),
          )}
          <button
            className="lib-import-entry"
            data-on={showImport}
            onClick={() => {
              setShowImport(true)
              setMenu(null)
            }}
          >
            <span>
              <IconImport size={14} />
              导入歌单
            </span>
          </button>
        </div>
      </aside>

      <section className={`lib-main${showImport ? " lib-import-main" : ""}`}>
        {showImport ? (
          <PlaylistImport
            onImported={({ id, name, count }) => {
              setShowImport(false)
              setView(id)
              setNote(`已导入 ${count} 首到「${name}」`)
            }}
          />
        ) : (
          <>
        <header>
          <input
            autoComplete="off"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`在 ${VIRTUAL_VIEWS.includes(activeView as never) ? VIEW_LABEL[activeView as never] : playlists.find((p) => p.id === activeView)?.name ?? ""} 中搜索`}
            aria-label="搜索曲目"
          />
          <div
            ref={sortMenuRef}
            className="lib-sort-container"
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !sortMenuOpen) return
              event.preventDefault()
              setSortMenuOpen(false)
              sortTriggerRef.current?.focus()
            }}
          >
            <button
              ref={sortTriggerRef}
              type="button"
              className="lib-sort-trigger"
              data-on={sortMenuOpen}
              onClick={() => setSortMenuOpen((v) => !v)}
              aria-label={`排序方式：${SORT_LABEL[sort]}`}
              aria-expanded={sortMenuOpen}
              aria-haspopup="true"
              aria-controls={sortMenuOpen ? "playlist-sort-options" : undefined}
              title={`排序：${SORT_LABEL[sort]}${sortDesc ? "（降序）" : ""}`}
            />
            {sortMenuOpen && (
              /*
               * 用 role="group" + 一排原生 button，而**不是** role="menu"。
               *
               * role="menu" 是一份完整的交互契约：上下键在项之间移动、焦点由菜单
               * 自己管、Home/End 跳首尾、字母键快速定位。只贴标签不兑现这些，读屏
               * 用户会按预期去按方向键，然后什么都不发生 —— 比不加标签更糟。
               * 这里要的其实就是"一组可选项"，原生 button + aria-pressed 表达得
               * 更准，键盘行为也天然正确（Tab 遍历、回车选中）。
               * Escape 关闭与焦点回到触发器在上面的 onKeyDown 里补齐。
               */
              <div
                id="playlist-sort-options"
                className="lib-sort-popover"
                role="group"
                aria-label="排序选项"
              >
                {SORT_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="lib-sort-item"
                    data-active={sort === k}
                    aria-pressed={sort === k}
                    onClick={() => {
                      setSort(k)
                      setSortMenuOpen(false)
                      requestAnimationFrame(() => sortTriggerRef.current?.focus())
                    }}
                  >
                    <span>{SORT_LABEL[k]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="lib-sort-direction"
            onClick={toggleSortDesc}
            aria-label={`切换为${sortDesc ? "升序" : "降序"}`}
            title={`当前${sortDesc ? "降序" : "升序"}，点击切换`}
          >
            <IconArrowRight size={14} className={sortDesc ? "sort-desc" : "sort-asc"} />
          </button>
        </header>

        {/*
          本地 M3U 导入、歌单导出与加文件的底层动作仍保留在 store/platform；这里移除的是
          重复或当前不需要的按钮。平台歌单导入改由左侧“导入歌单”入口承载，不复制逻辑。
        */}

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
                // 这一行是 <button>，会进 Tab 焦点序列、被读屏念作按钮 —— 只绑双击的话
                // 焦点走到这儿按回车什么都不发生，比不可聚焦还糟。鼠标仍是双击才播，
                // 单击要留给选中与拖动排序
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return
                  e.preventDefault()
                  void playFrom(rows, i)
                }}
                onPointerDown={(e) => beginDrag(e, i)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ track: t, x: e.clientX, y: e.clientY })
                }}
                title={canReorder ? "双击或回车播放，按住拖动可排序" : "双击或回车播放"}
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
          </>
        )}
      </section>
      </div>

      {pendingDelete && (
        <div
          className="confirm-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPendingDelete(null)
          }}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-playlist-title"
            aria-describedby="delete-playlist-description"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation()
                setPendingDelete(null)
              }
            }}
          >
            <h3 id="delete-playlist-title">删除「{pendingDelete.name}」？</h3>
            <p id="delete-playlist-description">只会删除这张歌单，不会删除曲库中的歌曲或本地文件。</p>
            <div>
              <button autoFocus onClick={() => setPendingDelete(null)}>取消</button>
              <button className="danger" onClick={confirmDelete}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={() => void playFrom(rows, rows.indexOf(menu.track))}>播放</button>
          <button onClick={() => playNext(menu.track)}>下一首播放</button>
          {/* 与「下一首播放」成对：那个插到当前之后，这个排到队尾 */}
          <button onClick={() => appendToQueue([menu.track])}>加入队列</button>
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
        </ContextMenu>
      )}
    </div>
  )
}
