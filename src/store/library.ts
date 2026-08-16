import { create } from "zustand"

import { isLyricFile, platform, type FileRef } from "@/platform"
import { readMetadata } from "@/audio/metadata"
import { formatM3u, matchByName, parseM3u } from "@/lib/m3u"
import { baseName, stripExt } from "@/lib/text"

export type Track = {
  id: string
  ref: FileRef
  title: string
  artist: string
  album: string
  duration: number
  cover: string | null
  lyrics: string | null
  playCount: number
  liked: boolean
  /** 毫秒时间戳，0 表示从未播放 */
  lastPlayed: number
  addedAt: number
  /** 源文件读不到时标灰 */
  missing: boolean
}

export type Playlist = {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
}

/** 虚拟歌单由数据算出来，不落盘 */
export const VIRTUAL_VIEWS = ["all", "liked", "recent", "most"] as const
export type VirtualView = (typeof VIRTUAL_VIEWS)[number]
export type ViewId = VirtualView | string

export const VIEW_LABEL: Record<VirtualView, string> = {
  all: "全部音乐",
  liked: "我喜欢的",
  recent: "最近播放",
  most: "最常播放",
}

export type SortKey = "added" | "title" | "artist" | "album" | "duration" | "playCount" | "lastPlayed"

export const SORT_LABEL: Record<SortKey, string> = {
  added: "添加时间",
  title: "标题",
  artist: "艺术家",
  album: "专辑",
  duration: "时长",
  playCount: "播放次数",
  lastPlayed: "最近播放",
}

const SCHEMA = 2
const RECENT_LIMIT = 100
const MOST_LIMIT = 100

/** 已经找过外挂歌词的曲目。没找到也记下来，避免每次播放都白跑一趟磁盘。 */
const probedLyrics = new Set<string>()

type LibraryFile = {
  schemaVersion: number
  tracks: Array<Omit<Track, "cover" | "lyrics" | "missing">>
  playlists: Playlist[]
  activeView: ViewId
  sort: SortKey
  sortDesc: boolean
}

type LibraryState = {
  tracks: Track[]
  playlists: Playlist[]
  activeView: ViewId
  sort: SortKey
  sortDesc: boolean
  scanning: { done: number; total: number } | null
  filter: string

  load(): Promise<void>
  addFiles(refs: FileRef[]): Promise<Track[]>
  removeTracks(ids: string[]): void
  markMissing(id: string): void

  setView(v: ViewId): void
  setSort(k: SortKey): void
  setFilter(q: string): void

  createPlaylist(name: string): string
  renamePlaylist(id: string, name: string): void
  deletePlaylist(id: string): void
  addToPlaylist(playlistId: string, trackIds: string[]): void
  removeFromPlaylist(playlistId: string, trackId: string): void
  reorderInPlaylist(playlistId: string, from: number, to: number): void

  toggleLike(id: string): void
  recordPlay(id: string): void

  /**
   * 确保这首歌的歌词就位：内嵌没有就找旁边的同名 .lrc。
   * 曲库落盘时不存歌词正文，重启后要靠这个补回来。
   */
  ensureLyrics(id: string): Promise<string | null>
  /** 把外挂歌词按同名规则挂到曲目上。返回挂上的数量。 */
  attachLyrics(refs: FileRef[]): Promise<number>
  /** 导入 m3u/m3u8，建一个同名歌单。返回结果说明。 */
  importPlaylist(ref: FileRef): Promise<{ playlistId: string | null; matched: number; missing: number }>
  /** 把当前视图导出为 m3u8。 */
  exportPlaylist(): Promise<boolean>

  /** 当前视图 + 搜索 + 排序 之后的曲目 */
  visible(): Track[]
  byId(id: string): Track | undefined
}

let saveTimer = 0

export const useLibrary = create<LibraryState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const s = get()
      const file: LibraryFile = {
        schemaVersion: SCHEMA,
        tracks: s.tracks.map(({ cover: _c, lyrics: _l, missing: _m, ...rest }) => rest),
        playlists: s.playlists,
        activeView: s.activeView,
        sort: s.sort,
        sortDesc: s.sortDesc,
      }
      void platform.writeConfig("library", file)
    }, 1000)
  }

  return {
    tracks: [],
    playlists: [],
    activeView: "all",
    sort: "added",
    sortDesc: false,
    scanning: null,
    filter: "",

    async load() {
      const raw = await platform.readConfig<LibraryFile>("library")
      if (!raw?.tracks) return
      // v1 没有 playlists / addedAt / lastPlayed，补默认值即可，不洗掉用户数据
      const tracks: Track[] = raw.tracks.map((t, i) => ({
        ...t,
        addedAt: t.addedAt ?? i,
        lastPlayed: t.lastPlayed ?? 0,
        cover: null,
        lyrics: null,
        missing: false,
      }))

      // fs 能力域是每次启动重建的，上次拖进来的路径这次并不自动可读。
      // 不在这里补放行，音乐库不在 $HOME/Music 等标准目录下的用户，
      // 重启后整个曲库都会变成"无法播放"。
      await platform.ensureReadable(tracks.map((t) => t.ref.id)).catch(() => {})
      set({
        tracks,
        playlists: raw.playlists ?? [],
        activeView: raw.activeView ?? "all",
        sort: raw.sort ?? "added",
        sortDesc: raw.sortDesc ?? false,
      })
    },

    async addFiles(refs) {
      if (refs.length === 0) return []
      const existing = new Set(get().tracks.map((t) => t.id))
      const fresh = refs.filter((r) => !existing.has(r.id))
      if (fresh.length === 0) return []

      set({ scanning: { done: 0, total: fresh.length } })
      const added: Track[] = []
      const now = Date.now()

      for (let i = 0; i < fresh.length; i++) {
        const ref = fresh[i]
        try {
          const bytes = await platform.readFile(ref)
          const meta = await readMetadata(ref, bytes)
          // 内嵌歌词优先，没有就找旁边的同名 .lrc —— 网上下到的音频几乎都靠这个
          let lyrics = meta.lyrics
          if (!lyrics) {
            lyrics = await platform.readSidecar(ref, "lrc").catch(() => null)
          }
          added.push({
            id: ref.id,
            ref,
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            duration: meta.duration,
            cover: meta.cover,
            lyrics,
            playCount: 0,
            liked: false,
            lastPlayed: 0,
            addedAt: now + i,
            missing: false,
          })
        } catch {
          // 单个文件失败不中断整批导入
        }
        set({ scanning: { done: i + 1, total: fresh.length } })
        // 让出主线程，导入几百首时界面不冻住
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0))
      }

      set((s) => ({ tracks: [...s.tracks, ...added], scanning: null }))

      // 导入到某个具体歌单时，顺带加进去
      const view = get().activeView
      if (!(VIRTUAL_VIEWS as readonly string[]).includes(view)) {
        get().addToPlaylist(view, added.map((t) => t.id))
      }
      save()
      return added
    },

    removeTracks(ids) {
      const set_ = new Set(ids)
      // 内嵌封面是 object URL，不主动释放就一直占着内存
      for (const t of get().tracks) {
        if (set_.has(t.id) && t.cover) URL.revokeObjectURL(t.cover)
        if (set_.has(t.id)) probedLyrics.delete(t.id)
      }
      set((s) => ({
        tracks: s.tracks.filter((t) => !set_.has(t.id)),
        playlists: s.playlists.map((p) => ({ ...p, trackIds: p.trackIds.filter((i) => !set_.has(i)) })),
      }))
      save()
    },

    markMissing(id) {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, missing: true } : t)) }))
    },

    setView(v) {
      set({ activeView: v })
      save()
    },

    setSort(k) {
      // 再点同一列切换升降序，与主流列表一致
      set((s) => (s.sort === k ? { sortDesc: !s.sortDesc } : { sort: k, sortDesc: false }))
      save()
    },

    setFilter(q) {
      set({ filter: q })
    },

    createPlaylist(name) {
      const id = `pl-${Date.now().toString(36)}`
      set((s) => ({
        playlists: [...s.playlists, { id, name, trackIds: [], createdAt: Date.now() }],
        activeView: id,
      }))
      save()
      return id
    },

    renamePlaylist(id, name) {
      set((s) => ({ playlists: s.playlists.map((p) => (p.id === id ? { ...p, name } : p)) }))
      save()
    },

    deletePlaylist(id) {
      set((s) => ({
        playlists: s.playlists.filter((p) => p.id !== id),
        activeView: s.activeView === id ? "all" : s.activeView,
      }))
      save()
    },

    addToPlaylist(playlistId, trackIds) {
      set((s) => ({
        playlists: s.playlists.map((p) =>
          p.id === playlistId
            ? { ...p, trackIds: [...p.trackIds, ...trackIds.filter((i) => !p.trackIds.includes(i))] }
            : p,
        ),
      }))
      save()
    },

    removeFromPlaylist(playlistId, trackId) {
      set((s) => ({
        playlists: s.playlists.map((p) =>
          p.id === playlistId ? { ...p, trackIds: p.trackIds.filter((i) => i !== trackId) } : p,
        ),
      }))
      save()
    },

    reorderInPlaylist(playlistId, from, to) {
      set((s) => ({
        playlists: s.playlists.map((p) => {
          if (p.id !== playlistId) return p
          const ids = [...p.trackIds]
          const [moved] = ids.splice(from, 1)
          if (moved === undefined) return p
          ids.splice(to, 0, moved)
          return { ...p, trackIds: ids }
        }),
      }))
      save()
    },

    toggleLike(id) {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, liked: !t.liked } : t)) }))
      save()
    },

    recordPlay(id) {
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id ? { ...t, playCount: t.playCount + 1, lastPlayed: Date.now() } : t,
        ),
      }))
      save()
    },

    async ensureLyrics(id) {
      const track = get().byId(id)
      if (!track) return null
      if (track.lyrics) return track.lyrics
      if (probedLyrics.has(id)) return null
      probedLyrics.add(id)

      const text = await platform.readSidecar(track.ref, "lrc").catch(() => null)
      if (!text) return null
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, lyrics: text } : t)) }))
      return text
    },

    async attachLyrics(refs) {
      const lrcs = refs.filter((r) => isLyricFile(r.name))
      if (lrcs.length === 0) return 0

      // 同名匹配：「歌名.lrc」配「歌名.mp3」
      const index = new Map<string, string>()
      for (const t of get().tracks) {
        const key = stripExt(t.ref.name).toLowerCase()
        if (!index.has(key)) index.set(key, t.id)
      }

      const patch = new Map<string, string>()
      for (const r of lrcs) {
        const id = index.get(stripExt(r.name).toLowerCase())
        if (!id) continue
        try {
          const text = await platform.readText(r)
          if (text.trim()) patch.set(id, text)
        } catch {
          // 单个歌词读失败不影响其余
        }
      }
      if (patch.size === 0) return 0

      for (const id of patch.keys()) probedLyrics.add(id)
      set((s) => ({
        tracks: s.tracks.map((t) => (patch.has(t.id) ? { ...t, lyrics: patch.get(t.id)! } : t)),
      }))
      return patch.size
    },

    async importPlaylist(ref) {
      const entries = parseM3u(await platform.readText(ref))
      if (entries.length === 0) return { playlistId: null, matched: 0, missing: 0 }

      // 一、先按真实路径解析。解析得出的文件直接导进曲库（可能本来就不在库里）
      const resolved = new Map<string, FileRef>()
      for (const e of entries) {
        const r = await platform.resolvePath(ref.id, e.path).catch(() => null)
        if (r) resolved.set(e.path, r)
      }
      if (resolved.size > 0) {
        // addFiles 会把新曲目塞进「当前歌单」，导入过程中先躲开，避免污染
        const prevView = get().activeView
        set({ activeView: "all" })
        await get().addFiles([...resolved.values()])
        set({ activeView: prevView })
      }

      // 二、路径失效的退回按文件名匹配 —— 歌单文件常是从别的机器拷来的
      const tracks = get().tracks
      const byRefId = new Map(tracks.map((t) => [t.ref.id, t]))
      const nameHits = matchByName(entries, tracks)

      // 严格按 m3u 里的顺序建歌单
      const ids: string[] = []
      let missing = 0
      for (const e of entries) {
        const viaPath = resolved.get(e.path)
        const hit = (viaPath && byRefId.get(viaPath.id)) ?? nameHits.get(e.path)
        if (!hit) {
          missing++
          continue
        }
        if (!ids.includes(hit.id)) ids.push(hit.id)
      }
      if (ids.length === 0) return { playlistId: null, matched: 0, missing }

      const pid = get().createPlaylist(stripExt(baseName(ref.name)) || "导入的歌单")
      get().addToPlaylist(pid, ids)
      return { playlistId: pid, matched: ids.length, missing }
    },

    async exportPlaylist() {
      const rows = get().visible()
      if (rows.length === 0) return false
      const view = get().activeView
      const name = isVirtual(view)
        ? VIEW_LABEL[view]
        : get().playlists.find((p) => p.id === view)?.name ?? "playlist"

      const text = formatM3u(
        rows.map((t) => ({
          // 浏览器实现下 ref.id 是会话内的假 id，写进文件没意义，退回文件名
          path: /^[a-zA-Z]:[\\/]|^\//.test(t.ref.id) ? t.ref.id : t.ref.name,
          title: t.title,
          artist: t.artist,
          duration: t.duration,
        })),
      )
      return platform.saveText(`${name}.m3u8`, text)
    },

    visible() {
      const { tracks, playlists, activeView, sort, sortDesc, filter } = get()
      return selectTracks({ tracks, playlists, view: activeView, sort, sortDesc, filter })
    },

    byId(id) {
      return get().tracks.find((t) => t.id === id)
    },
  }
})

function isVirtual(v: ViewId): v is VirtualView {
  return (VIRTUAL_VIEWS as readonly string[]).includes(v)
}

export type SelectArgs = {
  tracks: Track[]
  playlists: Playlist[]
  view: ViewId
  sort: SortKey
  sortDesc: boolean
  filter: string
}

/**
 * 视图筛选 + 搜索 + 排序。抽成纯函数是为了能单独测 —— 埋在 store 里的话，
 * 排序规则这种最容易写反的东西没法覆盖。
 */
export function selectTracks({ tracks, playlists, view, sort, sortDesc, filter }: SelectArgs): Track[] {
  let list: Track[]
  if (view === "all") list = tracks
  else if (view === "liked") list = tracks.filter((t) => t.liked)
  else if (view === "recent")
    list = tracks
      .filter((t) => t.lastPlayed > 0)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, RECENT_LIMIT)
  else if (view === "most")
    list = tracks
      .filter((t) => t.playCount > 0)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, MOST_LIMIT)
  else {
    const pl = playlists.find((p) => p.id === view)
    // 按歌单内的顺序而不是曲库顺序 —— 手动排过序就该保持
    const index = new Map(tracks.map((t) => [t.id, t]))
    list = pl ? pl.trackIds.map((i) => index.get(i)).filter((t): t is Track => !!t) : []
  }

  const q = filter.trim().toLowerCase()
  if (q) list = list.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))

  // 「最近播放」「最常播放」自带排序语义，不该被通用排序覆盖；
  // 歌单的手动顺序同理，只有显式选了排序键才动。
  const keepOrder = view === "recent" || view === "most" || (sort === "added" && !isVirtual(view))
  if (keepOrder) return list

  const sorted = [...list].sort((a, b) => compare(a, b, sort))
  return sortDesc ? sorted.reverse() : sorted
}

function compare(a: Track, b: Track, key: SortKey): number {
  switch (key) {
    case "title":
      return a.title.localeCompare(b.title, "zh-Hans-CN")
    case "artist":
      return a.artist.localeCompare(b.artist, "zh-Hans-CN")
    case "album":
      return a.album.localeCompare(b.album, "zh-Hans-CN")
    case "duration":
      return a.duration - b.duration
    case "playCount":
      return b.playCount - a.playCount
    case "lastPlayed":
      return b.lastPlayed - a.lastPlayed
    case "added":
    default:
      return a.addedAt - b.addedAt
  }
}
