/** 10 段均衡器。频点取 ISO 标准倍频程中心频率，与主流播放器一致。 */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

export const EQ_MIN_DB = -12
export const EQ_MAX_DB = 12

export type EqPreset = { name: string; gains: number[] }

export const EQ_PRESETS: EqPreset[] = [
  { name: "关闭", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "流行", gains: [-1, 2, 4, 4, 1, -1, -1, 0, 1, 2] },
  { name: "摇滚", gains: [4, 3, -1, -2, -1, 2, 3, 4, 4, 4] },
  { name: "古典", gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  { name: "爵士", gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { name: "人声", gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: "低音增强", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: "高音增强", gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
]

/**
 * 均衡器节点链。
 *
 * 关闭时整体旁路而不是把增益设成 0 —— 十个 BiquadFilter 即使增益为 0 也要逐样本
 * 计算，白白吃 CPU。
 */
export class Equalizer {
  private ctx: AudioContext
  private filters: BiquadFilterNode[]
  private _enabled = false
  private _gains: number[] = new Array(EQ_BANDS.length).fill(0)

  /** 外部只连这两个端点，内部怎么接由本类决定 */
  readonly input: GainNode
  readonly output: GainNode

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.input = ctx.createGain()
    this.output = ctx.createGain()

    this.filters = EQ_BANDS.map((hz, i) => {
      const f = ctx.createBiquadFilter()
      // 两端用 shelf，中间用 peaking —— 只用 peaking 的话最低/最高频段几乎无效
      f.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking"
      f.frequency.value = hz
      f.Q.value = 1.1
      f.gain.value = 0
      return f
    })

    this.rewire()
  }

  private rewire(): void {
    this.input.disconnect()
    for (const f of this.filters) f.disconnect()

    if (this._enabled) {
      let node: AudioNode = this.input
      for (const f of this.filters) {
        node.connect(f)
        node = f
      }
      node.connect(this.output)
    } else {
      this.input.connect(this.output)
    }
  }

  get enabled(): boolean {
    return this._enabled
  }

  setEnabled(on: boolean): void {
    if (this._enabled === on) return
    this._enabled = on
    this.rewire()
  }

  get gains(): number[] {
    return [...this._gains]
  }

  setGains(gains: number[]): void {
    for (let i = 0; i < this.filters.length; i++) {
      const db = clamp(gains[i] ?? 0, EQ_MIN_DB, EQ_MAX_DB)
      this._gains[i] = db
      // 用 setTargetAtTime 平滑过渡，直接赋值拖滑块时会有爆音
      this.filters[i].gain.setTargetAtTime(db, this.ctx.currentTime, 0.02)
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
