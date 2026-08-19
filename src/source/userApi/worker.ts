/**
 * 音源脚本的执行环境。**这里跑的是不可信的第三方代码。**
 *
 * 之所以放在 Worker 而不是主线程：Worker 里没有 DOM、没有 window、没有 Tauri 注入的
 * __TAURI_INTERNALS__，所以脚本够不着文件系统、配置和任何 IPC 命令。它唯一的对外通道
 * 是 postMessage，连网络请求都得让主线程代发（见 protocol.ts）。
 *
 * globalThis.lx 的形状照抄上游 src/main/modules/userApi/renderer/preload.js —— 音源脚本
 * 是按那个契约写的，差一个字段就跑不起来。
 */
/*
 * 必须是**第一个 import**。ES 模块会先把全部依赖求值完，再执行本模块的 body，
 * 所以在 body 里挂全局来不及 —— crypto-browserify / browserify-zlib 初始化时会碰到
 * 裸的 process，直接抛 ReferenceError。把注入放进一个单独模块并排在最前，
 * 它的 body 就先于后面这些依赖执行。
 */
import "@/polyfill"

import { Buffer } from "buffer"
import { createCipheriv, createHash, publicEncrypt, randomBytes, constants } from "crypto"
// @ts-expect-error browserify-zlib 没有类型声明，是个 CJS 老包
import { inflate, deflate } from "browserify-zlib"

import {
  EVENT_NAMES,
  SUPPORT_ACTIONS,
  SUPPORT_QUALITYS,
  type FromWorker,
  type ScriptInfo,
  type ToWorker,
} from "./protocol"

// 音源脚本按 Electron 渲染进程的环境写的，Buffer / process / global 都当全局用。
// 实际注入在 @/polyfill（见上面第一个 import 的理由），这里只是留个记号。
const g = globalThis as unknown as Record<string, unknown>

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m)

// ── 主线程代发的 HTTP ─────────────────────────────────────
let httpSeq = 0
const httpPending = new Map<number, (err: string | undefined, resp: unknown, body: unknown) => void>()

type RequestCallback = (err: Error | null, resp: unknown, body: unknown) => void

/** lx.request：签名与上游一致，回调式，返回一个取消函数 */
function request(url: string, options: Record<string, unknown>, callback: RequestCallback) {
  const id = ++httpSeq
  httpPending.set(id, (err, resp, body) => {
    if (err) callback.call(null, new Error(err), null, null)
    else callback.call(null, null, resp, body)
  })
  post({ t: "http-req", id, url, options: options ?? {} })
  return () => httpPending.delete(id)
}

// ── 脚本注册的 request 处理器 ─────────────────────────────
type RequestHandler = (params: { source: string; action: string; info: unknown }) => Promise<unknown>
let requestHandler: RequestHandler | null = null
let inited = false

let scriptInfo: ScriptInfo = {
  name: "",
  description: "",
  version: "",
  author: "",
  homepage: "",
  rawScript: "",
}

/**
 * 按上游 handleInit 的逻辑收敛脚本声明的能力：
 * 只保留我们认识的平台，且 actions/qualitys 与我们支持的取交集 —— 脚本说它支持什么不算数，
 * 得双方都支持才算。
 */
function handleInit(info: { sources?: Record<string, { type?: string; actions?: string[]; qualitys?: string[] }> }) {
  const sources: Record<string, { type: string; actions: string[]; qualitys: string[] }> = {}
  for (const source of Object.keys(SUPPORT_QUALITYS)) {
    const us = info?.sources?.[source]
    if (!us || us.type !== "music") continue
    sources[source] = {
      type: "music",
      actions: (SUPPORT_ACTIONS[source] ?? []).filter((a) => us.actions?.includes(a)),
      qualitys: (SUPPORT_QUALITYS[source] ?? []).filter((q) => us.qualitys?.includes(q)),
    }
  }
  post({ t: "inited", sources })
}

const lx = {
  EVENT_NAMES,
  request,
  on(eventName: string, handler: RequestHandler) {
    if (eventName !== EVENT_NAMES.request) {
      return Promise.reject(new Error(`不支持的事件: ${eventName}`))
    }
    requestHandler = handler
    return Promise.resolve()
  },
  send(eventName: string, data: unknown) {
    return new Promise<void>((resolve, reject) => {
      switch (eventName) {
        case EVENT_NAMES.inited:
          if (inited) return reject(new Error("脚本已初始化过"))
          inited = true
          handleInit(data as { sources?: Record<string, never> })
          resolve()
          break
        case EVENT_NAMES.updateAlert: {
          const d = data as { log?: string; updateUrl?: string }
          if (!d?.log) return reject(new Error("log is required."))
          post({ t: "alert", log: String(d.log).slice(0, 1024), updateUrl: d.updateUrl })
          resolve()
          break
        }
        default:
          reject(new Error(`未知事件: ${eventName}`))
      }
    })
  },
  utils: {
    crypto: {
      aesEncrypt(buffer: Buffer, mode: string, key: Buffer, iv: Buffer) {
        const cipher = createCipheriv(mode, key, iv)
        return Buffer.concat([cipher.update(buffer), cipher.final()])
      },
      rsaEncrypt(buffer: Buffer, key: string) {
        const padded = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])
        return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded)
      },
      randomBytes,
      md5: (str: string) => createHash("md5").update(str).digest("hex"),
    },
    buffer: {
      from: (...args: unknown[]) => (Buffer.from as (...a: unknown[]) => Buffer)(...args),
      bufToString: (buf: unknown, format: BufferEncoding) =>
        Buffer.from(buf as never, "binary").toString(format),
    },
    zlib: {
      inflate: (buf: Buffer) =>
        new Promise((resolve, reject) => {
          inflate(buf, (err: Error | null, data: Buffer) => (err ? reject(new Error(err.message)) : resolve(data)))
        }),
      deflate: (data: Buffer) =>
        new Promise((resolve, reject) => {
          deflate(data, (err: Error | null, buf: Buffer) => (err ? reject(new Error(err.message)) : resolve(buf)))
        }),
    },
  },
  get currentScriptInfo() {
    return scriptInfo
  },
  version: "2.0.0",
  // 脚本会拿它拼 User-Agent；报 desktop 与上游一致，报别的可能被音源服务端拒绝
  env: "desktop",
}

g.lx = lx

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  switch (msg.t) {
    case "boot": {
      scriptInfo = msg.info
      try {
        /*
         * 用 blob + 动态 import 加载，**不用 eval**：CSP 只需放行 `script-src blob:` /
         * `worker-src blob:`，不必开 unsafe-eval —— 后者对整个应用生效，口子宽得多。
         *
         * 原先用的是 importScripts，因为它在**非严格模式的全局作用域**里执行脚本，
         * 和洛雪的 Electron 渲染进程环境一致。但 importScripts 只有经典 worker 才有，
         * 而经典 worker 在 Vite dev 下根本起不来（理由写在 host.ts 起 Worker 那里）。
         * 权衡之后选了 module worker：`import(blobUrl)` 按模块跑，强制严格模式、
         * 顶层声明不进全局。实测三份真实音源（野草 / 野花 / 六音）都不受影响 ——
         * 它们只通过 globalThis.lx 对外说话，不依赖变量泄漏到全局。
         *
         * 安全边界仍然是 Worker 本身：没有 DOM、没有 window、没有 Tauri IPC，
         * 网络还得让主线程代发。CSP 这一步只决定"能不能执行动态代码"，不影响它能碰到什么。
         */
        const blob = new Blob([msg.script], { type: "text/javascript" })
        const url = URL.createObjectURL(blob)
        try {
          await import(/* @vite-ignore */ url)
        } finally {
          URL.revokeObjectURL(url)
        }
      } catch (err) {
        post({ t: "error", message: err instanceof Error ? err.message : String(err) })
      }
      break
    }
    case "http-res": {
      const cb = httpPending.get(msg.id)
      httpPending.delete(msg.id)
      cb?.(msg.err, msg.resp, msg.body)
      break
    }
    case "req": {
      if (!requestHandler) {
        post({ t: "req-res", id: msg.id, err: "脚本没有注册 request 处理器" })
        return
      }
      try {
        const result = await requestHandler({ source: msg.source, action: msg.action, info: msg.info })
        post({ t: "req-res", id: msg.id, result })
      } catch (err) {
        post({ t: "req-res", id: msg.id, err: err instanceof Error ? err.message : String(err) })
      }
      break
    }
  }
}
