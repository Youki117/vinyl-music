import { BUILTIN_PREFIX } from "@/skin/backdrops"
import { DEFAULT_VEIL, type VeilParams } from "@/stage/veil/renderer"

export const SKIN_SCHEMA_VERSION = 2

export type Focus = { x: number; y: number }

/** 唱片贴纸的取景框：中心位置 + 缩放倍数。 */
export type LabelFocus = { x: number; y: number; zoom: number }

export type Ink = {
  /** 是否从底图自动取色 */
  auto: boolean
  /** 当前行歌词、主要文字 */
  primary: string
  /** 次要文字、时间、控件 */
  secondary: string
  /** 品牌铜金色，用于标题 */
  accent: string
}

export type SkinText = {
  title: string
  subtitle: string
  year: string
  byline: string
}

export type Skin = {
  id: string
  name: string
  /** FileRef.id；null 表示用内置底纹 */
  backdrop: string | null
  backdropFocus: Focus
  label: {
    /** "backdrop" = 跟随底图切换；否则是另一张图的 FileRef.id */
    source: "backdrop" | string
    focus: LabelFocus
    /**
     * 黑胶中心那块贴纸，曲目自带的封面和皮肤指定的图谁优先。
     *
     * - `"cover"`（默认）：有内嵌封面就用封面，没有才退回皮肤的图。唱片上放专辑封面
     *   是主流播放器的样子，多数人期待的也是这个。
     * - `"skin"`：皮肤指定的图（跟随底图或单独指定）永远优先，封面只在没有皮肤图时出现。
     *   想要整屏统一视觉、不被各家封面打断的人选这个。
     */
    prefer: "cover" | "skin"
  }
  veil: VeilParams
  /**
   * 蒙版色是否自动从底图取。
   *
   * 开启时忽略 `veil.tint`，改用从底图提取的三个主色，按播放进度每首歌切三次。
   * 用户一旦手动调过蒙版色就自动关掉 —— 用户的选择优先级更高，面板上有开关能开回来。
   *
   * 放在 Skin 而不是 VeilParams 里：VeilParams 是喂给渲染器的，渲染器不该看见
   * 一个它永远用不上的开关。预设套用时单独带上它（见 store/skin.ts 的 applyVeilFrom）。
   */
  tintAuto: boolean
  ink: Ink
  text: SkinText
}

/**
 * 默认取景框中心偏上（y=0.32）：人物照片的头部绝大多数落在画面上三分之一，
 * 这个默认值让用户导入新图后无需调参就能取到人脸。
 */
export const DEFAULT_LABEL_FOCUS: LabelFocus = { x: 0.5, y: 0.32, zoom: 2.2 }

export const DEFAULT_SKIN: Skin = {
  id: "default",
  name: "默认",
  // 装完就有一张真图。留 null 的话首屏只有一层 CSS 渐变，而蒙版、墨色、贴纸取色
  // 全是从底图现算的 —— 没有底图，这套东西一样都看不出来
  backdrop: `${BUILTIN_PREFIX}b`,
  backdropFocus: { x: 0.5, y: 0.5 },
  label: { source: "backdrop", focus: { ...DEFAULT_LABEL_FOCUS }, prefer: "cover" },
  veil: { ...DEFAULT_VEIL },
  /*
   * 默认关：出厂就用 DEFAULT_VEIL 那层近白蒙版（#f7f5f0）。
   *
   * 自动取色会拿底图的三个主色去染蒙版，观感随图乱跳、也压掉了这套版式本来的
   * 素白调子。想要的人在皮肤面板里一开就有，但不该是第一眼看到的样子。
   */
  tintAuto: false,
  ink: {
    auto: true,
    primary: "#3a3a37",
    secondary: "#7b7975",
    accent: "#b2845f",
  },
  // 文案照抄效果图。SELP-PORTRAIT 是原图的拼写，还原优先，保留原样。
  text: {
    title: "FASHION",
    subtitle: "SELP-PORTRAIT",
    year: "1901",
    byline: "Xiaojie-for you",
  },
}

export type SkinsFile = {
  schemaVersion: number
  activeId: string
  skins: Skin[]
}

/**
 * makeSkin 接受的补丁。
 *
 * 嵌套字段是**逐层浅合并**的，所以类型上也该允许只给其中几项 ——
 * 从前写的是 `Partial<Skin>`，那要求 veil / ink / text / label 要给就给全套，
 * 比函数实际的行为严格，调用方只好把不关心的字段也抄一遍。
 */
export type SkinPatch = Omit<Partial<Skin>, "veil" | "ink" | "text" | "label"> & {
  veil?: Partial<VeilParams>
  ink?: Partial<Ink>
  text?: Partial<SkinText>
  label?: Partial<Skin["label"]>
}

export function makeSkin(patch: SkinPatch = {}): Skin {
  return {
    ...DEFAULT_SKIN,
    ...patch,
    id: patch.id ?? `skin-${Date.now().toString(36)}`,
    veil: { ...DEFAULT_SKIN.veil, ...patch.veil },
    ink: { ...DEFAULT_SKIN.ink, ...patch.ink },
    text: { ...DEFAULT_SKIN.text, ...patch.text },
    label: { ...DEFAULT_SKIN.label, ...patch.label },
  }
}

/**
 * v1 → v2：蒙版律动删除后的字段变更。
 *
 * - `veil.breath` 更名为 `veil.ripple`。它原本是"静音时的呼吸底噪"，现在没有任何东西
 *   在动了，就是一个纯静态的边缘起伏强度。名字不改的话，下一个读代码的人会去找
 *   哪里在"呼吸"。
 * - `veil.waveAmp`（跟随音乐的波动强度）整个删除。
 *
 * 不直接把旧值丢掉：用户可能把 breath 调过，迁移过来能保住他调好的形状。
 */
function v1ToV2(skin: unknown): unknown {
  if (!skin || typeof skin !== "object") return skin
  const s = skin as { veil?: Record<string, unknown> }
  if (!s.veil || typeof s.veil !== "object") return skin
  const { breath, waveAmp: _dropped, ...rest } = s.veil
  return { ...s, veil: { ...rest, ripple: typeof breath === "number" ? breath : rest.ripple } }
}

/** 迁移链。加载旧版配置时按 schemaVersion 逐级升级，不洗掉用户数据。 */
export function migrateSkins(raw: unknown): SkinsFile | null {
  if (!raw || typeof raw !== "object") return null
  const file = raw as Partial<SkinsFile>
  if (!Array.isArray(file.skins)) return null

  // 版本号缺失的一律按 v1 处理：v1 那会儿写盘就没有可靠的版本标记
  const from = typeof file.schemaVersion === "number" ? file.schemaVersion : 1
  let skins: unknown[] = file.skins
  if (from < 2) skins = skins.map(v1ToV2)

  return {
    schemaVersion: SKIN_SCHEMA_VERSION,
    activeId: file.activeId ?? DEFAULT_SKIN.id,
    skins: skins.map((s) => makeSkin(s as Partial<Skin>)),
  }
}
