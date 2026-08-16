import { parseLrc } from "@/lyrics/parse"

/** 构造提示词所需的曲目信息，刻意不依赖完整的 Track 类型以便单测。 */
export type PromptSource = {
  title: string
  artist: string
  album: string
  lyrics: string | null
}

/** 送给文本模型的歌词上限，避免长诗把上下文撑爆也避免多花钱 */
const MAX_LYRIC_CHARS = 1200

export const SYSTEM_PROMPT =
  "你是一位电影美术指导。用户会给你一首歌的信息，你要把它转写成一段用于 AI 绘图的画面描述。\n" +
  "要求：\n" +
  "1. 只输出画面描述本身，不要任何解释、前言或引号。\n" +
  "2. 描述一个具体的、有故事感的瞬间：一个人物、一处环境、一种光线。不要抽象概念。\n" +
  "3. 抓住歌词里最具画面感的意象，不要复述歌词，也不要在画面里出现文字。\n" +
  "4. 控制在 80 字以内。\n" +
  "5. 用中文。"

/**
 * 把曲目信息整理成给文本模型的输入。
 *
 * 有歌词就用歌词——歌词里有具体意象（山明水秀、没有星星的夜空），图像模型吃这个。
 * 没歌词就退回标题与专辑名，中文歌名本身往往也带意象，比纯靠曲风形容词强。
 */
export function buildLyricDigest(src: PromptSource): string {
  const parts: string[] = [`歌名：${src.title}`]
  if (src.artist && src.artist !== "未知艺术家") parts.push(`艺术家：${src.artist}`)
  if (src.album) parts.push(`专辑：${src.album}`)

  const lines = extractLyricLines(src.lyrics)
  if (lines.length > 0) {
    let text = lines.join("\n")
    if (text.length > MAX_LYRIC_CHARS) text = text.slice(0, MAX_LYRIC_CHARS) + "…"
    parts.push(`歌词：\n${text}`)
  } else {
    parts.push("（这首歌没有歌词文件，请只依据歌名与专辑名想象画面）")
  }
  return parts.join("\n")
}

/** 从 LRC 或纯文本里取出去重后的歌词行。 */
export function extractLyricLines(lyrics: string | null): string[] {
  if (!lyrics?.trim()) return []

  const parsed = parseLrc(lyrics)
  const raw =
    parsed.lines.length > 0
      ? parsed.lines.map((l) => l.text)
      : lyrics.split(/\r?\n/).map((l) => l.trim())

  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw) {
    const t = line.trim()
    // 跳过空行与 [ti:] 这类元信息行
    if (!t || /^\[[a-z]+:.*\]$/i.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** 文本模型的输出 + 固定风格后缀 = 最终送给生图模型的提示词。 */
export function composeImagePrompt(scene: string, styleSuffix: string): string {
  const s = scene.trim().replace(/^["'「『]|["'」』]$/g, "")
  return styleSuffix ? `${s}。${styleSuffix}` : s
}
