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

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36"

export interface LxResponse {
  statusCode: number
  headers: Record<string, string>
  body: unknown
  raw: string
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
    const raw = await res.text()
    let parsed: unknown = raw
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 不是 JSON 就保留原文：有些接口返回 jsonp 包裹或纯文本，上游自己会再处理
    }
    return {
      statusCode: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
      raw,
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
