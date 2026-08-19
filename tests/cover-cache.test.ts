import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FileRef } from "@/platform"
import type { Track } from "@/store/library"

/**
 * 封面的 LRU 上限。
 *
 * ensureCover 会把 object URL 写回曲目，改之前从不释放 —— 每播一首攒一张，只涨不落。
 * 加上限之后最容易出的事是**悬空引用**：revoke 了但还有谁指着那个 URL。这里锁住
 * 三件事：确实按 LRU 淘汰、淘汰时真的 revoke 了、正在用的那张不会被淘汰。
 */

const revoked: string[] = []
let seq = 0

vi.stubGlobal("URL", {
  createObjectURL: () => `blob:fake/${++seq}`,
  revokeObjectURL: (url: string) => revoked.push(url),
})
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id),
})

vi.mock("@/platform", () => ({
  platform: {
    readFile: vi.fn(async () => new Uint8Array([1])),
    readSidecar: vi.fn(async () => null),
    saveImage: vi.fn(async (name: string) => ({ id: `C:\\app\\skins\\${name}`, name, size: 1, mtime: 0 })),
    removeFile: vi.fn(async () => {}),
    writeConfig: vi.fn(async () => {}),
    readConfig: vi.fn(async () => null),
  },
  isLyricFile: () => false,
}))

vi.mock("@/audio/metadata", () => ({
  readMetadata: vi.fn(),
  // 每次调用给一张新的"封面"，模拟不同曲目有不同内嵌图
  readCover: vi.fn(async () => ({
    url: `blob:fake/${++seq}`,
    data: new Uint8Array([1, 2]),
    mime: "image/png",
  })),
}))

/**
 * 每个用例都重新加载一次 store。
 *
 * LRU 队列、已探测标记、封面文件表都是 library.ts 的**模块级**变量，不是 store 状态，
 * `setState` 清不掉它们。共用一份的话上一个用例攒下的队列会直接改变下一个用例的淘汰
 * 结果 —— 这个坑第一版就踩了，三个用例全红。
 */
async function freshLibrary() {
  vi.resetModules()
  return (await import("@/store/library")).useLibrary
}

const ref = (id: string): FileRef => ({ id, name: `${id}.mp3`, size: 1, mtime: 0 })
const track = (id: string): Track => ({
  id,
  origin: { kind: "local" as const, ref: ref(id) },
  title: id,
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
})

/** 上限写在 library.ts 里；这里跟着写死，改那边就该改这边 */
const MAX = 8

const ids = Array.from({ length: MAX + 4 }, (_, i) => `t${i}`)

type Store = Awaited<ReturnType<typeof freshLibrary>>
const withCover = (s: Store) =>
  s
    .getState()
    .tracks.filter((t) => t.cover !== null)
    .map((t) => t.id)

/** 装好一个 12 首的曲库，返回 store */
async function setup(): Promise<Store> {
  const s = await freshLibrary()
  s.setState({ tracks: ids.map(track), playlists: [], activeView: "all" })
  return s
}

const touch = (s: Store, id: string) => s.getState().ensureCover(id, new Uint8Array([1]))

beforeEach(() => {
  revoked.length = 0
})

describe("ensureCover · LRU 上限", () => {
  it("最多只留 8 张，超出的按最早使用淘汰", async () => {
    const s = await setup()
    for (const id of ids) await touch(s, id)

    expect(withCover(s)).toEqual(ids.slice(-MAX))
  })

  it("淘汰时真的 revoke 了，不是只把字段置空", async () => {
    const s = await setup()
    for (const id of ids) await touch(s, id)

    // 12 首里淘汰掉最早的 4 首
    expect(revoked).toHaveLength(ids.length - MAX)
    expect(revoked.every((u) => u.startsWith("blob:fake/"))).toBe(true)
  })

  it("再次访问会挪到最新，不会被接下来的淘汰带走", async () => {
    const s = await setup()
    for (const id of ids.slice(0, MAX)) await touch(s, id)

    // t0 本来是最早的，碰一下让它变成最新
    await touch(s, "t0")
    // 再进两首，该被淘汰的是 t1 t2 而不是 t0
    await touch(s, "t8")
    await touch(s, "t9")

    const alive = withCover(s)
    expect(alive).toContain("t0")
    expect(alive).not.toContain("t1")
    expect(alive).not.toContain("t2")
  })

  it("被淘汰的曲目可以重新解出封面（探测标记一并清掉了）", async () => {
    const s = await setup()
    for (const id of ids) await touch(s, id)
    expect(withCover(s)).not.toContain("t0")

    const again = await touch(s, "t0")
    expect(again?.url).toBeTruthy()
    expect(withCover(s)).toContain("t0")
  })
})
