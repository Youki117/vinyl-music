import { describe, expect, it } from "vitest"

import { onlineToTrack, type OnlineTrackInput, type Track } from "@/store/library"
import { mergeTracks } from "@/store/online"
import { sourceOfLink } from "@/source/catalog"

const input = (id: string, p: Partial<OnlineTrackInput> = {}): OnlineTrackInput => ({
  source: "wy",
  id,
  title: `歌 ${id}`,
  artist: "某人",
  album: "某专辑",
  duration: "04:32",
  qualities: ["128k", "320k"],
  raw: { songmid: id },
  ...p,
})

const track = (id: string): Track => onlineToTrack(input(id), 0)

describe("onlineToTrack", () => {
  it("id 跨会话稳定 —— 收藏与播放统计都按它存", () => {
    expect(onlineToTrack(input("96765035"), 0).id).toBe("wy:96765035")
    expect(onlineToTrack(input("96765035"), 999).id).toBe(onlineToTrack(input("96765035"), 0).id)
  })

  it("平台的 mm:ss 文本转成秒", () => {
    expect(onlineToTrack(input("a", { duration: "04:32" }), 0).duration).toBe(272)
    expect(onlineToTrack(input("a", { duration: "" }), 0).duration).toBe(0)
  })

  it("origin 是在线判别支，raw 原样带上 —— 音源脚本要的是它", () => {
    const t = onlineToTrack(input("a", { raw: { songmid: "a", extra: 1 } }), 0)
    expect(t.origin.kind).toBe("online")
    if (t.origin.kind !== "online") throw new Error("unreachable")
    expect(t.origin.source).toBe("wy")
    expect(t.origin.songId).toBe("a")
    expect(t.origin.qualities).toEqual(["128k", "320k"])
    expect(t.origin.raw).toEqual({ songmid: "a", extra: 1 })
  })

  it("刚搜到的曲目：没播过、没收藏、不算缺失", () => {
    const t = onlineToTrack(input("a"), 0)
    expect(t.playCount).toBe(0)
    expect(t.liked).toBe(false)
    expect(t.lastPlayed).toBe(0)
    // 在线曲目没有"源文件不见了"这回事
    expect(t.missing).toBe(false)
  })
})

describe("翻页合并", () => {
  it("顺序不变，新的接在后面", () => {
    const got = mergeTracks([track("1"), track("2")], [track("3"), track("4")])
    expect(got.map((t) => t.id)).toEqual(["wy:1", "wy:2", "wy:3", "wy:4"])
  })

  // 平台的分页不保证互斥，热门曲目在第一页和第二页各出现一次是常事
  it("跨页重复的丢掉，保留先出现的那个", () => {
    const got = mergeTracks([track("1"), track("2")], [track("2"), track("3")])
    expect(got.map((t) => t.id)).toEqual(["wy:1", "wy:2", "wy:3"])
  })

  it("同一页内部重复也要去掉 —— React 的 key 会撞", () => {
    const got = mergeTracks([], [track("1"), track("1"), track("2")])
    expect(got.map((t) => t.id)).toEqual(["wy:1", "wy:2"])
  })

  it("不改动传进来的数组", () => {
    const prev = [track("1")]
    mergeTracks(prev, [track("2")])
    expect(prev).toHaveLength(1)
  })
})

describe("分享链接认平台", () => {
  it("五个平台的常规链接", () => {
    expect(sourceOfLink("https://music.163.com/playlist?id=123")).toBe("wy")
    expect(sourceOfLink("https://y.qq.com/n/ryqq/playlist/8888")).toBe("tx")
    expect(sourceOfLink("http://www.kuwo.cn/playlist_detail/123")).toBe("kw")
    expect(sourceOfLink("https://www.kugou.com/yy/special/single/123.html")).toBe("kg")
    expect(sourceOfLink("https://music.migu.cn/v3/music/playlist/123")).toBe("mg")
  })

  // 分享出来的十有八九是短链，认不出短链等于认不出
  it("短链也要认得", () => {
    expect(sourceOfLink("https://163cn.tv/abcdef")).toBe("wy")
    expect(sourceOfLink("https://c6.y.qq.com/base/fcgi-bin/u?__=abc")).toBe("tx")
    expect(sourceOfLink("https://t1.kugou.com/song.html?id=xyz")).toBe("kg")
  })

  // 从 app 里复制出来的是一整段文案，不是一条干净的 URL
  it("链接埋在分享文案里也要认得", () => {
    expect(sourceOfLink("分享一个歌单《晨跑活力站》: https://y.qq.com/n/ryqq/playlist/8888 (来自QQ音乐)")).toBe("tx")
  })

  it("认不出就是 null，不瞎猜一个平台", () => {
    expect(sourceOfLink("")).toBe(null)
    expect(sourceOfLink("   ")).toBe(null)
    // 裸 id 判不出平台，得靠用户在界面上选
    expect(sourceOfLink("2829883282")).toBe(null)
    expect(sourceOfLink("https://example.com/playlist?id=1")).toBe(null)
  })

  it("别把域名当子串瞎认", () => {
    // 「不是 qq.com 而是 notqq.com」这种要认不出，而不是认成 QQ
    expect(sourceOfLink("https://notqq.com/x")).toBe(null)
    expect(sourceOfLink("https://163.com.evil.net/x")).toBe(null)
  })
})
