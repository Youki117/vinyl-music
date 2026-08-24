import { beforeEach, describe, expect, it, vi } from "vitest"

class FakeAudio extends EventTarget {
  preload = ""
  playbackRate = 1
  preservesPitch = true
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  src = ""
  paused = true
  currentTime = 0
  duration = 1

  pause() {
    this.paused = true
  }

  play() {
    this.paused = false
    return Promise.resolve()
  }

  load() {}

  removeAttribute(name: string) {
    if (name === "src") this.src = ""
  }
}

/**
 * 够 ensureGraph 把节点图搭起来就行 —— 这些用例关心的是引擎的**状态与通知**，
 * 不是真的出声。连线调用只要不抛就算数。
 */
const node = () => ({
  gain: {
    value: 0,
    cancelScheduledValues() {},
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    setTargetAtTime() {},
  },
  frequency: { value: 0 },
  Q: { value: 0 },
  type: "",
  connect() {},
  disconnect() {},
})

class FakeAudioContext {
  state = "running"
  currentTime = 0
  destination = node()
  createGain = () => node()
  createBiquadFilter = () => node()
  createMediaElementSource = () => node()
  resume = async () => {}
  close = async () => {}
}

let audio: FakeAudio
let objectUrl = 0

beforeEach(() => {
  vi.resetModules()
  audio = new FakeAudio()
  vi.stubGlobal("Audio", vi.fn(() => audio))
  vi.stubGlobal("document", { body: { appendChild: vi.fn() } })
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => `blob:test-${++objectUrl}`),
    revokeObjectURL: vi.fn(),
  })
  vi.stubGlobal("AudioContext", FakeAudioContext)
  // 定时器全走 window。用箭头转发而不是直接引用，vi.useFakeTimers() 换掉全局后才跟得上
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  })
})

describe("音频引擎加载代际", () => {
  it("新加载会取消等待 metadata 的旧加载", async () => {
    const { engine } = await import("@/audio/engine")
    const first = engine.loadBytes(new Uint8Array([1]))
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" })

    const second = engine.loadBytes(new Uint8Array([2]))
    await firstRejected
    expect(audio.src).toBe("blob:test-2")

    audio.dispatchEvent(new Event("loadedmetadata"))
    await second
    expect(engine.status).toBe("paused")
  })

  it("加载中暂停会立即取消待播放的音频", async () => {
    const { engine } = await import("@/audio/engine")
    const loading = engine.loadBytes(new Uint8Array([1]))
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" })

    engine.pause()

    await rejected
    expect(audio.src).toBe("")
    expect(engine.status).toBe("paused")
  })
})

/*
 * 播放设置面板是常驻挂载的，而存盘的 EQ 要等 player.init() 读完盘才写回引擎 ——
 * 比面板挂载晚得多。面板只在挂载时取一次快照的话会永远显示全 0，用户一拖滑块
 * 就拿这份全 0 覆盖掉存盘的整条曲线。所以订阅**必须连当前值一起给**。
 */
describe("均衡器状态订阅", () => {
  it("订阅时立刻回调一次当前值，晚订阅也追得上", async () => {
    const { engine } = await import("@/audio/engine")
    // 先改引擎（相当于 init() 读完盘写回），之后才有人订阅（相当于面板后挂载）
    engine.setEqGains([1, 2, 3])
    engine.setEqEnabled(true)

    const seen: Array<{ enabled: boolean; gains: number[] }> = []
    engine.onEqChange((eq) => seen.push(eq))

    expect(seen).toHaveLength(1)
    expect(seen[0].gains.slice(0, 3)).toEqual([1, 2, 3])
    expect(seen[0].enabled).toBe(true)
  })

  it("引擎侧的每次改动都推给订阅者", async () => {
    const { engine } = await import("@/audio/engine")
    const seen: Array<{ enabled: boolean; gains: number[] }> = []
    const off = engine.onEqChange((eq) => seen.push(eq))
    seen.length = 0 // 丢掉订阅时那一次

    engine.setEqGains([4, 5, 6])
    engine.setEqEnabled(true)
    expect(seen).toHaveLength(2)
    expect(seen[0].gains.slice(0, 3)).toEqual([4, 5, 6])
    expect(seen[1].enabled).toBe(true)

    off()
    engine.setEqGains([9, 9, 9])
    expect(seen, "退订之后还在收推送").toHaveLength(2)
  })

  it("推给订阅者的是副本，改它不会污染引擎", async () => {
    const { engine } = await import("@/audio/engine")
    engine.setEqGains([1, 2, 3])
    let got: number[] = []
    engine.onEqChange((eq) => (got = eq.gains))

    got[0] = 999
    expect(engine.eqGains[0]).toBe(1)
  })
})

/*
 * 定时器回调是在触发那一刻才读 sleepAfterTrack 的，所以改标志位就够了。
 * 不能拿 setSleepTimer 重设一遍来实现 —— 那会把已经跑掉的时间一起抹掉。
 */
describe("睡眠定时的「播完当前歌曲」开关", () => {
  it("改开关不会重置倒计时", async () => {
    vi.useFakeTimers()
    try {
      const { engine } = await import("@/audio/engine")
      engine.setSleepTimer(30)
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      const before = engine.sleepRemaining!
      engine.setSleepAfterTrack(true)
      const after = engine.sleepRemaining!

      expect(before).toBeLessThan(30 * 60_000)
      expect(after).toBeLessThanOrEqual(before)
      expect(after, "倒计时被拨开关重置回满值了").toBeLessThan(26 * 60_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("到点时按的是最后一次拨到的值", async () => {
    vi.useFakeTimers()
    try {
      const { engine } = await import("@/audio/engine")
      // 起定时器时是关的，中途才拨开 —— 早先这一拨完全不生效
      engine.setSleepTimer(30, false)
      engine.setSleepAfterTrack(true)
      await vi.advanceTimersByTimeAsync(31 * 60_000)

      // 拨开了就该等曲目自然结束，而不是到点直接停
      expect(engine.consumeSleepPending(), "到点直接停了，没等这首放完").toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
