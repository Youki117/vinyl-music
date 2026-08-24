import { useEffect, useRef } from "react"

import {
  DESIGN_W,
  LAYOUT_PARTS,
  SIDEBAR_TOOLS,
  clampOffset,
  offsetAfterNudge,
  sidebarOrderOf,
  useLayout,
  type Offset,
  type PartId,
  type SidebarToolId,
} from "@/store/layout"

const PART_LABEL = new Map<string, string>(LAYOUT_PARTS.map((p) => [p.id, p.label]))

/** 部件在设计坐标系里的默认位置与大小，外加舞台的缩放比 */
type PartMetrics = { rect: { x: number; y: number; w: number; h: number }; scale: number }

/**
 * DOM **此刻真正应用着**的偏移（而不是 store 里最新的那个）。
 *
 * 偏移是通过 `translate: var(--off-<id>-x/y)` 落到元素上的，所以计算样式里的
 * translate 就是当前这一帧被量进 getBoundingClientRect 的那份位移。
 *
 * 为什么不能直接用 store 里的值：连续微调时 React 可能把好几次 set 批到一起，
 * 一帧都没重排，此时 store 已经加到 +50 而 DOM 还停在 +20 —— 拿 store 的值去减，
 * 算出来的"默认位置"就会往负方向漂，夹取边界跟着一起漂，等于没夹。
 */
function appliedTranslate(host: HTMLElement): Offset {
  const raw = getComputedStyle(host).translate
  if (!raw || raw === "none") return { x: 0, y: 0 }
  const [x = 0, y = 0] = raw.split(/\s+/).map((v) => Number.parseFloat(v) || 0)
  return { x, y }
}

/**
 * 量一个部件。**拖动与方向键共用这一处** —— 两条路的夹取边界必须一模一样，
 * 各量各的迟早会漂。
 *
 * 返回的是部件的**默认**位置（当前实际位置减掉正应用着的偏移）：边界按默认位置算，
 * 否则每挪一次边界都会跟着跑。量不到（舞台还没排版）就返回 null，调用方原地不动。
 */
function measurePart(host: HTMLElement): PartMetrics | null {
  const content = document.querySelector(".content") as HTMLElement | null
  if (!content) return null

  // 设计坐标 → 屏幕像素的比例。舞台整体是缩放的，指针位移必须先除回去
  const contentRect = content.getBoundingClientRect()
  const scale = contentRect.width / DESIGN_W
  if (scale <= 0) return null

  const applied = appliedTranslate(host)
  const r = host.getBoundingClientRect()
  return {
    rect: {
      x: (r.left - contentRect.left) / scale - applied.x,
      y: (r.top - contentRect.top) / scale - applied.y,
      w: r.width / scale,
      h: r.height / scale,
    },
    scale,
  }
}

/**
 * 布局编辑层（需求 §4.3）。开着的时候整个画面覆一层，用来搬动部件。
 *
 * **用一层覆盖物接住所有指针事件**，而不是给每个部件挂拖拽处理：
 * 编辑态下点黑胶不该播放、点收藏不该收藏，逐个部件去禁用等于每加一个部件就要记得
 * 改一处。覆盖层天然把这些点击全挡住了，再用 elementsFromPoint 反查指针下面是哪个
 * 部件 —— 部件那边只需要标一个 data-part，别的什么都不用知道。
 */
export default function LayoutEdit() {
  const editing = useLayout((s) => s.editing)
  const offsets = useLayout((s) => s.offsets)
  const selected = useLayout((s) => s.selected)
  const sidebarOrder = useLayout((s) => s.sidebarOrder)
  const { setEditing, setOffset, reset, persist, select, moveSidebarTool, resetSidebarOrder } =
    useLayout.getState()
  const overlayRef = useRef<HTMLDivElement>(null)

  // 方向键微调。编辑态下这几个键归这里管 —— App 那边的快捷键会让开（见 App.tsx）
  useEffect(() => {
    if (!editing || !selected) return
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 1
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      const d = map[e.key]
      if (!d) return
      e.preventDefault()
      e.stopPropagation()

      // 和拖动一样要夹回可见范围，否则按住方向键能把部件推到画面外再也点不中
      const host = document.querySelector<HTMLElement>(`[data-part="${selected}"]`)
      if (!host) return
      const m = measurePart(host)
      if (!m) return
      const cur = useLayout.getState().offsets[selected] ?? { x: 0, y: 0 }
      setOffset(selected, offsetAfterNudge(m.rect, cur, d[0], d[1]))
      persist()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [editing, selected, setOffset, persist])

  if (!editing) return null

  /** 指针底下是哪个部件。覆盖层自己要跳过，否则永远只找到它 */
  const partAt = (x: number, y: number): { id: PartId; el: HTMLElement } | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === overlayRef.current || overlayRef.current?.contains(el)) continue
      const host = (el as HTMLElement).closest?.("[data-part]") as HTMLElement | null
      if (host) return { id: host.dataset.part as PartId, el: host }
    }
    return null
  }

  const beginDrag = (e: React.PointerEvent) => {
    const hit = partAt(e.clientX, e.clientY)
    if (!hit) {
      select(null)
      return
    }
    const m = measurePart(hit.el)
    if (!m) return
    const { rect: base, scale } = m
    const start = offsets[hit.id] ?? { x: 0, y: 0 }

    select(hit.id)
    const x0 = e.clientX
    const y0 = e.clientY

    const move = (ev: PointerEvent) => {
      const next: Offset = {
        x: Math.round(start.x + (ev.clientX - x0) / scale),
        y: Math.round(start.y + (ev.clientY - y0) / scale),
      }
      setOffset(hit.id, clampOffset(base, next))
    }
    const up = () => {
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", up)
      // 拖动中每帧都落盘没有意义，松手才写
      persist()
    }
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", up)
  }

  const moved = LAYOUT_PARTS.filter(({ id }) => {
    const o = offsets[id]
    return o && (o.x !== 0 || o.y !== 0)
  })

  /*
   * 侧栏按钮顺序改用列表 + 上下移，而不是在栏里拖。
   *
   * 编辑层已经把"拖动 = 搬部件"占掉了；同一个手势在侧栏里换成"拖动 = 换顺序"，
   * 用户没法预期哪次是哪个。两件事分开：整条栏拖着走，里面的顺序在这儿点。
   */
  const order = sidebarOrderOf(sidebarOrder)
  const toolLabel = (id: SidebarToolId) => SIDEBAR_TOOLS.find((t) => t.id === id)?.label ?? id

  return (
    <div ref={overlayRef} className="layout-edit" onPointerDown={beginDrag} data-keep-panel>
      <div className="layout-bar" onPointerDown={(e) => e.stopPropagation()}>
        <b>布局编辑</b>
        <span>
          {selected
            ? `已选中「${PART_LABEL.get(selected) ?? selected}」，方向键微调（Shift 一次 10px）`
            : "拖动画面上的部件调整位置"}
        </span>
        {selected && (
          <button onClick={() => reset(selected)} title="把这个部件放回默认位置">
            复位这个
          </button>
        )}
        {moved.length > 0 && (
          <button onClick={() => reset()} title="全部放回默认位置">
            全部复位（{moved.length}）
          </button>
        )}
        <button className="layout-done" onClick={() => setEditing(false)}>
          完成
        </button>
      </div>

      {selected === "sidebar" && (
        <div className="layout-order" onPointerDown={(e) => e.stopPropagation()}>
          <p className="layout-order-title">
            右侧栏顺序
            {sidebarOrder && (
              <button onClick={resetSidebarOrder} title="顺序恢复默认">
                恢复默认
              </button>
            )}
          </p>
          <ol>
            {order.map((id, i) => (
              <li key={id}>
                <span>{toolLabel(id)}</span>
                <button
                  onClick={() => moveSidebarTool(id, -1)}
                  disabled={i === 0}
                  aria-label={`${toolLabel(id)} 上移`}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  onClick={() => moveSidebarTool(id, 1)}
                  disabled={i === order.length - 1}
                  aria-label={`${toolLabel(id)} 下移`}
                  title="下移"
                >
                  ↓
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
