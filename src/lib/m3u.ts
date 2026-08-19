import { baseName } from "./text"

export type M3uEntry = {
  /** 原样保留的路径，可能是相对的 */
  path: string
  /** #EXTINF 里的显示名，通常是「艺术家 - 标题」 */
  title?: string
  /** #EXTINF 里的秒数；-1 或缺失时为 undefined */
  duration?: number
}

const EXTINF = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*,\s*(.*)$/i

/**
 * 解析 m3u / m3u8。
 *
 * 格式本身没有标准文档，实际见到的写法很杂：有的带 #EXTM3U 头有的不带，
 * 有的用反斜杠有的用正斜杠，有的整份是相对路径。这里只认两件事——
 * `#EXTINF:` 行给下一条路径提供元信息，不以 `#` 开头的非空行就是一条路径。
 */
export function parseM3u(text: string): M3uEntry[] {
  const out: M3uEntry[] = []
  let pending: { title?: string; duration?: number } = {}

  for (const raw of text.replace(/^﻿/, "").split(/\r\n?|\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith("#")) {
      const m = EXTINF.exec(line)
      if (m) {
        const secs = Number.parseFloat(m[1])
        pending = {
          title: m[2].trim() || undefined,
          duration: Number.isFinite(secs) && secs >= 0 ? secs : undefined,
        }
      }
      // 其余 #EXTM3U / #PLAYLIST / 注释一律忽略
      continue
    }

    out.push({ path: line, ...pending })
    pending = {}
  }
  return out
}

export type M3uTrack = { path: string; title: string; artist: string; duration: number }

/**
 * 生成 m3u8。统一写 UTF-8、正斜杠、绝对路径 —— 这份文件是给别的播放器读的，
 * 用最不容易出错的写法。
 */
export function formatM3u(tracks: M3uTrack[]): string {
  const lines = ["#EXTM3U"]
  for (const t of tracks) {
    const name = t.artist ? `${t.artist} - ${t.title}` : t.title
    lines.push(`#EXTINF:${Math.round(t.duration)},${name}`)
    lines.push(t.path.replace(/\\/g, "/"))
  }
  return lines.join("\n") + "\n"
}

/**
 * 按文件名把 m3u 条目匹配到已有曲目。
 *
 * 绝对路径解析失败时的退路：歌单文件常常是从别的机器、别的盘符拷过来的，
 * 里头的路径早就失效，但文件名一般没变。
 */
export function matchByName<T extends { name: string }>(
  entries: M3uEntry[],
  tracks: T[],
): Map<string, T> {
  const index = new Map<string, T>()
  for (const t of tracks) {
    const key = t.name.toLowerCase()
    if (!index.has(key)) index.set(key, t)
  }
  const out = new Map<string, T>()
  for (const e of entries) {
    const hit = index.get(baseName(e.path).toLowerCase())
    if (hit) out.set(e.path, hit)
  }
  return out
}
