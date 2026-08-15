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
    meta = await parseBlob(new Blob([bytes as BlobPart]))
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

  return {
    title: common.title?.trim() || fallback.title,
    artist: common.artist?.trim() || fallback.artist,
    album: common.album?.trim() || "",
    duration: meta.format.duration ?? 0,
    cover,
    lyrics: typeof lyrics === "string" ? lyrics : null,
  }
}
