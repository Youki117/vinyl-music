import { describe, expect, it } from "vitest"

import { ShuffleOrder } from "@/store/shuffle"

/** 可复现的伪随机，避免测试偶发失败 */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe("ShuffleOrder", () => {
  it("一轮内每首恰好出现一次", () => {
    const s = new ShuffleOrder()
    s.reshuffle(12, null, seeded(1))
    const seen = s.snapshot()
    expect(seen).toHaveLength(12)
    expect(new Set(seen).size).toBe(12)
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i))
  })

  it("走完一轮后自动重洗", () => {
    const s = new ShuffleOrder()
    const rand = seeded(7)
    s.reshuffle(4, null, rand)
    const first = s.snapshot()

    let reshuffled = false
    for (let i = 0; i < 3; i++) reshuffled = s.advance(4, rand) || reshuffled
    expect(reshuffled, "一轮没走完不该重洗").toBe(false)

    expect(s.advance(4, rand), "第 4 次前进应触发重洗").toBe(true)
    expect(s.snapshot()).toHaveLength(4)
    expect(new Set(s.snapshot()).size).toBe(4)
    void first
  })

  it("新一轮的第一首不等于指定要避开的那首", () => {
    // 逐个种子验证约束恒成立，而不是碰运气
    for (let seed = 1; seed <= 60; seed++) {
      const s = new ShuffleOrder()
      s.reshuffle(5, 3, seeded(seed))
      expect(s.snapshot()[0], `seed=${seed}`).not.toBe(3)
    }
  })

  it("曲目数变化时重建顺序", () => {
    const s = new ShuffleOrder()
    s.reshuffle(3, null, seeded(2))
    expect(s.advance(9, seeded(2))).toBe(true)
    expect(s.length).toBe(9)
  })

  it("单曲列表不会死循环", () => {
    const s = new ShuffleOrder()
    s.reshuffle(1, null, seeded(5))
    expect(s.current).toBe(0)
    s.advance(1, seeded(5))
    expect(s.current).toBe(0)
  })

  it("back 不会退到负数", () => {
    const s = new ShuffleOrder()
    s.reshuffle(4, null, seeded(3))
    s.back()
    s.back()
    expect(s.current).toBe(s.snapshot()[0])
  })
})

describe("peek —— 预取要知道下一首是谁", () => {
  it("说的和 advance 走到的是同一首", () => {
    const s = new ShuffleOrder()
    s.reshuffle(6, null, seeded(3))
    for (let i = 0; i < 5; i++) {
      const guess = s.peek(6)
      s.advance(6, seeded(3))
      expect(s.current).toBe(guess)
    }
  })

  it("不推进状态 —— 连问十次答案都一样", () => {
    const s = new ShuffleOrder()
    s.reshuffle(6, null, seeded(11))
    const before = s.current
    const answers = Array.from({ length: 10 }, () => s.peek(6))
    expect(new Set(answers).size).toBe(1)
    expect(s.current).toBe(before)
  })

  /**
   * 走到本轮最后一首时下一轮还没洗出来，答案此刻不存在。硬要给一个就会改变
   * 随机序列本身 —— 预取是个优化，不该决定用户听到的顺序。
   */
  it("轮末返回 null，而不是编一个出来", () => {
    const s = new ShuffleOrder()
    s.reshuffle(3, null, seeded(5))
    s.advance(3, seeded(5))
    expect(s.peek(3)).not.toBe(null)
    s.advance(3, seeded(5))
    expect(s.peek(3)).toBe(null)
  })

  it("队列长度对不上就不猜", () => {
    const s = new ShuffleOrder()
    s.reshuffle(6, null, seeded(2))
    expect(s.peek(7)).toBe(null)
  })
})
