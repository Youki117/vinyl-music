import { create } from "zustand"

import { isLyricFile, platform, type FileRef } from "@/platform"
import { readCover, readMetadata } from "@/audio/metadata"
import { formatM3u, matchByName, parseM3u } from "@/lib/m3u"
import { baseName, stripExt } from "@/lib/text"

/**
 * 曲目从哪来。**判别联合而不是可空字段**，是为了让类型逼着每个调用点表态 ——
 * 混音、AI 配图、m3u 导出、波形、外挂歌词这些本来就对在线曲目不成立，
 * 用 `ref: FileRef | null` 的话它们只会多一句 `if (!ref) return`，
 * 而真正该问的是「这件事对在线曲目意味着什么」。
 */
export type TrackOrigin =
  | { kind: "local"; ref: FileRef }
  | {
      kind: "online"
      /** 平台 id，与 src/source 的 SourceId 一致 */
      source: OnlineSourceId
      /** 平台内的曲目 id */
      songId: string
      qualities: string[]
      /** 平台返回的原始对象。音源脚本要的是它，裁剪过的字段不够用 */
      raw: unknown
    }

/** 只在类型上依赖 src/source —— 值上依赖会把整个 musicSdk 拖进曲库模块 */
export type OnlineSourceId = "kw" | "kg" | "tx" | "wy" | "mg"

/** 搜索/歌单给过来的曲目。结构与 src/source 的 OnlineTrack 一致，此处不引入它以免拖依赖。 */
export type OnlineTrackInput = {
  source: OnlineSourceId
  id: string
  title: string
  artist: string
  album: string
  /** 平台给的是 "mm:ss" 文本 */
  duration: string
  qualities: string[]
  raw: unknown
}

/** "04:32" / "1:02:03" → 秒。解析不出就是 0，界面那边本来就按 0 当"未知时长"处理。 */
export function parseDuration(text: string): number {
  const parts = text.split(":").map((x) => Number(x.trim()))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** 本地文件引用。在线曲目没有，返回 null。 */
export const localRef = (t: Track): FileRef | null =>
  t.origin.kind === "local" ? t.origin.ref : null

/** 在线曲目的稳定 id。歌单、收藏、播放统计都按 id 存，所以它必须跨会话不变。 */
export const onlineTrackId = (source: OnlineSourceId, songId: string): string =>
  `${source}:${songId}`

/**
 * 在线曲目 → Track。**纯函数**，因为它有两个调用方：搜索结果要立刻变成能进播放队列的
 * Track（还没入库），而 `addOnlineTracks` 要把同一份东西写进曲库。两边各转一次的话，
 * 迟早会转出两个不一样的 id 或 addedAt，而 id 一旦对不上，收藏和播放统计就静默失联。
 */
export function onlineToTrack(o: OnlineTrackInput, addedAt: number): Track {
  return {
    id: onlineTrackId(o.source, o.id),
    origin: { kind: "online", source: o.source, songId: o.id, qualities: o.qualities, raw: o.raw },
    title: o.title,
    artist: o.artist,
    album: o.album,
    duration: parseDuration(o.duration),
    cover: null,
    lyrics: null,
    playCount: 0,
    liked: false,
    lastPlayed: 0,
    addedAt,
    // 在线曲目没有"源文件不见了"这回事，能不能播是播的时候才知道的
    missing: false,
  }
}

export type Track = {
  id: string
  origin: TrackOrigin
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

/**
 * 导入时同时处理几个文件。
 *
 * 串行导入 1000 首实测 72 秒（scripts/perf/dbg-library.mjs，合成曲库每首约 0.6MB），
 * 而 PRD 定的是 15 秒 —— 每首 72ms 里真正的磁盘读只占极小一块，大头是"读整个文件
 * 过一次 IPC"的往返延迟，串着等就是纯浪费。
 *
 * **这个数是量出来的，不是拍的**（1000 首，每首约 0.6MB，整棵进程树的 Private Bytes）：
 *
 *   并发 1（原来）  72.4s   峰值  868MB
 *   并发 2          50.2s   峰值  701MB  ← 时间和峰值同时更优，没有取舍
 *   并发 4          38.3s   峰值 4253MB  ← 再快 24%，峰值涨六倍
 *
 * 并发 4 那 4253MB 事后强制回收能回落到 844MB，说明是垃圾不是泄漏 —— 但峰值就是峰值，
 * 内存小的机器上会当场崩掉，不能拿"反正能回收"当借口。每导一首要把整个文件过一遍 IPC
 * 再解析，产生的临时垃圾远大于文件本身；并发把分配速率乘上去，V8 的回收就跟不上了。
 *
 * 取 2 是因为它严格优于串行（两项都赢），而不是因为它是个折中。想再快得先别读整个
 * 文件（readSlice，见 docs/TECH-DESIGN.md 的待办）—— 那才是治本的。
 */
const IMPORT_CONCURRENCY = 2

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

const SCHEMA = 3
const RECENT_LIMIT = 100
const MOST_LIMIT = 100

/** 已经找过外挂歌词的曲目。没找到也记下来，避免每次播放都白跑一趟磁盘。 */
const probedLyrics = new Set<string>()
/** 同理，已经解过封面的曲目 */
const probedCovers = new Set<string>()
/** 曲目 id → 落盘后的封面文件路径，给系统媒体面板用 */
const coverFiles = new Map<string, string>()
/** 已物化封面的曲目 id，数组顺序即 LRU（末尾最新）。见 rememberCover */
const coverLru: string[] = []
/** 同时最多留几张封面的 object URL。只显示一张，留 8 张是为了来回切歌时不用重解 */
const COVER_CACHE_MAX = 8

/** FNV-1a，只用来给封面文件起个稳定的短名字 */
function hashId(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

type LibraryFile = {
  schemaVersion: number
  /**
   * 曲目 id → 落盘的封面副本路径。
   *
   * 存这张表是为了**不用为了拿封面把整个音频文件再解析一遍**：内嵌封面本身不进
   * JSON（那是二进制），但它已经被抄到 skins/ 下了，记住路径下次直接读那张小图。
   * 少一次 parseBlob 就少一份整文件拷贝，一首 10MB 的歌就是 10MB。
   */
  coverFiles?: Record<string, string>
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
  /**
   * 把在线曲目收进曲库。已在库里的按 id 去重，返回**全部**对应曲目（含已存在的），
   * 这样调用方可以直接拿去播放或加进歌单，不用自己再查一遍。
   */
  addOnlineTracks(list: OnlineTrackInput[]): Track[]
  /**
   * 把已经成形的 Track 收进曲库，按 id 去重，返回**全部**对应曲目（含已存在的）。
   *
   * 两个调用方：播放队列里那首在线曲目要补进库（"播了才入库"，见 player 的 playAt），
   * 以及歌单导入要整批入库。`addOnlineTracks` 也是转成 Track 之后走的这条路 ——
   * 去重规则只此一处。
   */
  addTracks(list: Track[]): Track[]
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
  /** 直接写入歌词正文。在线曲目的歌词来自平台接口，不走 ensureLyrics 那条找同名文件的路。 */
  setLyrics(id: string, text: string): void
  /** 取回远端封面并挂到曲目上。见实现处的说明（CSP 与 Referer）。 */
  setRemoteCover(id: string, url: string): Promise<void>
  /**
   * 确保内嵌封面就位。曲库落盘时不存封面，重启后要靠这个补回来 ——
   * 否则唱片中心和系统媒体面板都会是空的。
   * @param bytes 播放时已经读进内存的文件字节，避免二次读盘
   */
  ensureCover(id: string, bytes: Uint8Array): Promise<{ url: string; path: string | null } | null>
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
        coverFiles: Object.fromEntries(coverFiles),
        tracks: s.tracks.map(({ cover: _c, lyrics: _l, missing: _m, ...rest }) => rest),
        playlists: s.playlists,
        activeView: s.activeView,
        sort: s.sort,
        sortDesc: s.sortDesc,
      }
      void platform.writeConfig("library", file)
    }, 1000)
  }

  /**
   * 记下这首歌的封面已物化，并按 LRU 淘汰旧的。
   *
   * 封面只有当前播放的那一首会显示（Disc），但 ensureCover 会把 URL 写回曲目就再也
   * 不撒手。连播八小时约 160 首，每张三四百 KB，就是几十 MB 只涨不落 —— 正好顶在
   * PRD「连续播放 8 小时增长 < 50MB」的线上。做法照抄 skin.ts 的图片缓存。
   *
   * 淘汰是安全的，前提是**界面只从曲库读封面**：Disc 按曲目 id 从这里取，播放队列里
   * 那份副本不再作为显示来源，所以 revoke 之后不会有谁还指着一个死 URL。回切到被淘汰
   * 的曲目时 ensureCover 会重新解一份（磁盘上还留着几十 KB 的副本，很便宜）。
   */
  const rememberCover = (id: string) => {
    const at = coverLru.indexOf(id)
    if (at >= 0) coverLru.splice(at, 1)
    coverLru.push(id)
    if (coverLru.length <= COVER_CACHE_MAX) return

    const victims = coverLru.splice(0, coverLru.length - COVER_CACHE_MAX)
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (!victims.includes(t.id) || !t.cover) return t
        URL.revokeObjectURL(t.cover)
        // 连同"已探测过"的标记一起清掉，否则回切时 ensureCover 会直接返回 null
        probedCovers.delete(t.id)
        return { ...t, cover: null }
      }),
    }))
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
      for (const [id, path] of Object.entries(raw?.coverFiles ?? {})) coverFiles.set(id, path)
      if (!raw?.tracks) return
      /*
       * v1 没有 playlists / addedAt / lastPlayed，v2 用的是 `ref` 而不是 `origin`。
       * 一律补默认值，不洗掉用户数据 —— 曲库是用户攒出来的，宁可多留字段也不能丢。
       */
      const tracks: Track[] = raw.tracks.map((t, i) => {
        const legacy = t as typeof t & { ref?: FileRef }
        return {
          ...t,
          origin: t.origin ?? (legacy.ref ? { kind: "local", ref: legacy.ref } : t.origin),
          addedAt: t.addedAt ?? i,
          lastPlayed: t.lastPlayed ?? 0,
          cover: null,
          lyrics: null,
          missing: false,
        }
      }).filter((t) => t.origin != null)

      // fs 能力域是每次启动重建的，上次拖进来的路径这次并不自动可读。
      // 不在这里补放行，音乐库不在 $HOME/Music 等标准目录下的用户，
      // 重启后整个曲库都会变成"无法播放"。
      await platform
        .ensureReadable(tracks.map(localRef).filter((r): r is FileRef => r != null).map((r) => r.id))
        .catch(() => {})
      set({
        tracks,
        playlists: raw.playlists ?? [],
        activeView: raw.activeView ?? "all",
        sort: raw.sort ?? "added",
        sortDesc: raw.sortDesc ?? false,
      })
    },

    addOnlineTracks(list) {
      const now = Date.now()
      // addedAt 用 now + i 而不是全都 now：曲库默认按添加时间排，同一批全撞在一个
      // 毫秒上的话，「全部音乐」里的顺序就成了排序算法的实现细节
      return get().addTracks(list.map((o, i) => onlineToTrack(o, now + i)))
    },

    addTracks(list) {
      const byId = new Map(get().tracks.map((t) => [t.id, t]))
      const fresh: Track[] = []
      const out: Track[] = []

      for (const t of list) {
        const existing = byId.get(t.id)
        if (existing) {
          out.push(existing)
          continue
        }
        /*
         * 封面一律清空。曲库里的封面 URL 由 ensureCover / setRemoteCover 生成，
         * 它们同时负责 LRU 与 revokeObjectURL；从外面带一个进来，这份 URL 就
         * 不在淘汰名单里，等于一个稳定的泄漏。缺封面下次播放会自己补上。
         */
        const t2 = t.cover ? { ...t, cover: null } : t
        byId.set(t.id, t2)
        fresh.push(t2)
        out.push(t2)
      }

      if (fresh.length > 0) {
        set((s) => ({ tracks: [...s.tracks, ...fresh] }))
        save()
      }
      return out
    },

    async addFiles(refs) {
      if (refs.length === 0) return []
      const existing = new Set(get().tracks.map((t) => t.id))
      const fresh = refs.filter((r) => !existing.has(r.id))
      if (fresh.length === 0) return []

      set({ scanning: { done: 0, total: fresh.length } })
      const now = Date.now()
      // 按下标回填而不是 push：并发下完成顺序是乱的，但入库顺序必须还是用户选的顺序
      const slots: (Track | null)[] = new Array(fresh.length).fill(null)

      const readOne = async (ref: FileRef, i: number): Promise<void> => {
        try {
          const bytes = await platform.readFile(ref)
          const meta = await readMetadata(ref, bytes)
          // 内嵌歌词优先，没有就找旁边的同名 .lrc —— 网上下到的音频几乎都靠这个
          let lyrics = meta.lyrics
          if (!lyrics) {
            lyrics = await platform.readSidecar(ref, "lrc").catch(() => null)
          }
          slots[i] = {
            id: ref.id,
            origin: { kind: "local", ref },
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            duration: meta.duration,
            // 导入不物化封面，首播时由 ensureCover 补（理由见 TrackMeta 的说明）
            cover: null,
            lyrics,
            playCount: 0,
            liked: false,
            lastPlayed: 0,
            addedAt: now + i,
            missing: false,
          }
        } catch {
          // 单个文件失败不中断整批导入
        }
      }

      let cursor = 0
      let done = 0
      const worker = async (): Promise<void> => {
        while (cursor < fresh.length) {
          const i = cursor++
          await readOne(fresh[i], i)
          done++
          set({ scanning: { done, total: fresh.length } })
          // 让出主线程，导入几百首时界面不冻住
          if (done % 8 === 0) await new Promise((r) => setTimeout(r, 0))
        }
      }
      await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, fresh.length) }, worker))

      const added = slots.filter((t): t is Track => t !== null)
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
        if (!set_.has(t.id)) continue
        if (t.cover) URL.revokeObjectURL(t.cover)
        probedLyrics.delete(t.id)
        probedCovers.delete(t.id)
        // 落盘的封面副本也要清掉，否则 skins/ 里会留下没人认领的孤儿文件
        const file = coverFiles.get(t.id)
        if (file) {
          coverFiles.delete(t.id)
          void platform.removeFile(file).catch(() => {})
        }
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

      // 外挂 .lrc 是"音频文件旁边的同名文件"，在线曲目没有这个概念
      const ref = localRef(track)
      if (!ref) return null
      const text = await platform.readSidecar(ref, "lrc").catch(() => null)
      if (!text) return null
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, lyrics: text } : t)) }))
      return text
    },

    setLyrics(id, text) {
      if (!text.trim()) return
      probedLyrics.add(id)
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, lyrics: text } : t)) }))
    },

    /**
     * 把在线封面挂到曲目上。
     *
     * **必须先取回字节再造 blob**，不能把远端 URL 直接塞进 `<img>`：CSP 的 `img-src`
     * 只放行 `'self' blob: data:`，远端地址一律被拦；而且平台的图床常要校验 Referer，
     * WebView 里的 `<img>` 设不了。走 plugin-http 从 Rust 侧取则两个问题都没有。
     *
     * 落一份到磁盘是为了系统媒体面板 —— 它读不了 blob:，只认真实文件路径。
     */
    async setRemoteCover(id, url) {
      if (!get().byId(id) || probedCovers.has(id)) return
      probedCovers.add(id)
      try {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
        const res = await tauriFetch(url, { method: "GET" })
        if (!res.ok) return
        const mime = res.headers.get("content-type") ?? "image/jpeg"
        const data = new Uint8Array(await res.arrayBuffer())
        const objectUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
        set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, cover: objectUrl } : t)) }))
        rememberCover(id)
        try {
          const ext = mime.includes("png") ? "png" : "jpg"
          const ref = await platform.saveImage(`cover-${hashId(id)}.${ext}`, data)
          if (ref) {
            coverFiles.set(id, ref.id)
            save()
          }
        } catch {
          // 落盘失败只影响系统媒体面板的封面，界面照常显示
        }
      } catch {
        probedCovers.delete(id) // 网络抖动不该让这首歌永远没封面
      }
    },

    async ensureCover(id, bytes) {
      const track = get().byId(id)
      if (!track) return null
      const known = coverFiles.get(id)
      if (track.cover) {
        rememberCover(id) // 命中也要挪到 LRU 末尾，否则正在听的这首反而先被淘汰
        return { url: track.cover, path: known ?? null }
      }
      if (probedCovers.has(id)) return null
      probedCovers.add(id)

      // 上次已经把封面抄到 skins/ 下了，直接读那张几十 KB 的小图。
      // 走 readCover 意味着要为了一张封面把整个音频文件再解析一遍 ——
      // 一首 10MB 的歌就白白多出 10MB 的临时拷贝。
      if (known) {
        try {
          const bytes2 = await platform.readFile({ id: known, name: known, size: 0, mtime: 0 })
          // 扩展名是我们自己按 pic.mime 写下去的（见下方 saveImage），照它反推即可。
          // 硬编码 jpeg 的话 png 封面会被贴错 MIME —— <img> 会嗅探内容所以看不出来，
          // 但这个 blob 一旦喂给认 MIME 的地方就会翻车
          const url = URL.createObjectURL(
            new Blob([bytes2 as BlobPart], {
              type: /\.png$/i.test(known) ? "image/png" : "image/jpeg",
            }),
          )
          set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, cover: url } : t)) }))
          rememberCover(id)
          return { url, path: known }
        } catch {
          // 副本被删了就退回重解一次
          coverFiles.delete(id)
        }
      }

      const pic = await readCover(bytes)
      if (!pic) return null
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, cover: pic.url } : t)) }))
      rememberCover(id)

      // 顺手落一份到磁盘：系统媒体面板读不了 blob:，只认真实文件路径。
      // 文件名带曲目哈希，避免复用同一个名字时被系统占着写不进去。
      let path: string | null = null
      try {
        const ext = pic.mime.includes("png") ? "png" : "jpg"
        const ref = await platform.saveImage(`cover-${hashId(id)}.${ext}`, pic.data)
        path = ref.id
        coverFiles.set(id, path)
      } catch {
        // 写不进去只影响系统面板的缩略图，界面上的唱片贴纸照常
      }
      return { url: pic.url, path }
    },

    async attachLyrics(refs) {
      const lrcs = refs.filter((r) => isLyricFile(r.name))
      if (lrcs.length === 0) return 0

      // 同名匹配：「歌名.lrc」配「歌名.mp3」
      const index = new Map<string, string>()
      for (const t of get().tracks) {
        const ref = localRef(t)
        if (!ref) continue
        const key = stripExt(ref.name).toLowerCase()
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
      const byRefId = new Map(
        tracks.flatMap((t) => {
          const ref = localRef(t)
          return ref ? [[ref.id, t] as const] : []
        }),
      )
      // m3u 靠文件名兜底，只有本地曲目有文件名
      const nameHits = matchByName(
        entries,
        tracks.flatMap((t) => {
          const ref = localRef(t)
          return ref ? [{ id: t.id, name: ref.name }] : []
        }),
      )

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
      // m3u 是一份文件路径清单，在线曲目没有路径，只能略过
      const rows = get().visible().filter((t) => t.origin.kind === "local")
      if (rows.length === 0) return false
      const view = get().activeView
      const name = isVirtual(view)
        ? VIEW_LABEL[view]
        : get().playlists.find((p) => p.id === view)?.name ?? "playlist"

      const text = formatM3u(
        rows.map((t) => {
          const ref = localRef(t)!
          return {
            // 浏览器实现下 ref.id 是会话内的假 id，写进文件没意义，退回文件名
            path: /^[a-zA-Z]:[\\/]|^\//.test(ref.id) ? ref.id : ref.name,
            title: t.title,
            artist: t.artist,
            duration: t.duration,
          }
        }),
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

/**
 * 中文排序器。
 *
 * 必须提到模块级：`localeCompare(x, "zh-Hans-CN")` 每调一次都要在内部现建一个 ICU
 * collator，而排序里它被调用 O(n log n) 次 —— 一万首歌约 13 万次，单次排序能烧掉几百
 * 毫秒。复用同一个 Intl.Collator 排序结果完全一致，只是不再重复建对象。
 */
const collator = new Intl.Collator("zh-Hans-CN")

function compare(a: Track, b: Track, key: SortKey): number {
  switch (key) {
    case "title":
      return collator.compare(a.title, b.title)
    case "artist":
      return collator.compare(a.artist, b.artist)
    case "album":
      return collator.compare(a.album, b.album)
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
