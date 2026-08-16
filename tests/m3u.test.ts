import { describe, expect, it } from "vitest"

import { formatM3u, matchByName, parseM3u } from "@/lib/m3u"
import { decodeText, baseName, stripExt } from "@/lib/text"

describe("parseM3u", () => {
  it("读出 #EXTINF 的时长与显示名", () => {
    const r = parseM3u(["#EXTM3U", "#EXTINF:269,ProleteR - April Showers", "a.mp3"].join("\n"))
    expect(r).toEqual([{ path: "a.mp3", title: "ProleteR - April Showers", duration: 269 }])
  })

  it("没有 #EXTM3U 头也照读 —— 野生歌单大半不写", () => {
    expect(parseM3u("a.mp3\nb.flac")).toEqual([{ path: "a.mp3" }, { path: "b.flac" }])
  })

  it("时长 -1 表示未知，不当成 -1 秒", () => {
    expect(parseM3u("#EXTINF:-1,某曲\nx.mp3")[0].duration).toBeUndefined()
  })

  it("#EXTINF 只作用于紧随其后的一条路径", () => {
    const r = parseM3u("#EXTINF:10,甲\na.mp3\nb.mp3")
    expect(r[0].title).toBe("甲")
    expect(r[1].title).toBeUndefined()
  })

  it("忽略注释与其他 # 指令", () => {
    const r = parseM3u("#EXTM3U\n#PLAYLIST:我的歌单\n# 随便写的注释\na.mp3")
    expect(r).toHaveLength(1)
  })

  it("空行、BOM、CRLF 都不影响", () => {
    expect(parseM3u("\ufeff#EXTM3U\r\n\r\na.mp3\r\n")).toEqual([{ path: "a.mp3" }])
  })

  it("绝对路径与反斜杠原样保留，留给平台层去解析", () => {
    const r = parseM3u("D:\\Music\\a.mp3\n/home/u/b.mp3")
    expect(r.map((e) => e.path)).toEqual(["D:\\Music\\a.mp3", "/home/u/b.mp3"])
  })

  it("空输入得到空列表", () => {
    expect(parseM3u("")).toEqual([])
    expect(parseM3u("#EXTM3U\n")).toEqual([])
  })
})

describe("formatM3u", () => {
  const tracks = [
    { path: "D:\\Music\\a.mp3", title: "April Showers", artist: "ProleteR", duration: 269.06 },
    { path: "D:\\Music\\b.ogg", title: "无名", artist: "", duration: 30 },
  ]

  it("写出标准结构", () => {
    const out = formatM3u(tracks).split("\n")
    expect(out[0]).toBe("#EXTM3U")
    expect(out[1]).toBe("#EXTINF:269,ProleteR - April Showers")
    expect(out[2]).toBe("D:/Music/a.mp3")
  })

  it("没有艺术家时不留下多余的分隔符", () => {
    expect(formatM3u(tracks)).toContain("#EXTINF:30,无名")
  })

  it("统一成正斜杠 —— 给别的播放器读，这个写法最不容易出错", () => {
    expect(formatM3u(tracks)).not.toContain("\\")
  })

  it("能被自己解析回去", () => {
    const r = parseM3u(formatM3u(tracks))
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ path: "D:/Music/a.mp3", duration: 269 })
  })
})

describe("matchByName 兜底匹配", () => {
  const tracks = [
    { ref: { name: "April Showers.mp3" } },
    { ref: { name: "Downtown Irony.ogg" } },
  ]

  it("路径失效时靠文件名找回 —— 歌单常是从别的机器拷来的", () => {
    const entries = parseM3u("E:\\旧盘\\音乐\\April Showers.mp3")
    const hits = matchByName(entries, tracks)
    expect(hits.get("E:\\旧盘\\音乐\\April Showers.mp3")).toBe(tracks[0])
  })

  it("正斜杠路径同样能匹配", () => {
    const hits = matchByName(parseM3u("/mnt/d/Downtown Irony.ogg"), tracks)
    expect(hits.size).toBe(1)
  })

  it("大小写不敏感", () => {
    expect(matchByName(parseM3u("april showers.MP3"), tracks).size).toBe(1)
  })

  it("找不到就是找不到，不做模糊猜测", () => {
    expect(matchByName(parseM3u("完全不认识的歌.mp3"), tracks).size).toBe(0)
  })
})

describe("decodeText 判码", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s)

  it("UTF-8 正常解", () => {
    expect(decodeText(utf8("[00:01.00]测试歌词"))).toBe("[00:01.00]测试歌词")
  })

  it("剥掉 UTF-8 BOM", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("abc")])
    expect(decodeText(withBom)).toBe("abc")
  })

  it("UTF-16LE BOM", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00])
    expect(decodeText(bytes)).toBe("ab")
  })

  it("GBK 编码的中文歌词能读出来（不是乱码）", () => {
    // 「测试」的 GBK 字节；这两个字节序列不是合法 UTF-8，必须走退路
    const gbk = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4])
    expect(decodeText(gbk)).toBe("测试")
  })

  it("纯 ASCII 两种解码结果一致，不会被误判", () => {
    expect(decodeText(utf8("[ti:Hello]"))).toBe("[ti:Hello]")
  })
})

describe("路径小工具", () => {
  it("baseName 认两种分隔符", () => {
    expect(baseName("D:\\a\\b.mp3")).toBe("b.mp3")
    expect(baseName("/a/b.mp3")).toBe("b.mp3")
    expect(baseName("b.mp3")).toBe("b.mp3")
  })

  it("stripExt 只去最后一段扩展名", () => {
    expect(stripExt("a.b.mp3")).toBe("a.b")
    expect(stripExt("noext")).toBe("noext")
    expect(stripExt(".hidden")).toBe(".hidden")
  })
})
