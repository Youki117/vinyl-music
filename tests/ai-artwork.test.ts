import { describe, expect, it } from "vitest"

import {
  DEFAULT_ARTWORK_BUDGET,
  MIN_ARTWORK_BUDGET,
  artworkFile,
  clampBudget,
  findArtwork,
  forgetArtwork,
  formatBytes,
  planEviction,
  planLibrarySweep,
  planOrphanSweep,
  readArtworkIndex,
  readBudget,
  rememberArtwork,
  totalBytes,
  touchArtwork,
  type AiArtwork,
} from "@/ai/artworkStore"

const MB = 1024 * 1024

const art = (trackId: string, mb: number, usedAt: number): AiArtwork => ({
  trackId,
  path: `C:\\data\\skins\\ai-${trackId}.png`,
  bytes: mb * MB,
  usedAt,
})

describe("读账本", () => {
  it("忽略坏条目，不让磁盘上的脏数据把面板带崩", () => {
    const raw = {
      version: 2,
      items: [
        art("a", 2, 100),
        { trackId: "", path: "x", bytes: 1, usedAt: 1 },
        { trackId: "b", path: "", bytes: 1, usedAt: 1 },
        { trackId: "c", path: "y", bytes: -1, usedAt: 1 },
        { trackId: "d", path: "z", bytes: 1 },
        null,
        "不是对象",
      ],
    }
    expect(readArtworkIndex(raw, 0).map((i) => i.trackId)).toEqual(["a"])
  })

  it("同一首歌只留一条，否则预算会重复计数", () => {
    const raw = { version: 2, items: [art("a", 2, 100), art("a", 3, 200)] }
    const got = readArtworkIndex(raw, 0)
    expect(got).toHaveLength(1)
    expect(got[0].bytes).toBe(2 * MB)
  })

  /*
   * v1 存的是 trackId → 路径的映射，没有大小也没有使用时间。迁移时把使用时间
   * 记成"现在"很关键：记成 0 的话，老用户升级后第一次超预算就会被整批清空。
   */
  it("能读旧版本的映射式账本", () => {
    const raw = {
      schemaVersion: 1,
      artwork: { a: "C:\\x\\ai-a.png", b: "C:\\x\\ai-b.png", c: "" },
    }
    const got = readArtworkIndex(raw, 12345)
    expect(got.map((i) => i.trackId)).toEqual(["a", "b"])
    expect(got.every((i) => i.bytes === 0)).toBe(true)
    expect(got.every((i) => i.usedAt === 12345)).toBe(true)
  })

  it("预算缺失或离谱时回到默认值", () => {
    expect(readBudget({})).toBe(DEFAULT_ARTWORK_BUDGET)
    expect(readBudget({ budgetBytes: "很大" })).toBe(DEFAULT_ARTWORK_BUDGET)
    expect(readBudget({ budgetBytes: -5 })).toBe(MIN_ARTWORK_BUDGET)
    expect(clampBudget(1 * MB)).toBe(MIN_ARTWORK_BUDGET)
  })
})

describe("淘汰", () => {
  it("没超预算就一张都不动", () => {
    const items = [art("a", 10, 1), art("b", 10, 2)]
    expect(planEviction(items, 100 * MB).evict).toEqual([])
  })

  it("超了就从最久没听到的开始删，删到够为止", () => {
    const items = [art("new", 40, 300), art("old", 40, 100), art("mid", 40, 200)]
    const { keep, evict } = planEviction(items, 100 * MB)

    expect(evict.map((i) => i.trackId)).toEqual(["old"])
    expect(totalBytes(keep)).toBeLessThanOrEqual(100 * MB)
    // keep 保持原顺序，不该被排序副作用打乱
    expect(keep.map((i) => i.trackId)).toEqual(["new", "mid"])
  })

  /*
   * 最近用过的那张多半正挂在画面上。预算再小也不能把用户眼前的底图删掉 ——
   * 那个表现是"底图突然变空白"，比超预算难查得多。
   */
  it("预算再小也保住最近用过的那张", () => {
    const items = [art("a", 50, 100), art("b", 50, 200)]
    const { keep, evict } = planEviction(items, 1)

    expect(keep.map((i) => i.trackId)).toEqual(["b"])
    expect(evict.map((i) => i.trackId)).toEqual(["a"])
  })

  it("大小未知的旧条目不占预算，也就不会触发淘汰", () => {
    const items = [{ ...art("a", 0, 100), bytes: 0 }, art("b", 10, 200)]
    expect(totalBytes(items)).toBe(10 * MB)
    expect(planEviction(items, 100 * MB).evict).toEqual([])
  })
})

describe("增删与使用时间", () => {
  it("重新生成同一首歌是覆盖，不是新增", () => {
    const items = [art("a", 2, 100), art("b", 2, 200)]
    const next = rememberArtwork(items, art("a", 5, 300))

    expect(next).toHaveLength(2)
    expect(findArtwork(next, "a")?.bytes).toBe(5 * MB)
    expect(next[0].trackId).toBe("a")
  })

  /*
   * 淘汰按"最后一次用到"排而不是生成时间：常听的那几首生成得早，
   * 不刷新使用时间的话它们会先被删掉，而这恰恰是最不该删的。
   */
  it("套用一次就刷新使用时间", () => {
    const items = [art("a", 2, 100), art("b", 2, 200)]
    const next = touchArtwork(items, "a", 999)

    expect(findArtwork(next, "a")?.usedAt).toBe(999)
    expect(findArtwork(next, "b")?.usedAt).toBe(200)
    expect(planEviction(next, 3 * MB).evict.map((i) => i.trackId)).toEqual(["b"])
  })

  it("删掉一首不影响别的", () => {
    const items = [art("a", 2, 100), art("b", 2, 200)]
    expect(forgetArtwork(items, "a").map((i) => i.trackId)).toEqual(["b"])
  })
})

describe("对账", () => {
  /*
   * 图片先落盘、账本走 800ms 防抖，中间崩一次就留下一个谁也不认识的文件。
   * 不扫的话面板上那句"已用 320MB"只是账本的自述，不是磁盘的实情。
   */
  it("盘上有、账本里没有的算孤儿", () => {
    const items = [art("a", 2, 100)]
    const onDisk = [{ id: items[0].path }, { id: "C:\\data\\skins\\ai-orphan.png" }]
    expect(planOrphanSweep(items, onDisk)).toEqual(["C:\\data\\skins\\ai-orphan.png"])
  })

  it("曲库里已经没有的曲目，配图跟着清掉", () => {
    const items = [art("a", 2, 100), art("gone", 2, 200)]
    const dead = planLibrarySweep(items, new Set(["a"]))
    expect(dead.map((i) => i.trackId)).toEqual(["gone"])
  })

  it("写出去的文件结构是稳的，预算也夹过", () => {
    const file = artworkFile([art("a", 2, 100)], 1 * MB)
    expect(file.version).toBe(2)
    expect(file.items).toHaveLength(1)
    expect(file.budgetBytes).toBe(MIN_ARTWORK_BUDGET)
  })
})

describe("给人看的体积", () => {
  it("按量级换单位", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2 KB")
    expect(formatBytes(5 * MB)).toBe("5 MB")
    expect(formatBytes(3 * 1024 * MB)).toBe("3.0 GB")
  })
})
