import { describe, expect, it } from "vitest"

import { activeLineIndex, parseLrc } from "@/lyrics/parse"

describe("parseLrc", () => {
  it("解析基本时间戳", () => {
    const r = parseLrc("[00:12.00]第一行\n[01:05.50]第二行")
    expect(r.lines).toMatchObject([
      { t: 12, text: "第一行" },
      { t: 65.5, text: "第二行" },
    ])
  })

  it("小数位数决定量级：.5 是 500ms，.05 是 50ms", () => {
    const r = parseLrc("[00:01.5]a\n[00:02.05]b\n[00:03.123]c")
    expect(r.lines[0].t).toBeCloseTo(1.5, 4)
    expect(r.lines[1].t).toBeCloseTo(2.05, 4)
    expect(r.lines[2].t).toBeCloseTo(3.123, 4)
  })

  it("同一行多个时间戳展开成多条，并按时间排序", () => {
    const r = parseLrc("[00:30.00][01:30.00][02:30.00]副歌")
    expect(r.lines).toHaveLength(3)
    expect(r.lines.map((l) => l.t)).toEqual([30, 90, 150])
    expect(r.lines.every((l) => l.text === "副歌")).toBe(true)
  })

  it("乱序输入会被排序", () => {
    const r = parseLrc("[00:30.00]后\n[00:10.00]前")
    expect(r.lines.map((l) => l.text)).toEqual(["前", "后"])
  })

  it("读取 offset 与元信息", () => {
    const r = parseLrc("[ti:山明水秀]\n[ar:Xiaojie]\n[offset:-500]\n[00:01.00]x")
    expect(r.title).toBe("山明水秀")
    expect(r.artist).toBe("Xiaojie")
    expect(r.offset).toBe(-500)
  })

  it("正 offset 也能读", () => {
    expect(parseLrc("[offset:+300]\n[00:01.00]x").offset).toBe(300)
  })

  it("跳过空行、纯时间戳行与无时间戳的行", () => {
    const r = parseLrc("\n随便一句没有标签的\n[00:05.00]\n[00:06.00]有内容\n\n")
    expect(r.lines).toMatchObject([{ t: 6, text: "有内容" }])
  })

  it("去掉 BOM 与 CRLF", () => {
    const r = parseLrc("﻿[00:01.00]a\r\n[00:02.00]b\r\n")
    expect(r.lines).toMatchObject([
      { t: 1, text: "a" },
      { t: 2, text: "b" },
    ])
  })

  it("空输入不抛错", () => {
    expect(parseLrc("").lines).toEqual([])
    expect(parseLrc("   \n \n").lines).toEqual([])
  })

  it("时间戳不在行首的不当作歌词标签", () => {
    const r = parseLrc("歌词里[00:01.00]带方括号")
    expect(r.lines).toEqual([])
  })

  it("超过 99 分钟的长音频也能解析", () => {
    expect(parseLrc("[123:45.00]x").lines[0].t).toBeCloseTo(123 * 60 + 45, 4)
  })
})

describe("activeLineIndex", () => {
  const lines = [0, 10, 20, 30, 40].map((t) => ({ t, text: `L${t}` }))

  it("时间早于第一行时返回 -1", () => {
    expect(activeLineIndex(lines, -1)).toBe(-1)
  })

  it("命中区间内的最后一行", () => {
    expect(activeLineIndex(lines, 0)).toBe(0)
    expect(activeLineIndex(lines, 9.9)).toBe(0)
    expect(activeLineIndex(lines, 10)).toBe(1)
    expect(activeLineIndex(lines, 25)).toBe(2)
  })

  it("超过最后一行时停在最后一行", () => {
    expect(activeLineIndex(lines, 999)).toBe(4)
  })

  it("空歌词返回 -1", () => {
    expect(activeLineIndex([], 5)).toBe(-1)
  })

  it("二分结果与线性扫描一致", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ t: i * 1.7, text: String(i) }))
    for (let t = 0; t < 340; t += 0.37) {
      let expected = -1
      for (let i = 0; i < many.length; i++) if (many[i].t <= t) expected = i
      expect(activeLineIndex(many, t), `t=${t}`).toBe(expected)
    }
  })
})
