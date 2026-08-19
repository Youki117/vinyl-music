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

  /**
   * 下一首会是谁，**但不推进**。预取要用它。
   *
   * 走到本轮最后一首时返回 null：下一轮是那时才现洗的，答案此刻还不存在。
   * 硬要给一个（比如先洗出来）会改变随机序列本身 —— 预取是个优化，
   * 不该让它决定用户听到的顺序。返回 null 的那一次就不预取，仅此而已。
   */
  peek(n: number): number | null {
    if (this.order.length !== n) return null
    const next = this.pos + 1
    return next < this.order.length ? this.order[next] : null
  }

  back(): void {
    this.pos = Math.max(0, this.pos - 1)
  }

  /** 供测试观察当前整轮顺序 */
  snapshot(): number[] {
    return [...this.order]
  }
}
