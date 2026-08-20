import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Track } from "@/store/library"

/**
 * 播放状态机里两件靠肉眼看不出来的事：**设置真的落盘了**，以及
 * **失败重试不会跳掉用户自己选的歌**。
 *
 * 这两处原先都没有测试覆盖，也确实都出过错 —— EQ 调完不碰别的设置就退出会丢，
 * 失败后排的那个 2 秒定时器没有句柄、撒手不管。
 */

const engine = {
  _eqEnabled: false,
  _eqGains: [0, 0, 0] as number[],
  outputDevice: "",
  status: "paused" as string,
  currentTime: 0,
  duration: 0,
  eqEnabled: false,
  eqGains: [0, 0, 0] as number[],
  normalize: false,
  trackGainDb: 0,
  setEqEnabled: vi.fn(function (on: boolean) {
    engine.eqEnabled = on
  }),
  setEqGains: vi.fn(function (g: number[]) {
    engine.eqGains = [...g]
  }),
  setTrackGainDb: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
  setSpeed: vi.fn(),
  setNormalize: vi.fn(),
  setOutputDevice: vi.fn(async () => {}),
  loadBytes: vi.fn(async () => {}),
  loadUrl: vi.fn(async () => {}),
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  toggle: vi.fn(),
  seek: vi.fn(),
  onStatus: vi.fn(() => () => {}),
  onProgress: vi.fn(() => () => {}),
  onEnded: vi.fn(() => () => {}),
  /** 每首歌读盘的结果由用例决定：抛异常就是"这首播不了" */
  load: vi.fn(async (_ref: unknown) => new Uint8Array([1])),
}

const writeConfig = vi.fn(async (_name: string, _value: unknown) => {})
const resolvePlayUrl = vi.fn(async () => ({ url: "https://example.test/audio" }))

vi.mock("@/audio/engine", () => ({
  AudioLoadCancelledError: class AudioLoadCancelledError extends Error {
    name = "AbortError"
  },
  engine,
  isAudioLoadCancelled: (error: unknown) =>
    error instanceof Error && error.name === "AbortError",
}))
vi.mock("@/platform", () => ({
  platform: {
    writeConfig,
    readConfig: vi.fn(async () => null),
    readFile: vi.fn(async () => new Uint8Array([1])),
    readSlice: vi.fn(async () => new Uint8Array([1])),
    updateNowPlaying: vi.fn(async () => {}),
    ensureReadable: vi.fn(async () => {}),
  },
}))
vi.mock("@/audio/loudness", () => ({
  clampGainDb: (v: number) => v,
  gainDbFor: () => 0,
  loadLoudness: vi.fn(async () => null),
}))
vi.mock("@/source/boot", () => ({
  ensureSource: vi.fn(async () => ({ resolvePlayUrl })),
}))

const markMissing = vi.fn()
vi.mock("@/store/library", () => ({
  localRef: (t: Track) =>
    t.origin.kind === "local" ? { id: t.id, name: t.id, size: 1, mtime: 0 } : null,
  useLibrary: {
    getState: () => ({
      markMissing,
      addTracks: vi.fn(),
      ensureLyrics: vi.fn(async () => null),
      ensureCover: vi.fn(async () => null),
    }),
  },
}))

// store 的定时器全走 window，而这套单测跑在 node 环境里没有 window。
// 用箭头函数转发而不是直接引用，这样 vi.useFakeTimers() 换掉全局之后也能跟上。
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id),
  setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms) as unknown as number,
  clearInterval: (id: number) => clearInterval(id),
})

const { usePlayer } = await import("@/store/player")

const track = (id: string): Track =>
  ({
    id,
    origin: { kind: "local", ref: { id, name: id, size: 1, mtime: 0 } },
    title: id,
    artist: "",
    album: "",
    duration: 1,
    cover: null,
    lyrics: null,
    playCount: 0,
    liked: false,
    lastPlayed: 0,
    addedAt: 0,
    missing: false,
    gainDb: null,
    gainPeak: null,
  }) as unknown as Track

const onlineTrack = (id: string): Track =>
  ({
    ...track(id),
    origin: { kind: "online", source: "tx", songId: id, qualities: {}, raw: {} },
  }) as unknown as Track

/*
 * 每个用例发一套全新的曲目 id。
 *
 * store 里的预取缓存（prefetched）是模块级的，上一个用例播完排下的那次预取会
 * 跨用例留下来 —— id 一样的话，下一个用例的 playAt 会直接命中缓存、根本不读盘，
 * 于是"这首播不了"的用例静悄悄地变成了播成功。换 id 就撞不上了。
 */
let round = 0

beforeEach(() => {
  vi.useFakeTimers()
  writeConfig.mockClear()
  engine.load.mockClear()
  engine.load.mockImplementation(async () => new Uint8Array([1]))
  engine.play.mockClear()
  engine.pause.mockClear()
  engine.loadUrl.mockClear()
  resolvePlayUrl.mockClear()
  resolvePlayUrl.mockImplementation(async () => ({ url: "https://example.test/audio" }))
  markMissing.mockClear()
  engine.eqEnabled = false
  engine.eqGains = [0, 0, 0]
  round++
  usePlayer.setState({
    queue: [track(`a${round}`), track(`b${round}`), track(`c${round}`)],
    index: -1,
    mode: "all",
    status: "paused",
    error: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/** save() 是 1 秒防抖的，把时钟推过去再看落盘内容 */
async function flushSave(): Promise<SettingsShape | null> {
  await vi.advanceTimersByTimeAsync(1100)
  const last = writeConfig.mock.calls.at(-1)
  return last ? (last[1] as SettingsShape) : null
}

type SettingsShape = { eqEnabled: boolean; eqGains: number[] }

describe("EQ 走 store 才会落盘", () => {
  it("改增益会写进 settings", async () => {
    usePlayer.getState().setEqGains([3, -2, 5])
    const saved = await flushSave()

    expect(engine.setEqGains).toHaveBeenCalledWith([3, -2, 5])
    expect(saved?.eqGains).toEqual([3, -2, 5])
  })

  it("开关 EQ 会写进 settings", async () => {
    usePlayer.getState().setEqEnabled(true)
    const saved = await flushSave()

    expect(engine.setEqEnabled).toHaveBeenCalledWith(true)
    expect(saved?.eqEnabled).toBe(true)
  })

  it("只动 EQ、不碰别的设置，也必须落盘", async () => {
    // 这条正是从前会丢设置的场景：调完 EQ 直接退出
    usePlayer.getState().setEqGains([1, 1, 1])
    await flushSave()

    expect(writeConfig).toHaveBeenCalled()
  })
})

describe("播放失败后的自动跳转", () => {
  it("2 秒内用户自己点了别的歌，待触发的跳转必须作废", async () => {
    engine.load.mockRejectedValueOnce(new Error("读不了"))

    await usePlayer.getState().playAt(0) // 第一首失败，排下一次跳转
    expect(markMissing).toHaveBeenCalledWith(`a${round}`)

    // 用户不等它，自己点了 c
    await usePlayer.getState().playAt(2)
    expect(usePlayer.getState().index).toBe(2)

    // 越过那 2 秒：孤儿定时器要是还在，会把 c 跳成别的
    await vi.advanceTimersByTimeAsync(3000)
    expect(usePlayer.getState().index, "用户选的歌被自动跳转顶掉了").toBe(2)
  })

  it("没人打断时，照常跳下一首", async () => {
    engine.load.mockRejectedValueOnce(new Error("读不了"))

    await usePlayer.getState().playAt(0)
    await vi.advanceTimersByTimeAsync(3000)

    expect(usePlayer.getState().index).toBe(1)
  })

  it("手动暂停会取消待触发的跳转", async () => {
    engine.load.mockRejectedValueOnce(new Error("读不了"))
    await usePlayer.getState().playAt(0)

    engine.duration = 1
    usePlayer.getState().toggle()
    const at = usePlayer.getState().index

    await vi.advanceTimersByTimeAsync(3000)
    expect(usePlayer.getState().index).toBe(at)
    engine.duration = 0
  })

  it("连续 3 首失败就停下，不无限跳", async () => {
    engine.load.mockRejectedValue(new Error("全坏了"))

    await usePlayer.getState().playAt(0)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(usePlayer.getState().status).toBe("error")
    expect(usePlayer.getState().error).toContain("连续多首")
  })
})

describe("快速切歌的异步竞态", () => {
  it("旧请求晚完成也不能抢回播放权", async () => {
    let finishFirst!: (bytes: Uint8Array<ArrayBuffer>) => void
    const firstLoad = new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
      finishFirst = resolve
    })
    engine.load.mockImplementation((ref: unknown) => {
      const id = (ref as { id: string }).id
      return id === `a${round}` ? firstLoad : Promise.resolve(new Uint8Array(new ArrayBuffer(1)))
    })

    const first = usePlayer.getState().playAt(0)
    await Promise.resolve()
    const second = usePlayer.getState().playAt(1)
    await second

    expect(usePlayer.getState().index).toBe(1)
    expect(engine.play).toHaveBeenCalledTimes(1)
    expect(engine.pause).toHaveBeenCalledTimes(2)

    finishFirst(new Uint8Array(new ArrayBuffer(1)))
    await first

    expect(usePlayer.getState().index).toBe(1)
    expect(engine.play, "晚到的旧请求重新调用了播放").toHaveBeenCalledTimes(1)
    expect(markMissing).not.toHaveBeenCalled()
  })

  it("加载中暂停会作废自动播放，也不会误报文件丢失", async () => {
    let finish!: (bytes: Uint8Array<ArrayBuffer>) => void
    engine.load.mockImplementationOnce(
      () =>
        new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
          finish = resolve
        }),
    )

    const loading = usePlayer.getState().playAt(0)
    await Promise.resolve()
    usePlayer.getState().pause()
    finish(new Uint8Array(new ArrayBuffer(1)))
    await loading

    expect(engine.play).not.toHaveBeenCalled()
    expect(markMissing).not.toHaveBeenCalled()
  })

  it("旧的在线地址解析晚返回时不能取消已经切到的新歌", async () => {
    let finishResolve!: (value: { url: string }) => void
    resolvePlayUrl.mockImplementationOnce(
      () =>
        new Promise<{ url: string }>((resolve) => {
          finishResolve = resolve
        }),
    )
    usePlayer.setState({ queue: [onlineTrack(`online${round}`), track(`local${round}`)], index: -1 })

    const first = usePlayer.getState().playAt(0)
    for (let i = 0; i < 10 && !finishResolve; i++) await Promise.resolve()
    expect(finishResolve).toBeTypeOf("function")
    await usePlayer.getState().playAt(1)
    finishResolve({ url: "https://example.test/stale" })
    await first

    expect(usePlayer.getState().index).toBe(1)
    expect(engine.loadUrl, "旧地址解析结果闯进了音频引擎").not.toHaveBeenCalled()
    expect(engine.play).toHaveBeenCalledTimes(1)
    expect(markMissing).not.toHaveBeenCalled()
  })
})
