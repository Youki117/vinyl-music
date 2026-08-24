import { describe, expect, it } from "vitest"

import {
  DEFAULT_ARTWORK_BUDGET,
  MIN_ARTWORK_BUDGET,
  addArtwork,
  artworkFile,
  artworkForTrack,
  artworksOfTrack,
  attachThumbnail,
  clampBudget,
  findById,
  formatBytes,
  planEviction,
  planLibrarySweep,
  planOrphanSweep,
  prunePinned,
  readArtworkIndex,
  readBudget,
  readPinned,
  removeById,
  totalBytes,
  touchArtwork,
  type AiArtwork,
} from "@/ai/artworkStore"

const MB = 1024 * 1024

/** 某首歌的一张图 */
const song = (id: string, trackId: string, opts: Partial<AiArtwork> = {}): AiArtwork => ({
  id,
  path: `C:\\data\\skins\\ai-${id}.png`,
  thumbnail: "data:image/jpeg;base64,xx",
  bytes: 2 * MB,
  createdAt: 1000,
  usedAt: 1000,
  origin: { kind: "song", trackId, title: trackId, artist: "" },
  prompt: "p",
  scene: "s",
  ...opts,
})

/** 自定义提示词生成的一张 */
const custom = (id: string, opts: Partial<AiArtwork> = {}): AiArtwork => ({
  ...song(id, "unused", opts),
  origin: { kind: "custom" },
})

describe("读账本", () => {
  it("忽略坏条目，不让磁盘上的脏数据把面板带崩", () => {
    const raw = {
      version: 3,
      items: [
        song("a", "t1"),
        { ...song("b", "t1"), id: "" },
        { ...song("c", "t1"), path: "" },
        { ...song("d", "t1"), bytes: -1 },
        { ...song("e", "t1"), origin: { kind: "song" } },
        { ...song("f", "t1"), scene: 42 },
        null,
        "不是对象",
      ],
    }
    expect(readArtworkIndex(raw, 0).map((i) => i.id)).toEqual(["a"])
  })

  it("同一个 id 只留一条，否则预算会重复计数", () => {
    const raw = { version: 3, items: [song("a", "t1"), song("a", "t2", { bytes: 9 * MB })] }
    const got = readArtworkIndex(raw, 0)
    expect(got).toHaveLength(1)
    expect(got[0].bytes).toBe(2 * MB)
  })

  /*
   * v1 是 trackId → 路径的映射，v2 是没有 id/来源/提示词的数组。两者迁移时把使用
   * 时间记成"现在"很关键：记成 0 的话，老用户升级后第一次超预算就会被整批清空。
   */
  it("能读 v1 的映射式账本", () => {
    const raw = { schemaVersion: 1, artwork: { t1: "C:\\x\\ai-1.png", t2: "C:\\x\\ai-2.png", t3: "" } }
    const got = readArtworkIndex(raw, 12345)
    expect(got.map((i) => i.id)).toEqual(["legacy:t1", "legacy:t2"])
    expect(got.every((i) => i.usedAt === 12345)).toBe(true)
    expect(got.every((i) => i.thumbnail === "")).toBe(true)
    expect(got[0].origin).toEqual({ kind: "song", trackId: "t1", title: "", artist: "" })
  })

  it("能读 v2 的数组式账本，并保住它记过的大小", () => {
    const raw = {
      schemaVersion: 2,
      items: [{ trackId: "t1", path: "C:\\x\\ai-1.png", bytes: 3 * MB, usedAt: 777 }],
    }
    const got = readArtworkIndex(raw, 999)
    expect(got).toHaveLength(1)
    expect(got[0].bytes).toBe(3 * MB)
    expect(got[0].usedAt).toBe(777)
    expect(got[0].prompt).toBe("")
  })

  it("指定关系只保留指向现存图片的那些", () => {
    const items = [song("a", "t1")]
    expect(readPinned({ pinned: { t1: "a", t2: "已经不存在了" } }, items)).toEqual({ t1: "a" })
  })

  it("预算缺失或离谱时回到默认值", () => {
    expect(readBudget({})).toBe(DEFAULT_ARTWORK_BUDGET)
    expect(readBudget({ budgetBytes: "很大" })).toBe(DEFAULT_ARTWORK_BUDGET)
    expect(clampBudget(1 * MB)).toBe(MIN_ARTWORK_BUDGET)
  })
})

/*
 * 新模型的核心：一首歌可以有多张图，默认用最新的，用户也能指定用回旧的。
 * 这一段错了的表现是"回到这首歌换了张图"，很难查。
 */
describe("这首歌该用哪张", () => {
  const items = [
    song("old", "t1", { createdAt: 100 }),
    song("new", "t1", { createdAt: 300 }),
    song("mid", "t1", { createdAt: 200 }),
    song("other", "t2", { createdAt: 999 }),
  ]

  it("没指定过就用最新生成的那张", () => {
    expect(artworkForTrack(items, {}, "t1")?.id).toBe("new")
  })

  it("指定过就用指定的，哪怕它更旧", () => {
    expect(artworkForTrack(items, { t1: "old" }, "t1")?.id).toBe("old")
  })

  it("指定的图已被删掉时，退回用最新的", () => {
    expect(artworkForTrack(items, { t1: "已删" }, "t1")?.id).toBe("new")
  })

  it("这首歌没有图就返回 null，调用方回到基础底图", () => {
    expect(artworkForTrack(items, {}, "t3")).toBeNull()
  })

  it("不会把别的歌的图算进来", () => {
    expect(artworkForTrack(items, {}, "t1")?.id).not.toBe("other")
  })

  it("自定义提示词生成的图不属于任何歌", () => {
    const withCustom = [...items, custom("c", { createdAt: 9999 })]
    expect(artworkForTrack(withCustom, {}, "t1")?.id).toBe("new")
  })

  it("列出某首歌名下全部的图，最新在前", () => {
    expect(artworksOfTrack(items, "t1").map((i) => i.id)).toEqual(["new", "mid", "old"])
  })
})

describe("淘汰", () => {
  it("没超预算就一张都不动", () => {
    const items = [song("a", "t1", { bytes: 10 * MB }), song("b", "t2", { bytes: 10 * MB })]
    expect(planEviction(items, 100 * MB).evict).toEqual([])
  })

  it("超了就从最久没用到的开始删", () => {
    const items = [
      song("new", "t1", { bytes: 40 * MB, usedAt: 300 }),
      song("old", "t2", { bytes: 40 * MB, usedAt: 100 }),
      song("mid", "t3", { bytes: 40 * MB, usedAt: 200 }),
    ]
    const { keep, evict } = planEviction(items, 100 * MB)
    expect(evict.map((i) => i.id)).toEqual(["old"])
    expect(keep.map((i) => i.id)).toEqual(["new", "mid"])
  })

  /*
   * 最近用过的那张多半正挂在画面上，基础底图是用户明确选定的。删掉任一张的表现都是
   * "画面突然变空白"或"我设的底图没了"，比超预算难查得多。
   */
  it("预算再小也保住最近用过的那张", () => {
    const items = [song("a", "t1", { bytes: 50 * MB, usedAt: 100 }), song("b", "t2", { bytes: 50 * MB, usedAt: 200 })]
    const { keep } = planEviction(items, 1)
    expect(keep.map((i) => i.id)).toEqual(["b"])
  })

  it("基础底图也保住，哪怕它是最久没用到的那张", () => {
    const items = [
      song("base", "t1", { bytes: 50 * MB, usedAt: 1 }),
      song("mid", "t2", { bytes: 50 * MB, usedAt: 100 }),
      song("newest", "t3", { bytes: 50 * MB, usedAt: 300 }),
    ]
    const { keep, evict } = planEviction(items, 60 * MB, ["base"])
    expect(evict.map((i) => i.id)).toEqual(["mid"])
    expect(keep.map((i) => i.id)).toEqual(["base", "newest"])
  })

  it("大小未知的旧条目不占预算，也就不会触发淘汰", () => {
    const items = [song("a", "t1", { bytes: 0 }), song("b", "t2", { bytes: 10 * MB })]
    expect(totalBytes(items)).toBe(10 * MB)
    expect(planEviction(items, 100 * MB).evict).toEqual([])
  })
})

describe("增删与指定", () => {
  it("同一首歌再生成一张是新增，不覆盖旧的", () => {
    const items = [song("a", "t1", { createdAt: 100 })]
    const next = addArtwork(items, song("b", "t1", { createdAt: 200 }))
    expect(next.map((i) => i.id)).toEqual(["b", "a"])
    expect(artworksOfTrack(next, "t1")).toHaveLength(2)
  })

  /*
   * 淘汰按"最后一次用到"排而不是生成时间：常听的那几首生成得早，
   * 不刷新使用时间的话它们会先被删掉，而这恰恰是最不该删的。
   */
  it("用上一次就刷新使用时间", () => {
    const items = [song("a", "t1", { usedAt: 100 }), song("b", "t2", { usedAt: 200 })]
    const next = touchArtwork(items, "a", 999)
    expect(findById(next, "a")?.usedAt).toBe(999)
    expect(planEviction(next, 3 * MB).evict.map((i) => i.id)).toEqual(["b"])
  })

  it("删图之后，指向它的指定关系也要一起清掉", () => {
    const items = [song("a", "t1"), song("b", "t2")]
    const rest = removeById(items, "a")
    expect(prunePinned({ t1: "a", t2: "b" }, rest)).toEqual({ t2: "b" })
  })

  it("能给迁移来的旧条目补上缩略图", () => {
    const items = [song("a", "t1", { thumbnail: "" })]
    expect(attachThumbnail(items, "a", "data:image/jpeg;base64,yy")[0].thumbnail).toBe(
      "data:image/jpeg;base64,yy",
    )
  })
})

describe("对账", () => {
  it("盘上有、账本里没有的算孤儿", () => {
    const items = [song("a", "t1")]
    const onDisk = [{ id: items[0].path }, { id: "C:\\data\\skins\\ai-orphan.png" }]
    expect(planOrphanSweep(items, onDisk)).toEqual(["C:\\data\\skins\\ai-orphan.png"])
  })

  it("曲库里已经没有的曲目，专属图跟着清掉", () => {
    const items = [song("a", "t1"), song("gone", "t9")]
    expect(planLibrarySweep(items, new Set(["t1"])).map((i) => i.id)).toEqual(["gone"])
  })

  it("自定义提示词生成的图不受曲库清理影响", () => {
    const items = [custom("c"), song("gone", "t9")]
    expect(planLibrarySweep(items, new Set(["t1"])).map((i) => i.id)).toEqual(["gone"])
  })

  it("写出去的文件结构是稳的，预算夹过、失效的指定也剔掉", () => {
    const file = artworkFile([song("a", "t1")], { t1: "a", t2: "已删" }, 1 * MB)
    expect(file.version).toBe(3)
    expect(file.items).toHaveLength(1)
    expect(file.pinned).toEqual({ t1: "a" })
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
