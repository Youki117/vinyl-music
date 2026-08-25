import { create } from "zustand"

import { platform, type FileRef } from "@/platform"
import { DEFAULT_AI, isConfigured, type AiConfig } from "@/ai/config"
import {
  DEFAULT_ARTWORK_BUDGET,
  addArtwork,
  artworkFile,
  artworkForTrack,
  attachThumbnail,
  clampBudget,
  findById,
  planEviction,
  planLibrarySweep,
  planOrphanSweep,
  prunePinned,
  readArtworkIndex,
  readBudget,
  readPinned,
  removeById,
  totalBytes,
  touchArtwork,
  type AiArtwork,
} from "@/ai/artworkStore"
import { thumbnailFromBytes } from "@/ai/thumbnail"
import { generateArtwork, generateFromPrompt, hash, type Progress } from "@/ai/generate"
import type { Track } from "./library"
import { useSkin } from "./skin"
import { createConfigSaver } from "./configSaver"

const SCHEMA = 3

/** AI 图的文件名前缀。清扫孤儿时靠它把 AI 图和封面副本分开 */
const ARTWORK_PREFIX = "ai-"

type AiFile = {
  schemaVersion: number
  config: AiConfig
  items?: unknown
  pinned?: unknown
  budgetBytes?: unknown
  /** v1 的账本：trackId → 路径 */
  artwork?: unknown
}

export type GenStage = "idle" | "text" | "image" | "saving"

type AiState = {
  config: AiConfig
  stage: GenStage
  error: string | null
  /** 最近一次生成的画面描述，给用户看模型理解得对不对 */
  lastScene: string | null
  /** 图库：全部生成过的图，最新的排前面 */
  artwork: AiArtwork[]
  /** 每首歌指定用哪张。没指定就用该歌最新的一张 */
  pinned: Record<string, string>
  budgetBytes: number
  /** 正在为谁生成："custom" 或某个 trackId */
  generatingFor: string | null

  load(): Promise<void>
  patch(p: Partial<AiConfig>): void
  setBudget(bytes: number): void

  /** 为某首歌生成专属图。生成完只在这首歌播放时临时生效 */
  generateForTrack(track: Track): Promise<void>
  /** 用自己写的提示词生成，结果直接成为基础底图 */
  generateGlobal(prompt: string): Promise<void>
  cancel(): void

  /** 切歌时调用：有专属图就临时盖上，没有就回到基础底图 */
  applyForTrack(track: Track | null): Promise<void>

  /** 把某张图设为基础底图（持久，会进"手选底图"那条历史） */
  useAsBase(id: string): Promise<void>
  /** 指定某首歌用哪张图 */
  pinToTrack(trackId: string, id: string | null): void
  /** 给迁移来的旧条目补上缩略图 */
  ensureThumbnails(): Promise<void>

  removeArtwork(id: string): Promise<void>
  clearArtwork(): Promise<void>
  sweepLibrary(liveTrackIds: ReadonlySet<string>): Promise<void>
}

let controller: AbortController | null = null

/**
 * 生成请求代际。
 *
 * 一次生成要 10–30 秒，这期间用户完全可能已经切走。没有这个守卫的话，A 的图会
 * 在用户听 E 的时候把画面换成 A。图本身照存不误（钱已经花了），只是不许再上画。
 */
let genSeq = 0

async function removeQuietly(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => platform.removeFile(p).catch(() => {})))
}

/** 当前基础底图的 id。淘汰时要保住它 —— 那是用户明确选定的 */
function baseBackdropId(): string | null {
  return useSkin.getState().skin.backdrop
}

export const useAi = create<AiState>((set, get) => {
  const save = createConfigSaver<AiFile>(
    "ai",
    () => {
      const s = get()
      return {
        schemaVersion: SCHEMA,
        config: s.config,
        ...artworkFile(s.artwork, s.pinned, s.budgetBytes),
      }
    },
    800,
  )

  /** 超预算就从最久没用到的开始删，文件一起删掉 */
  const enforceBudget = () => {
    const { artwork, budgetBytes, pinned } = get()
    const base = baseBackdropId()
    const keepIds = artwork.filter((a) => a.path === base).map((a) => a.id)
    const { keep, evict } = planEviction(artwork, budgetBytes, keepIds)
    if (evict.length === 0) return
    set({ artwork: keep, pinned: prunePinned(pinned, keep) })
    void removeQuietly(evict.map((item) => item.path))
    save()
  }

  /** 把一张图临时盖上去，并记一次使用时间 */
  const applyOverride = async (item: AiArtwork) => {
    await useSkin.getState().setBackdropOverride(item.path)
    set((s) => ({ artwork: touchArtwork(s.artwork, item.id, Date.now()) }))
    save()
  }

  return {
    config: DEFAULT_AI,
    stage: "idle",
    error: null,
    lastScene: null,
    artwork: [],
    pinned: {},
    budgetBytes: DEFAULT_ARTWORK_BUDGET,
    generatingFor: null,

    async load() {
      const raw = await platform.readConfig<AiFile>("ai")
      if (raw) {
        const items = readArtworkIndex(raw, Date.now())
        set({
          config: { ...DEFAULT_AI, ...raw.config },
          artwork: items,
          pinned: readPinned(raw, items),
          budgetBytes: readBudget(raw),
        })
        // 迁移完要落一次盘，否则每次启动都重迁一遍
        if (raw.schemaVersion !== SCHEMA) save()
      }

      /*
       * 账本与磁盘对账：图片先落盘、账本走防抖，中间崩一次就留下孤儿文件。
       * 不扫的话面板上那句"已用 320MB"只是账本的自述，不是磁盘的实情。
       */
      try {
        const onDisk = await platform.listImages(ARTWORK_PREFIX)
        const orphans = planOrphanSweep(get().artwork, onDisk)
        if (orphans.length > 0) await removeQuietly(orphans)
      } catch {
        // 列不出来（浏览器实现、或目录还不存在）就算了
      }
    },

    patch(p) {
      set((s) => ({ config: { ...s.config, ...p } }))
      save()
    },

    setBudget(bytes) {
      set({ budgetBytes: clampBudget(bytes) })
      enforceBudget()
      save()
    },

    /**
     * 切歌时调用。
     *
     * 这首歌有专属图 → 临时盖上；没有 → **回到基础底图**。后者是新模型的关键：
     * 早先没有这一步，于是听完一首有图的歌，它的图会一直留在画面上，和正在放的
     * 歌完全对不上。
     */
    async applyForTrack(track) {
      const skin = useSkin.getState()
      if (!track) {
        if (skin.overrideBackdrop) await skin.setBackdropOverride(null)
        return
      }

      const item = artworkForTrack(get().artwork, get().pinned, track.id)
      if (!item) {
        if (skin.overrideBackdrop) await skin.setBackdropOverride(null)
        return
      }
      if (skin.overrideBackdrop === item.path) return

      try {
        await applyOverride(item)
      } catch {
        // 图片被手动删掉了：清掉记录并回到基础底图，下次可以重新生成
        set((s) => ({
          artwork: removeById(s.artwork, item.id),
          pinned: prunePinned(s.pinned, removeById(s.artwork, item.id)),
        }))
        save()
        await useSkin.getState().setBackdropOverride(null)
      }
    },

    async generateForTrack(track) {
      await runGeneration(
        track.id,
        (signal, onProgress) =>
          generateArtwork(
            get().config,
            { title: track.title, artist: track.artist, album: track.album, lyrics: track.lyrics },
            `${track.id}-${Date.now()}`,
            onProgress,
            signal,
          ),
        { kind: "song", trackId: track.id, title: track.title, artist: track.artist },
        // 专属图：只在这首歌还在放时才盖上去
        (item) => usePlayerTrackId() === track.id && applyOverride(item),
      )
    },

    async generateGlobal(prompt) {
      const text = prompt.trim()
      if (!text) {
        set({ error: "先写一句想要的画面" })
        return
      }
      await runGeneration(
        "custom",
        (signal, onProgress) =>
          generateFromPrompt(get().config, text, `custom-${Date.now()}`, onProgress, signal),
        { kind: "custom" },
        // 自定义提示词生的图直接成为基础底图
        (item) => get().useAsBase(item.id),
      )
    },

    cancel() {
      genSeq++
      controller?.abort()
      controller = null
      set({ stage: "idle", generatingFor: null })
    },

    async useAsBase(id) {
      const item = findById(get().artwork, id)
      if (!item) return
      // 先撤掉临时覆盖，否则设完基础底图画面还是被专属图盖着
      await useSkin.getState().setBackdropOverride(null)
      const ref: FileRef = {
        id: item.path,
        name: `${ARTWORK_PREFIX}${hash(item.id)}.png`,
        size: item.bytes,
        mtime: item.createdAt,
      }
      // remember=true：让它进"背景图片"那条历史，和手选的图平起平坐
      await useSkin.getState().setBackdrop(ref, true)
      set((s) => ({ artwork: touchArtwork(s.artwork, id, Date.now()) }))
      save()
    },

    pinToTrack(trackId, id) {
      set((s) => {
        const next = { ...s.pinned }
        if (id) next[trackId] = id
        else delete next[trackId]
        return { pinned: next }
      })
      save()
    },

    async ensureThumbnails() {
      const missing = get().artwork.filter((a) => !a.thumbnail)
      if (missing.length === 0) return
      for (const item of missing) {
        try {
          const bytes = await platform.readFile({
            id: item.path,
            name: item.path,
            size: item.bytes,
            mtime: 0,
          })
          const thumb = await thumbnailFromBytes(bytes)
          set((s) => ({ artwork: attachThumbnail(s.artwork, item.id, thumb) }))
        } catch {
          // 原图读不到就算了，列表里显示占位块，不影响其它条目
        }
      }
      save()
    },

    async removeArtwork(id) {
      const item = findById(get().artwork, id)
      if (!item) return
      const rest = removeById(get().artwork, id)
      set({ artwork: rest, pinned: prunePinned(get().pinned, rest) })
      save()
      // 正被临时盖着的就是它，删完要回到基础底图
      if (useSkin.getState().overrideBackdrop === item.path) {
        await useSkin.getState().setBackdropOverride(null)
      }
      await removeQuietly([item.path])
    },

    async clearArtwork() {
      const paths = get().artwork.map((item) => item.path)
      set({ artwork: [], pinned: {} })
      save()
      if (useSkin.getState().overrideBackdrop) {
        await useSkin.getState().setBackdropOverride(null)
      }
      await removeQuietly(paths)
    },

    async sweepLibrary(liveTrackIds) {
      /*
       * 空集合一律当作"曲库还没加载完"，不当作"用户把歌全删了"。两种情况在这里
       * 长得一样，但判断错的代价是把人家攒的图全删光。
       */
      if (liveTrackIds.size === 0) return
      const dead = planLibrarySweep(get().artwork, liveTrackIds)
      if (dead.length === 0) return
      const doomed = new Set(dead.map((i) => i.id))
      const rest = get().artwork.filter((i) => !doomed.has(i.id))
      set({ artwork: rest, pinned: prunePinned(get().pinned, rest) })
      save()
      await removeQuietly(dead.map((item) => item.path))
    },
  }

  /** 两条生成路径共用的骨架：配置检查、代际守卫、入账、预算、上画 */
  async function runGeneration(
    who: string,
    run: (
      signal: AbortSignal,
      onProgress: Progress,
    ) => Promise<{ scene: string | null; prompt: string; ref: FileRef; bytes: Uint8Array }>,
    origin: AiArtwork["origin"],
    apply: (item: AiArtwork) => unknown,
  ): Promise<void> {
    if (!isConfigured(get().config)) {
      set({ error: "请先在设置里填好接口地址、密钥与模型名" })
      return
    }
    if (get().stage !== "idle") return

    const mine = ++genSeq
    controller = new AbortController()
    const signal = controller.signal
    set({ stage: "text", error: null, lastScene: null, generatingFor: who })

    const onProgress: Progress = (stage) => {
      if (mine === genSeq) set({ stage })
    }

    try {
      const result = await run(signal, onProgress)

      // 缩略图现做：手上就有字节，不必回头再读一次盘
      const thumbnail = await thumbnailFromBytes(result.bytes).catch(() => "")

      const item: AiArtwork = {
        id: `${Date.now().toString(36)}-${hash(result.ref.id)}`,
        path: result.ref.id,
        thumbnail,
        bytes: result.ref.size,
        createdAt: Date.now(),
        usedAt: Date.now(),
        origin,
        prompt: result.prompt,
        scene: result.scene,
      }

      /*
       * 图无论如何都要入账 —— 这一次的钱已经花掉了，丢掉它等于下次还得再花一次。
       * 但"能不能上画"是另一回事，见下面的代际判断。
       */
      set((s) => ({ artwork: addArtwork(s.artwork, item), lastScene: result.scene }))
      enforceBudget()
      save()

      if (mine !== genSeq) return
      set({ stage: "idle", generatingFor: null })
      await apply(item)
    } catch (err) {
      if (mine !== genSeq) return
      const msg = err instanceof Error ? err.message : String(err)
      set({
        stage: "idle",
        generatingFor: null,
        error: msg.includes("aborted") ? null : msg,
      })
    } finally {
      if (mine === genSeq) controller = null
    }
  }
})

/**
 * 当前在放哪首。
 *
 * 用惰性 require 而不是顶层 import：player 会 import library，library 不 import ai，
 * 但 ai 顶层再 import player 就会绕成环，vite 下表现为其中一个模块拿到 undefined。
 */
function usePlayerTrackId(): string | null {
  return currentTrackId
}

/** 由 App 在切歌时写入，避免 ai ↔ player 的循环 import */
let currentTrackId: string | null = null
export function noteCurrentTrack(id: string | null): void {
  currentTrackId = id
}

/** 面板要显示"已用 / 上限"，算在这里省得每个组件各写一遍 */
export function artworkUsage(state: { artwork: AiArtwork[]; budgetBytes: number }) {
  const used = totalBytes(state.artwork)
  return { used, budget: state.budgetBytes, count: state.artwork.length }
}
