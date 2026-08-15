import { platform, type FileRef } from "@/platform"
import { BandAnalyser } from "./analyser"

/**
 * 播放引擎。用 HTMLAudioElement 而不是 AudioBufferSourceNode 作音源：前者自带
 * 流式解码、currentTime 跳转与缓冲管理，一首 FLAC 不必整个解码进内存。
 *
 * 节点图：
 *   <audio> → MediaElementSource → GainNode → destination
 *                                      └─→ AnalyserNode（旁路）
 */

const FADE_MS = 80
const MAX_FILE_BYTES = 200 * 1024 * 1024

export type EngineStatus = "empty" | "loading" | "paused" | "playing" | "error"

type Listener = (time: number, duration: number) => void
type StatusListener = (status: EngineStatus, error: string | null) => void

class Engine {
  private _el: HTMLAudioElement | null = null
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: BandAnalyser | null = null
  private objectUrl: string | null = null

  private progressListeners = new Set<Listener>()
  private statusListeners = new Set<StatusListener>()

  private _status: EngineStatus = "empty"
  private _error: string | null = null
  private _volume = 0.8
  private _muted = false

  /**
   * <audio> 元素惰性创建。模块级 new Audio() 会让这个文件一被 import 就依赖 DOM，
   * 纯逻辑的单元测试因此跑不起来。
   */
  private get el(): HTMLAudioElement {
    if (!this._el) {
      const el = new Audio()
      el.preload = "auto"
      el.addEventListener("timeupdate", () => this.emitProgress())
      el.addEventListener("durationchange", () => this.emitProgress())
      el.addEventListener("ended", () => this.onEnded?.())
      el.addEventListener("error", () => {
        this.setStatus("error", "音频文件无法播放（可能已损坏或格式不受支持）")
      })
      this._el = el
    }
    return this._el
  }

  /** 曲目自然结束的回调，由 store 接管以决定下一首。 */
  onEnded: (() => void) | null = null

  get status(): EngineStatus {
    return this._status
  }
  get currentTime(): number {
    return this.el.currentTime || 0
  }
  get duration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0
  }
  get bands(): Float32Array | null {
    return this.analyser?.bands ?? null
  }

  /**
   * Web Audio 图必须在用户手势之后才能建，否则 AudioContext 会是 suspended。
   * 这里惰性初始化，第一次真正播放时才建。
   */
  private ensureGraph(): void {
    if (this.ctx) return
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(this.el)
    const gain = ctx.createGain()
    const analyser = new BandAnalyser(ctx)

    src.connect(gain)
    gain.connect(ctx.destination)
    // 分析器旁路，不影响输出
    gain.connect(analyser.node)

    gain.gain.value = this.effectiveVolume()
    this.ctx = ctx
    this.gain = gain
    this.analyser = analyser
  }

  private effectiveVolume(): number {
    // 感知对数曲线：线性音量在低端几乎没有可用行程
    return this._muted ? 0 : Math.pow(this._volume, 2.2)
  }

  private setStatus(s: EngineStatus, err: string | null = null): void {
    this._status = s
    this._error = err
    for (const fn of this.statusListeners) fn(s, err)
  }

  private emitProgress(): void {
    const t = this.currentTime
    const d = this.duration
    for (const fn of this.progressListeners) fn(t, d)
  }

  private revoke(): void {
    if (this.objectUrl) {
      // 不 revoke 就是稳定的内存泄漏：PRD 要求连续播放 8 小时增长 < 50MB
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
  }

  /**
   * 载入曲目，返回文件字节供元数据与波形复用（避免二次读盘）。
   *
   * 走 Blob 而不是 Tauri 的 convertFileSrc：后者是跨源 URL，
   * createMediaElementSource 会污染音频图，getByteFrequencyData() 恒返回全 0
   * 且不报错，蒙版波动会静默失效。
   */
  async load(ref: FileRef): Promise<Uint8Array> {
    this.setStatus("loading")
    if (ref.size > MAX_FILE_BYTES) {
      this.setStatus("error", `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，已跳过`)
      throw new Error("文件过大")
    }

    const bytes = await platform.readFile(ref)
    this.revoke()
    this.objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]))
    this.el.src = this.objectUrl

    await new Promise<void>((resolve, reject) => {
      const ok = () => {
        cleanup()
        resolve()
      }
      const bad = () => {
        cleanup()
        reject(new Error("解码失败"))
      }
      const cleanup = () => {
        this.el.removeEventListener("loadedmetadata", ok)
        this.el.removeEventListener("error", bad)
      }
      this.el.addEventListener("loadedmetadata", ok, { once: true })
      this.el.addEventListener("error", bad, { once: true })
    })

    this.setStatus("paused")
    this.emitProgress()
    return bytes
  }

  async play(): Promise<void> {
    this.ensureGraph()
    if (this.ctx?.state === "suspended") await this.ctx.resume()
    if (!this.el.src) return

    // 淡入，消除咔哒声（F7.2）
    if (this.gain && this.ctx) {
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
      this.gain.gain.setValueAtTime(0.0001, this.ctx.currentTime)
      this.gain.gain.linearRampToValueAtTime(
        Math.max(0.0001, this.effectiveVolume()),
        this.ctx.currentTime + FADE_MS / 1000,
      )
    }
    try {
      await this.el.play()
      this.setStatus("playing")
    } catch (err) {
      this.setStatus("error", err instanceof Error ? err.message : "播放失败")
    }
  }

  pause(): void {
    if (this.gain && this.ctx) {
      const now = this.ctx.currentTime
      this.gain.gain.cancelScheduledValues(now)
      this.gain.gain.setValueAtTime(this.gain.gain.value, now)
      this.gain.gain.linearRampToValueAtTime(0.0001, now + FADE_MS / 1000)
      window.setTimeout(() => this.el.pause(), FADE_MS)
    } else {
      this.el.pause()
    }
    this.setStatus("paused")
  }

  toggle(): void {
    if (this._status === "playing") this.pause()
    else void this.play()
  }

  seek(frac: number): void {
    const d = this.duration
    if (d > 0) {
      this.el.currentTime = Math.min(d, Math.max(0, frac * d))
      this.emitProgress()
    }
  }

  seekBy(seconds: number): void {
    const d = this.duration
    if (d > 0) this.seek(Math.min(1, Math.max(0, (this.currentTime + seconds) / d)))
  }

  setVolume(v: number): void {
    this._volume = Math.min(1, Math.max(0, v))
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(this.effectiveVolume(), this.ctx.currentTime, 0.02)
    }
  }

  setMuted(m: boolean): void {
    this._muted = m
    this.setVolume(this._volume)
  }

  get volume(): number {
    return this._volume
  }
  get muted(): boolean {
    return this._muted
  }
  get error(): string | null {
    return this._error
  }

  /** 每帧刷新频谱包络。播放中取实时值，否则自然衰减。 */
  tickBands(): Float32Array | null {
    if (!this.analyser) return null
    return this._status === "playing" ? this.analyser.tick() : this.analyser.decay()
  }

  /**
   * 进度订阅。进度刻意不进 store —— 它每秒变化几十次，进 store 会让整棵组件树
   * 每秒重渲染几十次（技术文档 §10）。
   */
  onProgress(fn: Listener): () => void {
    this.progressListeners.add(fn)
    fn(this.currentTime, this.duration)
    return () => this.progressListeners.delete(fn)
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn)
    fn(this._status, this._error)
    return () => this.statusListeners.delete(fn)
  }

  dispose(): void {
    this._el?.pause()
    this.revoke()
    void this.ctx?.close()
  }
}

export const engine = new Engine()
