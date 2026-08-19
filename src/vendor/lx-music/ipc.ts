/**
 * 上游 musicSdk 里少数几处要把活儿交给 Electron 主进程做，走的是 IPC。**垫片，不是上游代码。**
 *
 * 三种事件，性质完全不同：
 *
 *   request                  转发 HTTP，为的是绕开渲染进程的跨域。我们的请求本来就从 Rust 侧发，
 *                            就地用 httpFetch 完成即可。
 *   handle_kw_decode_lyric   酷我歌词的解码。纯算法，照上游搬过来（见下）。
 *   handle_tx_decode_lyric   QQ 歌词的解码。**上游用的是不公开算法的 C++ 原生插件，搬不了。**
 *                            这里明确抛错，由 src/source 换到别的平台取歌词。
 */
import { httpFetch, type LxOptions } from "./request"
// @ts-expect-error browserify-zlib 没有类型声明，是个 CJS 老包
import { inflate } from "zlib"
import { Buffer } from "buffer"

export const WIN_MAIN_RENDERER_EVENT_NAME = {
  request: "request",
  handle_kw_decode_lyric: "handle_kw_decode_lyric",
  handle_tx_decode_lyric: "handle_tx_decode_lyric",
} as const

/** QQ 歌词解不了的时候抛这个，调用方据此决定换源，而不是把它当成一般故障 */
export class LyricDecoderUnavailable extends Error {
  constructor(source: string) {
    super(`${source} 的歌词要用上游不公开的原生解码器，本应用无法解出`)
    this.name = "LyricDecoderUnavailable"
  }
}

const inflateAsync = (data: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    inflate(data, (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out)))
  })

/*
 * 酷我歌词的解码，照抄上游 src/main/modules/winMain/rendererEvent/kw_decodeLyric.ts。
 *
 * 报文长这样：`tp=content\r\n...\r\n\r\n<deflate 数据>`。解压出来若是逐字歌词（lrcx），
 * 内容还要再 base64 解一层、按 'yeelion' 循环异或。**最后一律按 gb18030 解码** ——
 * 酷我给的不是 UTF-8，按 UTF-8 读中文全是乱码。
 */
const KW_KEY = Buffer.from("yeelion")

async function decodeKwLyric(raw: Buffer, isGetLyricx: boolean): Promise<string> {
  if (raw.toString("utf8", 0, 10) !== "tp=content") return ""
  const body = await inflateAsync(raw.subarray(raw.indexOf("\r\n\r\n") + 4))
  const gb18030 = new TextDecoder("gb18030")
  if (!isGetLyricx) return gb18030.decode(body)

  const str = Buffer.from(body.toString(), "base64")
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; ) {
    for (let j = 0; j < KW_KEY.length && i < str.length; j++, i++) out[i] = str[i]! ^ KW_KEY[j]!
  }
  return gb18030.decode(out)
}

export async function rendererInvoke(name: string, params: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case WIN_MAIN_RENDERER_EVENT_NAME.request: {
      const { url, options } = params as { url: string; options?: LxOptions }
      const resp = await httpFetch(url, options ?? { method: "get" }).promise
      return { statusCode: resp.statusCode, headers: resp.headers, body: resp.body }
    }
    case WIN_MAIN_RENDERER_EVENT_NAME.handle_kw_decode_lyric: {
      const { lrcBase64, isGetLyricx } = params as { lrcBase64: string; isGetLyricx: boolean }
      // 上游的契约是「进 base64、出 base64」，调用方会再解一次，照办
      const lrc = await decodeKwLyric(Buffer.from(lrcBase64, "base64"), isGetLyricx)
      return Buffer.from(lrc).toString("base64")
    }
    case WIN_MAIN_RENDERER_EVENT_NAME.handle_tx_decode_lyric:
      throw new LyricDecoderUnavailable("QQ 音乐")
    default:
      throw new Error(`rendererInvoke 垫片未实现该事件: ${name}`)
  }
}
