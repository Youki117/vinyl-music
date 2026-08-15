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
