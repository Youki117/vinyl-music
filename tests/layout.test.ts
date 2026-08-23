import { describe, expect, it } from "vitest"

import {
  DESIGN_H,
  DESIGN_W,
  SIDEBAR_TOOLS,
  clampOffset,
  offsetAfterNudge,
  offsetsToVars,
  sidebarOrderOf,
} from "@/store/layout"

/** 歌词栏的默认位置与大小，取自 ui.css */
const lyrics = { x: 8, y: 268, w: 208, h: 152 }

describe("偏移夹取", () => {
  it("画面之内的偏移原样通过", () => {
    expect(clampOffset(lyrics, { x: 40, y: -60 })).toEqual({ x: 40, y: -60 })
  })

  /**
   * 允许拖出画面是对的（有人就想把署名条藏起来），但不能允许拖到完全找不回来 ——
   * 那样用户只剩"全部复位"一条路。
   */
  it("拖得再远也留一角在画面里", () => {
    const far = clampOffset(lyrics, { x: -99999, y: -99999 })
    // 部件右下角仍在舞台左上角之内
    expect(lyrics.x + far.x + lyrics.w).toBeGreaterThan(0)
    expect(lyrics.y + far.y + lyrics.h).toBeGreaterThan(0)

    const far2 = clampOffset(lyrics, { x: 99999, y: 99999 })
    // 部件左上角仍在舞台右下角之内
    expect(lyrics.x + far2.x).toBeLessThan(DESIGN_W)
    expect(lyrics.y + far2.y).toBeLessThan(DESIGN_H)
  })

  // 标题块又宽又高（470×180），夹取要按它自己的尺寸算，不能套一个固定余量
  it("大块部件同样留得住一角", () => {
    const masthead = { x: 26, y: 2, w: 470, h: 180 }
    const right = clampOffset(masthead, { x: 5000, y: 0 })
    expect(masthead.x + right.x).toBeLessThan(DESIGN_W)
    expect(masthead.x + right.x + masthead.w).toBeGreaterThan(DESIGN_W)

    const up = clampOffset(masthead, { x: 0, y: -5000 })
    expect(masthead.y + up.y).toBeLessThan(0)
    expect(masthead.y + up.y + masthead.h).toBeGreaterThan(0)
  })
})

/*
 * 方向键微调早先是绕过夹取的（直接 cur.x + dx），拖动却夹了 —— 同一个约束两条路
 * 两种行为。按住 Shift+方向键几秒就能把部件推出画面，退出编辑后点不中它，
 * 只剩"全部复位"，而那会把其它部件的自定义位置一起清掉。
 */
describe("方向键微调", () => {
  it("画面之内的微调照常叠加", () => {
    expect(offsetAfterNudge(lyrics, { x: 10, y: 10 }, -1, 10)).toEqual({ x: 9, y: 20 })
  })

  it("一直按也推不出画面", () => {
    let off = { x: 0, y: 0 }
    // Shift 一次 10px，按住不放两百下
    for (let i = 0; i < 200; i++) off = offsetAfterNudge(lyrics, off, 10, 10)

    expect(lyrics.x + off.x).toBeLessThan(DESIGN_W)
    expect(lyrics.y + off.y).toBeLessThan(DESIGN_H)
  })

  it("反方向一直按也推不出画面", () => {
    let off = { x: 0, y: 0 }
    for (let i = 0; i < 200; i++) off = offsetAfterNudge(lyrics, off, -10, -10)

    expect(lyrics.x + off.x + lyrics.w).toBeGreaterThan(0)
    expect(lyrics.y + off.y + lyrics.h).toBeGreaterThan(0)
  })

  it("与拖动落在完全相同的边界上", () => {
    const nudged = offsetAfterNudge(lyrics, { x: 99990, y: 99990 }, 10, 10)
    expect(nudged).toEqual(clampOffset(lyrics, { x: 100000, y: 100000 }))
  })
})

describe("偏移 → CSS 变量", () => {
  it("只给动过的部件写变量，没动过的走 CSS 默认版式", () => {
    const vars = offsetsToVars({ lyrics: { x: 12, y: -4 }, disc: { x: 0, y: 0 } })
    expect(vars).toEqual({ "--off-lyrics-x": "12px", "--off-lyrics-y": "-4px" })
  })

  it("什么都没动就是空的", () => {
    expect(offsetsToVars({})).toEqual({})
  })
})

describe("右侧栏顺序：存下来的那份可能过期", () => {
  const DEFAULT = SIDEBAR_TOOLS.map((t) => t.id)

  it("新默认顺序与已确认的八个入口一致", () => {
    expect(DEFAULT).toEqual([
      "online",
      "playback",
      "mix",
      "skin",
      "layout",
      "volume",
      "library",
      "queue",
    ])
  })

  it("没存过就用默认顺序", () => {
    expect(sidebarOrderOf(null)).toEqual(DEFAULT)
  })

  it("存过就按存的来", () => {
    const custom = [...DEFAULT].reverse()
    expect(sidebarOrderOf(custom)).toEqual(custom)
  })

  it("以后新增的按钮补到末尾，不会因为老配置而消失", () => {
    // 老用户存的列表里只有前两个
    const stale = DEFAULT.slice(0, 2)
    const got = sidebarOrderOf(stale)
    expect(got.slice(0, 2)).toEqual(stale)
    expect(new Set(got)).toEqual(new Set(DEFAULT))
    expect(got).toHaveLength(DEFAULT.length)
  })

  it("已删掉的按钮从老配置里丢掉，不会渲染出一个空位", () => {
    const got = sidebarOrderOf(["nope", ...DEFAULT, "gone"])
    expect(got).toEqual(DEFAULT)
  })

  it("重复项不会让同一个按钮出现两次", () => {
    const got = sidebarOrderOf([DEFAULT[0], DEFAULT[0], ...DEFAULT])
    expect(got).toHaveLength(new Set(got).size)
  })
})
