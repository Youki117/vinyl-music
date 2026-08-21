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
    // 纯音乐、只有制作人署名、或滤完只剩零碎的，都走这条 ——
    // 让模型知道"确实没有词"，好过让它对着"请您欣赏"编画面
    parts.push("（这首歌没有可用的歌词，请只依据歌名与专辑名想象画面）")
  }
  return parts.join("\n")
}

/**
 * 制作人员署名行。
 *
 * 平台歌词几乎都在正文前面挂一串这个（`作词 : 某某`、`和声：某某`），它们不是
 * 歌词，喂给模型只会得到"一个叫某某的人在录音棚里"这种画面。
 *
 * 必须卡"行首职能词 + 冒号"这个形状，不能只匹配关键词 —— 「作曲家的手在发抖」
 * 是正经歌词，不能因为含"作曲"两个字就被丢掉。
 */
const CREDIT_LINE =
  /^\s*(作词|作曲|编曲|填词|制作人|出品人?|监制|录音|混音|母带|和声|配唱|统筹|策划|发行|企划|吉他|贝斯|鼓|键盘|弦乐|长笛|二胡|古筝|人声|录音室|录音棚|词|曲|OP|SP|OC|MV|Producer|Composer|Lyricist|Arranger|Mixing|Mastering)\s*[:：]/i

/**
 * 平台对纯音乐返回的占位句。
 *
 * 这类曲目在接口上不是"没有歌词"，而是"歌词内容是一句说明"。不识别的话，
 * buildLyricDigest 会以为拿到了歌词，把"请您欣赏"当意象送去生图。
 */
const INSTRUMENTAL_LINE =
  /(纯音乐[，,]?\s*请欣赏|此歌曲为没有填词的纯音乐|没有填词的纯音乐|暂无歌词|该歌曲暂时没有歌词|instrumental\s*(only)?$|no\s+lyrics)/i

/** 这一行是不是根本不算歌词正文 */
export function isNonLyricLine(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  // [ti:xxx] 这类 LRC 元信息标签
  if (/^\[[a-z]+:.*\]$/i.test(t)) return true
  if (CREDIT_LINE.test(t)) return true
  if (INSTRUMENTAL_LINE.test(t)) return true
  return false
}

/** 从 LRC 或纯文本里取出去重后的歌词正文，署名与占位说明都不算。 */
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
    if (isNonLyricLine(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/*
 * 这里刻意**不设"至少几行才算数"的门槛**。
 *
 * 试过按行数卡（少于三行就当没歌词），结果把「没有星星的夜空」这种一行就足够
 * 撑起一个画面的歌词也滤掉了 —— 而它正是本文件开头拿来举例的那类。真正该挡的
 * 是署名和占位说明，上面两条正则已经精确挡住了；再加个行数门槛只会误伤短歌词。
 * 万一漏网一行零碎（一句"Hey"），模型自然会退回去靠歌名，损失远小于误伤。
 */

/** 文本模型的输出 + 固定风格后缀 = 最终送给生图模型的提示词。 */
export function composeImagePrompt(scene: string, styleSuffix: string): string {
  const s = scene.trim().replace(/^["'「『]|["'」』]$/g, "")
  return styleSuffix ? `${s}。${styleSuffix}` : s
}
