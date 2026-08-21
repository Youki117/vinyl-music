import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useLibrary, type Track } from "@/store/library"
import { useOnline } from "@/store/online"

// library store 用 window.setTimeout 防抖落盘；单测只验证状态变更，不需要启动浏览器环境。
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id),
})

const track = (id: string): Track => ({
  id: `wy:${id}`,
  origin: { kind: "online", source: "wy", songId: id, qualities: ["128k"], raw: { id } },
  title: `歌 ${id}`,
  artist: "测试歌手",
  album: "测试专辑",
  duration: 180,
  cover: null,
  lyrics: null,
  playCount: 0,
  liked: false,
  lastPlayed: 0,
  addedAt: 0,
  missing: false,
  gainDb: null,
  gainPeak: null,
})

beforeEach(() => {
  vi.useFakeTimers()
  useLibrary.setState({ tracks: [], playlists: [], activeView: "all", scanning: null, filter: "" })
  useOnline.setState({
    listInput: "",
    listSource: null,
    listStatus: "idle",
    listError: null,
    preview: null,
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("平台歌单导入", () => {
  it("导入后创建歌单、保持曲序并切换到新歌单", () => {
    const tracks = [track("1"), track("2")]
    useOnline.setState({
      listStatus: "ready",
      preview: { source: "wy", name: "夜听", tracks, total: tracks.length },
    })

    const playlistId = useOnline.getState().importList()
    const library = useLibrary.getState()

    expect(playlistId).toBeTruthy()
    expect(library.activeView).toBe(playlistId)
    expect(library.playlists).toEqual([
      expect.objectContaining({ id: playlistId, name: "夜听", trackIds: ["wy:1", "wy:2"] }),
    ])
    expect(library.tracks.map((item) => item.id)).toEqual(["wy:1", "wy:2"])
  })
})

describe("歌单删除", () => {
  it("只删除歌单并回到全部音乐，不删除曲库歌曲", () => {
    const song = track("keep")
    useLibrary.setState({ tracks: [song] })
    const playlistId = useLibrary.getState().createPlaylist("待删除")
    useLibrary.getState().addToPlaylist(playlistId, [song.id])

    useLibrary.getState().deletePlaylist(playlistId)
    const library = useLibrary.getState()

    expect(library.playlists).toEqual([])
    expect(library.activeView).toBe("all")
    expect(library.tracks).toEqual([song])
  })
})
