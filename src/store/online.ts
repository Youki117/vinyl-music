import { create } from "zustand"

import { SOURCES, type SourceId } from "@/source/catalog"
import { onlineToTrack, useLibrary, type Track } from "./library"
import { usePlayer } from "./player"

export { SOURCES, type SourceId }

/** 一页多少条。平台大多支持 30，再大有的会截断 */
const PAGE_SIZE = 30

/**
 * `@/source` 一律**动态引入**：它会拉起整个 vendored musicSdk（几百 KB 加一串 node
 * polyfill）。只放本地文件的用户不该为一个没打开过的面板付这份加载成本 ——
 * App.tsx 与 store/player.ts 也是这么处理的。
 */
async function sourceModule() {
  return import("@/source")
}

/**
 * 结果按 id 去重后拼接。
 *
 * 平台的分页并不保证互斥，热门曲目在第一页和第二页各出现一次是常事。不去重的话
 * React 的 key 会撞（同一个 key 渲染两行），而且"加载更多"之后列表会莫名其妙变短 ——
 * 因为下一次去重又把它合并掉了。抽成纯函数是为了能直接测。
 */
export function mergeTracks(prev: Track[], next: Track[]): Track[] {
  const have = new Set(prev.map((t) => t.id))
  const out = [...prev]
  for (const t of next) {
    if (have.has(t.id)) continue
    have.add(t.id)
    out.push(t)
  }
  return out
}

export type OnlineStatus = "idle" | "loading" | "ready" | "error"

type OnlineState = {
  source: SourceId
  keyword: string
  results: Track[]
  page: number
  total: number
  status: OnlineStatus
  /** 正在取下一页。与 status 分开：翻页时列表还在，不该整块变成"搜索中" */
  loadingMore: boolean
  error: string | null

  setSource(s: SourceId): void
  setKeyword(k: string): void
  /** 从第一页重新搜。关键词为空时什么也不做 */
  search(): Promise<void>
  /** 追加下一页 */
  more(): Promise<void>
  hasMore(): boolean
  /** 整个结果列表作为播放队列，从第 i 首开始 */
  play(i: number): Promise<void>
  /** 收进曲库；给了歌单 id 就同时加进那个歌单 */
  collect(track: Track, playlistId?: string): void
}

/**
 * 请求序号。换平台、改关键词都会让在途的请求过期 —— 平台响应从几百毫秒到几秒不等，
 * 不做这个判断的话，先发的慢请求会盖掉后发的快请求，界面上就是"搜A出B"。
 */
let seq = 0

export const useOnline = create<OnlineState>((set, get) => ({
  source: "wy",
  keyword: "",
  results: [],
  page: 0,
  total: 0,
  status: "idle",
  loadingMore: false,
  error: null,

  setSource(source) {
    if (source === get().source) return
    // 换平台等于换了一份结果集，旧的留在屏幕上只会让人以为没换成功
    seq++
    set({ source, results: [], page: 0, total: 0, status: "idle", error: null, loadingMore: false })
  },

  setKeyword(keyword) {
    set({ keyword })
  },

  async search() {
    const keyword = get().keyword.trim()
    if (!keyword) return
    const mine = ++seq
    const source = get().source
    set({ status: "loading", error: null, results: [], page: 0, total: 0, loadingMore: false })
    try {
      const { searchMusic } = await sourceModule()
      const res = await searchMusic(source, keyword, 1, PAGE_SIZE)
      if (mine !== seq) return
      const now = Date.now()
      set({
        results: res.list.map((o, i) => onlineToTrack(o, now + i)),
        page: 1,
        total: res.total,
        status: "ready",
      })
    } catch (err) {
      if (mine !== seq) return
      set({ status: "error", error: err instanceof Error ? err.message : String(err) })
    }
  },

  async more() {
    const { keyword, source, page, loadingMore, status } = get()
    if (loadingMore || status === "loading" || page === 0 || !get().hasMore()) return
    const mine = seq
    set({ loadingMore: true })
    try {
      const { searchMusic } = await sourceModule()
      const res = await searchMusic(source, keyword.trim(), page + 1, PAGE_SIZE)
      if (mine !== seq) return
      const now = Date.now()
      set((s) => ({
        results: mergeTracks(s.results, res.list.map((o, i) => onlineToTrack(o, now + i))),
        page: page + 1,
        total: res.total || s.total,
        loadingMore: false,
      }))
    } catch (err) {
      if (mine !== seq) return
      // 翻页失败不该把已经搜到的结果清掉，只报一句
      set({ loadingMore: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  hasMore() {
    const { results, total, page } = get()
    // total 有的平台给的是估算值，宁可多给一次"加载更多"也不要提前把入口收掉
    return page > 0 && results.length > 0 && (total === 0 || results.length < total)
  },

  async play(i) {
    const rows = get().results
    if (i < 0 || i >= rows.length) return
    await usePlayer.getState().playFrom(rows, i)
  },

  collect(track, playlistId) {
    const lib = useLibrary.getState()
    lib.ensureInLibrary(track)
    if (playlistId) lib.addToPlaylist(playlistId, [track.id])
  },
}))
