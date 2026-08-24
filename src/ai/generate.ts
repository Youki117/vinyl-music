import { platform, type FileRef } from "@/platform"
import {
  resolveImageEndpoint,
  resolveTextEndpoint,
  type AiConfig,
} from "./config"
import { buildLyricDigest, composeImagePrompt, SYSTEM_PROMPT, type PromptSource } from "./prompt"

/**
 * 两步生成：歌词 → 文本模型总结成画面 → 生图模型出图 → 落盘成底图。
 *
 * 刻意保持最简：两次 HTTP 调用，都是 OpenAI 兼容格式，没有队列、没有重试策略、
 * 没有中间层。想换服务商只需在设置里改 Base URL 与模型名。
 */

export type GenerateResult = {
  /** 文本模型给出的画面描述；直接用用户提示词时为 null */
  scene: string | null
  /** 真正送给生图模型的完整提示词（含风格后缀） */
  prompt: string
  ref: FileRef
  /** 图片字节。调用方拿它现做缩略图，省一次回头读盘 */
  bytes: Uint8Array
}

export type Progress = (stage: "text" | "image" | "saving") => void

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await platform.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  if (!res.ok) {
    // 把服务端的原文带出来，否则用户看到的只有一个状态码，没法排查
    throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 200)}`)
  }
}

/**
 * 给文本模型的输出预算。
 *
 * 系统提示里要的是 80 字以内，本来 300 绰绰有余。给到 1000 是为了推理模型：
 * 它们的思考过程也从这个额度里扣，300 常常在推理阶段就被吃光，`content` 返回
 * 空串、finish_reason 是 length —— 那正是"文本模型没有返回内容"的最常见来源。
 */
const TEXT_MAX_TOKENS = 1000

/**
 * 空回复到底是哪一种。
 *
 * 早先这三种情况被压成同一句"文本模型没有返回内容"，用户看不出该去改模型名、
 * 改额度还是改歌 —— 而这三条的处理方式完全不同。
 */
function explainEmptyScene(choice: TextChoice | undefined): string {
  const reason = choice?.finish_reason
  if (choice?.message?.reasoning_content?.trim()) {
    return `模型只输出了推理过程、没有给出正文（finish_reason=${reason ?? "未知"}）。这类推理模型的思考也占输出额度，请换成对话模型（如 deepseek-chat）再试`
  }
  if (reason === "length") {
    return `输出在写完之前就被截断了（finish_reason=length）。若填的是推理模型，请换成对话模型（如 deepseek-chat）`
  }
  if (reason === "content_filter") {
    return "这首歌的歌词被服务端内容审核拦下了，换一首或关掉自动生成"
  }
  return `文本模型返回了空内容（finish_reason=${reason ?? "未知"}），请检查模型名是否填对`
}

type TextChoice = {
  finish_reason?: string
  message?: { content?: string; reasoning_content?: string }
}

/** 第一步：让文本模型把歌词总结成一句画面描述。 */
export async function describeScene(
  cfg: AiConfig,
  src: PromptSource,
  signal?: AbortSignal,
): Promise<string> {
  const { baseUrl, apiKey } = resolveTextEndpoint(cfg)
  const data = (await postJson(
    `${baseUrl}/chat/completions`,
    apiKey,
    {
      model: cfg.textModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildLyricDigest(src) },
      ],
      temperature: 0.9,
      max_tokens: TEXT_MAX_TOKENS,
    },
    signal,
  )) as { choices?: TextChoice[] }

  const choice = data.choices?.[0]
  const scene = choice?.message?.content?.trim()
  if (!scene) throw new Error(explainEmptyScene(choice))
  return scene
}

/** 第二步：把画面描述交给生图模型，取回图片字节。 */
export async function renderImage(
  cfg: AiConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const { baseUrl, apiKey } = resolveImageEndpoint(cfg)
  const data = (await postJson(
    `${baseUrl}/images/generations`,
    apiKey,
    {
      model: cfg.imageModel,
      prompt,
      n: 1,
      size: cfg.imageSize,
      // 拿 base64 可以少一次跨域取图；不支持的服务会退回 url，下面两种都处理
      response_format: "b64_json",
    },
    signal,
  )) as { data?: Array<{ b64_json?: string; url?: string }> }

  const first = data.data?.[0]
  if (!first) throw new Error("生图模型没有返回图片")

  if (first.b64_json) return base64ToBytes(first.b64_json)

  if (first.url) {
    const res = await platform.request(first.url, { method: "GET", signal })
    if (!res.ok) throw new Error(`取图失败：${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
  throw new Error("返回里既没有 b64_json 也没有 url")
}

/** 完整流程：歌词 → 画面描述 → 出图。调用方负责判断配置是否齐全。 */
export async function generateArtwork(
  cfg: AiConfig,
  src: PromptSource,
  key: string,
  onProgress?: Progress,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  onProgress?.("text")
  const scene = await describeScene(cfg, src, signal)

  onProgress?.("image")
  const prompt = composeImagePrompt(scene, cfg.styleSuffix)
  return { scene, ...(await renderAndSave(cfg, prompt, key, onProgress, signal)) }
}

/**
 * 跳过文本模型，直接拿用户写的提示词出图。
 *
 * 少一次调用就少一笔钱，而且用户自己写的话本来就不需要"把歌词转成画面"这一步。
 * 风格后缀照样拼上 —— 左侧留白那条是硬要求（画面左侧要压蒙版），不是审美偏好。
 */
export async function generateFromPrompt(
  cfg: AiConfig,
  userPrompt: string,
  key: string,
  onProgress?: Progress,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  onProgress?.("image")
  const prompt = composeImagePrompt(userPrompt, cfg.styleSuffix)
  return { scene: null, ...(await renderAndSave(cfg, prompt, key, onProgress, signal)) }
}

async function renderAndSave(
  cfg: AiConfig,
  prompt: string,
  key: string,
  onProgress?: Progress,
  signal?: AbortSignal,
): Promise<{ prompt: string; ref: FileRef; bytes: Uint8Array }> {
  const bytes = await renderImage(cfg, prompt, signal)
  onProgress?.("saving")
  // 文件名带 key 的哈希：同一首歌可以生成多张，名字不能互相覆盖
  const ref = await platform.saveImage(`ai-${hash(key)}.png`, bytes)
  return { prompt, ref, bytes }
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:image\/\w+;base64,/, "")
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 文件名用的短哈希，避免把路径里的非法字符带进文件名 */
export function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
