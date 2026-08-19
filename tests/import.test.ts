import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FileRef } from "@/platform"

/**
 * addFiles 的并发导入。
 *
 * 单独一个文件是因为要 mock 掉 platform 与 metadata，而 library.test.ts 测的是纯函数
 * selectTracks，不该被 mock 污染。
 *
 * 这里盯的是并发改造最容易出事的地方：完成顺序被打乱之后，入库顺序还对不对。
 */

/** 每个文件的模拟读盘耗时。故意做成倒序，让完成顺序和输入顺序完全相反 */
const delays = new Map<string, number>()

vi.mock("@/platform", () => ({
  platform: {
    readFile: vi.fn(async (ref: FileRef) => {
      await new Promise((r) => setTimeout(r, delays.get(ref.id) ?? 0))
      if (ref.id === "boom") throw new Error("读不了")
      return new Uint8Array([1, 2, 3])
    }),
    readSidecar: vi.fn(async () => null),
    writeConfig: vi.fn(async () => {}),
    readConfig: vi.fn(async () => null),
    ensureReadable: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
  },
  isLyricFile: () => false,
}))

vi.mock("@/audio/metadata", () => ({
  readMetadata: vi.fn(async (ref: FileRef) => ({
    title: ref.name.replace(/\.mp3$/, ""),
    artist: "测试",
    album: "",
    duration: 1,
    lyrics: null,
  })),
  readCover: vi.fn(async () => null),
}))

// store 用 window.setTimeout 做防抖落盘，而这套单测跑在 node 环境里没有 window。
// 只补它真正用到的两个方法 —— 为一个定时器拉进整个 jsdom 不划算。
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id),
})

const { useLibrary } = await import("@/store/library")

const ref = (id: string): FileRef => ({ id, name: `${id}.mp3`, size: 1, mtime: 0 })

beforeEach(() => {
  delays.clear()
  useLibrary.setState({ tracks: [], playlists: [], activeView: "all", scanning: null })
})

describe("addFiles · 并发导入", () => {
  it("完成顺序被打乱时，入库顺序仍是用户给的顺序", async () => {
    const inputs = ["a", "b", "c", "d", "e", "f", "g", "h"]
    // 越靠前的读得越慢：串行实现下这没影响，并发实现下会让完成顺序整个翻过来
    inputs.forEach((id, i) => delays.set(id, (inputs.length - i) * 5))

    const added = await useLibrary.getState().addFiles(inputs.map(ref))

    expect(added.map((t) => t.id)).toEqual(inputs)
    expect(useLibrary.getState().tracks.map((t) => t.id)).toEqual(inputs)
  })

  it("addedAt 跟着输入下标走，排序不会因为并发而错乱", async () => {
    const inputs = ["x", "y", "z"]
    delays.set("x", 20)
    delays.set("z", 1)

    const added = await useLibrary.getState().addFiles(inputs.map(ref))

    expect(added[0].addedAt).toBeLessThan(added[1].addedAt)
    expect(added[1].addedAt).toBeLessThan(added[2].addedAt)
  })

  it("单个文件失败不中断整批，其余照常入库", async () => {
    const added = await useLibrary.getState().addFiles([ref("p"), ref("boom"), ref("q")])

    expect(added.map((t) => t.id)).toEqual(["p", "q"])
  })

  it("导入结束后清掉进度，且进度总数是去重后的数量", async () => {
    useLibrary.setState({
      tracks: [
        {
          id: "dup",
          origin: { kind: "local" as const, ref: ref("dup") },
          title: "dup",
          artist: "",
          album: "",
          duration: 0,
          cover: null,
          lyrics: null,
          playCount: 0,
          liked: false,
          lastPlayed: 0,
          addedAt: 0,
          missing: false,
          gainDb: null,
          gainPeak: null,
        },
      ],
    })

    const seen: number[] = []
    const stop = useLibrary.subscribe((s) => {
      if (s.scanning) seen.push(s.scanning.total)
    })
    const added = await useLibrary.getState().addFiles([ref("dup"), ref("new1"), ref("new2")])
    stop()

    expect(added.map((t) => t.id)).toEqual(["new1", "new2"])
    expect(new Set(seen)).toEqual(new Set([2]))
    expect(useLibrary.getState().scanning).toBeNull()
  })

  it("并发上限生效：任何时刻在飞的读盘不超过 4 个", async () => {
    let inFlight = 0
    let peak = 0
    const { platform } = await import("@/platform")
    vi.mocked(platform.readFile).mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return new Uint8Array([1])
    })

    await useLibrary.getState().addFiles(Array.from({ length: 20 }, (_, i) => ref(`t${i}`)))

    expect(peak).toBeGreaterThan(1) // 真的并发了
    expect(peak).toBeLessThanOrEqual(4) // 但没放飞
  })
})
