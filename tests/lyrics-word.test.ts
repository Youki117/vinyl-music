import { describe, expect, it } from "vitest"

import { activeLineIndex, hasWordTiming, lineFill, parseLrc } from "@/lyrics/parse"

/** 增强型 LRC 的典型写法：行时间戳后面跟着每个词的时间戳 */
const ENHANCED = [
  "[00:10.00]<00:10.00>March <00:11.00>winds <00:12.00>and<00:13.00>",
  "[00:14.00]<00:14.00>April <00:16.00>showers<00:18.00>",
].join("\n")

describe("词级时间戳解析", () => {
  const r = parseLrc(ENHANCED)

  it("正文里不留标记", () => {
    expect(r.lines[0].text).toBe("March winds and")
    expect(r.lines[1].text).toBe("April showers")
  })

  it("每个词都拿到自己的时间", () => {
    expect(r.lines[0].words).toMatchObject([
      { t: 10, text: "March " },
      { t: 11, text: "winds " },
      { t: 12, text: "and" },
    ])
  })

  it("行尾那个不带文本的标记是收尾时刻，不是一个词", () => {
    expect(r.lines[0].words).toHaveLength(3)
    expect(r.lines[0].end).toBe(13)
  })

  it("识别得出这是逐字歌词", () => {
    expect(hasWordTiming(r)).toBe(true)
    expect(hasWordTiming(parseLrc("[00:01.00]普通一行"))).toBe(false)
    expect(hasWordTiming(null)).toBe(false)
  })
})

describe("lineFill 逐字推进", () => {
  const r = parseLrc(ENHANCED)
  const line = r.lines[0] // "March winds and"，10s 起，13s 收尾

  it("行还没开始是 0", () => {
    expect(lineFill(line, 9.9)).toBe(0)
  })

  it("收尾之后是 1", () => {
    expect(lineFill(line, 13)).toBe(1)
    expect(lineFill(line, 99)).toBe(1)
  })

  it("单调不减 —— 擦除只能往前走，不能回退", () => {
    let prev = -1
    for (let t = 9.5; t <= 13.5; t += 0.05) {
      const f = lineFill(line, t)
      expect(f, `t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(prev)
      prev = f
    }
  })

  it("词边界上的进度等于该词之前的字符占比", () => {
    // "March " 6 字符，"winds " 6 字符，"and" 3 字符，共 15
    expect(lineFill(line, 11)).toBeCloseTo(6 / 15, 5)
    expect(lineFill(line, 12)).toBeCloseTo(12 / 15, 5)
  })

  it("词内部按时间线性插值", () => {
    // 10.5s 是 "March " 这个词的一半
    expect(lineFill(line, 10.5)).toBeCloseTo(3 / 15, 5)
  })

  it("行级歌词没有词信息，进入即算唱满（否则整行永远是暗的）", () => {
    const plain = parseLrc("[00:05.00]一整行\n[00:09.00]下一行").lines[0]
    expect(lineFill(plain, 4.9)).toBe(0)
    expect(lineFill(plain, 5)).toBe(1)
    expect(lineFill(plain, 8)).toBe(1)
  })
})

describe("空行是停唱标记，不是歌词", () => {
  // 真实 LRC（LRCLIB 导出）里非常常见：一段唱完，空一行，几十秒后才是下一句
  const src = ["[00:10.00]最后一句", "[00:15.00]", "[01:00.00]间奏之后"].join("\n")
  const r = parseLrc(src)

  it("空行不进歌词列表", () => {
    expect(r.lines.map((l) => l.text)).toEqual(["最后一句", "间奏之后"])
  })

  it("空行成为上一行的结束时刻 —— 否则那句会一直高亮 45 秒", () => {
    expect(r.lines[0].end).toBe(15)
  })

  it("没有停唱标记时结束时刻取下一行起点", () => {
    const p = parseLrc("[00:10.00]甲\n[00:12.00]乙")
    expect(p.lines[0].end).toBe(12)
  })

  it("最后一行没有下一行，给个有限的收尾时间", () => {
    const p = parseLrc("[00:10.00]独一行")
    expect(p.lines[0].end).toBeGreaterThan(10)
    expect(Number.isFinite(p.lines[0].end)).toBe(true)
  })
})

describe("真实 LRCLIB 文件的形状", () => {
  // 取自 lrclib.net 上 ProleteR - April Showers 的同步歌词，逐字照抄前几行。
  // 注意时间戳后面带一个空格，且中间有一条空的停唱标记。
  const REAL = [
    "[01:02.27] March winds and April showers",
    "[01:03.96] Make way for sweet May flowers",
    "[01:06.48] And then comes June, a moon and you",
    "[01:21.72] ",
    "[02:03.65] March winds and April showers",
  ].join("\n")

  const r = parseLrc(REAL)

  it("时间戳后的空格被吃掉，正文不带前导空格", () => {
    expect(r.lines[0].text).toBe("March winds and April showers")
  })

  it("四句歌词，那条空标记不算", () => {
    expect(r.lines).toHaveLength(4)
  })

  it("间奏前最后一句在 01:21.72 结束，而不是拖到 02:03", () => {
    const last = r.lines[2]
    expect(last.text).toContain("And then comes June")
    expect(last.end).toBeCloseTo(81.72, 2)
  })

  it("间奏期间定位仍落在最后一句上，但它已经唱完了", () => {
    const i = activeLineIndex(r.lines, 95)
    expect(i).toBe(2)
    // 界面据此判断该把高亮撤掉
    expect(r.lines[i].end! < 95).toBe(true)
  })
})
