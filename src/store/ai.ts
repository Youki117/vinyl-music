import { create } from "zustand"

import { platform, type FileRef } from "@/platform"
import { DEFAULT_AI, isConfigured, type AiConfig } from "@/ai/config"
import {
  DEFAULT_ARTWORK_BUDGET,
  artworkFile,
  clampBudget,
  findArtwork,
  forgetArtwork,
  planEviction,
  planLibrarySweep,
  planOrphanSweep,
  readArtworkIndex,
  readBudget,
  rememberArtwork,
  totalBytes,
  touchArtwork,
  type AiArtwork,
} from "@/ai/artworkStore"
import { generateArtwork, hash, type Progress } from "@/ai/generate"
import type { Track } from "./library"
import { useSkin } from "./skin"

const SCHEMA = 2

/** AI 图的文件名前缀。清扫孤儿时靠它把 AI 图和封面副本分开 */
const ARTWORK_PREFIX = "ai-"

type AiFile = {
  schemaVersion: number
  config: AiConfig
  /** v2 的账本 */
  items?: unknown
  budgetBytes?: number
  /** v1 的账本：trackId → 路径。readArtworkIndex 负责迁移 */
  artwork?: unknown
}

export type GenStage = "idle" | "text" | "image" | "saving"

/**
 * 停留多久才自动生成。
 *
 * 翻歌单时一首歌只停两三秒，那时候就发请求等于每翻一首花一次钱，而且图还没出来
 * 人已经走了。等用户真正停下来听再生成 —— 与 player.ts 里预取延后开始是同一个道理，
 * 只是这边一次的代价是真金白银，所以等得更久。
 */
const AUTO_DELAY_MS = 8000

type AiState = {
  config: AiConfig
  stage: GenStage
  error: string | null
  /** 最近一次生成的画面描述，给用户看模型理解得对不对 */
  lastScene: string | null
  /** 已生成的配图账本，最近生成的排前面 */
  artwork: AiArtwork[]
  /** 磁盘预算（字节） */
  budgetBytes: number
  /** 正在为哪首歌生成。界面上要能说清楚"在给谁画" */
  generatingFor: string | null
  /** 自动生成已排上队、还没到点的那首 */
  pendingFor: string | null

  load(): Promise<void>
  patch(p: Partial<AiConfig>): void
  setBudget(bytes: number): void
  generate(track: Track): Promise<void>
  cancel(): void
  /** 曲目已有配图就直接套用，返回是否套上了 */
  applyExisting(track: Track): Promise<boolean>
  maybeAuto(track: Track): Promise<void>
  /** 删掉某首歌的配图（连文件一起） */
  removeArtwork(trackId: string): Promise<void>
  /** 清空全部配图 */
  clearArtwork(): Promise<void>
  /** 曲库里已经没有的曲目，配图跟着清掉 */
  sweepLibrary(liveTrackIds: ReadonlySet<string>): Promise<void>
}

let controller: AbortController | null = null
let saveTimer = 0
let autoTimer = 0

/**
 * 生成请求代际。
 *
 * 一次生成要 10–30 秒，这期间用户完全可能已经切走好几首。没有这个守卫的话，
 * A 的图会在用户听 E 的时候把画面换成 A —— 和播放那边 playSeq 防的是同一类事。
 * 图本身照存不误（钱已经花了），只是不许再往画面上套。
 */
let genSeq = 0

/** 删文件失败不该让流程断掉：文件可能已经被用户手动删了 */
async function removeQuietly(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => platform.removeFile(p).catch(() => {})))
}

export const useAi = create<AiState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const s = get()
      const file: AiFile = {
        schemaVersion: SCHEMA,
        config: s.config,
        ...artworkFile(s.artwork, s.budgetBytes),
      }
      void platform.writeConfig("ai", file)
    }, 800)
  }

  /** 超预算就从最久没用到的开始删，文件一起删掉 */
  const enforceBudget = () => {
    const { artwork, budgetBytes } = get()
    const { keep, evict } = planEviction(artwork, budgetBytes)
    if (evict.length === 0) return
    set({ artwork: keep })
    void removeQuietly(evict.map((item) => item.path))
    save()
  }

  const cancelAuto = () => {
    window.clearTimeout(autoTimer)
    autoTimer = 0
    if (get().pendingFor !== null) set({ pendingFor: null })
  }

  return {
    config: DEFAULT_AI,
    stage: "idle",
    error: null,
    lastScene: null,
    artwork: [],
    budgetBytes: DEFAULT_ARTWORK_BUDGET,
    generatingFor: null,
    pendingFor: null,

    async load() {
      const raw = await platform.readConfig<AiFile>("ai")
      if (raw) {
        set({
          config: { ...DEFAULT_AI, ...raw.config },
          artwork: readArtworkIndex(raw, Date.now()),
          budgetBytes: readBudget(raw),
        })
        // v1 的账本没有大小与使用时间，迁移完要落一次盘，否则每次启动都重迁
        if (raw.schemaVersion !== SCHEMA) save()
      }

      /*
       * 账本与磁盘对账。
       *
       * 图片先落盘、账本走 800ms 防抖，中间崩一次就留下一个谁也不认识的文件。
       * 不扫的话面板上那句"已用 320MB"只是账本的自述，不是磁盘的实情。
       */
      try {
        const onDisk = await platform.listImages(ARTWORK_PREFIX)
        const orphans = planOrphanSweep(get().artwork, onDisk)
        if (orphans.length > 0) await removeQuietly(orphans)
      } catch {
        // 列不出来（浏览器实现、或目录还不存在）就算了，不影响功能
      }
    },

    patch(p) {
      set((s) => ({ config: { ...s.config, ...p } }))
      // 关掉自动生成时，已经排上队的那次也得撤掉
      if (p.auto === false || p.enabled === false) cancelAuto()
      save()
    },

    setBudget(bytes) {
      set({ budgetBytes: clampBudget(bytes) })
      enforceBudget()
      save()
    },

    async applyExisting(track) {
      const item = findArtwork(get().artwork, track.id)
      if (!item) return false
      const ref: FileRef = {
        id: item.path,
        name: `${ARTWORK_PREFIX}${hash(track.id)}.png`,
        size: item.bytes,
        mtime: 0,
      }
      try {
        // 自动配图会随歌曲不断生成，不能挤进"用户手动选择过的底图"历史。
        await useSkin.getState().setBackdrop(ref, false)
        // 淘汰按"最后一次用到"排，所以套用一次就要记一次，
        // 否则常听的那几首会因为生成得早而先被删掉
        set((s) => ({ artwork: touchArtwork(s.artwork, track.id, Date.now()) }))
        save()
        return true
      } catch {
        // 图片被手动删掉了，把记录清掉以便下次重新生成
        set((s) => ({ artwork: forgetArtwork(s.artwork, track.id) }))
        save()
        return false
      }
    },

    async generate(track) {
      const { config } = get()
      if (!isConfigured(config)) {
        set({ error: "请先在设置里填好接口地址、密钥与模型名" })
        return
      }
      if (get().stage !== "idle") return

      cancelAuto()
      const mine = ++genSeq
      controller = new AbortController()
      const signal = controller.signal
      set({ stage: "text", error: null, lastScene: null, generatingFor: track.id })

      // 晚到的进度回调不能把界面从 idle 拽回 image
      const onProgress: Progress = (stage) => {
        if (mine === genSeq) set({ stage })
      }

      try {
        const result = await generateArtwork(
          config,
          {
            title: track.title,
            artist: track.artist,
            album: track.album,
            lyrics: track.lyrics,
          },
          track.id,
          onProgress,
          signal,
        )

        /*
         * 图无论如何都要入账 —— 这一次的钱已经花掉了，丢掉它等于下次还得再花一次。
         * 但"能不能往画面上套"是另一回事，见下面的代际判断。
         */
        set((s) => ({
          artwork: rememberArtwork(s.artwork, {
            trackId: track.id,
            path: result.ref.id,
            bytes: result.ref.size,
            usedAt: Date.now(),
          }),
          lastScene: result.scene,
        }))
        enforceBudget()
        save()

        if (mine !== genSeq) return
        set({ stage: "idle", generatingFor: null })
        await useSkin.getState().setBackdrop(result.ref, false)
      } catch (err) {
        if (mine !== genSeq) return
        const msg = err instanceof Error ? err.message : String(err)
        set({
          stage: "idle",
          generatingFor: null,
          error: msg.includes("aborted") ? null : msg,
        })
      } finally {
        // 只清自己那一份：取消之后马上又开一次时，这里不能把新的那个置空
        if (mine === genSeq) controller = null
      }
    },

    cancel() {
      cancelAuto()
      genSeq++
      controller?.abort()
      controller = null
      set({ stage: "idle", generatingFor: null })
    },

    /**
     * 切歌时调用。已有配图直接套用；没有且开了自动，就**排队等用户停下来**。
     *
     * 不立刻生成的理由见 AUTO_DELAY_MS：翻歌单时一首停两三秒，那时候发请求
     * 是白花钱，而且图出来时人早走了。
     */
    async maybeAuto(track) {
      // 换歌了，上一首排的队和正在跑的那次都不作数了
      cancelAuto()
      if (get().generatingFor && get().generatingFor !== track.id) {
        // 切走了就把在途请求掐掉，省下没意义的那笔调用
        get().cancel()
      }

      if (await get().applyExisting(track)) return

      const { config } = get()
      if (!config.auto || !isConfigured(config)) return

      set({ pendingFor: track.id })
      autoTimer = window.setTimeout(() => {
        autoTimer = 0
        set({ pendingFor: null })
        // 这 8 秒里可能已经切走了，也可能手动生成正在跑
        if (get().stage !== "idle") return
        void get().generate(track)
      }, AUTO_DELAY_MS)
    },

    async removeArtwork(trackId) {
      const item = findArtwork(get().artwork, trackId)
      if (!item) return
      set((s) => ({ artwork: forgetArtwork(s.artwork, trackId) }))
      save()
      await removeQuietly([item.path])
    },

    async clearArtwork() {
      const paths = get().artwork.map((item) => item.path)
      set({ artwork: [] })
      save()
      await removeQuietly(paths)
    },

    async sweepLibrary(liveTrackIds) {
      /*
       * 空集合一律当作"曲库还没加载完"，不当作"用户把歌全删了"。
       *
       * 两种情况在这里长得一模一样，但代价天差地别：判断错了要么留下几个陈旧
       * 文件（用户点一下"清空全部"就没了），要么把人家攒了几百张的配图全删光。
       */
      if (liveTrackIds.size === 0) return

      const dead = planLibrarySweep(get().artwork, liveTrackIds)
      if (dead.length === 0) return
      const doomed = new Set(dead.map((item) => item.trackId))
      set((s) => ({ artwork: s.artwork.filter((item) => !doomed.has(item.trackId)) }))
      save()
      await removeQuietly(dead.map((item) => item.path))
    },
  }
})

/** 面板要显示"已用 / 上限"，算在这里省得每个组件各写一遍 */
export function artworkUsage(state: { artwork: AiArtwork[]; budgetBytes: number }) {
  const used = totalBytes(state.artwork)
  return { used, budget: state.budgetBytes, count: state.artwork.length }
}
