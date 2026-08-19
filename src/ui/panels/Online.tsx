import { useState } from "react"

import { formatTime } from "@/lib/format"
import { useLibrary, type Track } from "@/store/library"
import { SOURCES, useOnline, type SourceId } from "@/store/online"
import { usePlayer } from "@/store/player"
import { useDismiss } from "../useDismiss"

/** 抽屉里的两件事：搜歌、导歌单。共用一个抽屉是因为它们要的都是"从平台拿曲目" */
type Tab = "search" | "list"

/**
 * 在线音乐抽屉：换平台 → 搜索 → 播放 / 加进歌单；或者贴一条分享链接导整个歌单。
 *
 * 与曲库抽屉刻意长得一样（双击播放、右键菜单），因为它们做的是同一件事，
 * 只是曲目从哪来不同。搜索结果**不入库**，播了的那首才入库（理由见 player 的 playAt）；
 * 歌单导入则是明确的收藏动作，整批入库。
 */
export default function Online({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 逐片订阅，不要整店订阅：别把关键词的每次按键都变成整棵子树重渲染
  const source = useOnline((s) => s.source)
  const keyword = useOnline((s) => s.keyword)
  const results = useOnline((s) => s.results)
  const status = useOnline((s) => s.status)
  const loadingMore = useOnline((s) => s.loadingMore)
  const error = useOnline((s) => s.error)
  const total = useOnline((s) => s.total)
  const listInput = useOnline((s) => s.listInput)
  const listSource = useOnline((s) => s.listSource)
  const listStatus = useOnline((s) => s.listStatus)
  const listError = useOnline((s) => s.listError)
  const preview = useOnline((s) => s.preview)
  const {
    setSource,
    setKeyword,
    search,
    more,
    play,
    collect,
    setListInput,
    setListSource,
    fetchList,
    importList,
  } = useOnline.getState()

  const playlists = useLibrary((s) => s.playlists)
  const libTracks = useLibrary((s) => s.tracks)
  const playNext = usePlayer((s) => s.playNext)
  const currentId = usePlayer((s) => s.current()?.id ?? null)

  const [tab, setTab] = useState<Tab>("search")
  const [note, setNote] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)
  const menuRef = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null), false)

  if (!open) return null

  const inLibrary = new Set(libTracks.map((t) => t.id))
  const hasMore = useOnline.getState().hasMore()

  const doImport = () => {
    const pid = importList()
    if (!pid) return
    const n = preview?.tracks.length ?? 0
    setNote(`已导入 ${n} 首到「${preview?.name || "导入的歌单"}」，去曲库 (P) 里看`)
  }

  return (
    <div ref={rootRef} className="drawer online-drawer" role="dialog" aria-label="在线音乐">
      <header>
        <div className="online-tabs" role="tablist" aria-label="在线音乐">
          <button role="tab" aria-selected={tab === "search"} data-on={tab === "search"} onClick={() => setTab("search")}>
            搜索
          </button>
          <button role="tab" aria-selected={tab === "list"} data-on={tab === "list"} onClick={() => setTab("list")}>
            歌单导入
          </button>
        </div>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      {tab === "search" ? (
        <>
          <div className="online-bar">
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
          </div>

          <div className="online-sources" role="tablist" aria-label="音乐平台">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={source === s.id}
                data-on={source === s.id}
                onClick={() => {
                  setSource(s.id)
                  // 换平台就拿同一个关键词再搜一次 —— 换源本来就是为了比较结果，
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
                    {loadingMore
                      ? "正在加载…"
                      : `加载更多（已 ${results.length}${total ? ` / ${total}` : ""}）`}
                  </button>
                ) : (
                  <span>共 {results.length} 首</span>
                )}
              </li>
            )}
          </ol>
        </>
      ) : (
        <>
          <div className="online-bar">
            <input
              value={listInput}
              autoFocus
              onChange={(e) => setListInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void fetchList()
              }}
              placeholder="贴歌单分享链接，或歌单 id"
              aria-label="歌单链接"
            />
            <select
              value={listSource ?? ""}
              onChange={(e) => setListSource((e.target.value || null) as SourceId | null)}
              aria-label="歌单所属平台"
              title="平台。贴分享链接时留在「自动」即可"
            >
              <option value="">自动</option>
              {SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button onClick={() => void fetchList()} disabled={listStatus === "loading"}>
              {listStatus === "loading" ? "解析中…" : "解析"}
            </button>
          </div>

          <p className="online-tip">
            自己的「我喜欢的音乐」也是一个歌单，只要不是私密的，贴分享链接就能导。
            酷狗必须给分享链接，裸 id 不行。
          </p>

          {listStatus === "error" && listError && <p className="lib-note online-error">{listError}</p>}
          {note && (
            <p className="lib-note" onClick={() => setNote(null)}>
              {note}
            </p>
          )}

          {preview && (
            <div className="online-preview">
              <b>{preview.name || "（这个歌单没有名字）"}</b>
              <span>
                {preview.tracks.length} 首
                {preview.total > preview.tracks.length ? ` / 平台说有 ${preview.total} 首` : ""}
              </span>
              <button onClick={doImport}>导入为歌单</button>
            </div>
          )}

          <ol>
            {preview?.tracks.map((t) => (
              <li key={t.id} data-active={t.id === currentId}>
                <span className="row">
                  <b>{t.title}</b>
                  <span>{t.artist}</span>
                  {inLibrary.has(t.id) && <i title="已在曲库">库</i>}
                  <em>{t.duration > 0 ? formatTime(t.duration) : "--:--"}</em>
                </span>
              </li>
            ))}
            {listStatus === "loading" && <li className="drawer-empty">正在解析歌单…</li>}
            {!preview && listStatus !== "loading" && (
              <li className="drawer-empty">歌单只给曲目信息，播到哪首才解析哪首的播放地址</li>
            )}
          </ol>
        </>
      )}

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
