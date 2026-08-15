/**
 * 随机播放顺序。
 *
 * 用 Fisher-Yates 洗出一个完整顺序，而不是每次随机取一首 —— 后者会重复播放
 * 同一首，用户体感很差（PRD F1.5 要求"一轮内不重复"）。
 */
export class ShuffleOrder {
  private order: number[] = []
  private pos = 0

  /** @param avoidFirst 新一轮的第一首不要等于这个下标（通常是上一轮的最后一首） */
  reshuffle(n: number, avoidFirst: number | null = null, rand: () => number = Math.random): void {
    this.order = Array.from({ length: n }, (_, i) => i)
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[this.order[i], this.order[j]] = [this.order[j], this.order[i]]
    }
    if (avoidFirst !== null && n > 1 && this.order[0] === avoidFirst) {
      ;[this.order[0], this.order[1]] = [this.order[1], this.order[0]]
    }
    this.pos = 0
  }

  get length(): number {
    return this.order.length
  }

  get current(): number {
    return this.order[this.pos] ?? 0
  }

  /** 前进一首。走完一轮时自动重洗并返回 true。 */
  advance(n: number, rand: () => number = Math.random): boolean {
    if (this.order.length !== n) {
      this.reshuffle(n, null, rand)
      return true
    }
    this.pos++
    if (this.pos >= this.order.length) {
      this.reshuffle(n, this.order[this.order.length - 1] ?? null, rand)
      return true
    }
    return false
  }

  back(): void {
    this.pos = Math.max(0, this.pos - 1)
  }

  /** 供测试观察当前整轮顺序 */
  snapshot(): number[] {
    return [...this.order]
  }
}
