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
