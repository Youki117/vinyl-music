import { describe, expect, it } from "vitest"

import { contrastRatio, deriveInk, hexToRgb, relativeLuminance } from "@/skin/palette"
import { DEFAULT_SKIN } from "@/skin/model"
import { DEFAULT_VEIL } from "@/stage/veil/renderer"

const lum = (hex: string) => relativeLuminance(...hexToRgb(hex))

/** 复算蒙版混合后的背景亮度，与 deriveInk 内部的模型一致 */
function blendedBg(avg: [number, number, number], opacity: number, tint: string): number {
  return relativeLuminance(...avg) * (1 - opacity) + lum(tint) * opacity
}

describe("deriveInk", () => {
  const veil = { ...DEFAULT_VEIL }

  it("亮底图给出深色文字", () => {
    const ink = deriveInk([230, 228, 220], veil, DEFAULT_SKIN.ink)
    const bg = blendedBg([230, 228, 220], Math.min(veil.opacity, 0.92), veil.tint)
    expect(lum(ink.primary)).toBeLessThan(bg)
  })

  it("暗底图仍能读：蒙版会把背景压亮，文字应保持深色", () => {
    const avg: [number, number, number] = [18, 18, 20]
    const ink = deriveInk(avg, veil, DEFAULT_SKIN.ink)
    const bg = blendedBg(avg, Math.min(veil.opacity, 0.92), veil.tint)
    expect(contrastRatio(lum(ink.primary), bg)).toBeGreaterThanOrEqual(4.5)
  })

  it("主文字对比度在各种底图下都不低于 4.5:1", () => {
    const samples: Array<[number, number, number]> = [
      [255, 255, 255],
      [0, 0, 0],
      [128, 128, 128],
      [220, 30, 30],
      [10, 90, 160],
      [240, 220, 90],
    ]
    for (const avg of samples) {
      const ink = deriveInk(avg, veil, DEFAULT_SKIN.ink)
      const bg = blendedBg(avg, Math.min(veil.opacity, 0.92), veil.tint)
      expect(contrastRatio(lum(ink.primary), bg), `底图 ${avg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("低不透明度蒙版下依然达标（此时底图亮度占主导）", () => {
    const thin = { ...veil, opacity: 0.35 }
    for (const avg of [
      [255, 255, 255],
      [0, 0, 0],
    ] as Array<[number, number, number]>) {
      const ink = deriveInk(avg, thin, DEFAULT_SKIN.ink)
      const bg = blendedBg(avg, 0.35, thin.tint)
      expect(contrastRatio(lum(ink.primary), bg), `底图 ${avg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("没有底图时原样返回，不瞎改", () => {
    expect(deriveInk(null, veil, DEFAULT_SKIN.ink)).toEqual(DEFAULT_SKIN.ink)
  })
})

describe("contrastRatio", () => {
  it("黑白对比是 21:1", () => {
    expect(contrastRatio(lum("#ffffff"), lum("#000000"))).toBeCloseTo(21, 1)
  })

  it("同色对比是 1:1，且与参数顺序无关", () => {
    expect(contrastRatio(lum("#7f7f7f"), lum("#7f7f7f"))).toBeCloseTo(1, 5)
    expect(contrastRatio(lum("#000000"), lum("#ffffff"))).toBeCloseTo(21, 1)
  })
})

describe("hexToRgb", () => {
  it("接受带井号与不带井号", () => {
    expect(hexToRgb("#b2845f")).toEqual([178, 132, 95])
    expect(hexToRgb("b2845f")).toEqual([178, 132, 95])
  })

  it("非法输入退回白色而不是抛错", () => {
    expect(hexToRgb("nope")).toEqual([255, 255, 255])
    expect(hexToRgb("#fff")).toEqual([255, 255, 255])
  })
})
