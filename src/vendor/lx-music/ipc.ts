/**
 * 上游只有 musicSdk/tx/lyric.js 用到 Electron IPC，用途是把歌词请求转给主进程绕过跨域。
 * **垫片，不是上游代码。**
 *
 * 我们的请求本来就走 Rust 侧（见 request.ts），不存在跨域问题，所以不需要"转发"这一层，
 * 就地用 httpFetch 完成即可。
 */
import { httpFetch, type LxOptions } from "./request"

export const WIN_MAIN_RENDERER_EVENT_NAME = {
  request: "request",
} as const

export async function rendererInvoke(
  name: string,
  params: { url: string; options?: LxOptions },
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
  if (name !== WIN_MAIN_RENDERER_EVENT_NAME.request) {
    throw new Error(`rendererInvoke 垫片未实现该事件: ${name}`)
  }
  const resp = await httpFetch(params.url, params.options ?? { method: "get" }).promise
  return { statusCode: resp.statusCode, headers: resp.headers, body: resp.body }
}
