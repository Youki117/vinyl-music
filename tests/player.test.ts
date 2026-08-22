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
  loop: { a: null as number | null, b: null as number | null },
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
  fetchAudio: vi.fn(async () => new Uint8Array([2])),
  copyLoadedBytes: vi.fn(async () => new Uint8Array([1])),
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  toggle: vi.fn(),
  seek: vi.fn(),
  seekSeconds: vi.fn(),
  setLoop: vi.fn(),
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
const updateNowPlaying = vi.fn(async (_info: unknown, _reason?: string) => {})
vi.mock("@/platform", () => ({
  platform: {
    writeConfig,
    readConfig: vi.fn(async () => null),
    readFile: vi.fn(async () => new Uint8Array([1])),
    readSlice: vi.fn(async () => new Uint8Array([1])),
    updateNowPlaying,
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
// 提到模块级而不是每次 getState() 现造：用例要跨调用观察它们有没有被调用过
const ensureLyrics = vi.fn(async (_id: string): Promise<string | null> => null)
const ensureCover = vi.fn(async (_id: string, _bytes?: unknown): Promise<{ path: string } | null> => null)
vi.mock("@/store/library", () => ({
  localRef: (t: Track) =>
    t.origin.kind === "local" ? { id: t.id, name: t.id, size: 1, mtime: 0 } : null,
  useLibrary: {
    getState: () => ({
      markMissing,
      addTracks: vi.fn(),
      ensureLyrics,
      ensureCover,
      // refreshQueueMeta 会走 byId；补齐歌词封面的用例要跑到它，缺了会 TypeError
      byId: () => null,
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

const { qualityForTrack, usePlayer } = await import("@/store/player")

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

const onlineTrack = (id: string, qualities = ["128k", "320k", "flac", "flac24bit"]): Track =>
  ({
    ...track(id),
    origin: { kind: "online", source: "tx", songId: id, qualities, raw: {} },
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
  engine.fetchAudio.mockClear()
  engine.fetchAudio.mockImplementation(async () => new Uint8Array([2]))
  engine.copyLoadedBytes.mockClear()
  engine.copyLoadedBytes.mockImplementation(async () => new Uint8Array([1]))
  engine.loadBytes.mockClear()
  engine.seekSeconds.mockClear()
  engine.setLoop.mockClear()
  resolvePlayUrl.mockClear()
  resolvePlayUrl.mockImplementation(async () => ({ url: "https://example.test/audio" }))
  markMissing.mockClear()
  updateNowPlaying.mockClear()
  ensureLyrics.mockClear()
  ensureLyrics.mockImplementation(async () => null)
  ensureCover.mockClear()
  ensureCover.mockImplementation(async () => null)
  engine.eqEnabled = false
  engine.eqGains = [0, 0, 0]
  engine.status = "paused"
  engine.currentTime = 0
  engine.duration = 0
  engine.loop = { a: null, b: null }
  round++
  usePlayer.setState({
    queue: [track(`a${round}`), track(`b${round}`), track(`c${round}`)],
    index: -1,
    mode: "all",
    status: "paused",
    error: null,
  })
})

describe("在线音质", () => {
  it("当前歌曲缺首选档位时向下选最接近的可用音质", () => {
    const t = onlineTrack(`quality${round}`, ["128k", "320k"])
    expect(qualityForTrack(t, "flac24bit")).toBe("320k")
    expect(qualityForTrack(t, "flac")).toBe("320k")
    expect(qualityForTrack(t, "128k")).toBe("128k")
  })

  it("切换当前在线歌曲时保留进度、播放状态与 A-B 区间", async () => {
    const t = onlineTrack(`quality${round}`)
    usePlayer.setState({
      queue: [t],
      index: 0,
      status: "playing",
      onlineQuality: "128k",
      activeOnlineQuality: "128k",
    })
    engine.status = "playing"
    engine.currentTime = 42
    engine.duration = 180
    engine.loop = { a: 30, b: 60 }

    await usePlayer.getState().setOnlineQuality("320k")

    expect(resolvePlayUrl).toHaveBeenCalledWith(expect.objectContaining({ id: t.origin.kind === "online" ? t.origin.songId : "" }), "320k")
    expect(engine.loadBytes).toHaveBeenCalledWith(new Uint8Array([2]))
    expect(engine.seekSeconds).toHaveBeenCalledWith(42)
    expect(engine.setLoop).toHaveBeenCalledWith(30, 60)
    expect(engine.play).toHaveBeenCalled()
    expect(usePlayer.getState().activeOnlineQuality).toBe("320k")
    expect(usePlayer.getState().qualityStatus).toBe("idle")
  })

  it("音质下载尚未完成时暂停，会作废晚到的自动换入", async () => {
    let finish!: (bytes: Uint8Array<ArrayBuffer>) => void
    engine.fetchAudio.mockImplementationOnce(
      () =>
        new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
          finish = resolve
        }),
    )
    const t = onlineTrack(`quality-cancel${round}`)
    usePlayer.setState({
      queue: [t],
      index: 0,
      status: "playing",
      onlineQuality: "128k",
      activeOnlineQuality: "128k",
    })
    engine.status = "playing"

    const switching = usePlayer.getState().setOnlineQuality("flac")
    for (let i = 0; i < 10 && !finish; i++) await Promise.resolve()
    usePlayer.getState().pause()
    finish(new Uint8Array(new ArrayBuffer(1)))
    await switching

    expect(engine.loadBytes).not.toHaveBeenCalled()
    expect(usePlayer.getState().qualityStatus).toBe("idle")
  })

  it("新音质解码失败时恢复旧字节与原进度", async () => {
    const t = onlineTrack(`quality-rollback${round}`)
    usePlayer.setState({
      queue: [t],
      index: 0,
      status: "playing",
      onlineQuality: "128k",
      activeOnlineQuality: "128k",
    })
    engine.status = "playing"
    engine.currentTime = 26
    engine.loop = { a: 20, b: 35 }
    engine.loadBytes
      .mockRejectedValueOnce(new Error("新音质解码失败"))
      .mockResolvedValueOnce(undefined)

    await usePlayer.getState().setOnlineQuality("flac")

    expect(engine.loadBytes).toHaveBeenNthCalledWith(1, new Uint8Array([2]))
    expect(engine.loadBytes).toHaveBeenNthCalledWith(2, new Uint8Array([1]))
    expect(engine.seekSeconds).toHaveBeenLastCalledWith(26)
    expect(engine.setLoop).toHaveBeenLastCalledWith(20, 35)
    expect(usePlayer.getState().activeOnlineQuality).toBe("128k")
    expect(usePlayer.getState().qualityStatus).toBe("error")
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

/*
 * 音源挂掉时的现场故障：只播得出第一首。
 *
 * 双击切歌 → 新歌载入失败 → 按播放键，放回来的却是上一首，而歌名显示的是新那首。
 * 根因是 toggle() 拿 `engine.duration` 是否为 0 判断"这首载入过没有" —— 那只说明
 * 引擎里有音频，不说明那是 index 指向的那首。载入失败时 index 已经指向新歌，
 * 引擎里还是上一首稳定载入的音频，duration 非 0，于是直接 play() 放了旧的。
 */
describe("载入失败后不能放回上一首", () => {
  it("新歌载入失败后按播放，重新载入新歌而不是播旧歌", async () => {
    // 第一首正常播上
    await usePlayer.getState().playAt(0)
    expect(engine.play).toHaveBeenCalledTimes(1)
    engine.duration = 123 // 引擎里挂着第一首，duration 非 0

    // 切到第二首，载入失败
    engine.load.mockRejectedValueOnce(new Error("解析播放地址失败"))
    await usePlayer.getState().playAt(1)
    expect(usePlayer.getState().index, "界面已经指向第二首").toBe(1)

    engine.play.mockClear()
    engine.load.mockClear()
    engine.load.mockResolvedValue(new Uint8Array([1]))

    // 用户按播放
    usePlayer.getState().toggle()
    await vi.advanceTimersByTimeAsync(0)

    expect(engine.load, "没有重新载入第二首，直接拿引擎里的旧音频开声了").toHaveBeenCalled()
    expect(usePlayer.getState().index, "播放位置漂回了上一首").toBe(1)
    engine.duration = 0
  })

  it("同一首歌暂停再播放，不该重新载入", async () => {
    await usePlayer.getState().playAt(0)
    engine.duration = 123
    engine.status = "playing"

    usePlayer.getState().toggle() // 暂停
    engine.status = "paused"
    engine.load.mockClear()

    usePlayer.getState().toggle() // 继续
    await vi.advanceTimersByTimeAsync(0)

    expect(engine.load, "暂停再播放不该重新读一遍文件").not.toHaveBeenCalled()
    expect(engine.play).toHaveBeenCalled()
    engine.duration = 0
    engine.status = "paused"
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

  /*
   * v0.1.0 的现场故障，原样复刻：短时间内连点好几首，然后按暂停 —— 软件自己响起来，
   * 而且一首刚放几秒就跳下一首。根因是那几次点击各自留了一个在途加载，暂停并不作废
   * 它们，晚回来的挨个调 engine.play()，其中失败的那些还各排了一个 2 秒自动跳转。
   *
   * 这条盯死三件事：暂停之后**一次都不准开声**、index 不准漂、不准有孤儿跳转。
   */
  it("连点多首后暂停：晚到的加载全部作废，不自动开声也不连环跳歌", async () => {
    const finishers: Array<(bytes: Uint8Array<ArrayBuffer>) => void> = []
    engine.load.mockImplementation(
      () =>
        new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
          finishers.push(resolve)
        }),
    )

    // 连点三首，每首都还卡在读盘里
    const first = usePlayer.getState().playAt(0)
    await Promise.resolve()
    const second = usePlayer.getState().playAt(1)
    await Promise.resolve()
    const third = usePlayer.getState().playAt(2)
    await Promise.resolve()
    expect(finishers).toHaveLength(3)

    usePlayer.getState().pause()
    const parked = usePlayer.getState().index

    // 三份字节这才陆续到齐
    for (const finish of finishers) finish(new Uint8Array(new ArrayBuffer(1)))
    await Promise.all([first, second, third])

    expect(engine.play, "暂停之后仍然有人把声音打开了").not.toHaveBeenCalled()
    expect(markMissing, "被取代的加载被误判成坏文件").not.toHaveBeenCalled()

    // 孤儿重试定时器要是还在，就是在这 2 秒后开始连环跳歌
    await vi.advanceTimersByTimeAsync(5000)
    expect(usePlayer.getState().index, "暂停后播放位置仍然自己漂走了").toBe(parked)
    expect(engine.play).not.toHaveBeenCalled()
  })

  /*
   * 与上一条相反的方向：暂停必须掐掉发声，但**不该**把这首歌在途的歌词封面一起作废。
   * 早先两件事共用一个代际计数，起播后一两秒内按暂停，封面就永远不来了。
   */
  it("暂停不影响当前这首在途的封面补齐", async () => {
    let finishCover!: (v: { path: string }) => void
    ensureCover.mockImplementationOnce(
      () => new Promise<{ path: string }>((resolve) => (finishCover = resolve)),
    )

    await usePlayer.getState().playAt(0)
    updateNowPlaying.mockClear()

    // 声音刚出来就按了暂停，此时封面还在解
    usePlayer.getState().pause()
    finishCover({ path: "C:/cover.jpg" })
    await vi.advanceTimersByTimeAsync(0)

    expect(updateNowPlaying, "暂停把在途的封面补齐一起作废了").toHaveBeenCalled()
  })

  it("换成别的歌之后，上一首在途的封面不准再写回来", async () => {
    let finishCover!: (v: { path: string }) => void
    ensureCover.mockImplementationOnce(
      () => new Promise<{ path: string }>((resolve) => (finishCover = resolve)),
    )

    await usePlayer.getState().playAt(0)
    await usePlayer.getState().playAt(1)
    updateNowPlaying.mockClear()

    finishCover({ path: "C:/stale-cover.jpg" })
    await vi.advanceTimersByTimeAsync(0)

    expect(updateNowPlaying, "上一首的封面盖到了新歌头上").not.toHaveBeenCalled()
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
