import { platform, type FileRef } from "@/platform"

import { Equalizer } from "./eq"
import { dbToGain } from "./loudness"

/**
 * 播放引擎。用 HTMLAudioElement 而不是 AudioBufferSourceNode 作音源：前者自带
 * 流式解码、currentTime 跳转与缓冲管理，一首 FLAC 不必整个解码进内存。
 *
 * 节点图：
 *   <audio> → MediaElementSource → Equalizer → 归一化增益 → 主增益 → destination
 *
 * 曾经在 GainNode 上旁路挂过一个 AnalyserNode，给蒙版提供 16 段频谱包络。
 * 蒙版律动删除后已一并移除（见 src/stage/Veil.tsx 的说明）。
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
  /** 音量归一化专用增益，接在均衡器与主增益之间。见 normGainValue */
  private norm: GainNode | null = null
  private objectUrl: string | null = null

  private progressListeners = new Set<Listener>()
  private statusListeners = new Set<StatusListener>()

  private _status: EngineStatus = "empty"
  private _error: string | null = null
  private _volume = 0.8
  private _muted = false

  private eq: Equalizer | null = null
  private _eqEnabled = false
  private _eqGains: number[] = new Array(10).fill(0)
  private _speed = 1
  private _outputDevice = ""
  private _normalize = false
  private _trackGainDb = 0

  /** pause() 的延迟停止计时器。play() 必须把它取消掉，见 pause() 里的说明。 */
  private pauseTimer = 0

  private sleepHandle = 0
  private sleepAt: number | null = null
  private sleepAfterTrack = false
  private sleepPending = false
  private sleepListeners = new Set<(remaining: number | null) => void>()

  /**
   * <audio> 元素惰性创建。模块级 new Audio() 会让这个文件一被 import 就依赖 DOM，
   * 纯逻辑的单元测试因此跑不起来。
   */
  private get el(): HTMLAudioElement {
    if (!this._el) {
      const el = new Audio()
      el.preload = "auto"
      el.playbackRate = this._speed
      el.preservesPitch = true
      // 挂进 DOM（隐藏）而不是留在游离状态：行为完全一样，但外部可观测，
      // 调试与端到端脚本都能直接数出有几路音频在发声。
      el.dataset.role = "host"
      el.style.display = "none"
      document.body.appendChild(el)
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
  /**
   * Web Audio 图必须在用户手势之后才能建，否则 AudioContext 会是 suspended。
   * 这里惰性初始化，第一次真正播放时才建。
   */
  private ensureGraph(): void {
    if (this.ctx) return
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(this.el)
    const eq = new Equalizer(ctx)
    const norm = ctx.createGain()
    const gain = ctx.createGain()

    src.connect(eq.input)
    eq.output.connect(norm)
    norm.connect(gain)
    gain.connect(ctx.destination)
    // 这里原本还旁路挂着一个 AnalyserNode，给蒙版提供 16 段频谱包络。
    // 蒙版律动删掉之后没人要这份数据了，整条链（audio/analyser.ts）一并移除。

    gain.gain.value = this.effectiveVolume()
    norm.gain.value = this.normGainValue()
    this.ctx = ctx
    this.gain = gain
    this.norm = norm
    this.eq = eq
  }

  // ── 音量归一化（F7.4）────────────────────────────────────
  /**
   * 归一化增益是**独立的一个节点**，不并进主增益。
   *
   * 主增益上跑着播放/暂停的淡入淡出包络（cancelScheduledValues + ramp），把归一化
   * 乘进去的话，任何一次暂停都会把它抹掉；反过来，测量结果晚到时的那次调整也会
   * 打断淡入。两件事各用一个节点，谁也不用知道谁的存在。
   *
   * 位置在均衡器之后、主增益之前 —— 叠加轨接的是主增益（见 attachLayer），
   * 所以不受归一化影响：那是给主音轨对齐响度的，不该动用户自己叠的环境音。
   */
  private normGainValue(): number {
    return this._normalize ? dbToGain(this._trackGainDb) : 1
  }

  /**
   * 应用当前的归一化增益。
   *
   * 用 250ms 的线性斜坡而不是直接赋值：测量结果可能在歌播到一半时才回来，
   * 音量当场跳一档比不归一化更难受。
   */
  private applyNorm(): void {
    if (!this.norm || !this.ctx) return
    const now = this.ctx.currentTime
    const g = this.norm.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(this.normGainValue(), now + 0.25)
  }

  setNormalize(on: boolean): void {
    this._normalize = on
    this.applyNorm()
  }

  get normalize(): boolean {
    return this._normalize
  }

  /**
   * 这首歌该加多少 dB。切歌时**必须显式设回 0**，否则上一首的增益会留在节点上。
   */
  setTrackGainDb(db: number): void {
    this._trackGainDb = Number.isFinite(db) ? db : 0
    this.applyNorm()
  }

  get trackGainDb(): number {
    return this._trackGainDb
  }

  /**
   * 给叠加轨挂一路输入，返回它自己的增益节点。
   *
   * 接在主增益之前，所以主音量会把叠加轨一起管住。均衡器不作用于叠加轨，
   * 那是给主音轨调音色用的。
   */
  attachLayer(el: HTMLAudioElement): GainNode | null {
    this.ensureGraph()
    if (!this.ctx || !this.gain) return null
    const src = this.ctx.createMediaElementSource(el)
    const g = this.ctx.createGain()
    g.gain.value = 0
    src.connect(g)
    g.connect(this.gain)
    return g
  }

  get context(): AudioContext | null {
    return this.ctx
  }

  // ── 均衡器 ────────────────────────────────────────────────
  setEqEnabled(on: boolean): void {
    this._eqEnabled = on
    this.ensureGraph()
    this.eq?.setEnabled(on)
  }

  setEqGains(gains: number[]): void {
    this._eqGains = [...gains]
    this.ensureGraph()
    this.eq?.setGains(gains)
  }

  get eqEnabled(): boolean {
    return this._eqEnabled
  }
  get eqGains(): number[] {
    return [...this._eqGains]
  }

  // ── 播放速度 ──────────────────────────────────────────────
  /**
   * preservesPitch 默认为 true，变速不变调 —— 关掉的话 1.5 倍速会把人声唱成花栗鼠。
   */
  setSpeed(rate: number): void {
    this._speed = Math.min(2, Math.max(0.5, rate))
    this.el.playbackRate = this._speed
    this.el.preservesPitch = true
  }

  get speed(): number {
    return this._speed
  }

  // ── 睡眠定时器 ────────────────────────────────────────────
  /**
   * @param minutes 分钟数；0 表示取消
   * @param afterTrack true 表示到点后等当前曲目播完再停
   */
  setSleepTimer(minutes: number, afterTrack = false): void {
    window.clearTimeout(this.sleepHandle)
    this.sleepAt = null
    this.sleepAfterTrack = afterTrack
    if (minutes <= 0) {
      this.emitSleep()
      return
    }
    this.sleepAt = Date.now() + minutes * 60_000
    this.sleepHandle = window.setTimeout(() => {
      if (this.sleepAfterTrack) {
        // 等当前曲目自然结束，由 store 的 onEnded 走到这里
        this.sleepPending = true
      } else {
        this.pause()
        this.clearSleep()
      }
    }, minutes * 60_000)
    this.emitSleep()
  }

  /** 曲目结束时由 store 询问：是否该停在这里。 */
  consumeSleepPending(): boolean {
    if (!this.sleepPending) return false
    this.clearSleep()
    return true
  }

  private clearSleep(): void {
    window.clearTimeout(this.sleepHandle)
    this.sleepHandle = 0
    this.sleepAt = null
    this.sleepPending = false
    this.emitSleep()
  }

  cancelSleepTimer(): void {
    this.clearSleep()
  }

  /** 剩余毫秒，未设置时为 null。 */
  get sleepRemaining(): number | null {
    return this.sleepAt === null ? null : Math.max(0, this.sleepAt - Date.now())
  }

  private emitSleep(): void {
    for (const fn of this.sleepListeners) fn(this.sleepRemaining)
  }

  onSleepChange(fn: (remaining: number | null) => void): () => void {
    this.sleepListeners.add(fn)
    fn(this.sleepRemaining)
    return () => this.sleepListeners.delete(fn)
  }

  // ── 输出设备 ──────────────────────────────────────────────
  async listOutputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === "audiooutput")
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const el = this.el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    if (typeof el.setSinkId !== "function") throw new Error("当前环境不支持切换输出设备")
    await el.setSinkId(deviceId)
    this._outputDevice = deviceId
  }

  get outputDevice(): string {
    return this._outputDevice
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

    // A-B 循环：放到 B 点就跳回 A。判定放在这里而不是 store 里，
    // 因为 timeupdate 每秒来四次，比 rAF 更省，也不依赖界面是否打开。
    const { a, b } = this._loop
    if (a !== null && b !== null && b > a && t >= b) {
      this.seekSeconds(a)
      return
    }

    for (const fn of this.progressListeners) fn(t, d)
  }

  /** A-B 循环区间，秒。两者都设上且 b > a 才生效。 */
  private _loop: { a: number | null; b: number | null } = { a: null, b: null }
  private loopListeners = new Set<(loop: { a: number | null; b: number | null }) => void>()

  get loop(): { a: number | null; b: number | null } {
    return this._loop
  }

  setLoop(a: number | null, b: number | null): void {
    this._loop = { a, b }
    for (const fn of this.loopListeners) fn(this._loop)
  }

  /** 依次调用：设 A → 设 B → 清除。一个按钮走完整个循环。 */
  cycleLoop(): void {
    const { a, b } = this._loop
    if (a === null) this.setLoop(this.currentTime, null)
    else if (b === null) {
      const t = this.currentTime
      // B 必须在 A 之后；点反了就当作重设 A，别让用户对着一个无效区间发愣
      if (t > a + 0.5) this.setLoop(a, t)
      else this.setLoop(t, null)
    } else this.setLoop(null, null)
  }

  onLoopChange(fn: (loop: { a: number | null; b: number | null }) => void): () => void {
    this.loopListeners.add(fn)
    fn(this._loop)
    return () => this.loopListeners.delete(fn)
  }

  /** 跳到绝对秒数 */
  seekSeconds(sec: number): void {
    const d = this.duration
    if (d > 0) this.seek(Math.min(1, Math.max(0, sec / d)))
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
    await this.attachBytes(bytes)
    return bytes
  }

  /**
   * 载入在线曲目。地址由 `src/source` 的 `resolvePlayUrl` 解析而来。
   *
   * **不把 URL 直接交给 `<audio>`**，而是先整段取回再走上面那条 Blob 路径。三个理由：
   *
   *   1. 音乐平台的 CDN 不给浏览器来源发 CORS 头，也常常要校验 Referer / UA。
   *      WebView 里的 `<audio>` 两样都做不到，只有走 plugin-http 从 Rust 侧取才拿得到。
   *   2. 这些直链大多是 `http://`，而 CSP 的 `media-src` 只放行了 `blob:` 与 `https:`。
   *      为一个可选功能把整个应用的 CSP 放宽到 `http:`，不值。
   *   3. 与本地文件同一条路径，播放行为、进度、A-B 区间的语义完全一致，不用维护两套。
   *
   * 代价是**要下完才能响**（128k 的四分钟大约 4MB，通常一两秒）。真嫌慢的话得改成
   * 直连流式播放，那就要接受上面三条各自的后果 —— 那是另一个决定，不在这里偷偷做。
   */
  async loadUrl(url: string): Promise<Uint8Array> {
    this.setStatus("loading")
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
    const res = await tauriFetch(url, { method: "GET" })
    if (!res.ok) {
      this.setStatus("error", `音源地址取回失败：HTTP ${res.status}`)
      throw new Error(`HTTP ${res.status}`)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > MAX_FILE_BYTES) {
      this.setStatus("error", `音频超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，已跳过`)
      throw new Error("文件过大")
    }
    await this.attachBytes(bytes)
    return bytes
  }

  /** 字节 → Blob → `<audio>`，等到 loadedmetadata 才算成功。本地与在线共用。 */
  private async attachBytes(bytes: Uint8Array): Promise<void> {
    this.revoke()
    // A-B 区间是按秒记的，换了曲目就没有意义了，必须清掉 ——
    // 否则新歌会在上一首的 B 点位置莫名其妙往回跳
    this.setLoop(null, null)
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
  }

  async play(): Promise<void> {
    this.ensureGraph()
    // 上一次 pause 的延迟停止还挂着的话先撤掉，否则它会在这次播放之后触发
    window.clearTimeout(this.pauseTimer)
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
      // 句柄必须留着：淡出的 80ms 内再按一次播放，这个计时器会在 play() 之后
      // 才触发，把已经在放的元素又暂停掉 —— 界面显示在播放，实际没声音
      window.clearTimeout(this.pauseTimer)
      this.pauseTimer = window.setTimeout(() => this.el.pause(), FADE_MS)
    } else {
      this.el.pause()
    }
    this.setStatus("paused")
  }

  toggle(): void {
    if (this._status === "playing") this.pause()
    else void this.play()
  }

  /** 跳转监听。系统媒体面板要靠它更新位置 —— 跳转不产生状态变化。 */
  private seekListeners = new Set<(t: number) => void>()

  onSeek(fn: (t: number) => void): () => void {
    this.seekListeners.add(fn)
    return () => this.seekListeners.delete(fn)
  }

  seek(frac: number): void {
    const d = this.duration
    if (d > 0) {
      this.el.currentTime = Math.min(d, Math.max(0, frac * d))
      this.emitProgress()
      for (const fn of this.seekListeners) fn(this.el.currentTime)
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
