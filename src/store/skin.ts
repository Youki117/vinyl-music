import { create } from "zustand"
import { FastAverageColor } from "fast-average-color"

import { platform, toObjectUrl, type FileRef } from "@/platform"
import { DEFAULT_SKIN, makeSkin, migrateSkins, SKIN_SCHEMA_VERSION, type Skin, type SkinsFile } from "@/skin/model"
import { deriveInk } from "@/skin/palette"
import { labelSourceId } from "@/skin/resolve"
import type { VeilParams } from "@/stage/veil/renderer"

/** 图片的运行时解析结果。持久化的是 FileRef.id，用时才转成 object URL。 */
type LoadedImage = { url: string; width: number; height: number }

type SkinState = {
  skin: Skin
  skins: Skin[]
  backdrop: LoadedImage | null
  label: LoadedImage | null
  /** 切换底图时的旧图，用于交叉淡入 */
  fading: LoadedImage | null

  load(): Promise<void>
  setBackdrop(ref: FileRef): Promise<void>
  setLabelSource(ref: FileRef | "backdrop"): Promise<void>
  patchVeil(p: Partial<VeilParams>): void
  patchSkin(p: Partial<Skin>): void
  activate(id: string): Promise<void>
  saveAs(name: string): Promise<void>
}

const fac = new FastAverageColor()

/** id -> object URL。同一张图被底图和贴纸共用时不重复读盘。 */
const urlCache = new Map<string, LoadedImage>()

async function loadImage(id: string | null): Promise<LoadedImage | null> {
  if (!id) return null
  const hit = urlCache.get(id)
  if (hit) return hit

  const url = await toObjectUrl({ id, name: id, size: 0, mtime: 0 })
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error(`图片无法识别：${id}`))
    img.src = url
  })
  const loaded: LoadedImage = { url, width: img.naturalWidth, height: img.naturalHeight }
  urlCache.set(id, loaded)
  return loaded
}

let saveTimer = 0
function scheduleSave(get: () => SkinState): void {
  window.clearTimeout(saveTimer)
  // 防抖 1 秒：调蒙版滑块时不要每一帧都写盘
  saveTimer = window.setTimeout(() => {
    const { skin, skins } = get()
    const file: SkinsFile = {
      schemaVersion: SKIN_SCHEMA_VERSION,
      activeId: skin.id,
      skins: skins.map((s) => (s.id === skin.id ? skin : s)),
    }
    void platform.writeConfig("skins", file)
  }, 1000)
}

export const useSkin = create<SkinState>((set, get) => ({
  skin: DEFAULT_SKIN,
  skins: [DEFAULT_SKIN],
  backdrop: null,
  label: null,
  fading: null,

  async load() {
    const raw = await platform.readConfig<SkinsFile>("skins")
    const file = migrateSkins(raw)
    if (!file) return

    const active = file.skins.find((s) => s.id === file.activeId) ?? file.skins[0] ?? DEFAULT_SKIN
    set({ skin: active, skins: file.skins })
    await refreshImages(set, get)
  },

  async setBackdrop(ref) {
    const prev = get().backdrop
    set((s) => ({ skin: { ...s.skin, backdrop: ref.id }, fading: prev }))
    await refreshImages(set, get)
    scheduleSave(get)
    // 转场结束后丢掉旧图引用
    window.setTimeout(() => set({ fading: null }), 700)
  },

  async setLabelSource(ref) {
    const source = ref === "backdrop" ? "backdrop" : ref.id
    set((s) => ({ skin: { ...s.skin, label: { ...s.skin.label, source } } }))
    await refreshImages(set, get)
    scheduleSave(get)
  },

  patchVeil(p) {
    set((s) => ({ skin: { ...s.skin, veil: { ...s.skin.veil, ...p } } }))
    scheduleSave(get)
  },

  patchSkin(p) {
    set((s) => ({ skin: { ...s.skin, ...p } }))
    scheduleSave(get)
  },

  async activate(id) {
    const next = get().skins.find((s) => s.id === id)
    if (!next) return
    set((s) => ({ skin: next, fading: s.backdrop }))
    await refreshImages(set, get)
    scheduleSave(get)
    window.setTimeout(() => set({ fading: null }), 700)
  },

  async saveAs(name) {
    const copy = makeSkin({ ...get().skin, id: undefined as unknown as string, name })
    set((s) => ({ skins: [...s.skins, copy], skin: copy }))
    scheduleSave(get)
  },
}))

async function refreshImages(
  set: (p: Partial<SkinState>) => void,
  get: () => SkinState,
): Promise<void> {
  const { skin } = get()
  try {
    const backdrop = await loadImage(skin.backdrop)
    const label = await loadImage(labelSourceId(skin))
    set({ backdrop, label })

    // 自动配色：只看蒙版覆盖的左侧区域，右半区不影响文字可读性
    if (skin.ink.auto && backdrop) {
      const color = await fac.getColorAsync(backdrop.url, {
        left: 0,
        top: 0,
        width: Math.max(1, Math.round(backdrop.width * 0.4)),
        height: backdrop.height,
        algorithm: "dominant",
      })
      const ink = deriveInk([color.value[0], color.value[1], color.value[2]], skin.veil, skin.ink)
      set({ skin: { ...get().skin, ink } })
    }
  } catch (err) {
    // 保留上一张底图，不让画面塌掉（技术文档 §12）
    console.error("[skin] 图片加载失败", err)
  }
}
