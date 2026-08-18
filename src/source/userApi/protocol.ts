/**
 * 主线程 ↔ 音源脚本 Worker 之间的消息协议。
 *
 * 音源脚本是第三方代码，必须当成不可信的来跑。放在 Worker 里的理由：
 * Worker 没有 DOM、没有 window、拿不到 Tauri 注入的 __TAURI_INTERNALS__，
 * 所以脚本**够不着文件系统、配置、任何 IPC 命令**，只能通过下面这几条消息和我们说话。
 * 网络请求也不是它自己发的 —— 它发 http-req，由主线程用 plugin-http 代发再把结果回给它。
 *
 * 隔离是 Worker 提供的，不是 CSP 提供的。CSP 那边只需要放行 worker 的 eval
 * （脚本本来就是动态代码，不放行等于这个功能不存在），隔离不受影响。
 */

/** lx.EVENT_NAMES，与上游 preload.js 一致 */
export const EVENT_NAMES = {
  request: "request",
  inited: "inited",
  updateAlert: "updateAlert",
} as const

/** 各平台支持的音质，抄自上游 preload.js 的 supportQualitys */
export const SUPPORT_QUALITYS: Record<string, string[]> = {
  kw: ["128k", "320k", "flac", "flac24bit"],
  kg: ["128k", "320k", "flac", "flac24bit"],
  tx: ["128k", "320k", "flac", "flac24bit"],
  wy: ["128k", "320k", "flac", "flac24bit"],
  mg: ["128k", "320k", "flac", "flac24bit"],
  local: [],
}

export const SUPPORT_ACTIONS: Record<string, string[]> = {
  kw: ["musicUrl"],
  kg: ["musicUrl"],
  tx: ["musicUrl"],
  wy: ["musicUrl"],
  mg: ["musicUrl"],
  local: ["musicUrl", "lyric", "pic"],
}

export interface ScriptInfo {
  name: string
  description: string
  version: string
  author: string
  homepage: string
  rawScript: string
}

/** 脚本声明它支持哪些平台与音质，由 lx.send('inited', ...) 触发 */
export interface InitedSources {
  [source: string]: { type: string; actions: string[]; qualitys: string[] }
}

// ── 主线程 → Worker ───────────────────────────────────────
export type ToWorker =
  | { t: "boot"; script: string; info: ScriptInfo }
  /** 代发的 HTTP 请求结果 */
  | { t: "http-res"; id: number; err?: string; resp?: unknown; body?: unknown }
  /** 要一个播放地址 */
  | { t: "req"; id: number; source: string; action: string; info: unknown }

// ── Worker → 主线程 ───────────────────────────────────────
export type FromWorker =
  /** 脚本初始化完成，声明支持的平台 */
  | { t: "inited"; sources: InitedSources }
  /** 脚本要发一个 HTTP 请求，主线程代发 */
  | { t: "http-req"; id: number; url: string; options: Record<string, unknown> }
  /** req 的结果 */
  | { t: "req-res"; id: number; err?: string; result?: unknown }
  /** 脚本调用了 updateAlert */
  | { t: "alert"; log: string; updateUrl?: string }
  | { t: "error"; message: string }
