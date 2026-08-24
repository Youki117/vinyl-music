import { parseBlob, parseFromTokenizer, type IAudioMetadata } from "music-metadata"

import type { FileRef } from "@/platform"
import { cleanTitle } from "@/lib/text"
import { parseGainTag } from "./loudness"
import { SliceTokenizer, type SliceReader } from "./sliceTokenizer"

/**
 * 导入时要落进曲目的元数据。
 *
 * 这里**故意没有封面**。导入路径不该物化封面：全项目只有 Disc 显示封面，而且只显示
 * 当前播放的那一首（`usePlayer(s => s.current()?.cover)`），列表行根本不画图。导入一千首
 * 就建一千个 object URL，等于为「一次只显示一张」的需求常驻几百兆的图，还让每首歌多一次
 * blob 拷贝、拖慢导入。封面改由 `library.ensureCover` 在首播时解 —— 那条路径本来就存在：
 * 曲库落盘不存封面，所以**重启之后一直是这个行为**，跑得好好的。
 */
export type TrackMeta = {
  title: string
  artist: string
  album: string
  duration: number
  lyrics: string | null
  /**
   * ReplayGain 标签：该给这首歌加多少 dB，以及它的采样峰值（0..1，用于防削波）。
   * 文件里没写就是 null —— 归一化那边会退回自己测一遍（audio/loudness.ts）。
   */
  gainDb: number | null
  gainPeak: number | null
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(0, i) : name
}

/**
 * 判断标签值是不是解码坏了。
 *
 * 控制字符（\x00-\x08、\x0b、\x0c、\x0e-\x1f）不该出现在正常曲名里，出现了就说明
 * 解码环节出了问题，此时宁可退回文件名，也不要把乱码显示给用户。
 */
export function looksCorrupt(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)
}

/** RIFF LIST/INFO 里我们关心的字段 */
const WAV_INFO_KEYS: Record<string, "title" | "artist" | "album"> = {
  INAM: "title",
  IART: "artist",
  IPRD: "album",
}

/**
 * 自己解一遍 WAV 的 LIST/INFO 块。
 *
 * music-metadata 读这个块时按 7 位 ASCII 处理，会把每个字节的最高位抹掉
 * （实测「测试曲目一」的 UTF-8 字节 E6 B5 8B… 变成 'f' '5' \x0b…）。这是有损的，
 * 拿到字符串后再怎么转码都救不回来，只能重新读原始字节。
 *
 * RIFF 规范里 INFO 值本是 ASCII/CP1252，但 ffmpeg 等工具普遍直接写 UTF-8，
 * 所以这里先试 UTF-8，失败再退回 latin1。
 */
type WavInfo = Partial<Record<"title" | "artist" | "album", string>>

const ascii = (b: Uint8Array, o: number, n: number) =>
  String.fromCharCode(...b.subarray(o, o + n))

/**
 * 解一个 LIST/INFO 块的正文（"INFO" 那四个字节之后的部分）。
 * 整读与切片两条路都用它，保证两边解出来的东西一模一样。
 */
export function parseInfoChunk(body: Uint8Array): WavInfo {
  const out: WavInfo = {}
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const utf8 = new TextDecoder("utf-8", { fatal: true })
  const latin1 = new TextDecoder("latin1")

  let q = 0
  while (q + 8 <= body.byteLength) {
    const sub = ascii(body, q, 4)
    const len = view.getUint32(q + 4, true)
    const valStart = q + 8
    if (len > body.byteLength - valStart) break

    const key = WAV_INFO_KEYS[sub]
    if (key) {
      // 去掉结尾的填充 0
      let n = len
      while (n > 0 && body[valStart + n - 1] === 0) n--
      const raw = body.subarray(valStart, valStart + n)
      let text: string
      try {
        text = utf8.decode(raw)
      } catch {
        text = latin1.decode(raw)
      }
      const trimmed = text.trim()
      if (trimmed) out[key] = trimmed
    }
    // 各子块按偶数字节对齐
    q = valStart + len + (len % 2)
  }
  return out
}

export function parseWavInfo(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return {}
  }

  let p = 12
  while (p + 8 <= bytes.byteLength) {
    const id = ascii(bytes, p, 4)
    const size = view.getUint32(p + 4, true)
    const body = p + 8
    if (size > bytes.byteLength - body) break

    if (id === "LIST" && size >= 4 && ascii(bytes, body, 4) === "INFO") {
      return parseInfoChunk(bytes.subarray(body + 4, body + size))
    }
    p = body + size + (size % 2)
  }
  return {}
}

/** 一个 LIST 块正文最多读这么多。正常的 INFO 块只有几百字节。 */
const MAX_LIST_BYTES = 1024 * 1024
/** 最多走这么多个 RIFF 块。正常 wav 也就三五个。 */
const MAX_RIFF_CHUNKS = 64

/**
 * 不整读，顺着 RIFF 的块表走到 LIST/INFO。
 *
 * 每个块只读 8 字节的块头再跳过正文，所以哪怕 INFO 被写在 data 之后（ffmpeg
 * 有时如此），也只花几次几字节的读取 —— 不必为一个几百字节的标签把整首无损
 * wav 搬过 IPC。
 */
export async function readWavInfoSliced(size: number, read: SliceReader): Promise<WavInfo> {
  const head = await read(0, 12)
  if (head.length < 12 || ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WAVE") {
    return {}
  }

  let p = 12
  for (let i = 0; i < MAX_RIFF_CHUNKS && p + 8 <= size; i++) {
    const h = await read(p, 8)
    if (h.length < 8) break
    const id = ascii(h, 0, 4)
    const len = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(4, true)
    const body = p + 8
    if (len > size - body) break

    if (id === "LIST" && len >= 4 && len <= MAX_LIST_BYTES) {
      const chunk = await read(body, len)
      if (chunk.length >= 4 && ascii(chunk, 0, 4) === "INFO") {
        return parseInfoChunk(chunk.subarray(4))
      }
    }
    p = body + len + (len % 2)
  }
  return {}
}

/**
 * 只把内嵌封面取出来。
 *
 * 曲库落盘时不存封面（那是二进制，塞进 JSON 不合适），重启后 Track.cover 是 null。
 * 播放时反正已经把整个文件读进内存了，顺手解一次封面比另存一份缓存简单得多。
 *
 * 同时返回原始字节：系统媒体面板要的是**磁盘上的真实文件**，而 CSP 的
 * `default-src 'self'` 不允许 fetch 自己造的 blob: URL（img-src 放行的只是显示），
 * 想拿回字节只能在这里一并交出去。
 *
 * @returns url 供界面显示（调用方负责 revoke）；bytes 供写盘。无封面返回 null
 */
export async function readCover(
  bytes: Uint8Array,
): Promise<{ url: string; data: Uint8Array; mime: string } | null> {
  try {
    const meta = await parseBlob(new Blob([bytes as BlobPart]))
    const pic = meta.common.picture?.[0]
    if (!pic) return null
    const data: Uint8Array = pic.data
    return {
      url: URL.createObjectURL(new Blob([data as BlobPart], { type: pic.format })),
      data,
      mime: pic.format ?? "image/jpeg",
    }
  } catch {
    return null
  }
}

/**
 * 读取元数据。复用已经拿到的字节，不重复读盘。
 * 任何一步失败都回退到文件名，绝不因为标签坏了就让曲目不可用。
 */
function fallbackMeta(ref: FileRef): TrackMeta {
  return {
    title: cleanTitle(stripExt(ref.name)),
    artist: "未知艺术家",
    album: "",
    duration: 0,
    lyrics: null,
    gainDb: null,
    gainPeak: null,
  }
}

/** 把 music-metadata 的结果与自解的 wav INFO 合成 TrackMeta。整读与切片共用。 */
function buildMeta(ref: FileRef, meta: IAudioMetadata, wav: WavInfo): TrackMeta {
  const fallback = fallbackMeta(ref)
  const common = meta.common
  // 封面在这里**不取**（见 TrackMeta 的说明），首播时走 library.ensureCover

  // 内嵌歌词：不同容器放在不同字段，逐个试
  const lyricsEntry = common.lyrics?.[0]
  const lyrics =
    (typeof lyricsEntry === "string" ? lyricsEntry : lyricsEntry?.text) ??
    (meta.native?.["ID3v2.3"]?.find((t) => t.id === "USLT")?.value as string | undefined) ??
    null

  const pick = (own: string | undefined, parsed: string | undefined, fb: string) => {
    const a = own?.trim()
    if (a && !looksCorrupt(a)) return a
    const b = parsed?.trim()
    if (b && !looksCorrupt(b)) return b
    return fb
  }

  /*
   * ReplayGain。音轨增益优先于专辑增益 —— 我们是按单曲连播的播放器，
   * 专辑增益保的是"同一张专辑内的相对关系"，在混播的列表里反而对不齐。
   * music-metadata 已经把 ID3 的 TXXX、RVA2 与 Vorbis 注释统一成了 { dB, ratio }。
   */
  const gainDb = parseGainTag(common.replaygain_track_gain ?? common.replaygain_album_gain)
  const peakRatio = (common.replaygain_track_peak ?? common.replaygain_album_peak)?.ratio
  const gainPeak = typeof peakRatio === "number" && peakRatio > 0 ? peakRatio : null

  return {
    title: cleanTitle(pick(wav.title, common.title, fallback.title)),
    artist: pick(wav.artist, common.artist, fallback.artist),
    album: pick(wav.album, common.album, ""),
    duration: meta.format.duration ?? 0,
    lyrics: typeof lyrics === "string" ? lyrics : null,
    gainDb,
    gainPeak,
  }
}

/**
 * 读取元数据。复用已经拿到的字节，不重复读盘。
 * 任何一步失败都回退到文件名，绝不因为标签坏了就让曲目不可用。
 *
 * 播放路径用这条：那时整首歌本来就已经在内存里了。
 * 导入路径请用 readMetadataLazy —— 为读标签而整读是导入耗时与内存峰值的大头。
 */
export async function readMetadata(ref: FileRef, bytes: Uint8Array): Promise<TrackMeta> {
  let meta: IAudioMetadata
  try {
    // duration: true 是必须的。Ogg/Vorbis 的时长藏在最后一个页的 granule position 里，
    // 不开这个选项 music-metadata 只读文件头，format.duration 会是 undefined ——
    // 实测两个真实 ogg 都拿不到时长，列表里全显示 00:00。MP3 从帧头就能算，不受影响。
    // 字节本来就已经全部在内存里，多扫一遍只花 CPU，不产生额外磁盘 IO。
    meta = await parseBlob(new Blob([bytes as BlobPart]), { duration: true })
  } catch {
    return fallbackMeta(ref)
  }

  // WAV 的 INFO 块由我们自己重解，避开 music-metadata 抹掉高位的问题
  const wav = /\.wav$/i.test(ref.name) ? parseWavInfo(bytes) : {}
  return buildMeta(ref, meta, wav)
}

const OGG_RE = /\.(ogg|opus|oga)$/i

/** ogg 页头 27 字节：'OggS'(4) 版本(1) 类型(1) granule(8, LE) 序列号(4) 页号(4) 校验(4) 段数(1) */
const OGG_HEADER_LEN = 27
/** 从尾部取这么多来找最后一页。一页最大约 65KB，64KB 够覆盖到。 */
const OGG_TAIL_BYTES = 64 * 1024

/**
 * 从文件尾算 ogg 时长。
 *
 * 时长藏在最后一个页的 absolute granule position 里。公式与 music-metadata 内部
 * 一致（VorbisStream / OpusStream 的 calculateDuration）：Vorbis 是
 * granule / sampleRate，Opus 是 (granule - preSkip) / 48000。差别只在于我们直接
 * 跳到尾部去拿，而不是从头把每一页都读一遍。
 *
 * @returns 秒。找不到可信的页头时返回 null，调用方保持时长为 0
 */
async function readOggDuration(
  size: number,
  read: SliceReader,
  sampleRate: number,
  codec: string | undefined,
): Promise<number | null> {
  const isOpus = codec === "Opus"
  const rate = isOpus ? 48000 : sampleRate
  if (!rate) return null

  const from = Math.max(0, size - OGG_TAIL_BYTES)
  const tail = await read(from, size - from)
  if (tail.length < OGG_HEADER_LEN) return null

  const preSkip = isOpus ? await readOpusPreSkip(read) : 0
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)

  // 倒着找：最后一个通得过校验的页头就是最后一页
  for (let i = tail.length - OGG_HEADER_LEN; i >= 0; i--) {
    if (tail[i] !== 0x4f || tail[i + 1] !== 0x67 || tail[i + 2] !== 0x67 || tail[i + 3] !== 0x53) {
      continue
    }
    // 'OggS' 四个字节也可能在页数据里撞上，用版本号再筛一道
    if (tail[i + 4] !== 0) continue

    const granule = Number(view.getBigUint64(i + 6, true))
    // -1（全 1）表示这一页还没有完整的包，不能拿来算时长
    if (!Number.isSafeInteger(granule) || granule <= 0) continue

    const seconds = (granule - preSkip) / rate
    if (seconds > 0) return seconds
  }
  return null
}

/**
 * OpusHead 里的 pre-skip：编码器在流首垫的样本数，算时长时要减掉。
 * 结构是 'OpusHead'(8) 版本(1) 声道(1) preSkip(2, LE)…，就在第一页里。
 */
async function readOpusPreSkip(read: SliceReader): Promise<number> {
  const head = await read(0, 4096)
  const magic = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64] // "OpusHead"
  for (let i = 0; i + 12 <= head.length; i++) {
    if (magic.every((b, k) => head[i + k] === b)) {
      return new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(i + 10, true)
    }
  }
  return 0
}

/**
 * 只读需要的那几片，解元数据。
 *
 * 解析器拿到的是一个报告**真实文件大小**的随机访问 tokenizer，于是它按自己的
 * 需要去取：mp3/flac/wav 走头部；ogg 的时长由 readOggDuration 单独从尾部取。
 * 失败（含切片预算用尽）时抛出，由 readMetadataLazy 兜底。
 */
export async function readMetadataSliced(ref: FileRef, read: SliceReader): Promise<TrackMeta> {
  const ogg = OGG_RE.test(ref.name)

  const tokenizer = new SliceTokenizer(ref.size, read, {
    fileInfo: { path: ref.id, size: ref.size },
  })
  /*
   * ogg 这里关掉 duration，时长改由 readOggDuration 从尾部取。
   *
   * 因为 music-metadata 找最后一页的办法是**从第一页顺序读到文件尾**
   * （OggParser.parse 的那个 do/while，从不 seek）。整读时那只是 CPU，
   * 换成按需切片就等于把整个文件搬过来 —— 正是这次要消灭的事。
   * 关掉之后它读满 12 页就收手，标签照样解得到。
   */
  const meta = await parseFromTokenizer(tokenizer, { duration: !ogg })

  const wav = /\.wav$/i.test(ref.name) ? await readWavInfoSliced(ref.size, read) : {}
  const built = buildMeta(ref, meta, wav)

  if (ogg && !built.duration) {
    // 用 tokenizer 的共享缓存读，避免把已经取过的头部再取一遍
    const cached: SliceReader = (offset, length) => tokenizer.readRange(offset, length)
    const d = await readOggDuration(ref.size, cached, meta.format.sampleRate ?? 0, meta.format.codec)
    if (d) built.duration = d
  }
  return built
}

/**
 * 导入路径的元数据读取：先切片，不行再整读。
 *
 * 回退不是保险起见的摆设，它兜三种情况：文件大小未知（size 为 0，浏览器实现下
 * 可能如此）、切片预算用尽（见 sliceTokenizer 的 SLICE_BUDGET）、以及任何解析
 * 异常。回退之后的行为与从前逐字节相同，所以最坏情况只是多花一次头部读取。
 */
export async function readMetadataLazy(
  ref: FileRef,
  read: SliceReader,
  readAll: () => Promise<Uint8Array>,
): Promise<TrackMeta> {
  if (ref.size > 0) {
    try {
      return await readMetadataSliced(ref, read)
    } catch {
      // 落到整读
    }
  }
  return readMetadata(ref, await readAll())
}
