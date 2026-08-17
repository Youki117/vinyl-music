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
  it("色调很窄的图：宁可少给几个，也不给三个看着一样的", () => {
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
    // 凑不满三个是可以接受的结果：三色轮换会自动变成两段，比硬塞一个看不出差别的强
    expect(got.length).toBeGreaterThanOrEqual(2)
    expect(got.length).toBeLessThanOrEqual(3)
    // 但给出来的每一对都必须真的分得开
    const gaps: number[] = []
    for (let i = 0; i < got.length; i++)
      for (let j = i + 1; j < got.length; j++) gaps.push(dist(got[i], got[j]))
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

/**
 * 这一组的核心是**保真**，不是"把颜色调进某个区间"。
 *
 * 前三版都错在同一个想当然上：认定蒙版必须是浅色，于是把亮度硬压进一条窄而浅的带子。
 * 后果是取色再准也没用 —— 实测四张真实底图十二个色，没有一个不是淡的：
 * 饱满的铁锈橙 #a65927 变成近白的 #f4ede9，"黑 + 血红"的一组变成三个几乎一样的淡粉。
 * 现在只挡纯黑、纯白和霓虹，中间一律原样放行。
 */
describe("veilTintFrom", () => {
  const lumOf = (hex: string) => relativeLuminance(...hexToRgb(veilTintFrom(hex)))

  it("深色保持深 —— 这正是之前最大的毛病", () => {
    // 那张暗红角色图整张取到的三个主色，人眼看就是"黑 + 血红"
    for (const c of ["#0b0808", "#543737", "#2c2224"]) {
      expect(lumOf(c)).toBeLessThan(0.12)
    }
  })

  it("血红还是血红，不会变成玫瑰粉", () => {
    const [r, g, b] = hexToRgb(veilTintFrom("#5e0d0d")) // 用户自己手调过的蒙版色
    expect(lumOf("#5e0d0d")).toBeLessThan(0.08)
    expect(r).toBeGreaterThan(g * 2)
    expect(r).toBeGreaterThan(b * 2)
  })

  it("饱满的中间调不会被冲白", () => {
    expect(lumOf("#a65927")).toBeLessThan(0.3) // 铁锈橙。旧实现给出近白的 #f4ede9
  })

  it("没到上限的饱和度与亮度原样放行（只容 HSL 往返的舍入误差）", () => {
    // 旧实现把饱和度一律压到 0.32，那是三色发灰的元凶之一
    expect(dist(veilTintFrom("#7a6a55"), "#7a6a55")).toBeLessThanOrEqual(2)
  })

  it("纯黑被抬离纯黑（纯黑没有色相），但仍然是黑", () => {
    expect(veilTintFrom("#000000")).not.toBe("#000000")
    expect(lumOf("#000000")).toBeLessThan(0.05)
  })

  it("纯白被压下来，不至于和没有蒙版没区别", () => {
    expect(veilTintFrom("#ffffff")).not.toBe("#ffffff")
    expect(lumOf("#fffef8")).toBeLessThan(0.92)
  })

  it("霓虹被压饱和：一整片纯色铺 0.89 不透明度会刺眼", () => {
    const sat = (hex: string) => {
      const [r, g, b] = hexToRgb(hex)
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      return mx === 0 ? 0 : (mx - mn) / mx
    }
    expect(sat(veilTintFrom("#ff0000"))).toBeLessThan(sat("#ff0000"))
  })

  it("保留色相：暖色出来还是暖的，冷色还是冷的", () => {
    const warm = hexToRgb(veilTintFrom("#c86400")) // 橙
    const cool = hexToRgb(veilTintFrom("#0064c8")) // 蓝
    expect(warm[0]).toBeGreaterThan(warm[2])
    expect(cool[2]).toBeGreaterThan(cool[0])
  })

  it("输出永远是合法的 #rrggbb", () => {
    for (const c of ["#000000", "#ffffff", "#123456", "#abcdef"]) {
      expect(veilTintFrom(c)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

/**
 * 整组处理。用例喂的全是**真实底图上实测到的主色**，不是合成数据 ——
 * 合成的红/蓝/黄照不到真实照片的形状，之前几次翻车全是这么漏过去的。
 */
describe("veilTintsFrom（整组）", () => {
  const minGap = (hexes: string[]) => {
    const gaps: number[] = []
    for (let i = 0; i < hexes.length; i++)
      for (let j = i + 1; j < hexes.length; j++) gaps.push(dist(hexes[i], hexes[j]))
    return Math.min(...gaps)
  }

  // 那张暗红角色图整张取到的三个主色，原始最近距离 49
  const DARK_RED = ["#0b0808", "#543737", "#2c2224"]

  it("保真：原图里拉得开，出来也拉得开", () => {
    expect(minGap(veilTintsFrom(DARK_RED))).toBeGreaterThan(20)
  })

  it("不再把整组摊到一条浅带子上", () => {
    // 旧实现给出 #d1bfbf / #f4eeee / #e1d8da —— 三个淡粉，亮度全在 0.55 以上
    for (const c of veilTintsFrom(DARK_RED)) {
      expect(relativeLuminance(...hexToRgb(c))).toBeLessThan(0.2)
    }
  })

  it("灰度图三个色仍然分得出来（靠的是它本来就有的明暗差）", () => {
    const out = veilTintsFrom(["#878787", "#090909", "#f5f5f5"])
    expect(new Set(out).size).toBe(3)
    expect(minGap(out)).toBeGreaterThan(25)
  })

  it("返回顺序跟入参走（入参按出现次数排，第一个是主色）", () => {
    const out = veilTintsFrom(["#878787", "#090909", "#f5f5f5"])
    // 入参 0 是中间调，出来也该还是中间调，而不是被排序挪走
    const lum = out.map((c) => relativeLuminance(...hexToRgb(c)))
    expect(lum[1]).toBeLessThan(lum[0])
    expect(lum[0]).toBeLessThan(lum[2])
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
