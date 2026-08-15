import { DEFAULT_VEIL, type VeilParams } from "@/stage/veil/renderer"

export const SKIN_SCHEMA_VERSION = 1

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
  }
  veil: VeilParams
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
  backdrop: null,
  backdropFocus: { x: 0.5, y: 0.5 },
  label: { source: "backdrop", focus: { ...DEFAULT_LABEL_FOCUS } },
  veil: { ...DEFAULT_VEIL },
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

export function makeSkin(patch: Partial<Skin> = {}): Skin {
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

/** 迁移链。加载旧版配置时按 schemaVersion 逐级升级，不洗掉用户数据。 */
export function migrateSkins(raw: unknown): SkinsFile | null {
  if (!raw || typeof raw !== "object") return null
  const file = raw as Partial<SkinsFile>
  if (!Array.isArray(file.skins)) return null
  // v1 是当前版本，暂无历史版本需要迁移
  return {
    schemaVersion: SKIN_SCHEMA_VERSION,
    activeId: file.activeId ?? DEFAULT_SKIN.id,
    skins: file.skins.map((s) => makeSkin(s)),
  }
}
