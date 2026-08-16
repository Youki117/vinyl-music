import { describe, expect, it } from "vitest"

import { selectTracks, type Playlist, type Track } from "@/store/library"

function track(p: Partial<Track> & { id: string }): Track {
  return {
    ref: { id: p.id, name: `${p.id}.mp3`, size: 1, mtime: 0 },
    title: p.id,
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

const tracks: Track[] = [
  track({ id: "c", title: "长安", artist: "赵六", album: "III", duration: 300, addedAt: 3, playCount: 9, lastPlayed: 100, liked: true }),
  track({ id: "a", title: "阿刁", artist: "张三", album: "I", duration: 100, addedAt: 1, playCount: 2, lastPlayed: 300 }),
  track({ id: "b", title: "北方", artist: "李四", album: "II", duration: 200, addedAt: 2, playCount: 5, lastPlayed: 200, liked: true }),
  track({ id: "d", title: "东风", artist: "钱七", album: "IV", duration: 400, addedAt: 4 }),
]

const playlists: Playlist[] = [{ id: "pl1", name: "夜听", trackIds: ["d", "a", "c"], createdAt: 0 }]

const base = { tracks, playlists, sortDesc: false, filter: "" } as const
const ids = (list: Track[]) => list.map((t) => t.id)

describe("selectTracks · 视图", () => {
  it("全部音乐默认按添加顺序，不按数组顺序", () => {
    expect(ids(selectTracks({ ...base, view: "all", sort: "added" }))).toEqual(["a", "b", "c", "d"])
  })

  it("我喜欢的只含收藏曲目", () => {
    expect(ids(selectTracks({ ...base, view: "liked", sort: "added" }))).toEqual(["b", "c"])
  })

  it("最近播放按最后播放时间倒序，且排除从未播放的", () => {
    const r = selectTracks({ ...base, view: "recent", sort: "added" })
    expect(ids(r)).toEqual(["a", "b", "c"])
    expect(ids(r)).not.toContain("d")
  })

  it("最常播放按次数倒序，且排除次数为 0 的", () => {
    const r = selectTracks({ ...base, view: "most", sort: "added" })
    expect(ids(r)).toEqual(["c", "b", "a"])
  })

  it("歌单保持自己的手动顺序，而不是曲库顺序", () => {
    expect(ids(selectTracks({ ...base, view: "pl1", sort: "added" }))).toEqual(["d", "a", "c"])
  })

  it("歌单里引用了已删除的曲目时安全跳过", () => {
    const broken: Playlist[] = [{ id: "pl2", name: "残缺", trackIds: ["a", "不存在", "b"], createdAt: 0 }]
    expect(ids(selectTracks({ ...base, playlists: broken, view: "pl2", sort: "added" }))).toEqual(["a", "b"])
  })

  it("不存在的歌单返回空而不是抛错", () => {
    expect(selectTracks({ ...base, view: "查无此单", sort: "added" })).toEqual([])
  })
})

describe("selectTracks · 排序", () => {
  it("按标题排序用中文拼音顺序", () => {
    // 阿ā < 北běi < 东dōng < 长zhǎng
    //
    // 注意「长」是多音字，Intl 的 zh-Hans-CN 排序规则按 zhǎng 读，所以它排在
    // 「东」之后而不是之前。这不是 bug，是中文排序的既定行为，在此锁住以免
    // 有人日后"顺手改正"成 cháng 的顺序。
    expect(ids(selectTracks({ ...base, view: "all", sort: "title" }))).toEqual(["a", "b", "d", "c"])
  })

  it("按时长升序，降序时正好反过来", () => {
    expect(ids(selectTracks({ ...base, view: "all", sort: "duration" }))).toEqual(["a", "b", "c", "d"])
    expect(ids(selectTracks({ ...base, view: "all", sort: "duration", sortDesc: true }))).toEqual([
      "d",
      "c",
      "b",
      "a",
    ])
  })

  it("按播放次数默认就是多的在前", () => {
    expect(ids(selectTracks({ ...base, view: "all", sort: "playCount" }))).toEqual(["c", "b", "a", "d"])
  })

  it("按艺术家排序", () => {
    // 李四 < 钱七 < 张三 < 赵六
    expect(ids(selectTracks({ ...base, view: "all", sort: "artist" }))).toEqual(["b", "d", "a", "c"])
  })

  it("显式选排序键时，歌单的手动顺序会被覆盖", () => {
    expect(ids(selectTracks({ ...base, view: "pl1", sort: "duration" }))).toEqual(["a", "c", "d"])
  })

  it("最近播放/最常播放自带语义，不被通用排序键干扰", () => {
    // 即使传 title，也仍按播放次数倒序
    expect(ids(selectTracks({ ...base, view: "most", sort: "title" }))).toEqual(["c", "b", "a"])
  })
})

describe("selectTracks · 搜索", () => {
  it("标题、艺术家、专辑都能命中", () => {
    expect(ids(selectTracks({ ...base, view: "all", sort: "added", filter: "北方" }))).toEqual(["b"])
    expect(ids(selectTracks({ ...base, view: "all", sort: "added", filter: "张三" }))).toEqual(["a"])
    expect(ids(selectTracks({ ...base, view: "all", sort: "added", filter: "III" }))).toEqual(["c"])
  })

  it("大小写不敏感，且忽略首尾空格", () => {
    expect(ids(selectTracks({ ...base, view: "all", sort: "added", filter: "  iii  " }))).toEqual(["c"])
  })

  it("搜索在视图之内生效，不会捞出视图外的曲目", () => {
    // d 不在「我喜欢的」里，搜它也不该出现
    expect(selectTracks({ ...base, view: "liked", sort: "added", filter: "东风" })).toEqual([])
  })

  it("无匹配时返回空数组", () => {
    expect(selectTracks({ ...base, view: "all", sort: "added", filter: "查无此歌" })).toEqual([])
  })
})
