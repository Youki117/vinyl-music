import { create } from "zustand"

import { platform, type FileRef } from "@/platform"
import { DEFAULT_AI, isConfigured, type AiConfig } from "@/ai/config"
import { generateArtwork, hash, type Progress } from "@/ai/generate"
import type { Track } from "./library"
import { useSkin } from "./skin"

const SCHEMA = 1

type AiFile = { schemaVersion: number; config: AiConfig; artwork: Record<string, string> }

export type GenStage = "idle" | "text" | "image" | "saving"

type AiState = {
  config: AiConfig
  stage: GenStage
  error: string | null
  /** 最近一次生成的画面描述，给用户看模型理解得对不对 */
  lastScene: string | null
  /** trackId → 已生成图片的绝对路径 */
  artwork: Record<string, string>

  load(): Promise<void>
  patch(p: Partial<AiConfig>): void
  generate(track: Track): Promise<void>
  cancel(): void
  /** 曲目已有配图就直接套用，返回是否套上了 */
  applyExisting(track: Track): Promise<boolean>
  maybeAuto(track: Track): Promise<void>
}

let controller: AbortController | null = null
let saveTimer = 0

export const useAi = create<AiState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const s = get()
      const file: AiFile = { schemaVersion: SCHEMA, config: s.config, artwork: s.artwork }
      void platform.writeConfig("ai", file)
    }, 800)
  }

  return {
    config: DEFAULT_AI,
    stage: "idle",
    error: null,
    lastScene: null,
    artwork: {},

    async load() {
      const raw = await platform.readConfig<AiFile>("ai")
      if (!raw) return
      set({
        config: { ...DEFAULT_AI, ...raw.config },
        artwork: raw.artwork ?? {},
      })
    },

    patch(p) {
      set((s) => ({ config: { ...s.config, ...p } }))
      save()
    },

    async applyExisting(track) {
      const path = get().artwork[track.id]
      if (!path) return false
      const ref: FileRef = { id: path, name: `ai-${hash(track.id)}.png`, size: 0, mtime: 0 }
      try {
        // 自动配图会随歌曲不断生成，不能挤进“用户手动选择过的底图”历史。
        await useSkin.getState().setBackdrop(ref, false)
        return true
      } catch {
        // 图片被手动删掉了，把记录清掉以便下次重新生成
        set((s) => {
          const next = { ...s.artwork }
          delete next[track.id]
          return { artwork: next }
        })
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

      controller?.abort()
      controller = new AbortController()
      set({ stage: "text", error: null, lastScene: null })

      const onProgress: Progress = (stage) => set({ stage })

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
          controller.signal,
        )
        set((s) => ({
          artwork: { ...s.artwork, [track.id]: result.ref.id },
          lastScene: result.scene,
          stage: "idle",
        }))
        save()
        await useSkin.getState().setBackdrop(result.ref, false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        set({ stage: "idle", error: msg.includes("aborted") ? null : msg })
      } finally {
        controller = null
      }
    },

    cancel() {
      controller?.abort()
      controller = null
      set({ stage: "idle" })
    },

    /**
     * 切歌时调用。已有配图直接套用；没有且开了自动才去生成。
     * 生成是后台进行的，绝不阻塞播放。
     */
    async maybeAuto(track) {
      if (await get().applyExisting(track)) return
      const { config, stage } = get()
      if (!config.auto || !isConfigured(config) || stage !== "idle") return
      void get().generate(track)
    },
  }
})
