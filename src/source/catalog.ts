/**
 * 平台清单。**单独成模块是为了它没有依赖** —— `src/source/index.ts` 一被 import
 * 就会拉起整个 vendored musicSdk（几百 KB，还带一串 node polyfill），
 * 而界面只是想画五个平台的名字。
 *
 * 曲库那边的 `OnlineSourceId` 是同一批 id 的独立声明（见 store/library.ts 的说明），
 * 两边对不上会在编译期就炸，不会拖到运行时。
 */
export type SourceId = "kw" | "kg" | "tx" | "wy" | "mg"

export const SOURCES: { id: SourceId; name: string }[] = [
  { id: "kw", name: "酷我" },
  { id: "kg", name: "酷狗" },
  { id: "tx", name: "QQ" },
  { id: "wy", name: "网易云" },
  { id: "mg", name: "咪咕" },
]

/**
 * 各平台的域名。短链也在其中：网易云的 163cn.tv、QQ 的 c6.y.qq.com、
 * 酷狗的 t1.kugou.com —— 分享出来的十有八九就是短链，认不出短链等于认不出。
 */
const LINK_DOMAINS: { re: RegExp; id: SourceId }[] = [
  { re: /(?:^|[./@])(?:163\.com|163cn\.tv)(?:$|[/:?#])/, id: "wy" },
  { re: /(?:^|[./@])qq\.com(?:$|[/:?#])/, id: "tx" },
  { re: /(?:^|[./@])kuwo\.cn(?:$|[/:?#])/, id: "kw" },
  { re: /(?:^|[./@])kugou\.com(?:$|[/:?#])/, id: "kg" },
  { re: /(?:^|[./@])migu\.(?:cn|com)(?:$|[/:?#])/, id: "mg" },
]

/**
 * 分享链接 → 平台。认不出返回 null。
 *
 * 用户手上的东西是**一条从 app 里复制出来的分享链接**，不是"平台 + 歌单 id"。
 * 让他先在五个平台里点对一个，是把我们自己能做的判断推给了他。
 *
 * 只按域名判，不去解析 id：各平台的 id 藏在哪个参数里由 musicSdk 的正则负责
 * （songList.getListDetail 直接吃链接），在这层重复一遍只会多一处要跟着上游改的地方。
 *
 * 分享文案里常常前后还有一堆字（"分享XXX的歌单《晨跑》: https://…"），所以是在
 * 整段文本里找域名，而不是要求整个字符串就是一条 URL。
 */
export function sourceOfLink(text: string): SourceId | null {
  const s = text.trim().toLowerCase()
  if (!s) return null
  return LINK_DOMAINS.find((d) => d.re.test(s))?.id ?? null
}
