export type CustomBackdrop = {
  id: string
  name: string
  /** 小尺寸 JPEG data URL；历史列表不重新解码每张原始大图。 */
  thumbnail: string
}

export type BackdropHistoryFile = {
  version: 1
  items: CustomBackdrop[]
}

export const BACKDROP_HISTORY_LIMIT = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** 配置来自磁盘，坏条目应被忽略，不能让皮肤初始化一起失败。 */
export function readBackdropHistory(raw: unknown): CustomBackdrop[] {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.items)) return []
  const seen = new Set<string>()
  return raw.items
    .filter(
      (item): item is CustomBackdrop =>
        isRecord(item) &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.name === "string" &&
        item.name.length > 0 &&
        typeof item.thumbnail === "string" &&
        item.thumbnail.startsWith("data:image/"),
    )
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .slice(0, BACKDROP_HISTORY_LIMIT)
}

/** 同一路径只保留最新缩略图，并把最近选择的图放在最前。 */
export function rememberBackdrop(
  items: readonly CustomBackdrop[],
  next: CustomBackdrop,
): CustomBackdrop[] {
  return [next, ...items.filter((item) => item.id !== next.id)].slice(0, BACKDROP_HISTORY_LIMIT)
}

export function backdropHistoryFile(items: readonly CustomBackdrop[]): BackdropHistoryFile {
  return { version: 1, items: items.slice(0, BACKDROP_HISTORY_LIMIT) }
}
