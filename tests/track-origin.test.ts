import { describe, expect, it } from "vitest"

import {
  localRef,
  onlineTrackId,
  parseDuration,
  selectTracks,
  type Playlist,
  type Track,
  type TrackOrigin,
} from "@/store/library"

function track(id: string, origin: TrackOrigin, p: Partial<Track> = {}): Track {
  return {
    id,
    origin,
    title: id,
    artist: "",
    album: "",
    duration: 0,
    cover: null,
    lyrics: null,
    playCount: 0,
    liked: false,
    lastPlayed: 0,
    addedAt: 0,
    missing: false,
    ...p,
  }
}

const local = (id: string): TrackOrigin => ({
  kind: "local",
  ref: { id, name: `${id}.mp3`, size: 1, mtime: 0 },
})
const online = (source: "kw" | "wy", songId: string): TrackOrigin => ({
  kind: "online",
  source,
  songId,
  qualities: ["128k"],
  raw: {},
})

describe("parseDuration", () => {
  it("mm:ss", () => expect(parseDuration("04:32")).toBe(272))
  it("hh:mm:ss", () => expect(parseDuration("1:02:03")).toBe(3723))
  it("前导零与空格", () => expect(parseDuration(" 00:05 ")).toBe(5))
  // 平台偶尔给空串或 "--:--"，界面把 0 当"未知时长"处理，不能变成 NaN
  it("解析不出就是 0，不是 NaN", () => {
    expect(parseDuration("")).toBe(0)
    expect(parseDuration("--:--")).toBe(0)
    expect(parseDuration("未知")).toBe(0)
  })
})

describe("在线曲目的 id", () => {
  it("同平台同曲目永远是同一个 id —— 歌单、收藏、播放统计都按它存", () => {
    expect(onlineTrackId("kw", "96765035")).toBe("kw:96765035")
    expect(onlineTrackId("kw", "96765035")).toBe(onlineTrackId("kw", "96765035"))
  })

  it("不同平台的同号曲目不是同一首", () => {
    expect(onlineTrackId("kw", "123")).not.toBe(onlineTrackId("wy", "123"))
  })
})

describe("localRef", () => {
  it("本地曲目给出文件引用", () => {
    expect(localRef(track("a", local("a")))?.name).toBe("a.mp3")
  })

  // 混音、波形、m3u 导出、外挂歌词都靠这个 null 把在线曲目挡在门外
  it("在线曲目没有文件引用", () => {
    expect(localRef(track("kw:1", online("kw", "1")))).toBeNull()
  })
})

describe("在线曲目在曲库里与本地曲目一视同仁", () => {
  const tracks: Track[] = [
    track("local-a", local("local-a"), { title: "阿刁", addedAt: 1, liked: true, playCount: 3 }),
    track("kw:1", online("kw", "1"), { title: "北方", addedAt: 2, liked: true, playCount: 9 }),
    track("wy:2", online("wy", "2"), { title: "长安", addedAt: 3, lastPlayed: 500 }),
  ]
  const playlists: Playlist[] = [
    { id: "pl", name: "混着放", trackIds: ["kw:1", "local-a"], createdAt: 0 },
  ]
  const pick = (view: string) =>
    selectTracks({ tracks, playlists, view, sort: "added", sortDesc: false, filter: "" }).map(
      (t) => t.id,
    )

  it("进得了「我喜欢的」", () => expect(pick("liked")).toEqual(["local-a", "kw:1"]))
  it("进得了「最常播放」", () =>
    expect(
      selectTracks({ tracks, playlists, view: "most", sort: "playCount", sortDesc: true, filter: "" })[0]
        ?.id,
    ).toBe("kw:1"))
  it("进得了「最近播放」", () => expect(pick("recent")).toEqual(["wy:2"]))
  it("进得了自建歌单，且保持歌单里的顺序", () => expect(pick("pl")).toEqual(["kw:1", "local-a"]))
  it("搜索过滤对在线曲目同样生效", () =>
    expect(
      selectTracks({ tracks, playlists, view: "all", sort: "added", sortDesc: false, filter: "北方" }).map(
        (t) => t.id,
      ),
    ).toEqual(["kw:1"]))
})
