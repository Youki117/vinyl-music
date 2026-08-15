import { describe, expect, it } from "vitest"

import { labelBackground, labelSourceId } from "@/skin/resolve"
import { DEFAULT_LABEL_FOCUS, makeSkin } from "@/skin/model"

const pct = (v: string | undefined) => Number.parseFloat(String(v))

describe("labelBackground", () => {
  it("zoom 越大取景框越小，背景放得越大", () => {
    const a = labelBackground("x.png", { x: 0.5, y: 0.5, zoom: 1 }, 1000, 1000)
    const b = labelBackground("x.png", { x: 0.5, y: 0.5, zoom: 4 }, 1000, 1000)
    expect(pct(String(b.backgroundSize).split(" ")[0])).toBeGreaterThan(
      pct(String(a.backgroundSize).split(" ")[0]),
    )
  })

  it("方形图 zoom=1 时正好铺满，不放大", () => {
    const s = labelBackground("x.png", { x: 0.5, y: 0.5, zoom: 1 }, 800, 800)
    const [w, h] = String(s.backgroundSize).split(" ").map(pct)
    expect(w).toBeCloseTo(100, 3)
    expect(h).toBeCloseTo(100, 3)
  })

  it("非方形图按短边取正方形取景框", () => {
    // 宽 2000 高 1000，短边 1000，zoom=1 → 取景框 1000×1000
    // 背景需放大到 200% 宽才能让 1000px 的取景框填满容器
    const s = labelBackground("x.png", { x: 0.5, y: 0.5, zoom: 1 }, 2000, 1000)
    const [w, h] = String(s.backgroundSize).split(" ").map(pct)
    expect(w).toBeCloseTo(200, 3)
    expect(h).toBeCloseTo(100, 3)
  })

  it("焦点位置被夹在 0..100% 内，边缘处不会露白", () => {
    for (const f of [-1, 0, 0.5, 1, 2]) {
      const s = labelBackground("x.png", { x: f, y: f, zoom: 2 }, 1600, 900)
      const [px, py] = String(s.backgroundPosition).split(" ").map(pct)
      expect(px, `x=${f}`).toBeGreaterThanOrEqual(0)
      expect(px, `x=${f}`).toBeLessThanOrEqual(100)
      expect(py, `y=${f}`).toBeGreaterThanOrEqual(0)
      expect(py, `y=${f}`).toBeLessThanOrEqual(100)
    }
  })

  it("zoom 小于 1 被钳到 1，不会把图缩到比取景框还小", () => {
    const s = labelBackground("x.png", { x: 0.5, y: 0.5, zoom: 0.2 }, 900, 900)
    const [w] = String(s.backgroundSize).split(" ").map(pct)
    expect(w).toBeCloseTo(100, 3)
  })

  it("拿不到图片尺寸时退回 cover，不产出 NaN", () => {
    const s = labelBackground("x.png", DEFAULT_LABEL_FOCUS, 0, 0)
    expect(s.backgroundSize).toBe("cover")
    expect(JSON.stringify(s)).not.toContain("NaN")
  })
})

describe("labelSourceId", () => {
  it("默认跟随底图", () => {
    const skin = makeSkin({ backdrop: "D:/a.png" })
    expect(skin.label.source).toBe("backdrop")
    expect(labelSourceId(skin)).toBe("D:/a.png")
  })

  it("底图换掉后贴纸自动跟着换 —— 这是核心需求", () => {
    const skin = makeSkin({ backdrop: "D:/a.png" })
    const next = { ...skin, backdrop: "D:/b.png" }
    expect(labelSourceId(next)).toBe("D:/b.png")
  })

  it("单独指定贴纸后脱离联动", () => {
    const skin = makeSkin({
      backdrop: "D:/a.png",
      label: { source: "D:/other.png", focus: DEFAULT_LABEL_FOCUS },
    })
    expect(labelSourceId(skin)).toBe("D:/other.png")
    expect(labelSourceId({ ...skin, backdrop: "D:/b.png" })).toBe("D:/other.png")
  })

  it("没有底图时返回 null", () => {
    expect(labelSourceId(makeSkin({ backdrop: null }))).toBeNull()
  })
})
