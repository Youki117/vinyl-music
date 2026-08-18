/**
 * 音源脚本的宿主：起 Worker、代发网络请求、把它注册进 musicSdk 的 apis()。
 *
 * 分工见 protocol.ts。这一侧唯一要守的规矩是：**Worker 那边的东西一律当不可信**，
 * 它要发的请求由这里代发（所以 URL 也由这里过一遍），它返回的播放地址由这里校验。
 */
import { httpFetch } from "@/vendor/lx-music/request"
import { registerUserApi, clearUserApi } from "@/vendor/lx-music/store"
import type { FromWorker, InitedSources, ScriptInfo, ToWorker } from "./protocol"

export interface LoadedScript {
  info: ScriptInfo
  sources: InitedSources
}

/**
 * 调试钩子。音源脚本出问题时，唯一有用的信息是"它发了什么请求、收到了什么"——
 * 这些请求走 Rust 侧，浏览器的网络面板里看不到，所以必须在这里留个出口。
 */
export type SourceDebug = (ev: { dir: "req" | "res" | "note"; detail: unknown }) => void
let debugFn: SourceDebug | null = null
export const setSourceDebug = (fn: SourceDebug | null): void => {
  debugFn = fn
}
const dbg = (dir: "req" | "res" | "note", detail: unknown) => debugFn?.({ dir, detail })

let worker: Worker | null = null
let reqSeq = 0
const reqPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** 从脚本头部的注释里读元信息，格式与上游一致（@name / @version / ...） */
export function parseScriptInfo(script: string): ScriptInfo {
  const pick = (key: string) => {
    const m = new RegExp(`^\\s*\\*?\\s*@${key}\\s+(.+)$`, "m").exec(script.slice(0, 4000))
    return m?.[1].trim() ?? ""
  }
  return {
    name: pick("name") || "未命名音源",
    description: pick("description"),
    version: pick("version"),
    author: pick("author"),
    homepage: pick("homepage"),
    rawScript: script,
  }
}

function stop() {
  worker?.terminate()
  worker = null
  for (const p of reqPending.values()) p.reject(new Error("音源已卸载"))
  reqPending.clear()
  clearUserApi()
}

/**
 * 载入并启动一个音源脚本。
 *
 * 返回的 Promise 在脚本调用 lx.send('inited') 之后才 resolve —— 那一刻才知道它支持哪些平台。
 * 超时是必须的：脚本可能因为服务端校验失败而永远不 inited，不能让界面一直转圈。
 */
export function loadUserApi(script: string, timeoutMs = 20000): Promise<LoadedScript> {
  stop()
  const info = parseScriptInfo(script)

  return new Promise<LoadedScript>((resolve, reject) => {
    // 经典 worker 而不是 module worker：importScripts 只在经典 worker 里有，
    // 而我们要用它在非严格模式下跑音源脚本（理由见 worker.ts 的 boot 分支）
    const w = new Worker(new URL("./worker.ts", import.meta.url))
    worker = w

    const timer = setTimeout(() => {
      stop()
      reject(new Error(`音源脚本 ${timeoutMs / 1000}s 内没有完成初始化，可能是服务端校验未通过`))
    }, timeoutMs)

    const send = (m: ToWorker) => w.postMessage(m)

    w.onerror = (e) => {
      clearTimeout(timer)
      stop()
      reject(new Error(`音源脚本执行出错：${e.message}`))
    }

    w.onmessage = async (e: MessageEvent<FromWorker>) => {
      const msg = e.data
      switch (msg.t) {
        case "http-req": {
          // 脚本自己不能发请求，这里代发。plugin-http 走 Rust 侧，没有 CORS 限制。
          dbg("req", { url: msg.url, options: msg.options })
          try {
            const resp = await httpFetch(msg.url, msg.options).promise
            dbg("res", { url: msg.url, status: resp.statusCode, body: resp.body })
            send({ t: "http-res", id: msg.id, resp, body: resp.body })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            dbg("res", { url: msg.url, err: message })
            send({ t: "http-res", id: msg.id, err: message })
          }
          break
        }
        case "inited": {
          clearTimeout(timer)
          // 把脚本声明支持的每个平台接进 musicSdk 的 apis()
          for (const source of Object.keys(msg.sources)) {
            if (!msg.sources[source].actions.includes("musicUrl")) continue
            registerUserApi(source, {
              getMusicUrl: (songInfo: unknown, quality: string) =>
                askScript(source, "musicUrl", { musicInfo: songInfo, type: quality }).then((url) => ({
                  url: url as string,
                })),
            })
          }
          resolve({ info, sources: msg.sources })
          break
        }
        case "req-res": {
          const p = reqPending.get(msg.id)
          reqPending.delete(msg.id)
          if (!p) break
          if (msg.err) p.reject(new Error(msg.err))
          else p.resolve(msg.result)
          break
        }
        case "alert":
          console.info(`[音源] ${info.name} 提示：${msg.log}`, msg.updateUrl ?? "")
          break
        case "error":
          dbg("note", { scriptError: msg.message })
          clearTimeout(timer)
          stop()
          reject(new Error(`音源脚本报错：${msg.message}`))
          break
      }
    }

    send({ t: "boot", script, info })
  })
}

/** 向脚本要一个结果（目前只有 musicUrl）。 */
function askScript(source: string, action: string, info: unknown): Promise<unknown> {
  const w = worker
  if (!w) return Promise.reject(new Error("尚未载入音源"))
  const id = ++reqSeq
  return new Promise((resolve, reject) => {
    reqPending.set(id, { resolve, reject })
    // 脚本卡住时不能让调用方一直挂着
    setTimeout(() => {
      if (reqPending.delete(id)) reject(new Error("音源响应超时"))
    }, 15000)
    w.postMessage({ t: "req", id, source, action, info } satisfies ToWorker)
  })
}

export const unloadUserApi = stop
