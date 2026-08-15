/**
 * 频谱 → 16 段能量包络。蒙版波动（PRD F10）的唯一数据源。
 */

export const BAND_COUNT = 16

/** 快起慢落：高频闪烁会让画面抽搐，落得慢才有浪涌感（F10.4） */
const ATTACK = 0.35
const RELEASE = 0.06

const LOW_HZ = 40
const HIGH_HZ = 14000

export class BandAnalyser {
  private analyser: AnalyserNode
  private freq: Uint8Array
  private edges: number[]
  private env = new Float32Array(BAND_COUNT)
  private smoothed = new Float32Array(BAND_COUNT)

  constructor(ctx: AudioContext) {
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    // 平滑自己做 —— 浏览器那套是对称的，满足不了"快起慢落"
    this.analyser.smoothingTimeConstant = 0
    this.freq = new Uint8Array(this.analyser.frequencyBinCount)

    // 对数分箱。线性分箱会让 16 段里十几段都落在高频，视觉上全在抖同一个东西。
    const hzPerBin = ctx.sampleRate / this.analyser.fftSize
    this.edges = Array.from({ length: BAND_COUNT + 1 }, (_, i) => {
      const hz = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / BAND_COUNT)
      return Math.min(this.freq.length - 1, Math.max(0, Math.round(hz / hzPerBin)))
    })
  }

  get node(): AnalyserNode {
    return this.analyser
  }

  /** 每帧调用。返回长度 16、取值 0..1 的包络，低频在 [0]。 */
  tick(): Float32Array {
    this.analyser.getByteFrequencyData(this.freq as Uint8Array<ArrayBuffer>)

    for (let i = 0; i < BAND_COUNT; i++) {
      const lo = this.edges[i]
      const hi = Math.max(lo + 1, this.edges[i + 1])
      let sum = 0
      for (let b = lo; b < hi; b++) sum += this.freq[b]
      const v = sum / (hi - lo) / 255
      this.env[i] += (v - this.env[i]) * (v > this.env[i] ? ATTACK : RELEASE)
    }

    // 相邻段做一次 [0.25, 0.5, 0.25] 卷积，消掉 16 段的台阶感
    for (let i = 0; i < BAND_COUNT; i++) {
      const a = this.env[Math.max(0, i - 1)]
      const b = this.env[i]
      const c = this.env[Math.min(BAND_COUNT - 1, i + 1)]
      this.smoothed[i] = a * 0.25 + b * 0.5 + c * 0.25
    }
    return this.smoothed
  }

  /** 暂停时让包络自然衰减到 0，画面平滑回到静止的呼吸态。 */
  decay(): Float32Array {
    for (let i = 0; i < BAND_COUNT; i++) this.env[i] *= 1 - RELEASE
    for (let i = 0; i < BAND_COUNT; i++) {
      const a = this.env[Math.max(0, i - 1)]
      const b = this.env[i]
      const c = this.env[Math.min(BAND_COUNT - 1, i + 1)]
      this.smoothed[i] = a * 0.25 + b * 0.5 + c * 0.25
    }
    return this.smoothed
  }

  get bands(): Float32Array {
    return this.smoothed
  }
}
