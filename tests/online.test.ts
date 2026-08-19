import { describe, expect, it } from "vitest"

import { onlineToTrack, type OnlineTrackInput, type Track } from "@/store/library"
import { mergeTracks } from "@/store/online"

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
