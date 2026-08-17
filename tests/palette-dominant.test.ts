import { describe, expect, it } from "vitest"

import { dominantColors, hexToRgb, relativeLuminance, veilTintFrom, veilTintsFrom } from "@/skin/palette"

/** 把若干 [r,g,b,重复次数] 拼成一段 RGBA 像素 */
function pixels(...spec: [number, number, number, number][]): number[] {
  const out: number[] = []
  for (const [r, g, b, n] of spec) for (let i = 0; i < n; i++) out.push(r, g, b, 255)
  return out
}

const dist = (a: string, b: string) => {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2)
}

describe("dominantColors", () => {
  it("按像素数排序，最多的排第一", () => {
    const px = pixels([200, 30, 30, 100], [30, 200, 30, 50], [30, 30, 200, 10])
    const [first] = dominantColors(px, 3)
    expect(dist(first, "#c81e1e")).toBeLessThan(12)
  })

  it("三个色彼此拉得开，不会返回同一片色阶", () => {
    // 一大片相近的蓝，外加两小块完全不同的颜色
    const px = pixels(
      [40, 60, 200, 100],
      [44, 64, 204, 90],
      [48, 68, 208, 80], // ← 和上面几乎同色，不该被选成第二第三
      [220, 200, 40, 40],
      [30, 180, 90, 30],
    )
    const got = dominantColors(px, 3)
    expect(got).toHaveLength(3)
    expect(dist(got[0], got[1])).toBeGreaterThanOrEqual(60)
    expect(dist(got[0], got[2])).toBeGreaterThanOrEqual(60)
    expect(dist(got[1], got[2])).toBeGreaterThanOrEqual(60)
  })

  /**
   * 这条对着真实翻车现场写。
   *
   * 之前的实现是"先按 minDist 过一遍，凑不满就按出现次数补齐"。色调统一的照片里，
   * 出现次数第二第三的桶就是第一名的相邻色阶，于是补齐补出来三个几乎一样的颜色 ——
   * 实测一张暖色底图给出 rgb(213,193,173) / (214,191,175) / (211,193,171)，
   * 面板上三个色块看着是同一个。上面那条"三个色彼此拉得开"是绿的，因为它喂的是
   * 红/蓝/黄这种一眼分得开的合成数据，照不到这个分支。
   */
  it("色调很窄的图，也要挑出它能给出的最大差异（而不是三个相邻色阶）", () => {
    // 一大片暖米色的细微色阶（模拟真实照片），外加两小块偏离得多一些的颜色
    const px = pixels(
      [213, 193, 173, 300],
      [214, 191, 175, 280],
      [211, 193, 171, 260],
      [216, 195, 176, 240],
      [212, 190, 172, 220], // ← 以上全是邻居，旧实现就在这里挑满了三个
      [150, 128, 96, 60],
      [232, 222, 214, 40],
    )
    const got = dominantColors(px, 3)
    expect(got).toHaveLength(3)
    // 不要求达到"红蓝黄"那种距离，图里本来就没有；但必须明显好过相邻色阶（差值个位数）
    const gaps = [dist(got[0], got[1]), dist(got[0], got[2]), dist(got[1], got[2])]
    expect(Math.min(...gaps)).toBeGreaterThan(30)
  })

  it("不会为了拉开差异去挑几个像素的杂色", () => {
    // 极少量的纯品红：距离最远，但它不是这张图的主色调
    const px = pixels([90, 110, 140, 400], [96, 116, 148, 350], [140, 150, 170, 300], [255, 0, 255, 2])
    const got = dominantColors(px, 3)
    expect(got.some((c) => dist(c, "#ff00ff") < 40)).toBe(false)
  })

  it("纯色图也要凑够个数，不能返回空", () => {
    const got = dominantColors(pixels([120, 120, 120, 200]), 3)
    expect(got.length).toBeGreaterThan(0)
    expect(got.length).toBeLessThanOrEqual(3)
  })

  it("透明像素不参与统计", () => {
    // 大量全透明的红 + 少量不透明的绿：结果应该是绿
    const px: number[] = []
    for (let i = 0; i < 500; i++) px.push(255, 0, 0, 0)
    for (let i = 0; i < 10; i++) px.push(0, 200, 0, 255)
    const [first] = dominantColors(px, 1)
    expect(dist(first, "#00c800")).toBeLessThan(12)
  })

  it("空输入不抛", () => {
    expect(dominantColors([], 3)).toEqual([])
  })
})

describe("veilTintFrom", () => {
  // 蒙版是压在左半边、不透明度 0.89 的一大片，原色直接上去不是刺眼就是糊死
  const range = (hex: string) => {
    const [r, g, b] = hexToRgb(veilTintFrom(hex))
    return relativeLuminance(r, g, b)
  }

  // 区间见 palette.ts 的 VEIL_TINT_MIN_LUM / MAX_LUM
  it("很暗的色被抬进可用区间（乘系数抬不动，必须混合）", () => {
    expect(range("#101018")).toBeGreaterThan(0.5)
  })

  it("很亮的色被压下来，不至于和默认的近白色没区别", () => {
    expect(range("#fffef8")).toBeLessThan(0.9)
    expect(veilTintFrom("#fffef8")).not.toBe("#ffffff")
  })

  it("不管输入多极端，输出都落在同一个区间里", () => {
    for (const c of ["#000000", "#ffffff", "#ff0000", "#003300", "#fefefe"]) {
      const l = range(c)
      expect(l).toBeGreaterThan(0.5)
      expect(l).toBeLessThan(0.9)
    }
  })

  it("压饱和：输出比输入更接近灰", () => {
    const spread = (hex: string) => {
      const [r, g, b] = hexToRgb(hex)
      return Math.max(r, g, b) - Math.min(r, g, b)
    }
    expect(spread(veilTintFrom("#c81e1e"))).toBeLessThan(spread("#c81e1e"))
  })

  it("保留色相：暖色出来还是暖的，冷色还是冷的", () => {
    const warm = hexToRgb(veilTintFrom("#c86400")) // 橙
    const cool = hexToRgb(veilTintFrom("#0064c8")) // 蓝
    expect(warm[0]).toBeGreaterThan(warm[2])
    expect(cool[2]).toBeGreaterThan(cool[0])
  })

  /**
   * 这条是补的，也是最该有的一条。
   *
   * 之前的实现单看每个颜色都"合格"（亮度在区间内、色相没丢），但三个色一起处理完
   * 全被挤进一条窄灰带：实测 rgb(199,199,199) / (203,199,197) / (208,199,188)，
   * 摆在面板上肉眼分不出来 —— 功能等于没做，而所有单色断言都是绿的。
   * 端到端跑起来才发现。所以约束必须落在"三个色之间"，不能只看单个。
   */
  it("三个拉开距离的输入，处理完仍然分得出来", () => {
    const src = ["#c81e1e", "#1e64c8", "#c8b41e"] // 红 / 蓝 / 黄
    const out = src.map(veilTintFrom)
    expect(new Set(out).size).toBe(3)
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(dist(out[i], out[j])).toBeGreaterThan(25)
      }
    }
  })

  it("感知亮度对齐：不同色相处理完亮度接近，不会一个刺眼一个发暗", () => {
    const lums = ["#c81e1e", "#1e64c8", "#c8b41e"].map((c) => range(c))
    expect(Math.max(...lums) - Math.min(...lums)).toBeLessThan(0.2)
  })

  it("输出永远是合法的 #rrggbb", () => {
    for (const c of ["#000000", "#ffffff", "#123456", "#abcdef"]) {
      expect(veilTintFrom(c)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

/**
 * 整组处理。这一组用例喂的全是**真实底图上实测到的主色**，不是合成数据 ——
 * 上面 veilTintFrom 那些单色断言全绿，端到端却出来三个一模一样的色块，
 * 就是因为合成数据（红/蓝/黄）照不到真实照片的形状：真实照片的三个主色
 * 往往同一个色相、只差明暗，而 veilTintFrom 保的正是色相、抹的正是明暗。
 */
describe("veilTintsFrom（整组）", () => {
  const minGap = (hexes: string[]) => {
    const gaps: number[] = []
    for (let i = 0; i < hexes.length; i++)
      for (let j = i + 1; j < hexes.length; j++) gaps.push(dist(hexes[i], hexes[j]))
    return Math.min(...gaps)
  }

  it("同色相只差明暗的三个主色，处理完仍分得出来（backdrop-1 实测值）", () => {
    // 逐个 veilTintFrom 的结果是 #d5c1ad / #d5c8ae / #d3c1ab，最近距离 3
    const src = ["#090603", "#dacaa9", "#996628"]
    expect(minGap(src.map(veilTintFrom))).toBeLessThan(10) // 先钉住旧行为确实是坏的
    expect(minGap(veilTintsFrom(src))).toBeGreaterThan(25)
  })

  it("灰度图没有色相可留，靠明暗也要分得出来（backdrop-2 实测值）", () => {
    // 逐个处理时 #878787 和 #090909 会撞成同一个 #c4c4c4
    const src = ["#878787", "#090909", "#f5f5f5"]
    expect(new Set(src.map(veilTintFrom)).size).toBeLessThan(3) // 旧行为：三个色只剩两个
    const out = veilTintsFrom(src)
    expect(new Set(out).size).toBe(3)
    expect(minGap(out)).toBeGreaterThan(25)
  })

  it("返回顺序跟入参走（入参按出现次数排，第一个是主色）", () => {
    const src = ["#878787", "#090909", "#f5f5f5"]
    const out = veilTintsFrom(src)
    // 入参 0 是中间调，所以它出来也该是三个里的中间调，而不是被排序挪走
    const lum = out.map((c) => relativeLuminance(...hexToRgb(c)))
    expect(lum[1]).toBeLessThan(lum[0])
    expect(lum[0]).toBeLessThan(lum[2])
  })

  it("每个色仍落在蒙版可用的亮度区间里", () => {
    for (const c of veilTintsFrom(["#000000", "#7f7f7f", "#ffffff"])) {
      const l = relativeLuminance(...hexToRgb(c))
      expect(l).toBeGreaterThanOrEqual(0.54)
      expect(l).toBeLessThanOrEqual(0.87)
    }
  })

  it("色相不丢：暖色组出来还是暖的", () => {
    for (const c of veilTintsFrom(["#090603", "#dacaa9", "#996628"])) {
      const [r, , b] = hexToRgb(c)
      expect(r).toBeGreaterThan(b)
    }
  })

  it("一个色或空数组不崩", () => {
    expect(veilTintsFrom([])).toEqual([])
    expect(veilTintsFrom(["#c81e1e"])).toEqual([veilTintFrom("#c81e1e")])
  })
})
