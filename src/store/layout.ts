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
  { id: "sidebar", label: "右侧栏" },
] as const

/**
 * 右侧栏里的按钮。**顺序可改**，所以这里给的是默认顺序而不是渲染顺序。
 *
 * 位置走 LAYOUT_PARTS 那套偏移（整条一起搬），顺序单独存一份 id 列表 ——
 * 两件事的数据形状不一样，混在一起会让偏移那套变复杂，而它现在很干净。
 */
export const SIDEBAR_TOOLS = [
  { id: "online", label: "搜索", hint: "在线搜索与歌单导入 (F)" },
  { id: "playback", label: "参数设置", hint: "播放与调音设置 (E)" },
  { id: "mix", label: "混音", hint: "混音 (X)" },
  { id: "skin", label: "底图与蒙版", hint: "底图、蒙版、文案与 AI 配图 (S)" },
  { id: "layout", label: "自定义组件位置", hint: "自定义组件位置与侧栏顺序" },
  { id: "volume", label: "音量", hint: "音量（M 静音）" },
  { id: "library", label: "曲库与歌单", hint: "曲库与歌单 (P)" },
] as const

export type SidebarToolId = (typeof SIDEBAR_TOOLS)[number]["id"]

const DEFAULT_SIDEBAR_ORDER: SidebarToolId[] = SIDEBAR_TOOLS.map((t) => t.id)

/**
 * 存下来的顺序 → 实际渲染顺序。
 *
 * 存的那份可能过期：以后加了新按钮，老用户的列表里没有它；删了按钮，老列表里
 * 还留着。所以每次都按 SIDEBAR_TOOLS 校一遍 —— 认识的按存的顺序排，
 * 存里没有的（新增的）补到末尾，不认识的（已删的）丢掉。
 */
export function sidebarOrderOf(saved: string[] | null): SidebarToolId[] {
  if (!saved) return DEFAULT_SIDEBAR_ORDER
  const known = new Set<string>(DEFAULT_SIDEBAR_ORDER)
  // seen 同时兼两件事：去重，以及算出"存里缺了哪些"。重复项会让同一个按钮渲染两次，
  // React 还会因为 key 撞车报警
  const seen = new Set<string>()
  const kept = saved.filter((id): id is SidebarToolId => {
    if (!known.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
  const missing = DEFAULT_SIDEBAR_ORDER.filter((id) => !seen.has(id))
  return [...kept, ...missing]
}

export type PartId = (typeof LAYOUT_PARTS)[number]["id"]

export type Offset = { x: number; y: number }
export type Offsets = Partial<Record<PartId, Offset>>

/** 设计坐标系，与 stage.css 的 .content 一致 */
export const DESIGN_W = 1243
export const DESIGN_H = 688

const SCHEMA = 2

type LayoutFile = {
  schemaVersion: number
  offsets: Offsets
  /** 右侧栏按钮顺序。没改过就不写，让默认顺序生效 */
  sidebarOrder?: string[]
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

/**
 * 在已有偏移上叠加一个增量，并夹回可见范围。
 *
 * 方向键微调必须和拖动走同一条约束。早先微调是直接 `cur.x + dx` 的，绕过了
 * clampOffset：按住 Shift+方向键几秒就能把部件推出画面，退出编辑后它已经不在
 * 画面上、点不中，只剩"全部复位"一条路 —— 而那会把其它部件的自定义位置一起清掉，
 * 正是 clampOffset 上面那段说要避免的结局。
 */
export function offsetAfterNudge(
  rect: { x: number; y: number; w: number; h: number },
  current: Offset,
  dx: number,
  dy: number,
): Offset {
  return clampOffset(rect, { x: current.x + dx, y: current.y + dy })
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
  /** 右侧栏按钮顺序。null = 没改过，用默认 */
  sidebarOrder: string[] | null
  /** 编辑模式：部件描边、可拖动，且本来的点击行为一律不触发 */
  editing: boolean
  /** 最近动过的部件。方向键微调作用在它身上 */
  selected: PartId | null

  load(): Promise<void>
  setEditing(on: boolean): void
  select(id: PartId | null): void
  /**
   * 直接设定偏移（拖动中调用，所以不落盘，松手时才落）。
   *
   * 夹取在调用方做 —— 边界要按部件的默认位置与大小算，那只有量过 DOM 的
   * LayoutEdit 知道。store 这一层不碰 DOM，见 offsetAfterNudge。
   */
  setOffset(id: PartId, off: Offset): void
  /** 把右侧栏里的某个按钮上移/下移一格 */
  moveSidebarTool(id: SidebarToolId, dir: -1 | 1): void
  /** 右侧栏顺序恢复默认 */
  resetSidebarOrder(): void
  /** 不传 id 就是全部复位。位置与顺序一起还原 */
  reset(id?: PartId): void
  /** 落盘。拖动过程中不落，松手调一次 */
  persist(): void
}

let saveTimer = 0

export const useLayout = create<LayoutState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const file: LayoutFile = {
        schemaVersion: SCHEMA,
        offsets: get().offsets,
        ...(get().sidebarOrder ? { sidebarOrder: get().sidebarOrder ?? undefined } : {}),
      }
      void platform.writeConfig("layout", file)
    }, 400)
  }

  return {
    offsets: {},
    sidebarOrder: null,
    editing: false,
    selected: null,

    async load() {
      const raw = await platform.readConfig<LayoutFile>("layout")
      if (raw?.offsets) set({ offsets: raw.offsets })
      if (Array.isArray(raw?.sidebarOrder)) {
        if ((raw.schemaVersion ?? 0) < 2) {
          // v2 增加曲库入口，并按用户确认的七项顺序重新排过。旧顺序只在这次升级时
          // 归位一次；迁移落盘后，用户之后从布局编辑里做的自定义仍会照常保留。
          set({ sidebarOrder: null })
          save()
        } else {
          set({ sidebarOrder: raw.sidebarOrder })
        }
      }
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

    moveSidebarTool(id, dir) {
      const cur = [...sidebarOrderOf(get().sidebarOrder)]
      const i = cur.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= cur.length) return
      ;[cur[i], cur[j]] = [cur[j], cur[i]]
      set({ sidebarOrder: cur })
      save()
    },

    resetSidebarOrder() {
      set({ sidebarOrder: null })
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
        set({ offsets: {}, sidebarOrder: null })
      }
      save()
    },

    persist() {
      save()
    },
  }
})
