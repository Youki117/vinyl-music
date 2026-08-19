import { describe, expect, it } from "vitest"

import { DESIGN_H, DESIGN_W, clampOffset, offsetsToVars } from "@/store/layout"

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

describe("偏移 → CSS 变量", () => {
  it("只给动过的部件写变量，没动过的走 CSS 默认版式", () => {
    const vars = offsetsToVars({ lyrics: { x: 12, y: -4 }, disc: { x: 0, y: 0 } })
    expect(vars).toEqual({ "--off-lyrics-x": "12px", "--off-lyrics-y": "-4px" })
  })

  it("什么都没动就是空的", () => {
    expect(offsetsToVars({})).toEqual({})
  })
})
