import { useState } from "react"

import { formatTime } from "@/lib/format"
import { useLibrary, type Track } from "@/store/library"
import { SOURCES, useOnline } from "@/store/online"
import { usePlayer } from "@/store/player"
import { useDismiss } from "../useDismiss"

/**
 * 在线音乐抽屉：换平台 → 搜索 → 播放 / 加进歌单。
 *
 * 与曲库抽屉刻意长得一样（双击播放、右键菜单），因为它们做的是同一件事，
 * 只是曲目从哪来不同。搜索结果**不入库**，播了的那首才入库 ——
 * 理由写在 store/player.ts 的 playAt 里。
 */
export default function Online({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 逐片订阅，不要整店订阅：翻页时 results 变一次就够了，别把 keyword 的每次按键
  // 都变成整棵子树重渲染
  const source = useOnline((s) => s.source)
  const keyword = useOnline((s) => s.keyword)
  const results = useOnline((s) => s.results)
  const status = useOnline((s) => s.status)
  const loadingMore = useOnline((s) => s.loadingMore)
  const error = useOnline((s) => s.error)
  const total = useOnline((s) => s.total)
  const { setSource, setKeyword, search, more, play, collect } = useOnline.getState()

  const playlists = useLibrary((s) => s.playlists)
  const libIds = useLibrary((s) => s.tracks)
  const playNext = usePlayer((s) => s.playNext)
  const currentId = usePlayer((s) => s.current()?.id ?? null)

  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)
  const menuRef = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null), false)

  if (!open) return null

  const inLibrary = new Set(libIds.map((t) => t.id))
  const hasMore = useOnline.getState().hasMore()

  return (
    <div ref={rootRef} className="drawer online-drawer" role="dialog" aria-label="在线音乐">
      <header>
        <input
          value={keyword}
          autoFocus
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search()
          }}
          placeholder="搜索歌名、歌手"
          aria-label="搜索在线音乐"
        />
        <button onClick={() => void search()} title="搜索（回车）">
          搜索
        </button>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      <div className="online-sources" role="tablist" aria-label="音乐平台">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={source === s.id}
            data-on={source === s.id}
            onClick={() => {
              setSource(s.id)
              // 换平台就用同一个关键词直接再搜一次 —— 换源本来就是为了比较结果，
              // 还要用户再点一次「搜索」是多余的一步
              if (keyword.trim()) void search()
            }}
          >
            {s.name}
          </button>
        ))}
      </div>

      {status === "error" && error && <p className="lib-note online-error">{error}</p>}

      <ol onClick={() => setMenu(null)}>
        {results.map((t, i) => (
          <li key={t.id} data-active={t.id === currentId}>
            <button
              className="row"
              onDoubleClick={() => void play(i)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ track: t, x: e.clientX, y: e.clientY })
              }}
              title="双击播放，右键更多"
            >
              <b>{t.title}</b>
              <span>{t.artist}</span>
              {inLibrary.has(t.id) && <i title="已在曲库">库</i>}
              <em>{t.duration > 0 ? formatTime(t.duration) : "--:--"}</em>
            </button>
          </li>
        ))}

        {status === "loading" && <li className="drawer-empty">正在搜索…</li>}
        {status === "ready" && results.length === 0 && (
          <li className="drawer-empty">没有搜到，换个关键词或换个平台</li>
        )}
        {status === "idle" && results.length === 0 && (
          <li className="drawer-empty">输入歌名或歌手，回车搜索</li>
        )}

        {results.length > 0 && (
          <li className="online-more">
            {hasMore ? (
              <button onClick={() => void more()} disabled={loadingMore}>
                {loadingMore ? "正在加载…" : `加载更多（已 ${results.length}${total ? ` / ${total}` : ""}）`}
              </button>
            ) : (
              <span>共 {results.length} 首</span>
            )}
          </li>
        )}
      </ol>

      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={() => setMenu(null)}
        >
          <button onClick={() => void play(results.indexOf(menu.track))}>播放</button>
          <button onClick={() => playNext(menu.track)}>下一首播放</button>
          <button onClick={() => collect(menu.track)}>收进曲库</button>
          {playlists.length > 0 && <hr />}
          {playlists.map((p) => (
            <button key={p.id} onClick={() => collect(menu.track, p.id)}>
              加入「{p.name}」
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
