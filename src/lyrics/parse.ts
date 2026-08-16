/** 词级时间戳。增强型 LRC 的 `<mm:ss.xx>` 标记。 */
export type LyricWord = { t: number; text: string }

export type LyricLine = {
  t: number
  /** 已剥掉词级标记的纯文本 */
  text: string
  /** 词级时间戳，仅增强型 LRC 有 */
  words?: LyricWord[]
  /** 本行唱完的时刻。由下一行推出，或由空行 / 行尾收尾标记显式给出 */
  end?: number
}

export type Lyrics = {
  lines: LyricLine[]
  /** [offset:] 声明的整体偏移，毫秒。正值表示歌词应提前显示 */
  offset: number
  title?: string
  artist?: string
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const META_TAG = /^\[(ti|ar|al|by|offset):(.*)\]$/i

/** 行级歌词没有词级时间戳时，假定一行唱这么久 —— 只用于最后一行 */
const TAIL_LINE = 4

function toSeconds(min: string, sec: string, frac: string | undefined): number {
  // [00:12.5] 是 500ms，[00:12.05] 是 50ms —— 按位数决定量级，不能一律当毫秒
  const f = frac ? Number.parseInt(frac, 10) / Math.pow(10, frac.length) : 0
  return Number.parseInt(min, 10) * 60 + Number.parseInt(sec, 10) + f
}

/**
 * 拆出一行里的词级时间戳。
 *
 * 增强型 LRC 形如 `[00:12.34]<00:12.34>March <00:12.90>winds<00:13.40>`：
 * 每个标记之后到下一个标记之间是一个词，末尾那个不带文本的标记是收尾时刻。
 */
function parseWords(content: string, lineT: number): Pick<LyricLine, "text" | "words" | "end"> {
  WORD_TAG.lastIndex = 0
  const marks: Array<{ t: number; at: number; len: number }> = []
  let m: RegExpExecArray | null
  while ((m = WORD_TAG.exec(content)) !== null) {
    marks.push({ t: toSeconds(m[1], m[2], m[3]), at: m.index, len: m[0].length })
  }

  const text = content.replace(WORD_TAG, "").trim()
  if (marks.length === 0) return { text }

  const words: LyricWord[] = []
  let end: number | undefined
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].at + marks[i].len
    const to = i + 1 < marks.length ? marks[i + 1].at : content.length
    const piece = content.slice(from, to)
    // 末尾的空标记是收尾时刻，不是一个词
    if (piece === "" && i === marks.length - 1) {
      end = marks[i].t
      break
    }
    words.push({ t: marks[i].t, text: piece })
  }

  // 第一个标记之前若还有文本，归给首词（有些工具不给行首的词打标记）
  const lead = content.slice(0, marks[0].at)
  if (lead && words.length > 0) {
    words[0] = { t: Math.min(lineT, words[0].t), text: lead + words[0].text }
  }

  return { text, words: words.length > 0 ? words : undefined, end }
}

/**
 * LRC 解析，兼容增强型（词级）LRC。
 *
 * 自己写而不是引 lrc-kit：本体不过百来行，而且我们需要 [offset:]、同一行挂多个
 * 时间戳、词级标记，自己写更好控制。
 */
export function parseLrc(src: string): Lyrics {
  const out: Lyrics = { lines: [], offset: 0 }
  if (!src) return out

  // 去掉 BOM，统一换行
  const text = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n")

  /** 空内容的时间戳：不是歌词，是「唱到此为止」的标记 */
  const stops: number[] = []

  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue

    const meta = META_TAG.exec(line)
    if (meta) {
      const [, key, value] = meta
      const v = value.trim()
      const k = key.toLowerCase()
      if (k === "offset") {
        const n = Number.parseInt(v, 10)
        if (Number.isFinite(n)) out.offset = n
      } else if (k === "ti") out.title = v
      else if (k === "ar") out.artist = v
      continue
    }

    // 收集本行所有时间戳，正文是最后一个时间戳之后的部分
    TIME_TAG.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let end = 0
    while ((m = TIME_TAG.exec(line)) !== null) {
      if (m.index !== end) break // 时间戳必须连续出现在行首
      stamps.push(toSeconds(m[1], m[2], m[3]))
      end = TIME_TAG.lastIndex
    }
    if (stamps.length === 0) continue

    const content = line.slice(end)
    const parsed = parseWords(content, stamps[0])
    if (!parsed.text) {
      // 真实 LRC 里这种空行很常见（间奏起点）。丢掉它，上一行就会一直高亮到
      // 几十秒后的下一句 —— 所以要留下来当上一行的结束时刻。
      for (const t of stamps) stops.push(t)
      continue
    }
    for (const t of stamps) out.lines.push({ ...parsed, t })
  }

  out.lines.sort((a, b) => a.t - b.t)
  stops.sort((a, b) => a - b)

  // 补齐每行的结束时刻：显式收尾标记 > 最近的停唱标记 > 下一行起点
  for (let i = 0; i < out.lines.length; i++) {
    const cur = out.lines[i]
    const next = out.lines[i + 1]?.t ?? cur.t + TAIL_LINE
    if (cur.end === undefined) {
      const stop = stops.find((s) => s > cur.t && s <= next)
      cur.end = stop ?? next
    }
  }

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

/**
 * 这一行唱到了百分之几，0..1。用于逐字擦除。
 *
 * 词级歌词按字符数加权推进；行级歌词没有词内信息，进入即算唱满
 * （否则整行会一直是暗的，反而比现在难看）。
 */
export function lineFill(line: LyricLine, time: number): number {
  if (time < line.t) return 0
  const words = line.words
  if (!words || words.length === 0) return 1

  const end = line.end ?? line.t + TAIL_LINE
  if (time >= end) return 1

  const total = words.reduce((n, w) => n + w.text.length, 0)
  if (total === 0) return 1

  let done = 0
  for (let i = 0; i < words.length; i++) {
    const from = words[i].t
    const to = i + 1 < words.length ? words[i + 1].t : end
    if (time >= to) {
      done += words[i].text.length
      continue
    }
    if (time <= from) break
    done += (words[i].text.length * (time - from)) / Math.max(1e-6, to - from)
    break
  }
  return Math.min(1, done / total)
}

/** 这份歌词有没有词级时间戳。有的话界面上标一下，用户才知道自己拿到的是逐字版。 */
export function hasWordTiming(lyrics: Lyrics | null): boolean {
  return !!lyrics?.lines.some((l) => l.words && l.words.length > 0)
}
