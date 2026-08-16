import { platform, type FileRef } from "@/platform"
import { clipAt, clipEnd, fadeFactor, type Clip } from "./clips"
import { engine } from "./engine"

export type LayerConfig = {
  id: string
  trackId: string
  name: string
  /** 整轨音量，片段音量叠在它之上 */
  volume: number
  muted: boolean
  clips: Clip[]
}

/** 播放位置偏离超过这个秒数就重新对齐，小于它不动，免得频繁 seek 产生爆音 */
const DRIFT_TOLERANCE = 0.35

/**
 * 一条叠加音轨。
 *
 * 时间轴跟着主音轨走：主音轨走到哪一秒，就查片段表决定本层此刻该播源文件的
 * 哪个位置、用多大音量。没有片段覆盖的时刻就是静音——「删掉一段」在听感上
 * 正是这么实现的。
 *
 * 全程只是运行时混音，不改动也不产出任何音频文件。
 */
export class AudioLayer {
  readonly config: LayerConfig
  private el = new Audio()
  private gain: GainNode | null = null
  private url: string | null = null
  private ready = false
  private lastGain = -1
  private lastClipId: string | null = null

  constructor(config: LayerConfig) {
    this.config = config
    this.el.preload = "auto"
    // 与主音轨一样挂进 DOM（隐藏），便于观测与调试
    this.el.dataset.role = "layer"
    this.el.dataset.layerId = config.id
    this.el.style.display = "none"
    document.body.appendChild(this.el)
  }

  async load(ref: FileRef): Promise<void> {
    const bytes = await platform.readFile(ref)
    this.revoke()
    this.url = URL.createObjectURL(new Blob([bytes as BlobPart]))
    this.el.src = this.url
    await new Promise<void>((resolve, reject) => {
      this.el.addEventListener("loadedmetadata", () => resolve(), { once: true })
      this.el.addEventListener("error", () => reject(new Error("叠加轨解码失败")), { once: true })
    })
    this.gain = engine.attachLayer(this.el)
    this.ready = true
  }

  get duration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0
  }

  /**
   * 每帧调用。查片段表，校正本层进度并施加音量。
   *
   * @param hostTime 主音轨当前秒数
   * @param hostPlaying 主音轨是否在播放
   */
  tick(hostTime: number, hostPlaying: boolean): void {
    if (!this.ready || !this.gain) return

    const clip = clipAt(this.config.clips, hostTime)

    if (!hostPlaying || !clip || this.config.muted) {
      this.applyGain(0)
      if (!this.el.paused) this.el.pause()
      this.lastClipId = null
      return
    }

    const target = clip.sourceStart + (hostTime - clip.at)
    // 换到另一个片段时必须立刻对位，不能等漂移超阈值——那会把上一段的尾巴带过来
    const jumped = clip.id !== this.lastClipId
    if (jumped || Math.abs(this.el.currentTime - target) > DRIFT_TOLERANCE) {
      this.el.currentTime = Math.max(0, target)
    }
    this.lastClipId = clip.id

    if (this.el.paused) void this.el.play().catch(() => {})
    this.applyGain(this.config.volume * clip.gain * fadeFactor(clip, hostTime))
  }

  private applyGain(v: number): void {
    if (!this.gain) return
    // 只在变化足够大时才写，省掉每帧的无谓调度
    if (Math.abs(v - this.lastGain) < 0.002) return
    this.lastGain = v
    const ctx = engine.context
    if (ctx) this.gain.gain.setTargetAtTime(v, ctx.currentTime, 0.012)
    else this.gain.gain.value = v
  }

  private revoke(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url)
      this.url = null
    }
  }

  dispose(): void {
    this.el.pause()
    this.revoke()
    this.gain?.disconnect()
    this.gain = null
    this.ready = false
    this.el.remove()
  }
}

export { clipEnd }
export type { Clip }
