import { create } from "zustand"

import { platform } from "@/platform"

/**
 * 组件位置自定义（需求 §4.3）。
 *
 * 存的是**相对默认位置的偏移**，不是绝对坐标。默认位置在 CSS 里（版式是照参考图
 * 一个像素一个像素对出来的，SSIM 关口盯着它），改成由 JS 给绝对坐标就等于把那份版式
 * 搬进了状态里 —— 以后调 CSS 不再生效，而用户存下的旧坐标会永远盖住新版式。
 * 存偏移则是叠加关系：没动过的部件跟着 CSS 走，动过的在此基础上平移。
 */

/** 可以搬动的部件。id 同时是 CSS 变量名的一部分（--off-<id>-x/y） */
export const LAYOUT_PARTS = [
  { id: "masthead", label: "标题" },
  { id: "byline", label: "署名条" },
  { id: "lyrics", label: "歌词" },
  { id: "disc", label: "黑胶" },
  { id: "actions", label: "收藏与播放次数" },
  { id: "transport", label: "进度条与控制" },
] as const

export type PartId = (typeof LAYOUT_PARTS)[number]["id"]

export type Offset = { x: number; y: number }
export type Offsets = Partial<Record<PartId, Offset>>

/** 设计坐标系，与 stage.css 的 .content 一致 */
export const DESIGN_W = 1243
export const DESIGN_H = 688

const SCHEMA = 1

type LayoutFile = {
  schemaVersion: number
  offsets: Offsets
}

/**
 * 把偏移夹进"部件至少还有一角在画面里"的范围。
 *
 * 纯函数，因为这是唯一容易写反的一段：允许拖出画面才是对的（有人就想把署名条藏起来），
 * 但**不能允许拖到完全找不回来** —— 那样用户只剩"全部复位"一条路。所以留一块
 * KEEP_VISIBLE 大小的余量必须还在舞台内。
 *
 * @param rect 部件在设计坐标系里的默认位置与大小
 */
export function clampOffset(rect: { x: number; y: number; w: number; h: number }, off: Offset): Offset {
  const keep = Math.min(KEEP_VISIBLE, rect.w, rect.h)
  return {
    x: clamp(off.x, -rect.x - rect.w + keep, DESIGN_W - rect.x - keep),
    y: clamp(off.y, -rect.y - rect.h + keep, DESIGN_H - rect.y - keep),
  }
}

/** 至少要留在画面里的边长（设计像素） */
const KEEP_VISIBLE = 24

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 偏移 → CSS 变量。没动过的部件不写变量，让 CSS 的默认值生效 */
export function offsetsToVars(offsets: Offsets): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { id } of LAYOUT_PARTS) {
    const o = offsets[id]
    if (!o || (o.x === 0 && o.y === 0)) continue
    out[`--off-${id}-x`] = `${o.x}px`
    out[`--off-${id}-y`] = `${o.y}px`
  }
  return out
}

type LayoutState = {
  offsets: Offsets
  /** 编辑模式：部件描边、可拖动，且本来的点击行为一律不触发 */
  editing: boolean
  /** 最近动过的部件。方向键微调作用在它身上 */
  selected: PartId | null

  load(): Promise<void>
  setEditing(on: boolean): void
  select(id: PartId | null): void
  /** 直接设定偏移（拖动中调用，所以不落盘，松手时才落） */
  setOffset(id: PartId, off: Offset): void
  /** 相对当前偏移挪一点（方向键微调） */
  nudge(id: PartId, dx: number, dy: number): void
  /** 不传 id 就是全部复位 */
  reset(id?: PartId): void
  /** 落盘。拖动过程中不落，松手调一次 */
  persist(): void
}

let saveTimer = 0

export const useLayout = create<LayoutState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const file: LayoutFile = { schemaVersion: SCHEMA, offsets: get().offsets }
      void platform.writeConfig("layout", file)
    }, 400)
  }

  return {
    offsets: {},
    editing: false,
    selected: null,

    async load() {
      const raw = await platform.readConfig<LayoutFile>("layout")
      if (raw?.offsets) set({ offsets: raw.offsets })
    },

    setEditing(on) {
      set({ editing: on, selected: on ? get().selected : null })
    },

    select(id) {
      set({ selected: id })
    },

    setOffset(id, off) {
      set((s) => ({ offsets: { ...s.offsets, [id]: off }, selected: id }))
    },

    nudge(id, dx, dy) {
      const cur = get().offsets[id] ?? { x: 0, y: 0 }
      set((s) => ({ offsets: { ...s.offsets, [id]: { x: cur.x + dx, y: cur.y + dy } }, selected: id }))
      save()
    },

    reset(id) {
      if (id) {
        set((s) => {
          const next = { ...s.offsets }
          delete next[id]
          return { offsets: next }
        })
      } else {
        set({ offsets: {} })
      }
      save()
    },

    persist() {
      save()
    },
  }
})
