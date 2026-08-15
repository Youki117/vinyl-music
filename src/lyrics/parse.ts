export type LyricLine = { t: number; text: string }

export type Lyrics = {
  lines: LyricLine[]
  /** [offset:] 声明的整体偏移，毫秒。正值表示歌词应提前显示 */
  offset: number
  title?: string
  artist?: string
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META_TAG = /^\[(ti|ar|al|by|offset):(.*)\]$/i

/**
 * LRC 解析。
 *
 * 自己写而不是引 lrc-kit：本体不过几十行，而且我们需要 [offset:]、同一行挂多个
 * 时间戳、以及后续的双语预留，自己写更好控制。
 */
export function parseLrc(src: string): Lyrics {
  const out: Lyrics = { lines: [], offset: 0 }
  if (!src) return out

  // 去掉 BOM，统一换行
  const text = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n")

  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue

    const meta = META_TAG.exec(line)
    if (meta) {
      const [, key, value] = meta
      const v = value.trim()
      if (key.toLowerCase() === "offset") {
        const n = Number.parseInt(v, 10)
        if (Number.isFinite(n)) out.offset = n
      } else if (key.toLowerCase() === "ti") out.title = v
      else if (key.toLowerCase() === "ar") out.artist = v
      continue
    }

    // 收集本行所有时间戳，正文是最后一个时间戳之后的部分
    TIME_TAG.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let end = 0
    while ((m = TIME_TAG.exec(line)) !== null) {
      if (m.index !== end) break // 时间戳必须连续出现在行首
      const min = Number.parseInt(m[1], 10)
      const sec = Number.parseInt(m[2], 10)
      const fracStr = m[3] ?? "0"
      // [00:12.5] 是 500ms，[00:12.05] 是 50ms —— 按位数决定量级，不能一律当毫秒
      const frac = Number.parseInt(fracStr, 10) / Math.pow(10, fracStr.length)
      stamps.push(min * 60 + sec + frac)
      end = TIME_TAG.lastIndex
    }
    if (stamps.length === 0) continue

    const content = line.slice(end).trim()
    if (!content) continue
    for (const t of stamps) out.lines.push({ t, text: content })
  }

  out.lines.sort((a, b) => a.t - b.t)
  return out
}

/**
 * 定位当前行。用二分而非线性扫描 —— 这个函数跑在渲染循环里，
 * 一首歌 200 行的线性扫描每秒 60 次是纯浪费。
 *
 * @returns 当前行下标；时间早于第一行时返回 -1
 */
export function activeLineIndex(lines: LyricLine[], time: number): number {
  if (lines.length === 0 || time < lines[0].t) return -1
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid].t <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}
