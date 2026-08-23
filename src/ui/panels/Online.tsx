import { useEffect, useMemo, useState } from "react"

import { formatTime } from "@/lib/format"
import { platform } from "@/platform"
import { ensureSource } from "@/source/boot"
import { useLibrary, type Track } from "@/store/library"
import { SOURCES, useOnline } from "@/store/online"
import { usePlayer } from "@/store/player"
import { useDismiss } from "../useDismiss"

type Tab = "search" | "source"

/**
 * 在线音乐抽屉：换平台 → 搜索 → 播放 / 加进歌单，并管理播放音源。
 *
 * 与曲库抽屉刻意长得一样（双击播放、右键菜单），因为它们做的是同一件事，
 * 只是曲目从哪来不同。搜索结果**不入库**，播了的那首才入库（理由见 player 的 playAt）；
 * 平台歌单导入已经迁到曲库抽屉，避免搜索页同时承担两条不同任务。
 */
/**
 * 音源脚本的导入入口。
 *
 * 脚本不随应用分发（见 src/source/builtin/README.md），所以必须有这条路 ——
 * 否则「搜得到但播不了」，而用户完全不知道少了什么。状态点常驻，详细说明放在
 * 鼠标悬停与下方提示里，避免重复文字挤占标题行。
 */
function SourceScript() {
  const [info, setInfo] = useState<{ file: string; name: string; version: string } | null>(null)
  // 这份构建自带脚本吗。自用构建会带，开源构建不带 —— 状态得说清楚当前**生效的是哪个**，
  // 只报"有没有导入过"会让自用构建显示"未导入"，而音源其实是活的
  const [builtin, setBuiltin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = () =>
    void ensureSource()
      .then(async (m) => {
        setBuiltin(m.hasBuiltinSource())
        setInfo(await m.savedScriptInfo())
      })
      .catch(() => setInfo(null))

  useEffect(refresh, [])

  const pick = async () => {
    setErr(null)
    const ref = await platform.pickScript()
    if (!ref) return
    setBusy(true)
    try {
      const text = await platform.readText(ref)
      const m = await ensureSource()
      const loaded = await m.importUserScript(ref.name, text)
      setInfo({ file: ref.name, name: loaded.info.name, version: loaded.info.version })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    const m = await ensureSource()
    await m.clearUserScript()
    setInfo(null)
  }

  return (
    <section className="panel-section source-script">
      <div className="source-script-row">
        <div>
          <b>当前激活音源</b>
          <span>
            {info ? (
              <>
                {info.name}
                {info.version && ` v${info.version}`}
              </>
            ) : builtin ? (
              "随构建附带"
            ) : (
              "尚未导入"
            )}
          </span>
        </div>
        <span
          className="source-status-dot"
          data-ready={Boolean(info || builtin)}
          data-tooltip={info || builtin ? "音源可用，可以解析播放地址" : "音源未配置，在线歌曲暂时不能播放"}
          role="status"
          aria-label={info || builtin ? "音源可用，可以解析播放地址" : "音源未配置，在线歌曲暂时不能播放"}
          tabIndex={0}
        />
      </div>
      <div className="source-script-actions">
        <button onClick={() => void pick()} disabled={busy}>
          {busy ? "载入中…" : info ? "更换脚本文件…" : "导入音源脚本…"}
        </button>
        {info && (
          <button className="danger" onClick={() => void clear()}>
            清除已导入音源
          </button>
        )}
      </div>
      <p className="hint">
        {err
          ? `载入失败：${err}`
          : info
            ? `来自 ${info.file}。脚本正文已存到本机，源文件挪走也不影响。`
            : builtin
              ? "当前自用构建附带音源；导入自己的脚本后会优先使用新脚本。"
              : "搜索、歌词与歌单解析不依赖音源；真正播放在线歌曲时需要一份可用音源脚本。"}
      </p>
    </section>
  )
}

export default function Online({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 逐片订阅，不要整店订阅：别把关键词的每次按键都变成整棵子树重渲染
  const source = useOnline((s) => s.source)
  const keyword = useOnline((s) => s.keyword)
  const results = useOnline((s) => s.results)
  const status = useOnline((s) => s.status)
  const loadingMore = useOnline((s) => s.loadingMore)
  const error = useOnline((s) => s.error)
  const total = useOnline((s) => s.total)
  // 订阅而不是 getState() 里现读一次：现读的话这一格什么时候刷新，全看别的字段
  // 碰巧在同一次变更里改没改。返回的是布尔值，zustand 默认的 Object.is 比较就够
  const hasMore = useOnline((s) => s.hasMore())
  const {
    setSource,
    setKeyword,
    search,
    more,
    play,
    collect,
  } = useOnline.getState()

  const playlists = useLibrary((s) => s.playlists)
  const libTracks = useLibrary((s) => s.tracks)
  const playNext = usePlayer((s) => s.playNext)
  const appendToQueue = usePlayer((s) => s.appendToQueue)
  const currentId = usePlayer((s) => s.current()?.id ?? null)

  const [tab, setTab] = useState<Tab>("search")
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)
  const menuRef = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null), false)
  // 曲库上千首时，这个 Set 每次重渲染都重建一遍就是每次按键都扫一遍全库
  const inLibrary = useMemo(() => new Set(libTracks.map((t) => t.id)), [libTracks])

  if (!open) return null

  return (
    <div ref={rootRef} className="drawer online-drawer" role="dialog" aria-label="在线音乐">
      <header className="panel-header">
        <div className="online-tabs" role="tablist" aria-label="在线音乐">
          <button role="tab" aria-selected={tab === "search"} data-on={tab === "search"} onClick={() => setTab("search")}>
            在线搜索
          </button>
          <button role="tab" aria-selected={tab === "source"} data-on={tab === "source"} onClick={() => setTab("source")}>
            音源管理
          </button>
        </div>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      {tab === "search" ? (
        <>
          <section className="panel-section online-query">
            <div className="online-bar">
              <input
                autoComplete="off"
                value={keyword}
                autoFocus
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void search()
                }}
                placeholder="输入歌名、歌手或专辑"
                aria-label="搜索在线音乐"
              />
              <button className="primary" onClick={() => void search()} title="搜索（回车）">
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
          </section>

          <div className="result-heading">
            <b>搜索结果</b>
            <span>{results.length > 0 ? `${results.length}${total ? ` / ${total}` : ""} 首` : ""}</span>
          </div>

          {status === "error" && error && <p className="lib-note online-error">{error}</p>}

          <ol onClick={() => setMenu(null)}>
            {results.map((t, i) => (
              <li key={t.id} data-active={t.id === currentId}>
                <button
                  className="row"
                  onDoubleClick={() => void play(i)}
                  // 焦点能走到这一行，回车就得能播 —— 详见 Playlist.tsx 同一处的说明
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return
                    e.preventDefault()
                    void play(i)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ track: t, x: e.clientX, y: e.clientY })
                  }}
                  title="双击或回车播放，右键更多"
                >
                  <span className="song-index">{String(i + 1).padStart(2, "0")}</span>
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
        <div className="panel-scroll source-manager">
          <SourceScript />
        </div>
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
          <button onClick={() => appendToQueue([menu.track])}>加入队列</button>
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
