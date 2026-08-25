import { create } from "zustand"
import { FastAverageColor } from "fast-average-color"

import { isVideoFile, platform, toObjectUrl, videoMime, type FileRef } from "@/platform"
import {
  backdropHistoryFile,
  readBackdropHistory,
  rememberBackdrop,
  type CustomBackdrop,
} from "@/skin/backdropHistory"
import { DEFAULT_SKIN, makeSkin, migrateSkins, SKIN_SCHEMA_VERSION, type Skin, type SkinsFile } from "@/skin/model"
import { dominantColors, veilTintsFrom } from "@/skin/palette"
import { builtinBackdropUrl } from "@/skin/backdrops"
import { planEviction } from "@/skin/evict"
import { labelSourceId } from "@/skin/resolve"
import type { VeilParams } from "@/stage/veil/renderer"

/**
 * 底图的运行时解析结果。持久化的是 FileRef.id，用时才转成 object URL。
 *
 * 视频底图和图片底图共用这一个类型，差别只有 `kind` 和 `poster` 两处。
 */
export type LoadedMedia = {
  url: string
  /** 原始像素尺寸。视频取 videoWidth/videoHeight，与 poster 的尺寸一致。 */
  width: number
  height: number
  kind: "image" | "video"
  /**
   * **静态取样帧**。图片就是 url 自己；视频是从开头截下来的一帧。
   *
   * 所有"把底图当一张图看"的下游都吃它而不是 url —— 蒙版取色、文字配色的平均色、
   * 历史缩略图、黑胶贴纸 —— 于是那几处一行都不用改，同时白捡一条更要紧的性质：
   * **取色只发生一次，之后冻住**。真跟着视频逐帧取，蒙版色和文字色会每秒抖几十下，
   * 正是 Stage.tsx 注释里已经否掉的那种"一首歌里换三次色"，只是更糟。
   */
  poster: string
}

type SkinState = {
  skin: Skin
  skins: Skin[]
  backdrop: LoadedMedia | null
  label: LoadedMedia | null
  /** 切换底图时的旧图，用于交叉淡入 */
  fading: LoadedMedia | null
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

  /**
   * **临时**盖在基础底图上的那张（歌曲专属 AI 配图）。null = 用基础底图。
   *
   * 刻意不写进 `skin.backdrop`：那个是要落盘的"基础底图"，代表用户的选择。
   * 专属图只在那首歌播放时生效，切走就该回到基础 —— 写进去的话，随便听一首歌
   * 就把用户手选的底图永久顶掉了，而且每切一首都触发一次存盘与历史记录。
   */
  overrideBackdrop: string | null

  load(): Promise<void>
  setBackdrop(ref: FileRef, remember?: boolean): Promise<void>
  /**
   * 设置/清除临时覆盖。传 null 回到基础底图。
   * 与 setBackdrop 的区别：不落盘、不进"手选底图"历史、不改 skin。
   */
  setBackdropOverride(id: string | null): Promise<void>
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
const urlCache = new Map<string, LoadedMedia>()
const URL_CACHE_MAX = 6

/**
 * 视频底图额外的上限。**只留 1 份**（外加钉住的），理由见 skin/evict.ts。
 *
 * 一句话：6 这个数是按 2MB 的 jpg 定的，而一段视频底图是整个文件驻留在内存里，
 * 同一个格子数放视频要贵两个数量级。
 */
const VIDEO_CACHE_MAX = 1

/** 正在用的图不能被淘汰掉，否则底图会当场变白 */
let pinnedIds: string[] = []

/**
 * 当前真正在显示的那两张（底图 / 贴纸）的 id。
 *
 * 底图取**临时覆盖优先**，否则基础底图 —— 取色、平均色、贴纸都得跟着真正显示的那张
 * 走，否则听一首有专属 AI 配图的歌时，画面是 A 而配色取自 B，文字对比度会算错。
 *
 * 抽出来是因为有两处要用同一套判断：refreshImages 进来时钉表，转场结束时重算钉表。
 * 两边各写一份的话，哪天 label 的取值规则变了，只改一处就会让另一处解错钉。
 */
function activeIds(state: SkinState): { backdrop: string | null; label: string | null } {
  const backdrop = state.overrideBackdrop ?? state.skin.backdrop
  const label = state.skin.label.source === "backdrop" ? backdrop : labelSourceId(state.skin)
  return { backdrop, label }
}

/**
 * 正在交叉淡出的旧底图 id，转场那 700ms 里也不能被淘汰。
 *
 * 它不在 skin 里（skin.backdrop 已经指向新图了），光钉 skin 上那两张钉不住它 ——
 * 700ms 内连切六张底图就会把它 revoke 掉，淡入当场闪一下白。概率不高，但代价是一行。
 */
let fadingId: string | null = null

/** 转场收场定时器的代际。700ms 内连换两张底图时，前一个定时器不许掐断后一个的淡入。 */
let fadeSeq = 0

/** 结束转场：只有最后一次安排的定时器有资格清 fading。 */
function scheduleFadingEnd(
  set: (p: Partial<SkinState>) => void,
  get: () => SkinState,
): void {
  const mine = ++fadeSeq
  window.setTimeout(() => {
    if (mine !== fadeSeq) return
    fadingId = null
    /*
     * 转场结束，旧底图不再需要保护 —— 重算钉表并立刻收一次缓存。
     *
     * 不在这里收，那份旧的要等到**下一次 loadMedia** 才有机会被淘汰；而"换一张就
     * 不动了"恰恰是最常见的用法，于是稳定多占一份。图片时代无所谓（多留一张 jpg），
     * 视频底图下就是白占几十上百兆。
     *
     * 重算而不是从钉表里摘掉 fadingId：用户重新选中同一张图时，fadingId 和当前底图
     * 是同一个 id，摘掉它等于把正在显示的那张解了钉，下一轮淘汰会把画面撤成白的。
     *
     * 与在飞的 refreshImages 不冲突：上面的代际检查保证只有最后一次转场能走到这里，
     * 此时在飞的那次读的是同一份状态，算出来的钉表与这里一致，只少一个 fadingId ——
     * 而那正是要放掉的。
     */
    const { backdrop, label } = activeIds(get())
    pinnedIds = [backdrop, label].filter((v): v is string => !!v)
    evictMedia()
    set({ fading: null })
  }, 700)
}

function evictMedia(): void {
  const entries = [...urlCache].map(([id, media]) => ({ id, kind: media.kind }))
  for (const id of planEviction(entries, pinnedIds, {
    total: URL_CACHE_MAX,
    video: VIDEO_CACHE_MAX,
  })) {
    const media = urlCache.get(id)
    if (!media) continue
    URL.revokeObjectURL(media.url)
    // poster 是 data: URL，没有可撤的句柄，跟着这条记录一起被 GC
    urlCache.delete(id)
  }
}

async function loadMedia(id: string | null): Promise<LoadedMedia | null> {
  if (!id) return null
  const hit = urlCache.get(id)
  if (hit) {
    // 命中就挪到末尾，让淘汰顺序反映最近使用
    urlCache.delete(id)
    urlCache.set(id, hit)
    return hit
  }

  /*
   * 内置底图是打包进产物的静态资源，直接用它的 URL；用户导入的才走
   * platform.readFile 转 object URL。淘汰时对静态 URL 调 revokeObjectURL
   * 是空操作（规范如此），所以下面那套缓存逻辑不用分叉。
   *
   * 内置底图全是图片，所以「是不是视频」只对用户文件问 —— 否则 `builtin:a`
   * 这种没有扩展名的 id 还要额外照顾。
   */
  const builtin = builtinBackdropUrl(id)
  const video = builtin === null && isVideoFile(id)

  /*
   * 视频优先走宿主的流式 URL（Tauri 下是 asset://），拿不到才退回 toObjectUrl。
   *
   * 差别是本质的：toObjectUrl 把**整个文件**读进内存，一段 200MB 的壁纸就占 200MB，
   * 与播到第几秒无关；流式那条按 Range 供给，内存只留一个缓冲窗口。图片不走这条 ——
   * 它们本来就小，而且 poster 直接复用 url，同源省掉一整套 CORS 顾虑。
   *
   * 退回路径不是摆设：浏览器 dev 模式没有真实路径，streamUrl 恒返回 null。
   */
  const streamed = video ? await platform.streamUrl(id).catch(() => null) : null
  const url =
    builtin ??
    streamed ??
    (await toObjectUrl({ id, name: id, size: 0, mtime: 0 }, video ? videoMime(id) : undefined))

  try {
    const loaded = video ? await probeVideo(url) : await probeImage(url)
    urlCache.set(id, loaded)
    evictMedia()
    return loaded
  } catch (err) {
    // 加载失败的 URL 也要还回去，不然这条泄漏路径反而最容易被触发
    URL.revokeObjectURL(url)
    throw new Error(`底图无法识别：${id}`, { cause: err })
  }
}

async function probeImage(url: string): Promise<LoadedMedia> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error("图片解码失败"))
    img.src = url
  })
  return { url, width: img.naturalWidth, height: img.naturalHeight, kind: "image", poster: url }
}

/**
 * 读出视频的尺寸，并截一帧当 poster。
 *
 * **不取第 0 帧**：很多片子开头是黑场或淡入，取到的就是一块纯黑，于是蒙版取色和
 * 文字配色全按"深色底图"算，跟观众实际看到的画面对不上。往后挪一点，挪多少按时长
 * 成比例，三五秒的循环壁纸也不至于挪过头。
 */
async function probeVideo(url: string): Promise<LoadedMedia> {
  const el = document.createElement("video")
  el.preload = "auto"
  el.muted = true
  el.playsInline = true
  /*
   * 跨源视频会**污染 canvas**，那样下面的 toDataURL 直接抛 SecurityError，poster 取不到，
   * 蒙版取色、文字配色、唱片贴纸整条链一起断。asset:// 与页面不同源，所以必须声明
   * anonymous 走一遍 CORS —— tauri 的 protocol/asset.rs 每个响应都带
   * `Access-Control-Allow-Origin: <window_origin>`，正好放行本窗口。
   *
   * blob: 是同源的，本来就不需要，也不该设：给同源资源发起 CORS 检查没有收益，
   * 只多一条可能出岔子的路径。
   */
  if (!url.startsWith("blob:")) el.crossOrigin = "anonymous"
  el.src = url

  try {
    await videoEvent(el, "loadedmetadata")
    const width = el.videoWidth
    const height = el.videoHeight
    // 纯音频文件套了个视频扩展名时会走到这里，早点说清楚，别留一块黑屏
    if (width <= 0 || height <= 0) throw new Error("这个文件里没有画面轨道")

    if (Number.isFinite(el.duration) && el.duration > 0) {
      el.currentTime = Math.min(1.5, el.duration * 0.1)
      await videoEvent(el, "seeked")
    } else {
      // 时长未知（某些流式 webm）就退一步，只等第一帧解出来
      await videoEvent(el, "loadeddata")
    }

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("无法创建视频取样帧")
    ctx.drawImage(el, 0, 0, width, height)

    /*
     * 按原始尺寸截，不缩。
     *
     * 下游有两处吃像素坐标而不是比例：贴纸取景（labelBackground 按 width/height 算
     * 取景框边长）和文字配色（fac 的裁剪矩形是 backdrop.width * 0.4）。poster 缩过
     * 而 width/height 报的是视频原始尺寸的话，这两处会一起算歪。
     * 1080p 一帧 JPEG 约 200KB，而这张表最多存 6 条，不值得为它引入一个尺寸字段。
     */
    return { url, width, height, kind: "video", poster: canvas.toDataURL("image/jpeg", 0.9) }
  } finally {
    // 探测用的元素必须解绑：只丢引用的话它还攥着解码器和这份 blob 不放
    el.removeAttribute("src")
    el.load()
  }
}

/**
 * 等视频的某个事件，同时盯着 error 和超时。
 *
 * 超时那一路不是防御性冗余：坏文件能让 `seeked` 和 `error` 都不触发，那样这个
 * Promise 永远挂着，refreshImages 里的 await 跟着永远不返回 —— 画面会僵在上一张，
 * 而且没有任何报错。
 */
function videoEvent(el: HTMLVideoElement, event: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error(`视频${event}超时`)), 10_000)
    const onOk = () => finish(null)
    const onErr = () => finish(new Error(el.error?.message || "视频解码失败"))

    function finish(err: Error | null): void {
      window.clearTimeout(timer)
      el.removeEventListener(event, onOk)
      el.removeEventListener("error", onErr)
      if (err) reject(err)
      else resolve()
    }

    el.addEventListener(event, onOk)
    el.addEventListener("error", onErr)
  })
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
async function thumbnailOf(img: LoadedMedia): Promise<string> {
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
    source.src = img.poster
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
  overrideBackdrop: null,

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
    await enqueueRefresh(set, get)
  },

  async setBackdrop(ref, shouldRemember = true) {
    await platform.ensureReadable([ref.id])
    let loaded: LoadedMedia
    try {
      // 先确认目标真的能读，再改 skin；历史文件被移走时不会把当前画面切成空白。
      const target = await loadMedia(ref.id)
      if (!target) return
      loaded = target
    } catch (err) {
      console.error("[skin] 底图无法加载", err)
      return
    }

    const prev = get().backdrop
    fadingId = get().overrideBackdrop ?? get().skin.backdrop
    /*
     * 手动选图 = 用户明确表达"我要这张"，所以它成为新的基础底图，并且**清掉临时覆盖** ——
     * 否则会出现"选了图但画面没变"（专属图还盖在上面），是最让人困惑的一类 bug。
     */
    set((s) => ({ skin: { ...s.skin, backdrop: ref.id }, fading: prev, overrideBackdrop: null }))
    await enqueueRefresh(set, get)
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
    scheduleFadingEnd(set, get)
  },

  async setBackdropOverride(id) {
    if (get().overrideBackdrop === id) return

    if (id) {
      await platform.ensureReadable([id])
      // 先确认能读再切；专属图被手动删掉时不该把画面变空白，而是留在基础底图上
      const ok = await loadMedia(id).catch(() => null)
      if (!ok) return
    }

    const prev = get().backdrop
    fadingId = get().overrideBackdrop ?? get().skin.backdrop
    set({ overrideBackdrop: id, fading: prev })
    await enqueueRefresh(set, get)
    // 刻意不调 scheduleSave：这一层本来就不该落盘
    scheduleFadingEnd(set, get)
  },

  async setLabelSource(ref) {
    const source = ref === "backdrop" ? "backdrop" : ref.id
    set((s) => ({ skin: { ...s.skin, label: { ...s.skin.label, source } } }))
    await enqueueRefresh(set, get)
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
    await enqueueRefresh(set, get)
    scheduleSave(get)
    scheduleFadingEnd(set, get)
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
    await enqueueRefresh(set, get)
    scheduleSave(get)
  },
}))

/**
 * 从整张底图提取三个可用作蒙版色的主色。
 *
 * 缩到 96px 宽再取样：主色调不需要全分辨率，一张 4K 底图逐像素统计要几千万次循环，
 * 而缩图之后结果几乎一样。
 */
async function extractTints(img: LoadedMedia): Promise<string[]> {
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
      bitmap.src = img.poster
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
  const { backdrop: activeBackdrop, label: activeLabel } = activeIds(get())
  try {
    // 先钉住这一轮要用的两张，免得加载第二张时把第一张淘汰掉
    pinnedIds = [activeBackdrop, activeLabel, fadingId].filter((v): v is string => !!v)
    const backdrop = await loadMedia(activeBackdrop)
    const label = await loadMedia(activeLabel)
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
      const color = await fac.getColorAsync(backdrop.poster, {
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

/*
 * refreshImages 必须串行。
 *
 * 它一进来就覆写模块级的 pinnedIds（钉住本轮要用的两张图不被 LRU 淘汰）。两次并发
 * 的话，后一次的钉表会把前一次的盖掉 —— 前一次还在 probeImage 里的那张瞬间失去
 * 保护，可能被 evictMedia 当场 revoke，换来的就是偶发的底图闪白。快速切歌时 AI 配图
 * 来回覆盖、用户连点预设，都恰好构成这种并发。排成一条链：后一次等前一次落地再开始，
 * 反正它读的是当时的最新状态，最终结果不变，只是把浪费的那次变成顺序的重算。
 */
let refreshChain: Promise<void> = Promise.resolve()

function enqueueRefresh(
  set: (p: Partial<SkinState>) => void,
  get: () => SkinState,
): Promise<void> {
  const run = refreshChain.then(() => refreshImages(set, get))
  // 链上只留"已落地"的尾巴：某一次失败（loadMedia 抛错已被内部接住，这里只是兜底）
  // 不能传染给后面排队的每一次
  refreshChain = run.then(
    () => {},
    () => {},
  )
  return run
}
