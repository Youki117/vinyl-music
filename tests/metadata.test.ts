import { describe, expect, it } from "vitest"

import { looksCorrupt, parseWavInfo } from "@/audio/metadata"

/** 拼一个最小可用的 RIFF/WAVE，带 LIST/INFO 块 */
function makeWav(tags: Record<string, string>, encoder: (s: string) => Uint8Array): Uint8Array {
  const subs: Uint8Array[] = []
  for (const [id, value] of Object.entries(tags)) {
    const body = encoder(value)
    // 值以 0 结尾，且各子块按偶数字节对齐
    const len = body.length + 1
    const pad = len % 2
    const chunk = new Uint8Array(8 + len + pad)
    chunk.set([...id].map((c) => c.charCodeAt(0)), 0)
    new DataView(chunk.buffer).setUint32(4, len, true)
    chunk.set(body, 8)
    subs.push(chunk)
  }
  const infoBody = subs.reduce((n, s) => n + s.length, 0) + 4
  const list = new Uint8Array(8 + infoBody)
  list.set([..."LIST"].map((c) => c.charCodeAt(0)), 0)
  new DataView(list.buffer).setUint32(4, infoBody, true)
  list.set([..."INFO"].map((c) => c.charCodeAt(0)), 8)
  let o = 12
  for (const s of subs) {
    list.set(s, o)
    o += s.length
  }

  const out = new Uint8Array(12 + list.length)
  out.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  out.set([..."WAVE"].map((c) => c.charCodeAt(0)), 8)
  out.set(list, 12)
  return out
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff))

describe("parseWavInfo", () => {
  it("读出 UTF-8 写入的中文标签", () => {
    const wav = makeWav({ INAM: "测试曲目一", IART: "张三", IPRD: "第一张" }, utf8)
    expect(parseWavInfo(wav)).toEqual({ title: "测试曲目一", artist: "张三", album: "第一张" })
  })

  it("读出纯 ASCII 标签", () => {
    const wav = makeWav({ INAM: "Hello World", IART: "Someone" }, utf8)
    expect(parseWavInfo(wav)).toMatchObject({ title: "Hello World", artist: "Someone" })
  })

  it("非 UTF-8 的字节退回 latin1 而不是抛错", () => {
    const wav = makeWav({ INAM: "Café" }, latin1)
    expect(parseWavInfo(wav).title).toBe("Café")
  })

  it("忽略不关心的子块", () => {
    const wav = makeWav({ INAM: "曲名", ISFT: "Lavf63.1.100", ICMT: "备注" }, utf8)
    expect(parseWavInfo(wav)).toEqual({ title: "曲名" })
  })

  it("奇数长度的值也能正确对齐到下一个子块", () => {
    // "abc" 长 3，加结尾 0 是 4；"中" 是 3 字节 + 0 = 4；换成 5 字节的值触发填充
    const wav = makeWav({ INAM: "abcd", IART: "王五" }, utf8)
    expect(parseWavInfo(wav)).toEqual({ title: "abcd", artist: "王五" })
  })

  it("不是 RIFF/WAVE 时返回空对象", () => {
    expect(parseWavInfo(new Uint8Array([1, 2, 3, 4]))).toEqual({})
    expect(parseWavInfo(new Uint8Array(0))).toEqual({})
  })

  it("块长度越界时安全退出，不读越界内存", () => {
    const wav = makeWav({ INAM: "x" }, utf8)
    // 把 LIST 的长度改成一个远超实际的值
    new DataView(wav.buffer).setUint32(16, 0xffff, true)
    expect(() => parseWavInfo(wav)).not.toThrow()
  })

  it("空值不产出字段", () => {
    expect(parseWavInfo(makeWav({ INAM: "   " }, utf8))).toEqual({})
  })
})

describe("looksCorrupt", () => {
  it("正常文本不算坏", () => {
    for (const s of ["山明水秀不比你有看头", "Hello World", "Café", "曲目 1 - 副歌", "①②③"]) {
      expect(looksCorrupt(s), s).toBe(false)
    }
  })

  it("含控制字符判为坏 —— 正是 WAV 高位被抹后的特征", () => {
    // music-metadata 把「测试曲目一」的 UTF-8 字节抹掉最高位后的实际产物
    expect(looksCorrupt("f5\u000bh/\u0015f\u001b2g\u001b.d8")).toBe(true)
    expect(looksCorrupt("normal text")).toBe(false)
    expect(looksCorrupt("abc\u0000def")).toBe(true)
    expect(looksCorrupt("abc\u001bdef")).toBe(true)
  })

  it("换行与制表符不判为坏（歌词里合法）", () => {
    expect(looksCorrupt("第一行\n第二行")).toBe(false)
    expect(looksCorrupt("列一\t列二")).toBe(false)
  })
})
