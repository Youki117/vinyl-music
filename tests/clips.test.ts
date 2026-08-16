import { describe, expect, it } from "vitest"

import {
  clipAt,
  clipEnd,
  duplicateClip,
  fadeFactor,
  gainAt,
  initialClips,
  MIN_CLIP,
  moveClip,
  removeClip,
  setGain,
  splitAt,
  trimClip,
  type Clip,
} from "@/audio/clips"

const clip = (p: Partial<Clip> & { id: string; at: number; duration: number }): Clip => ({
  sourceStart: 0,
  gain: 1,
  ...p,
})

/** 断言：同一层内片段永不重叠。这是单个 <audio> 元素带来的硬限制。 */
function expectNoOverlap(clips: Clip[]) {
  const s = [...clips].sort((a, b) => a.at - b.at)
  for (let i = 1; i < s.length; i++) {
    expect(s[i].at, `片段 ${s[i].id} 与前一段重叠`).toBeGreaterThanOrEqual(clipEnd(s[i - 1]) - 1e-9)
  }
}

describe("clipAt / gainAt", () => {
  const clips = [clip({ id: "a", at: 0, duration: 10 }), clip({ id: "b", at: 20, duration: 10 })]

  it("命中区间内的片段", () => {
    expect(clipAt(clips, 5)?.id).toBe("a")
    expect(clipAt(clips, 25)?.id).toBe("b")
  })

  it("片段之间的空白没有片段 —— 这正是「删掉一段」的听感来源", () => {
    expect(clipAt(clips, 15)).toBeNull()
    expect(gainAt(clips, 15)).toBe(0)
  })

  it("区间左闭右开，边界不会同时命中两段", () => {
    expect(clipAt(clips, 0)?.id).toBe("a")
    expect(clipAt(clips, 10)).toBeNull()
  })

  it("片段音量会乘进去", () => {
    const c = [clip({ id: "a", at: 0, duration: 10, gain: 0.4 })]
    expect(gainAt(c, 5)).toBeCloseTo(0.4, 5)
  })
})

describe("fadeFactor", () => {
  const c = clip({ id: "a", at: 10, duration: 10 })

  it("片段中部是满音量", () => {
    expect(fadeFactor(c, 15)).toBeCloseTo(1, 5)
  })

  it("两端从 0 渐入渐出，避免咔哒", () => {
    expect(fadeFactor(c, 10)).toBeCloseTo(0, 5)
    expect(fadeFactor(c, 20)).toBeCloseTo(0, 5)
    expect(fadeFactor(c, 10.01)).toBeGreaterThan(0)
    expect(fadeFactor(c, 10.01)).toBeLessThan(1)
  })

  it("片段比两段淡变还短时按比例压缩，仍能到满音量", () => {
    const tiny = clip({ id: "t", at: 0, duration: 0.02 })
    expect(fadeFactor(tiny, 0.01)).toBeCloseTo(1, 5)
  })

  it("区间外为 0", () => {
    expect(fadeFactor(c, 5)).toBe(0)
    expect(fadeFactor(c, 25)).toBe(0)
  })
})

describe("splitAt", () => {
  const clips = [clip({ id: "a", at: 0, duration: 30 })]

  it("在中间切成两段，源内位置正确顺延", () => {
    const r = splitAt(clips, 12)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ at: 0, duration: 12, sourceStart: 0 })
    expect(r[1]).toMatchObject({ at: 12, duration: 18, sourceStart: 12 })
    expectNoOverlap(r)
  })

  it("保留原片段的源偏移", () => {
    const c = [clip({ id: "a", at: 10, duration: 20, sourceStart: 100 })]
    const r = splitAt(c, 15)
    expect(r[1].sourceStart).toBeCloseTo(105, 5)
  })

  it("切点不在任何片段内时原样返回", () => {
    expect(splitAt(clips, 99)).toBe(clips)
  })

  it("切出的碎片太短就不切，避免产生一堆零碎", () => {
    expect(splitAt(clips, MIN_CLIP / 2)).toBe(clips)
    expect(splitAt(clips, 30 - MIN_CLIP / 2)).toBe(clips)
  })

  it("连切两刀得到三段，「只留中间」由此而来", () => {
    let r = splitAt(clips, 10)
    r = splitAt(r, 20)
    expect(r).toHaveLength(3)
    expect(r.map((c) => c.at)).toEqual([0, 10, 20])
    expectNoOverlap(r)
  })
})

describe("removeClip", () => {
  it("删掉后那段变成静音", () => {
    let r = splitAt([clip({ id: "a", at: 0, duration: 30 })], 10)
    r = splitAt(r, 20)
    const mid = r[1]
    const after = removeClip(r, mid.id)
    expect(after).toHaveLength(2)
    expect(gainAt(after, 15)).toBe(0)
    expect(gainAt(after, 5)).toBeGreaterThan(0)
  })
})

describe("moveClip", () => {
  const clips = [clip({ id: "a", at: 0, duration: 10 }), clip({ id: "b", at: 30, duration: 10 })]

  it("整体平移，源内位置不变", () => {
    const r = moveClip(clips, "b", 15, 60)
    const b = r.find((c) => c.id === "b")!
    expect(b.at).toBeCloseTo(15, 5)
    expect(b.sourceStart).toBe(0)
  })

  it("被前一段挡住时贴住它，不会重叠", () => {
    const r = moveClip(clips, "b", 2, 60)
    expect(r.find((c) => c.id === "b")!.at).toBeCloseTo(10, 5)
    expectNoOverlap(r)
  })

  it("不能移出主音轨范围", () => {
    const r = moveClip(clips, "b", 999, 60)
    expect(clipEnd(r.find((c) => c.id === "b")!)).toBeLessThanOrEqual(60 + 1e-9)
  })

  it("不能移到负数", () => {
    const r = moveClip([clip({ id: "a", at: 5, duration: 10 })], "a", -20, 60)
    expect(r[0].at).toBe(0)
  })

  it("移动不存在的片段时原样返回", () => {
    expect(moveClip(clips, "查无此段", 5, 60)).toBe(clips)
  })
})

describe("trimClip", () => {
  it("拖右缘只改时长", () => {
    const c = [clip({ id: "a", at: 0, duration: 30 })]
    const r = trimClip(c, "a", "end", 20, 100)
    expect(r[0]).toMatchObject({ at: 0, duration: 20, sourceStart: 0 })
  })

  it("拖左缘同时改源内起点 —— 即「从后面一点开始放」", () => {
    const c = [clip({ id: "a", at: 0, duration: 30 })]
    const r = trimClip(c, "a", "start", 10, 100)
    expect(r[0]).toMatchObject({ at: 10, duration: 20, sourceStart: 10 })
  })

  it("右缘不能超出源文件长度", () => {
    const c = [clip({ id: "a", at: 0, duration: 30, sourceStart: 90 })]
    const r = trimClip(c, "a", "end", 999, 100)
    // 源只剩 10 秒可用
    expect(r[0].duration).toBeCloseTo(10, 5)
  })

  it("左缘不能把源内起点拖成负数", () => {
    const c = [clip({ id: "a", at: 10, duration: 20, sourceStart: 2 })]
    const r = trimClip(c, "a", "start", 0, 100)
    expect(r[0].sourceStart).toBeGreaterThanOrEqual(0)
  })

  it("不能裁到比最小长度还短", () => {
    const c = [clip({ id: "a", at: 0, duration: 30 })]
    const r = trimClip(c, "a", "end", 0, 100)
    expect(r[0].duration).toBeGreaterThanOrEqual(MIN_CLIP - 1e-9)
  })

  it("裁剪时不会撞进邻居", () => {
    const c = [clip({ id: "a", at: 0, duration: 10 }), clip({ id: "b", at: 20, duration: 10 })]
    const r = trimClip(c, "a", "end", 25, 100)
    expectNoOverlap(r)
    expect(clipEnd(r.find((x) => x.id === "a")!)).toBeLessThanOrEqual(20 + 1e-9)
  })
})

describe("duplicateClip", () => {
  it("复制到紧随其后的空位", () => {
    const c = [clip({ id: "a", at: 0, duration: 10 })]
    const r = duplicateClip(c, "a", 60)
    expect(r).toHaveLength(2)
    expect(r[1].at).toBeCloseTo(10, 5)
    expect(r[1].sourceStart).toBe(r[0].sourceStart)
    expect(r[1].id).not.toBe("a")
    expectNoOverlap(r)
  })

  it("紧邻位置被占时往后找空位", () => {
    const c = [clip({ id: "a", at: 0, duration: 10 }), clip({ id: "b", at: 10, duration: 10 })]
    const r = duplicateClip(c, "a", 60)
    expect(r).toHaveLength(3)
    expectNoOverlap(r)
  })

  it("放不下就不放，不会溢出主音轨", () => {
    const c = [clip({ id: "a", at: 50, duration: 10 })]
    expect(duplicateClip(c, "a", 60)).toBe(c)
  })
})

describe("setGain / initialClips", () => {
  it("音量被夹在 0..1", () => {
    const c = [clip({ id: "a", at: 0, duration: 10 })]
    expect(setGain(c, "a", 5)[0].gain).toBe(1)
    expect(setGain(c, "a", -5)[0].gain).toBe(0)
  })

  it("初始片段不超过主音轨长度", () => {
    expect(initialClips(300, 60)[0].duration).toBeCloseTo(60, 5)
    expect(initialClips(30, 60)[0].duration).toBeCloseTo(30, 5)
  })
})

describe("典型剪辑场景", () => {
  it("只保留副歌：前后各切一刀，两边删掉", () => {
    let clips = initialClips(180, 180)
    clips = splitAt(clips, 60) // 副歌起点
    clips = splitAt(clips, 90) // 副歌终点
    expect(clips).toHaveLength(3)

    clips = removeClip(clips, clips[0].id)
    clips = removeClip(clips, clips[clips.length - 1].id)
    expect(clips).toHaveLength(1)

    expect(gainAt(clips, 30)).toBe(0) // 主歌静音
    expect(gainAt(clips, 75)).toBeGreaterThan(0) // 副歌有声
    expect(gainAt(clips, 120)).toBe(0) // 尾段静音

    // 保留的这段仍然取自源文件的第 60 秒，音画没有错位
    expect(clips[0].sourceStart).toBeCloseTo(60, 5)
  })

  it("某段压低而不是删掉", () => {
    let clips = initialClips(120, 120)
    clips = splitAt(clips, 40)
    clips = splitAt(clips, 80)
    clips = setGain(clips, clips[1].id, 0.2)
    expect(gainAt(clips, 60)).toBeCloseTo(0.2, 5)
    expect(gainAt(clips, 20)).toBeCloseTo(1, 5)
  })

  it("反复编辑后始终不重叠", () => {
    let clips = initialClips(200, 200)
    clips = splitAt(clips, 50)
    clips = splitAt(clips, 100)
    clips = splitAt(clips, 150)
    clips = moveClip(clips, clips[1].id, 20, 200)
    clips = trimClip(clips, clips[0].id, "end", 180, 200)
    clips = duplicateClip(clips, clips[clips.length - 1].id, 200)
    expectNoOverlap(clips)
  })
})
