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
