import { create } from "zustand"

import { platform } from "@/platform"
import { AudioLayer, type LayerConfig } from "@/audio/layer"
import { initialClips, type Clip } from "@/audio/clips"
import { engine } from "@/audio/engine"
import { subscribe } from "@/stage/clock"
import { useLibrary } from "./library"

const SCHEMA = 1

/** 一份混音编排，挂在某个主音轨上 */
export type Mix = { hostTrackId: string; layers: LayerConfig[] }

type MixFile = { schemaVersion: number; mixes: Record<string, Mix> }

type MixState = {
  /** hostTrackId → 编排 */
  mixes: Record<string, Mix>
  /** 当前主音轨 id */
  hostId: string | null
  /** 正在编辑的层 */
  selectedId: string | null
  loading: boolean
  error: string | null

  load(): Promise<void>
  setHost(trackId: string | null): Promise<void>
  addLayer(trackId: string): Promise<void>
  removeLayer(layerId: string): void
  patchLayer(layerId: string, p: Partial<LayerConfig>): void
  setClips(layerId: string, clips: Clip[]): void
  select(layerId: string | null): void
  current(): Mix | null
}

/** layerId → 正在发声的实例。与 store 里的配置一一对应。 */
const live = new Map<string, AudioLayer>()
let unsubscribeClock: (() => void) | null = null
let saveTimer = 0

export const useMix = create<MixState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const file: MixFile = { schemaVersion: SCHEMA, mixes: get().mixes }
      void platform.writeConfig("mix", file)
    }, 800)
  }

  /** 把 live 里的实例调成与配置一致 */
  const sync = async () => {
    const mix = get().current()
    const want = new Map((mix?.layers ?? []).map((l) => [l.id, l]))

    for (const [id, layer] of live) {
      if (!want.has(id)) {
        layer.dispose()
        live.delete(id)
      }
    }

    for (const [id, cfg] of want) {
      const existing = live.get(id)
      if (existing) {
        Object.assign(existing.config, cfg)
        continue
      }
      const track = useLibrary.getState().byId(cfg.trackId)
      if (!track) continue
      const layer = new AudioLayer({ ...cfg })
      try {
        await layer.load(track.ref)
        live.set(id, layer)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : "叠加轨加载失败" })
      }
    }

    // 有层就开时钟，没有就停
    if (live.size > 0 && !unsubscribeClock) {
      unsubscribeClock = subscribe(() => {
        const playing = engine.status === "playing"
        const t = engine.currentTime
        for (const layer of live.values()) layer.tick(t, playing)
      }, 30)
    } else if (live.size === 0 && unsubscribeClock) {
      unsubscribeClock()
      unsubscribeClock = null
    }
  }

  return {
    mixes: {},
    hostId: null,
    selectedId: null,
    loading: false,
    error: null,

    async load() {
      const raw = await platform.readConfig<MixFile>("mix")
      if (raw?.mixes) set({ mixes: raw.mixes })
    },

    async setHost(trackId) {
      if (get().hostId === trackId) return
      set({ hostId: trackId, selectedId: null, error: null })
      set({ loading: true })
      await sync()
      set({ loading: false })
    },

    async addLayer(trackId) {
      const { hostId } = get()
      if (!hostId) return
      const track = useLibrary.getState().byId(trackId)
      if (!track) return

      const hostDuration = useLibrary.getState().byId(hostId)?.duration ?? 0
      const layer: LayerConfig = {
        id: `ly-${Date.now().toString(36)}`,
        trackId,
        name: track.title,
        volume: 0.5,
        muted: false,
        // 初始铺一整段；后续的分割/删除/移动都在这张表上做
        clips: initialClips(track.duration || hostDuration, hostDuration || track.duration || 60),
      }
      set((s) => {
        const mix = s.mixes[hostId] ?? { hostTrackId: hostId, layers: [] }
        return {
          mixes: { ...s.mixes, [hostId]: { ...mix, layers: [...mix.layers, layer] } },
          selectedId: layer.id,
        }
      })
      save()
      set({ loading: true })
      await sync()
      set({ loading: false })
    },

    removeLayer(layerId) {
      const { hostId } = get()
      if (!hostId) return
      set((s) => {
        const mix = s.mixes[hostId]
        if (!mix) return s
        return {
          mixes: {
            ...s.mixes,
            [hostId]: { ...mix, layers: mix.layers.filter((l) => l.id !== layerId) },
          },
          selectedId: s.selectedId === layerId ? null : s.selectedId,
        }
      })
      save()
      void sync()
    },

    patchLayer(layerId, p) {
      const { hostId } = get()
      if (!hostId) return
      set((s) => {
        const mix = s.mixes[hostId]
        if (!mix) return s
        return {
          mixes: {
            ...s.mixes,
            [hostId]: {
              ...mix,
              layers: mix.layers.map((l) => (l.id === layerId ? { ...l, ...p } : l)),
            },
          },
        }
      })
      // 音量、静音、片段这些改完要立刻生效，不能等下一次 sync
      const layer = live.get(layerId)
      if (layer) Object.assign(layer.config, p)
      save()
    },

    setClips(layerId, clips) {
      get().patchLayer(layerId, { clips })
    },

    select(layerId) {
      set({ selectedId: layerId })
    },

    current() {
      const { hostId, mixes } = get()
      return hostId ? (mixes[hostId] ?? null) : null
    },
  }
})

/** 供 UI 显示当前实际发声的层数 */
export function liveLayerCount(): number {
  return live.size
}
