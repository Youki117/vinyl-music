/**
 * 在线音源。对上层只暴露这一个模块，vendored 的 musicSdk 不直接外泄。
 *
 * 分工（这条边界是洛雪定的，不是我们选的）：
 *
 *   搜索 / 歌词 / 歌单 / 排行榜   musicSdk 自带，装好就能用
 *   解析播放地址                  必须由用户导入的音源脚本提供
 *
 * 上游 musicSdk/api-source.js 里 `allApi` 是空对象（内置音源全被注释掉），
 * `getMusicUrl` 只在 `apiSource.value` 以 `user_api` 开头且脚本已注册时才有结果。
 * 洛雪本身就是这个行为 —— 用它也要先"导入音源"。详见 vendor/lx-music/store.ts。
 */
// @ts-expect-error vendored 的上游代码没有类型声明，且原则是不改它
import sdk from "@/vendor/lx-music/musicSdk/index.js"
import { hasUserApi, registerUserApi, clearUserApi, type SourceApi } from "@/vendor/lx-music/store"

export type SourceId = "kw" | "kg" | "tx" | "wy" | "mg"

export const SOURCES: { id: SourceId; name: string }[] = [
  { id: "kw", name: "酷我" },
  { id: "kg", name: "酷狗" },
  { id: "tx", name: "QQ" },
  { id: "wy", name: "网易云" },
  { id: "mg", name: "咪咕" },
]

/** 搜索结果。各平台字段名不一致，统一成这一份再往上层交。 */
export interface OnlineTrack {
  source: SourceId
  /** 平台内的唯一标识，播放时要原样回传给音源脚本 */
  id: string
  title: string
  artist: string
  album: string
  /** "mm:ss"，平台给的就是这个格式 */
  duration: string
  /** 可用音质档位，如 128k / 320k / flac */
  qualities: string[]
  /** 原始对象。音源脚本的 getMusicUrl 要的是它，不能只传我们裁剪过的字段 */
  raw: unknown
}

interface RawTrack {
  name?: string
  singer?: string
  albumName?: string
  interval?: string
  songmid?: string | number
  hash?: string
  copyrightId?: string
  types?: { type: string }[]
}

function normalize(source: SourceId, raw: RawTrack): OnlineTrack {
  return {
    source,
    id: String(raw.songmid ?? raw.hash ?? raw.copyrightId ?? ""),
    title: raw.name ?? "",
    artist: raw.singer ?? "",
    album: raw.albumName ?? "",
    duration: raw.interval ?? "",
    qualities: (raw.types ?? []).map((t) => t.type),
    raw,
  }
}

/**
 * 搜索。不需要音源脚本。
 *
 * @param page 从 1 开始，平台的分页都是 1-based
 */
export async function searchMusic(
  source: SourceId,
  keyword: string,
  page = 1,
  limit = 30,
): Promise<{ list: OnlineTrack[]; total: number }> {
  const api = sdk[source]
  if (!api?.musicSearch) throw new Error(`音源 ${source} 不支持搜索`)
  const res = await api.musicSearch.search(keyword, page, limit)
  const list: RawTrack[] = res?.list ?? []
  return { list: list.map((r) => normalize(source, r)), total: res?.total ?? list.length }
}

/** 歌词。不需要音源脚本。返回 LRC 文本，交给现有的歌词解析器。 */
export async function getLyric(track: OnlineTrack): Promise<{ lyric: string; tlyric?: string }> {
  const api = sdk[track.source]
  if (!api?.getLyric) throw new Error(`音源 ${track.source} 不支持歌词`)
  const res = await api.getLyric(track.raw)
  return { lyric: res?.lyric ?? "", tlyric: res?.tlyric }
}

/** 封面。不需要音源脚本。 */
export async function getPic(track: OnlineTrack): Promise<string> {
  const api = sdk[track.source]
  if (!api?.getPic) return ""
  return (await api.getPic(track.raw)) ?? ""
}

/**
 * 播放地址。**需要先导入音源脚本**，否则抛错。
 *
 * 这不是缺陷，是上游的设计：见本文件顶部与 vendor/lx-music/store.ts。
 */
export async function getMusicUrl(track: OnlineTrack, quality?: string): Promise<string> {
  if (!hasUserApi()) {
    throw new Error("尚未导入音源，无法解析播放地址。搜索和歌词不受影响。")
  }
  const api = sdk[track.source]
  if (!api?.getMusicUrl) throw new Error(`音源 ${track.source} 不支持播放`)
  const q = quality ?? track.qualities[0] ?? "128k"
  const res = await api.getMusicUrl(track.raw, q)
  const url = typeof res === "string" ? res : res?.url
  if (!url) throw new Error("音源没有返回播放地址")
  return url
}

export { hasUserApi, registerUserApi, clearUserApi, type SourceApi }
export { loadUserApi, unloadUserApi, parseScriptInfo, type LoadedScript } from "./userApi/host"
