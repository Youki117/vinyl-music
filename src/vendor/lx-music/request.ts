/**
 * musicSdk 的 HTTP 层。**垫片，不是上游代码。**
 *
 * 上游用 needle 在 Electron 里发请求。我们走 `@tauri-apps/plugin-http`，由 Rust 侧转发 ——
 * 这不只是替代品，对这些接口来说是更合适的通道：
 *   1. 不受 CORS 限制（音乐平台的接口不会给浏览器来源发 CORS 头）
 *   2. 可以自由设 User-Agent / Referer / Cookie，这些接口普遍要校验
 *
 * 契约照抄上游 src/renderer/utils/request.js：
 *   httpFetch(url, options) → { promise, cancelHttp() }
 *   promise resolve 出 resp，其中 resp.body 已尝试 JSON.parse，失败保留原文
 * musicSdk 有 56 处依赖这个形状，改了就得改 56 个调用点，所以照抄。
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { Buffer } from "buffer"

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36"

export interface LxResponse {
  statusCode: number
  headers: Record<string, string>
  body: unknown
  /**
   * 响应的**原始字节**，不是文本。
   *
   * 上游用 needle，它的 `resp.raw` 就是 Buffer，musicSdk 有地方直接
   * `raw.toString('base64')` 再去解码 —— 酷我歌词接口返回的是 deflate 过的二进制，
   * 一旦这里给的是字符串，那次 `toString('base64')` 会静默变成空操作
   * （String.prototype.toString 不认参数），拿到的 base64 是乱码，歌词永远解不出来
   * 且不报错。契约必须与上游一致。
   */
  raw: Buffer
}

export interface LxOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  form?: Record<string, string>
  formData?: Record<string, string>
  timeout?: number
  [k: string]: unknown
}

/** 上游把请求体放在 body / form / formData 三个字段之一，语义不同，要分开处理 */
function buildBody(options: LxOptions, headers: Record<string, string>): string | undefined {
  if (options.body != null) {
    if (typeof options.body === "string") return options.body
    headers["Content-Type"] ??= "application/json"
    return JSON.stringify(options.body)
  }
  if (options.form) {
    headers["Content-Type"] ??= "application/x-www-form-urlencoded"
    return new URLSearchParams(options.form).toString()
  }
  if (options.formData) {
    headers["Content-Type"] ??= "application/x-www-form-urlencoded"
    return new URLSearchParams(options.formData).toString()
  }
  return undefined
}

export function httpFetch(url: string, options: LxOptions = { method: "get" }) {
  const ctrl = new AbortController()
  const obj = {
    isCancelled: false,
    cancelHttp: () => {
      obj.isCancelled = true
      ctrl.abort()
    },
    promise: undefined as unknown as Promise<LxResponse>,
  }

  obj.promise = (async () => {
    const headers: Record<string, string> = { "User-Agent": DEFAULT_UA, ...(options.headers ?? {}) }
    const body = buildBody(options, headers)
    const res = await tauriFetch(url, {
      method: (options.method ?? "get").toUpperCase(),
      headers,
      body,
      signal: ctrl.signal,
    })
    // 先拿字节再转文本，顺序不能反：有些接口（酷我歌词）返回的是二进制，
    // 先 text() 会按 UTF-8 解一遍，非法字节被替换成 U+FFFD，原始数据就回不来了
    const bytes = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // 不是 JSON 就保留原文：有些接口返回 jsonp 包裹或纯文本，上游自己会再处理
    }
    return {
      statusCode: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
      raw: Buffer.from(bytes),
    }
  })()

  return obj
}

/** 回调风格，上游少数地方用。签名与 needle 一致：(err, resp, body) */
export function httpGet(
  url: string,
  options: LxOptions | ((err: Error | null, resp?: LxResponse, body?: unknown) => void),
  callback?: (err: Error | null, resp?: LxResponse, body?: unknown) => void,
) {
  const cb = (typeof options === "function" ? options : callback)!
  const opts = typeof options === "function" ? {} : options
  const req = httpFetch(url, { ...opts, method: "get" })
  req.promise.then(
    (resp) => cb(null, resp, resp.body),
    (err) => cb(err as Error),
  )
  return req
}

export const cancelHttp = (requestObj: { cancelHttp?: () => void } | null): void => {
  requestObj?.cancelHttp?.()
}
