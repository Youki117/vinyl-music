import { parseBlob, type IAudioMetadata } from "music-metadata"

import type { FileRef } from "@/platform"

export type TrackMeta = {
  title: string
  artist: string
  album: string
  duration: number
  /** 内嵌封面的 object URL，调用方负责 revoke */
  cover: string | null
  lyrics: string | null
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
export function parseWavInfo(bytes: Uint8Array): Partial<Record<"title" | "artist" | "album", string>> {
  const out: Partial<Record<"title" | "artist" | "album", string>> = {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (o: number, n: number) =>
    String.fromCharCode(...bytes.subarray(o, o + n))

  if (bytes.byteLength < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return out

  const utf8 = new TextDecoder("utf-8", { fatal: true })
  const latin1 = new TextDecoder("latin1")

  let p = 12
  while (p + 8 <= bytes.byteLength) {
    const id = ascii(p, 4)
    const size = view.getUint32(p + 4, true)
    const body = p + 8
    if (size > bytes.byteLength - body) break

    if (id === "LIST" && size >= 4 && ascii(body, 4) === "INFO") {
      let q = body + 4
      const end = body + size
      while (q + 8 <= end) {
        const sub = ascii(q, 4)
        const len = view.getUint32(q + 4, true)
        const valStart = q + 8
        if (len > end - valStart) break

        const key = WAV_INFO_KEYS[sub]
        if (key) {
          // 去掉结尾的填充 0
          let n = len
          while (n > 0 && bytes[valStart + n - 1] === 0) n--
          const raw = bytes.subarray(valStart, valStart + n)
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
    }
    p = body + size + (size % 2)
  }
  return out
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
export async function readMetadata(ref: FileRef, bytes: Uint8Array): Promise<TrackMeta> {
  const fallback: TrackMeta = {
    title: stripExt(ref.name),
    artist: "未知艺术家",
    album: "",
    duration: 0,
    cover: null,
    lyrics: null,
  }

  let meta: IAudioMetadata
  try {
    // duration: true 是必须的。Ogg/Vorbis 的时长藏在最后一个页的 granule position 里，
    // 不开这个选项 music-metadata 只读文件头，format.duration 会是 undefined ——
    // 实测两个真实 ogg 都拿不到时长，列表里全显示 00:00。MP3 从帧头就能算，不受影响。
    // 字节本来就已经全部在内存里，多扫一遍只花 CPU，不产生额外磁盘 IO。
    meta = await parseBlob(new Blob([bytes as BlobPart]), { duration: true })
  } catch {
    return fallback
  }

  const common = meta.common
  let cover: string | null = null
  const pic = common.picture?.[0]
  if (pic) {
    try {
      cover = URL.createObjectURL(new Blob([pic.data as BlobPart], { type: pic.format }))
    } catch {
      cover = null
    }
  }

  // 内嵌歌词：不同容器放在不同字段，逐个试
  const lyricsEntry = common.lyrics?.[0]
  const lyrics =
    (typeof lyricsEntry === "string" ? lyricsEntry : lyricsEntry?.text) ??
    (meta.native?.["ID3v2.3"]?.find((t) => t.id === "USLT")?.value as string | undefined) ??
    null

  // WAV 的 INFO 块由我们自己重解，避开 music-metadata 抹掉高位的问题
  const wav = /\.wav$/i.test(ref.name) ? parseWavInfo(bytes) : {}

  const pick = (own: string | undefined, parsed: string | undefined, fb: string) => {
    const a = own?.trim()
    if (a && !looksCorrupt(a)) return a
    const b = parsed?.trim()
    if (b && !looksCorrupt(b)) return b
    return fb
  }

  return {
    title: pick(wav.title, common.title, fallback.title),
    artist: pick(wav.artist, common.artist, fallback.artist),
    album: pick(wav.album, common.album, ""),
    duration: meta.format.duration ?? 0,
    cover,
    lyrics: typeof lyrics === "string" ? lyrics : null,
  }
}
