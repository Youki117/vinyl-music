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
import {
  hasUserApi,
  playableSources,
  registerUserApi,
  clearUserApi,
  type SourceApi,
} from "@/vendor/lx-music/store"
import { platform } from "@/platform"
import { cleanTitle } from "@/lib/text"
import { loadUserApi, unloadUserApi, parseScriptInfo, type LoadedScript } from "./userApi/host"
/*
 * 内置音源脚本。**开源仓库里不带**，见 builtin/README.md ——
 * 聚合音源脚本原样分发有法律风险，用户自己放一份进去，或用界面上的「导入音源」。
 *
 * 用 glob 而不是写死 import：目录空着时它得到一个空对象，构建照常通过；
 * 放了脚本就自动被收进来。`?raw` 拿的是源文本 —— 它不是我们的模块，
 * 绝不能让打包器去解析它，要原样丢进 Worker 当第三方代码跑。
 */
const builtinScripts = import.meta.glob("./builtin/*.js", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>
import { lxLyricToEnhancedLrc } from "./lyric"
import { SOURCES, qqPlaylistIdOfInput, type SourceId } from "./catalog"

export { SOURCES, sourceOfLink, type SourceId } from "./catalog"

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
    title: cleanTitle(raw.name ?? ""),
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

/** 一个在线歌单。曲目结构与搜索结果完全一致，上层拿去入库的路径也就是同一条。 */
export interface OnlinePlaylist {
  source: SourceId
  /** 歌单名。平台没给就是空串，由调用方决定叫什么 */
  name: string
  list: OnlineTrack[]
  /** 平台声明的总数，可能大于本页拿到的条数 */
  total: number
  page: number
}

interface RawList {
  list?: RawTrack[]
  total?: number
  info?: { name?: string }
}

const QQ_PLAYLIST_PAGE_SIZE = 30

type QqPlaylistResponse = {
  code?: number
  req_0?: {
    code?: number
    data?: {
      dirinfo?: { title?: string; songnum?: number }
      songlist?: unknown[]
    }
  }
}

function firstUrl(text: string): string | null {
  const url = /https?:\/\/[^\s<>"']+/i.exec(text)?.[0]
  return url?.replace(/[),，。；;）]+$/, "") ?? null
}

async function resolveQqPlaylistId(input: string): Promise<string> {
  const direct = qqPlaylistIdOfInput(input)
  if (direct) return direct

  // 短链本身没有 id。让平台层的 HTTP 跟完重定向后，再从最终 URL 里取。
  const url = firstUrl(input)
  if (!url) throw new Error("QQ 歌单链接里没有找到歌单 id")
  const host = new URL(url).hostname.toLowerCase()
  if (host !== "qq.com" && !host.endsWith(".qq.com")) {
    throw new Error("这不是 QQ 音乐的歌单链接")
  }
  const res = await platform.request(url)
  const redirected = qqPlaylistIdOfInput(res.url)
  if (!redirected) throw new Error("QQ 歌单短链没有解析出歌单 id")
  return redirected
}

/**
 * QQ 的旧 qzone 歌单接口在 Tauri HTTP 客户端下会把请求判成 `invalid referer`，即使显式
 * 传 Referer 也一样。musicu 的歌单接口没有这个限制，但每次最多回 30 首，因此这里保留
 * page 契约，让 store/online.ts 继续负责整单分页与去重。
 */
async function getQqPlaylist(idOrLink: string, page: number): Promise<OnlinePlaylist> {
  const id = await resolveQqPlaylistId(idOrLink)
  const numericId = Number(id)
  if (!Number.isSafeInteger(numericId)) throw new Error("QQ 歌单 id 无效")
  const safePage = Math.max(1, Math.trunc(page))
  const request = {
    comm: {
      g_tk: 5381,
      uin: 0,
      format: "json",
      inCharset: "utf-8",
      outCharset: "utf-8",
      notice: 0,
      platform: "h5",
      needNewCode: 1,
    },
    req_0: {
      module: "music.srfDissInfo.aiDissInfo",
      method: "uniform_get_Dissinfo",
      param: {
        disstid: numericId,
        enc_host_uin: "",
        tag: 1,
        userinfo: 1,
        song_begin: (safePage - 1) * QQ_PLAYLIST_PAGE_SIZE,
        song_num: QQ_PLAYLIST_PAGE_SIZE,
      },
    },
  }
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(request))}`
  const res = await platform.request(url, {
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0" },
  })
  if (!res.ok) throw new Error(`QQ 歌单请求失败（HTTP ${res.status}）`)

  const body = (await res.json()) as QqPlaylistResponse
  const data = body.req_0?.data
  if (body.code !== 0 || body.req_0?.code !== 0 || !data?.dirinfo) {
    throw new Error("QQ 歌单解析失败（可能是私密歌单，或链接已失效）")
  }

  const api = sdk.tx
  if (!api?.songList?.filterListDetail) throw new Error("QQ 歌单格式化器不可用")
  const list = api.songList.filterListDetail(data.songlist ?? []) as RawTrack[]
  return {
    source: "tx",
    name: data.dirinfo.title?.trim() ?? "",
    list: list.map((r) => normalize("tx", r)),
    total: data.dirinfo.songnum ?? list.length,
    page: safePage,
  }
}

/**
 * 取一个歌单。**不需要音源脚本** —— 和搜索、歌词一样是 musicSdk 自带的。
 *
 * `idOrLink` 直接把用户贴进来的东西原样交给上游：每个平台的 `songList` 都自带一组
 * 解析分享链接的正则，我们再解析一遍只会多一处要跟着上游改的地方。实测（2026-08-19）：
 *
 *   网易云   歌单 id 与分享链接都行
 *   QQ      分享链接可以
 *   酷我     歌单 id 可以
 *   酷狗     **必须给分享链接**，裸 specialId 不行
 *   咪咕     部分 id 报错，上游这块本来就脆
 *
 * 歌单**只给曲目信息，不给播放地址**。所以这里不碰 resolvePlayUrl ——
 * 一个两百首的歌单挨个解析要几分钟，而且大部分地址等真播到的时候早就过期了。
 * 播到哪首解析哪首，那是播放路径的事（store/player.ts 的 playAt）。
 */
export async function getPlaylist(
  source: SourceId,
  idOrLink: string,
  page = 1,
): Promise<OnlinePlaylist> {
  if (source === "tx") return getQqPlaylist(idOrLink.trim(), page)

  const api = sdk[source]
  if (!api?.songList?.getListDetail) throw new Error(`音源 ${source} 不支持歌单`)
  const res = await unwrap<RawList>(api.songList.getListDetail(idOrLink.trim(), page))
  const list = res?.list ?? []
  if (list.length === 0) throw new Error("这个歌单里没解析出曲目（可能是私密歌单，或链接不对）")
  return {
    source,
    name: res?.info?.name?.trim() ?? "",
    list: list.map((r) => normalize(source, r)),
    total: res?.total ?? list.length,
    page,
  }
}

/**
 * musicSdk 有一半的接口返回的是**请求对象** `{ promise, cancelHttp }` 而不是 Promise，
 * 契约见 vendor/lx-music/request.ts。直接 `await` 它拿到的是对象本身，
 * `res.lyric` 于是永远 undefined —— 歌词和封面一直是空的就是栽在这里，而且不报错。
 */
async function unwrap<T>(res: unknown): Promise<T> {
  return (res && typeof res === "object" && "promise" in res
    ? await (res as { promise: Promise<T> }).promise
    : await (res as Promise<T>)) as T
}

interface RawLyric {
  lyric?: string
  tlyric?: string
  /** 洛雪的逐字歌词，格式 `[mm:ss.xxx]<起始ms,时长ms>字…`，与增强型 LRC 不同 */
  lxlyric?: string
}

/** 单个平台的歌词。**不需要音源脚本** —— 只有 getMusicUrl 走音源，歌词封面都是 musicSdk 自带的。 */
export async function getLyric(
  track: OnlineTrack,
): Promise<{ lyric: string; tlyric?: string; lxlyric?: string }> {
  const api = sdk[track.source]
  if (!api?.getLyric) throw new Error(`音源 ${track.source} 不支持歌词`)
  const res = await unwrap<RawLyric>(api.getLyric(track.raw))
  return { lyric: res?.lyric ?? "", tlyric: res?.tlyric, lxlyric: res?.lxlyric }
}

/** 从哪个平台取歌词最靠谱。实测前三个能出完整的逐字歌词，排前面。 */
const LYRIC_ORDER: SourceId[] = ["wy", "kg", "kw", "tx"]

/**
 * 歌词与封面这两条路在这些平台上**根本不能碰**。
 *
 * 咪咕：上游 `musicSdk/mg/pic.js` 有两个缺陷 —— `createHttpFetch` 是 async（返回 Promise），
 * 而 pic.js 拿它当请求对象用 `tryRequestObj.cancelHttp.bind(...)`，`cancelHttp` 是
 * undefined 直接 TypeError；而且那是个**游离 promise**，我们的 try/catch 拦不住，
 * 只会变成一条未捕获错误飘到控制台。歌词那条同样会抛 `object is not iterable`。
 *
 * 原则是不改 vendored 代码（见 vendor/lx-music/UPSTREAM.md），所以只能在这一层不去调它。
 * 反正换源本来就要做，咪咕的歌词封面从别的平台拿，功能上没有损失。
 */
const NO_LYRIC_PIC: SourceId[] = ["mg"]

export interface OnlineLyric {
  /** 增强型 LRC，直接交给 lyrics/parse.ts。有逐字就是逐字的 */
  lrc: string
  /** 翻译，没有就没有 */
  tlyric?: string
  /** 实际取自哪个平台 —— 和曲目所在平台不一定相同 */
  source: SourceId
}

/**
 * 拿一份**能用的**歌词。播放器该用的是这个，不是 getLyric。
 *
 * 各平台的歌词能力差得很远，本平台拿不到是常态而不是异常：
 *
 *   网易云 / 酷狗   完整逐字 + 翻译，最稳
 *   酷我           要解一层私有编码，垫片已实现（vendor/lx-music/ipc.ts）
 *   QQ            逐字歌词由上游一个**不公开算法的 C++ 原生插件**解，我们解不了
 *   咪咕           接口本身就不稳，时好时坏
 *
 * 所以拿不到就换平台找同一首歌要，和 resolvePlayUrl 的换源是同一个道理。
 */
export async function resolveLyric(track: OnlineTrack): Promise<OnlineLyric> {
  const pick = (l: { lyric: string; tlyric?: string; lxlyric?: string }, source: SourceId) => {
    const lrc = l.lxlyric?.trim() ? lxLyricToEnhancedLrc(l.lxlyric) : l.lyric
    return lrc.trim() ? { lrc, tlyric: l.tlyric, source } : null
  }

  if (!NO_LYRIC_PIC.includes(track.source)) {
    try {
      const got = pick(await getLyric(track), track.source)
      if (got) return got
    } catch {
      // 本平台不行是常态，往下换源
    }
  }

  for (const source of LYRIC_ORDER) {
    if (source === track.source) continue
    const alt = await findSameTrack(source, track)
    if (!alt) continue
    try {
      const got = pick(await getLyric(alt), source)
      if (got) return got
    } catch {
      continue
    }
  }
  throw new Error(`所有平台都没有《${track.title}》的歌词`)
}

/** 单个平台的封面。不需要音源脚本。拿不到就返回空串，不抛。 */
export async function getPic(track: OnlineTrack): Promise<string> {
  if (NO_LYRIC_PIC.includes(track.source)) return ""
  const api = sdk[track.source]
  if (!api?.getPic) return ""
  try {
    const url = await unwrap<string>(api.getPic(track.raw))
    return typeof url === "string" && /^https?:/.test(url) ? url : ""
  } catch {
    return ""
  }
}

/**
 * 拿一张封面。播放器该用的是这个。
 *
 * 和歌词同理：本平台没有就去别的平台找同一首要。封面是黑胶贴纸的内容，
 * 空盘比换一张同名同歌手的封面难看得多。
 */
export async function resolveCover(track: OnlineTrack): Promise<string> {
  const own = await getPic(track)
  if (own) return own
  for (const source of LYRIC_ORDER) {
    if (source === track.source) continue
    const alt = await findSameTrack(source, track)
    if (!alt) continue
    const url = await getPic(alt)
    if (url) return url
  }
  return ""
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
  /*
   * 先问脚本注册过这个平台没有，再进 musicSdk。
   *
   * 不拦的话，musicSdk 内部会拿一个 undefined 去取 getMusicUrl，抛的是
   * `Cannot read properties of undefined (reading 'getMusicUrl')` —— 这句会一路
   * 冒到界面上。而它其实是一件很好解释的事：这份音源不解析这个平台，去换源就是了。
   */
  if (!playableSources().includes(track.source)) {
    const name = SOURCES.find((s) => s.id === track.source)?.name ?? track.source
    throw new Error(`当前音源不解析${name}`)
  }
  const api = sdk[track.source]
  if (!api?.getMusicUrl) throw new Error(`音源 ${track.source} 不支持播放`)
  const q = quality ?? track.qualities[0] ?? "128k"
  const res = await api.getMusicUrl(track.raw, q)
  const url = typeof res === "string" ? res : res?.url
  if (!url) throw new Error("音源没有返回播放地址")
  return url
}

/** 用户导入的音源脚本存这里。存的是脚本正文本身，不是路径 —— 用户把源文件挪走
 *  或删掉之后，已经导入的音源不该跟着失效。 */
const SCRIPT_CONFIG = "source-script"

export type SavedScript = {
  /** 文件名，只用于界面显示 */
  file: string
  text: string
  savedAt: number
}

/** 当前导入的是哪一份。没导入过返回 null。 */
export async function savedScriptInfo(): Promise<{ file: string; name: string; version: string } | null> {
  const saved = await platform.readConfig<SavedScript>(SCRIPT_CONFIG)
  if (!saved?.text) return null
  const info = parseScriptInfo(saved.text)
  return { file: saved.file, name: info.name, version: info.version }
}

/**
 * 导入一份音源脚本：**先加载，成功了才落盘**。
 *
 * 顺序很关键 —— 反过来的话，一份跑不起来的脚本会被存下来，下次启动继续加载失败，
 * 而用户在界面上看到的是"已导入某某音源"。
 */
export async function importUserScript(file: string, text: string): Promise<LoadedScript> {
  const loaded = await loadUserApi(text)
  await platform.writeConfig<SavedScript>(SCRIPT_CONFIG, { file, text, savedAt: Date.now() })
  return loaded
}

/** 清掉导入的音源。之后要么回到内置脚本（如果这份构建带了），要么就没有音源。 */
export async function clearUserScript(): Promise<void> {
  unloadUserApi()
  await platform.writeConfig<SavedScript | null>(SCRIPT_CONFIG, null)
}

/**
 * 按优先级把音源拉起来：**用户导入的 > 随构建附带的内置脚本**。
 *
 * 用户显式导入过的那份优先级更高 —— 他既然特意放了一份进来，就不该被构建里
 * 碰巧带着的那份盖掉。两份都没有时抛错，由 boot.ts 降级（搜索与歌词不受影响）。
 */
export async function loadConfiguredSource(): Promise<LoadedScript> {
  const saved = await platform.readConfig<SavedScript>(SCRIPT_CONFIG)
  if (saved?.text) return loadUserApi(saved.text)
  return loadBuiltinSource()
}

/** 仓库里有没有放音源脚本。界面据此决定要不要提示用户去导入。 */
export function hasBuiltinSource(): boolean {
  return Object.keys(builtinScripts).length > 0
}

/**
 * 载入内置音源。**应用启动时调一次**，之后用户导入自己的脚本会覆盖它
 * （loadUserApi 会先停掉旧的）。
 *
 * 开源版本不附带脚本，所以这里会抛 —— boot.ts 对此有降级：搜索和歌词不依赖
 * 音源脚本，只有解析播放地址依赖它。
 */
export function loadBuiltinSource(): Promise<LoadedScript> {
  const script = Object.values(builtinScripts)[0]
  if (!script) {
    return Promise.reject(
      new Error("还没有音源脚本。在「在线音乐」面板点「导入音源」选一个 .js 脚本即可。"),
    )
  }
  return loadUserApi(script)
}

/** 跨平台换源时的尝试顺序。酷我排前面：实测它的直链最稳，且不挑音质。 */
const FALLBACK_ORDER: SourceId[] = ["kw", "tx", "wy", "kg", "mg"]

/**
 * 拿一个**能真的播出来**的地址。播放器该用的是这个，不是 getMusicUrl。
 *
 * 两件 getMusicUrl 不做的事：
 *
 *   1. **验证**。音源脚本返回 200 不代表返回的是音频 —— 实测酷狗会回落到一个
 *      返回 JSON 的地址，交给 <audio> 只会得到一句没头没尾的解码失败。
 *      这里花一个 Range 请求（2 字节）确认 Content-Type，比事后猜便宜得多。
 *   2. **换源**。音源脚本对各平台的可用性并不一致，同一首歌换个平台往往就通了。
 *      洛雪把这个叫「换源」，是在线播放能不能用的关键，不是锦上添花。
 *
 * 代价是失败路径上会多打几个接口。成功路径只多一个 2 字节的请求。
 */
export async function resolvePlayUrl(
  track: OnlineTrack,
  quality?: string,
): Promise<{ url: string; source: SourceId }> {
  const tried: string[] = []

  const attempt = async (t: OnlineTrack): Promise<string | null> => {
    try {
      const url = await getMusicUrl(t, quality)
      if (await isAudio(url)) return url
      tried.push(`${t.source}: 返回的不是音频`)
    } catch (err) {
      tried.push(`${t.source}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }

  const first = await attempt(track)
  if (first) return { url: first, source: track.source }

  // 本平台不行就拿歌名+歌手去别的平台找同一首，找到了再解析
  const playable = new Set(playableSources())
  for (const source of FALLBACK_ORDER) {
    if (source === track.source) continue
    // 脚本压根解析不了的平台就别去搜了：搜到也放不出来，白花一次网络往返。
    // 有的音源只剩一个平台能用，挨个试的代价不是常数。
    if (!playable.has(source)) continue
    const alt = await findSameTrack(source, track)
    if (!alt) continue
    const url = await attempt(alt)
    if (url) return { url, source }
  }

  throw new Error(`所有平台都没拿到可播放的地址（${tried.join("；")}）`)
}

/** 在别的平台上找同一首歌。宁可找不到也不要找错：只认歌名一致且歌手有交集的。 */
async function findSameTrack(source: SourceId, track: OnlineTrack): Promise<OnlineTrack | null> {
  const norm = (s: string) => s.toLowerCase().replace(/[\s()（）\[\]【】·・-]/g, "")
  try {
    const { list } = await searchMusic(source, `${track.title} ${track.artist}`.trim(), 1, 10)
    const wantTitle = norm(track.title)
    const wantArtists = norm(track.artist).split(/[,、\/&]/).filter(Boolean)
    return (
      list.find((t) => {
        if (norm(t.title) !== wantTitle) return false
        const got = norm(t.artist)
        return wantArtists.length === 0 || wantArtists.some((a) => got.includes(a))
      }) ?? null
    )
  } catch {
    // 换源本来就是兜底，某个平台搜挂了不该让整件事失败
    return null
  }
}

/**
 * 这个地址给出来的到底是不是音频。
 *
 * 只要头 2 个字节，服务端支持 Range 就几乎不产生流量。走平台层的 request() 从外壳侧发 ——
 * 音乐平台的 CDN 不会给浏览器来源发 CORS 头，在 WebView 里直接 fetch 一律失败。
 */
async function isAudio(url: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false
  try {
    const res = await platform.request(url, { method: "GET", headers: { Range: "bytes=0-1" } })
    if (res.status !== 200 && res.status !== 206) return false
    const type = res.headers.get("content-type") ?? ""
    // 有的 CDN 就是不给 content-type，那就当它是音频 —— 宁可放过，不可错杀
    return type === "" || !/^(text|application\/(json|xml))/.test(type)
  } catch {
    return false
  }
}

export { lxLyricToEnhancedLrc } from "./lyric"
export { hasUserApi, playableSources, registerUserApi, clearUserApi, type SourceApi }
export { loadUserApi, unloadUserApi, parseScriptInfo, setSourceDebug, type LoadedScript } from "./userApi/host"
