import { create } from "zustand"
import { FastAverageColor } from "fast-average-color"

import { platform, toObjectUrl, type FileRef } from "@/platform"
import {
  backdropHistoryFile,
  readBackdropHistory,
  rememberBackdrop,
  type CustomBackdrop,
} from "@/skin/backdropHistory"
import { DEFAULT_SKIN, makeSkin, migrateSkins, SKIN_SCHEMA_VERSION, type Skin, type SkinsFile } from "@/skin/model"
import { dominantColors, veilTintsFrom } from "@/skin/palette"
import { builtinBackdropUrl } from "@/skin/backdrops"
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
  /**
   * 从当前底图提取的三个主色（已按蒙版可用性调过，见 veilTintFrom）。
   *
   * 派生数据，不落盘：底图换了就该重新取，存下来只会和底图对不上。
   * 没有底图或提取失败时是空数组，此时 tintAuto 形同关闭。
   */
  tintColors: string[]

  /**
   * 底图**左侧 40%**（蒙版覆盖区）的平均色，给 deriveInk 算文字对比度用。
   *
   * 存下来是因为文字配色不能再在换图时算一次就完事：自动取色会让蒙版色在一首歌里
   * 换三次，深浅可能差很多，文字得跟着走。所以这里只存输入，配色在 Stage 里按
   * 当前生效的蒙版色现算。同样是派生数据，不落盘。
   */
  backdropAvg: [number, number, number] | null
  /** 用户手动选过的底图；配置只存路径与小缩略图，不复制原始图片。 */
  customBackdrops: CustomBackdrop[]

  load(): Promise<void>
  setBackdrop(ref: FileRef, remember?: boolean): Promise<void>
  setLabelSource(ref: FileRef | "backdrop"): Promise<void>
  patchVeil(p: Partial<VeilParams>): void
  patchSkin(p: Partial<Skin>): void
  activate(id: string): Promise<void>
  saveAs(name: string): Promise<void>
  /** 删除一个预设。只剩一个时不允许删；删掉当前这个会自动切到别的。 */
  removeSkin(id: string): Promise<void>
  /** 只套用另一个预设的蒙版参数，保留当前底图与文案 */
  applyVeilFrom(id: string): Promise<void>
}

const fac = new FastAverageColor()

/**
 * id -> object URL。同一张图被底图和贴纸共用时不重复读盘。
 *
 * 必须有上限并主动 revoke：手动换底图时最多攒几张，无所谓；但开了 AI 自动配图
 * 之后每首歌一张 1792×1024 的 PNG，播一百首就是几百 MB 常驻，直接违反
 * PRD「连续播放 8 小时增长 < 50MB」。Map 的插入顺序就是 LRU 的天然实现。
 */
const urlCache = new Map<string, LoadedImage>()
const URL_CACHE_MAX = 6

/** 正在用的图不能被淘汰掉，否则底图会当场变白 */
let pinnedIds: string[] = []

/**
 * 正在交叉淡出的旧底图 id，转场那 700ms 里也不能被淘汰。
 *
 * 它不在 skin 里（skin.backdrop 已经指向新图了），光钉 skin 上那两张钉不住它 ——
 * 700ms 内连切六张底图就会把它 revoke 掉，淡入当场闪一下白。概率不高，但代价是一行。
 */
let fadingId: string | null = null

function evictImages(): void {
  for (const [id, img] of urlCache) {
    if (urlCache.size <= URL_CACHE_MAX) break
    if (pinnedIds.includes(id)) continue
    URL.revokeObjectURL(img.url)
    urlCache.delete(id)
  }
}

async function loadImage(id: string | null): Promise<LoadedImage | null> {
  if (!id) return null
  const hit = urlCache.get(id)
  if (hit) {
    // 命中就挪到末尾，让淘汰顺序反映最近使用
    urlCache.delete(id)
    urlCache.set(id, hit)
    return hit
  }

  /*
   * 内置底图是打包进产物的静态资源，直接用它的 URL；用户导入的图才走
   * platform.readFile 转 object URL。淘汰时对静态 URL 调 revokeObjectURL
   * 是空操作（规范如此），所以下面那套缓存逻辑不用分叉。
   */
  const url = builtinBackdropUrl(id) ?? (await toObjectUrl({ id, name: id, size: 0, mtime: 0 }))
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => {
      // 加载失败的 URL 也要还回去，不然这条泄漏路径反而最容易被触发
      URL.revokeObjectURL(url)
      reject(new Error(`图片无法识别：${id}`))
    }
    img.src = url
  })
  const loaded: LoadedImage = { url, width: img.naturalWidth, height: img.naturalHeight }
  urlCache.set(id, loaded)
  evictImages()
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

function readableImageIds(skin: Skin, history: readonly CustomBackdrop[]): string[] {
  return [...new Set([skin.backdrop, labelSourceId(skin), ...history.map((item) => item.id)])].filter(
    (id): id is string => !!id && builtinBackdropUrl(id) === null,
  )
}

/** 历史列表显示固定尺寸缩略图，避免打开面板就解码十几张原始 4K 图片。 */
async function thumbnailOf(img: LoadedImage): Promise<string> {
  const width = 160
  const height = 100
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("无法创建底图缩略图")

  const source = new Image()
  await new Promise<void>((resolve, reject) => {
    source.onload = () => resolve()
    source.onerror = () => reject(new Error("无法读取底图缩略图"))
    source.src = img.url
  })

  const scale = Math.max(width / img.width, height / img.height)
  const drawWidth = img.width * scale
  const drawHeight = img.height * scale
  ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
  return canvas.toDataURL("image/jpeg", 0.74)
}

export const useSkin = create<SkinState>((set, get) => ({
  skin: DEFAULT_SKIN,
  skins: [DEFAULT_SKIN],
  backdrop: null,
  label: null,
  fading: null,
  tintColors: [],
  backdropAvg: null,
  customBackdrops: [],

  async load() {
    const [raw, rawHistory] = await Promise.all([
      platform.readConfig<SkinsFile>("skins"),
      platform.readConfig<unknown>("backdrop-history"),
    ])
    const file = migrateSkins(raw)
    const customBackdrops = readBackdropHistory(rawHistory)
    const active = file?.skins.find((s) => s.id === file.activeId) ?? file?.skins[0] ?? DEFAULT_SKIN
    set({ skin: active, skins: file?.skins ?? [DEFAULT_SKIN], customBackdrops })

    // 对话框权限只活在当前进程；重启后要按已保存的路径重新放行，历史缩略图才能复选。
    await platform.ensureReadable(readableImageIds(active, customBackdrops))
    /*
     * 读不到存档就是首次运行。state 里已经是 DEFAULT_SKIN，但它引用的内置底图
     * 还没加载过 —— 从前 DEFAULT_SKIN.backdrop 是 null，直接 return 什么都不做
     * 是对的；现在它指向一张内置图，不刷这一次首屏就还是那层 CSS 渐变。
     */
    await refreshImages(set, get)
  },

  async setBackdrop(ref, shouldRemember = true) {
    await platform.ensureReadable([ref.id])
    let loaded: LoadedImage
    try {
      // 先确认目标真的能读，再改 skin；历史文件被移走时不会把当前画面切成空白。
      const target = await loadImage(ref.id)
      if (!target) return
      loaded = target
    } catch (err) {
      console.error("[skin] 底图无法加载", err)
      return
    }

    const prev = get().backdrop
    fadingId = get().skin.backdrop
    set((s) => ({ skin: { ...s.skin, backdrop: ref.id }, fading: prev }))
    await refreshImages(set, get)
    scheduleSave(get)

    if (shouldRemember && builtinBackdropUrl(ref.id) === null) {
      try {
        const next = rememberBackdrop(get().customBackdrops, {
          id: ref.id,
          name: ref.name,
          thumbnail: await thumbnailOf(loaded),
        })
        set({ customBackdrops: next })
        await platform.writeConfig("backdrop-history", backdropHistoryFile(next))
      } catch (err) {
        // 记录失败不该回滚已经成功的换图；下一次仍可以重新选择原文件。
        console.warn("[skin] 记录自定义底图失败", err)
      }
    }
    // 转场结束后丢掉旧图引用，同时解除钉住
    window.setTimeout(() => {
      fadingId = null
      set({ fading: null })
    }, 700)
  },

  async setLabelSource(ref) {
    const source = ref === "backdrop" ? "backdrop" : ref.id
    set((s) => ({ skin: { ...s.skin, label: { ...s.skin.label, source } } }))
    await refreshImages(set, get)
    scheduleSave(get)
  },

  patchVeil(p) {
    set((s) => ({
      skin: {
        ...s.skin,
        veil: { ...s.skin.veil, ...p },
        // 用户手调了蒙版色 → 自动取色让位。规则放在这里而不是面板里，
        // 这样任何改 tint 的路径都自动遵守，不会漏掉某个入口。
        // 其余参数（羽化、边缘、起伏）与取色无关，不影响开关。
        tintAuto: p.tint !== undefined ? false : s.skin.tintAuto,
      },
    }))
    scheduleSave(get)
  },

  patchSkin(p) {
    set((s) => ({ skin: { ...s.skin, ...p } }))
    scheduleSave(get)
  },

  async activate(id) {
    const next = get().skins.find((s) => s.id === id)
    if (!next) return
    fadingId = get().skin.backdrop
    set((s) => ({ skin: next, fading: s.backdrop }))
    await refreshImages(set, get)
    scheduleSave(get)
    window.setTimeout(() => {
      fadingId = null
      set({ fading: null })
    }, 700)
  },

  async saveAs(name) {
    const copy = makeSkin({ ...get().skin, id: undefined as unknown as string, name })
    set((s) => ({ skins: [...s.skins, copy], skin: copy }))
    scheduleSave(get)
  },

  async removeSkin(id) {
    const { skins, skin } = get()
    // 至少留一个，否则界面会没有可用皮肤
    if (skins.length <= 1) return
    const rest = skins.filter((s) => s.id !== id)
    if (rest.length === skins.length) return
    set({ skins: rest })
    // 删的正好是当前这个，就切到剩下的第一个（activate 里会顺带落盘）
    if (skin.id === id) await get().activate(rest[0].id)
    else scheduleSave(get)
  },

  /**
   * 只把另一个预设的**蒙版参数**搬过来，底图、取景、文案、配色都不动。
   *
   * 存在的理由：预设存的是整张皮肤，一键套用会连底图一起换掉。而调蒙版时最常见的
   * 需求是"这套雾的参数不错，换到我现在这张图上看看"。
   *
   * 套完要走一遍 refreshImages 重推配色：deriveInk 的输入里就有 veil.tint 和
   * veil.opacity（底图被蒙版压过之后的混合亮度才决定文字可读性），换了一套差别很大的
   * 蒙版参数却不重推，文字可能当场变得看不清。
   */
  async applyVeilFrom(id) {
    const src = get().skins.find((s) => s.id === id)
    if (!src) return
    // tintAuto 跟着一起搬：预设如果是在自动取色下存的，里面那个 tint 本来就是算出来的、
    // 没有意义；反过来如果是手调后存的，就该保持手动。让预设携带它自己的意图。
    set((s) => ({ skin: { ...s.skin, veil: { ...src.veil }, tintAuto: src.tintAuto } }))
    await refreshImages(set, get)
    scheduleSave(get)
  },
}))

/**
 * 从整张底图提取三个可用作蒙版色的主色。
 *
 * 缩到 96px 宽再取样：主色调不需要全分辨率，一张 4K 底图逐像素统计要几千万次循环，
 * 而缩图之后结果几乎一样。
 */
async function extractTints(img: LoadedImage): Promise<string[]> {
  try {
    const W = 96
    const H = Math.max(1, Math.round((img.height / Math.max(1, img.width)) * W))
    const canvas = document.createElement("canvas")
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return []

    const bitmap = new Image()
    await new Promise<void>((resolve, reject) => {
      bitmap.onload = () => resolve()
      bitmap.onerror = () => reject(new Error("取色时图片加载失败"))
      bitmap.src = img.url
    })
    ctx.drawImage(bitmap, 0, 0, W, H)

    const { data } = ctx.getImageData(0, 0, W, H)
    return veilTintsFrom(dominantColors(data, 3))
  } catch (err) {
    // 取不到色就退回手动 tint，不该让整个换图流程失败
    console.warn("[skin] 蒙版取色失败", err)
    return []
  }
}

async function refreshImages(
  set: (p: Partial<SkinState>) => void,
  get: () => SkinState,
): Promise<void> {
  const { skin } = get()
  try {
    // 先钉住这一轮要用的两张，免得加载第二张时把第一张淘汰掉
    pinnedIds = [skin.backdrop, labelSourceId(skin), fadingId].filter((v): v is string => !!v)
    const backdrop = await loadImage(skin.backdrop)
    const label = await loadImage(labelSourceId(skin))
    set({ backdrop, label })

    // 蒙版自动取色：看**整张图**。
    //
    // 原来这里只采左 40%，理由是"取的区域要和盖的区域一致"。那个理由对配色成立、
    // 对取色不成立 —— 人是看着整张图说"这图的主色是黑、血红、盔甲白"的，而这类图
    // 主体往往在右边，左边只是背景。实测那张暗红角色图，左 40% 全是黑烟，三个主色
    // 的原始距离只有 9；整张图才能取到 #543737 那块血红。
    set({ tintColors: backdrop ? await extractTints(backdrop) : [] })

    // 文字配色的输入：只看蒙版覆盖的左侧区域，右半区不影响文字可读性。
    // 这里只算平均色存起来，配色本身在 Stage 按当前生效的蒙版色现算（见 backdropAvg）。
    if (backdrop) {
      const color = await fac.getColorAsync(backdrop.url, {
        left: 0,
        top: 0,
        width: Math.max(1, Math.round(backdrop.width * 0.4)),
        height: backdrop.height,
        algorithm: "dominant",
      })
      set({ backdropAvg: [color.value[0], color.value[1], color.value[2]] })
    } else {
      set({ backdropAvg: null })
    }
  } catch (err) {
    // 保留上一张底图，不让画面塌掉（技术文档 §12）
    console.error("[skin] 图片加载失败", err)
  }
}
