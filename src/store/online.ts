import { create } from "zustand"

import { SOURCES, type SourceId } from "@/source/catalog"
import { onlineToTrack, useLibrary, type Track } from "./library"
import { usePlayer } from "./player"

export { SOURCES, type SourceId }

/** 一页多少条。平台大多支持 30，再大有的会截断 */
const PAGE_SIZE = 30

/** 歌单最多翻几页、最多取几首。防的是 total 给了个离谱大数，把内存和耐心一起吃掉 */
const MAX_LIST_PAGES = 10
const MAX_LIST_TRACKS = 1000

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

  // ── 歌单导入 ──────────────────────────────────────────
  /** 用户贴进来的东西：分享链接、分享文案、或者裸的歌单 id */
  listInput: string
  /** 手动指定的平台。null = 按链接自动判断（贴链接时的常态） */
  listSource: SourceId | null
  listStatus: OnlineStatus
  listError: string | null
  /** 解析出来的歌单。导入前先摆给用户看一眼名字和首数，别让他盲点 */
  preview: { source: SourceId; name: string; tracks: Track[]; total: number } | null

  setListInput(v: string): void
  setListSource(s: SourceId | null): void
  /** 解析歌单（不入库）。 */
  fetchList(): Promise<void>
  /** 把预览里的歌单落成一个本地歌单，返回歌单 id。没有预览时返回 null。 */
  importList(): string | null
}

/**
 * 请求序号。换平台、改关键词都会让在途的请求过期 —— 平台响应从几百毫秒到几秒不等，
 * 不做这个判断的话，先发的慢请求会盖掉后发的快请求，界面上就是"搜A出B"。
 */
let seq = 0
/** 歌单解析的序号，同理。搜索与歌单是两条独立的在途请求，共用一个计数会互相作废 */
let listSeq = 0

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
    lib.addTracks([track])
    if (playlistId) lib.addToPlaylist(playlistId, [track.id])
  },

  // ── 歌单导入 ──────────────────────────────────────────
  listInput: "",
  listSource: null,
  listStatus: "idle",
  listError: null,
  preview: null,

  setListInput(listInput) {
    set({ listInput })
  },

  setListSource(listSource) {
    set({ listSource })
  },

  async fetchList() {
    const raw = get().listInput.trim()
    if (!raw) return
    const mine = ++listSeq
    set({ listStatus: "loading", listError: null, preview: null })
    try {
      const { getPlaylist, sourceOfLink } = await sourceModule()
      // 手动选了平台就听用户的；否则按链接判。都判不出来时报错而不是瞎猜一个平台 ——
      // 拿网易云的 id 去酷我要，报回来的错只会更让人摸不着头脑
      const source = get().listSource ?? sourceOfLink(raw)
      if (!source) {
        set({
          listStatus: "error",
          listError: "认不出这是哪个平台的链接。贴分享链接，或者在上面先点一个平台",
        })
        return
      }

      const first = await getPlaylist(source, raw, 1)
      const now = Date.now()
      let tracks = first.list.map((o, i) => onlineToTrack(o, now + i))

      /*
       * 翻页把整个歌单取全。
       *
       * 终止条件是**这一页没带来任何新曲目**，而不是"页数到了 total/limit"：
       * 有的平台压根不理 page 参数，每次都回第一页，按算出来的页数循环就是死循环。
       * 上限另外再兜一道，防止 total 是个离谱的大数。
       */
      for (let page = 2; page <= MAX_LIST_PAGES && tracks.length < first.total; page++) {
        if (tracks.length >= MAX_LIST_TRACKS) break
        const next = await getPlaylist(source, raw, page).catch(() => null)
        if (!next) break
        const merged = mergeTracks(tracks, next.list.map((o, i) => onlineToTrack(o, now + i)))
        if (merged.length === tracks.length) break
        tracks = merged
      }

      if (mine !== listSeq) return
      set({
        listStatus: "ready",
        preview: { source, name: first.name, tracks, total: first.total },
      })
    } catch (err) {
      if (mine !== listSeq) return
      set({ listStatus: "error", listError: err instanceof Error ? err.message : String(err) })
    }
  },

  importList() {
    const preview = get().preview
    if (!preview || preview.tracks.length === 0) return null
    const lib = useLibrary.getState()
    /*
     * 导入歌单是**明确的收藏动作**，和搜索结果不一样：这里该整批入库。
     * addTracks 按 id 去重并返回全部对应曲目（含本来就在库里的），
     * 所以重复导入同一个歌单不会产生副本，也不用先查一遍再决定加哪些。
     */
    const tracks = lib.addTracks(preview.tracks)
    const pid = lib.createPlaylist(preview.name || "导入的歌单")
    // 严格按歌单里的顺序，不是曲库顺序 —— 和 m3u 导入是同一条规矩
    lib.addToPlaylist(pid, tracks.map((t) => t.id))
    return pid
  },
}))
