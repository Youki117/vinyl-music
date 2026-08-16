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
  scene: string
  prompt: string
  ref: FileRef
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
      max_tokens: 300,
    },
    signal,
  )) as { choices?: Array<{ message?: { content?: string } }> }

  const scene = data.choices?.[0]?.message?.content?.trim()
  if (!scene) throw new Error("文本模型没有返回内容")
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

/** 完整流程。调用方负责判断配置是否齐全。 */
export async function generateArtwork(
  cfg: AiConfig,
  src: PromptSource,
  trackId: string,
  onProgress?: Progress,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  onProgress?.("text")
  const scene = await describeScene(cfg, src, signal)

  onProgress?.("image")
  const prompt = composeImagePrompt(scene, cfg.styleSuffix)
  const bytes = await renderImage(cfg, prompt, signal)

  onProgress?.("saving")
  const ref = await platform.saveImage(`ai-${hash(trackId)}.png`, bytes)
  return { scene, prompt, ref }
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
