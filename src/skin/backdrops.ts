import aUrl from "@/assets/backdrops/a.jpg"
import bUrl from "@/assets/backdrops/b.jpg"
import cUrl from "@/assets/backdrops/c.jpg"
import dUrl from "@/assets/backdrops/d.jpg"

/**
 * 随应用一起发布的底图。
 *
 * 为什么要内置：`skin.backdrop` 存的是用户磁盘上的文件路径，装完不选图就只有一层
 * CSS 渐变（`.backdrop-builtin`）。整个界面的配色都是从底图现算的 —— 蒙版、墨色、
 * 贴纸取色 —— 没有底图等于这套东西全看不出来。内置几张，装上就是完整效果。
 *
 * 用 `builtin:` 前缀和用户文件区分开：`loadMedia` 见到这个前缀直接用打包后的
 * 资源 URL，不去走 `platform.readFile`（那条路只读用户文件，也读不到应用资源）。
 */
export const BUILTIN_PREFIX = "builtin:"

export type BuiltinBackdrop = {
  id: string
  name: string
  url: string
}

export const BUILTIN_BACKDROPS: readonly BuiltinBackdrop[] = [
  { id: `${BUILTIN_PREFIX}a`, name: "内置 1", url: aUrl },
  { id: `${BUILTIN_PREFIX}b`, name: "内置 2", url: bUrl },
  { id: `${BUILTIN_PREFIX}c`, name: "内置 3", url: cUrl },
  { id: `${BUILTIN_PREFIX}d`, name: "内置 4", url: dUrl },
]

/** 是内置底图就返回它的资源 URL，否则 null（调用方按用户文件处理）。 */
export function builtinBackdropUrl(id: string): string | null {
  if (!id.startsWith(BUILTIN_PREFIX)) return null
  return BUILTIN_BACKDROPS.find((b) => b.id === id)?.url ?? null
}
