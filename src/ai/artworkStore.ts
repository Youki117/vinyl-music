/**
 * AI 配图的落盘账本。
 *
 * 为什么需要一层账本而不是"生成了就存着"：开着自动配图放完一个千首的库，就是
 * 一千张 1792×1024 的 PNG（每张 2–3MB）静静躺在 AppData 里 —— 用户看不到、
 * 删不掉、也不知道它占了几个 G。所以这里要能回答三个问题：一共占了多少、
 * 该淘汰谁、盘上有没有账本不认识的孤儿文件。
 *
 * 纯函数，不碰磁盘也不碰 store：淘汰策略是唯一容易写错又看不出来的一段
 * （错了的表现是"图莫名其妙没了"或者"占用一直涨"），必须能单测。
 */

export type AiArtwork = {
  trackId: string
  /** 图片的绝对路径，可直接当底图用 */
  path: string
  /** 文件字节数。0 表示未知 —— 旧版本迁移过来的条目没记过大小 */
  bytes: number
  /** 最后一次被套用为底图的时间。淘汰按这个排，不是按生成时间 */
  usedAt: number
}

export type ArtworkFile = {
  version: 2
  items: AiArtwork[]
  /** 磁盘预算（字节）。超出就从最久没用到的开始淘汰 */
  budgetBytes: number
}

/** 默认给 AI 配图 500MB。按 2–3MB 一张算，够放两百来首常听的歌 */
export const DEFAULT_ARTWORK_BUDGET = 500 * 1024 * 1024

/** 预算的可选范围。给到 0 等于"每首都只留当前这张"，太反直觉，所以下限给 100MB */
export const MIN_ARTWORK_BUDGET = 100 * 1024 * 1024
export const MAX_ARTWORK_BUDGET = 8 * 1024 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validItem(item: unknown): item is AiArtwork {
  return (
    isRecord(item) &&
    typeof item.trackId === "string" &&
    item.trackId.length > 0 &&
    typeof item.path === "string" &&
    item.path.length > 0 &&
    typeof item.bytes === "number" &&
    Number.isFinite(item.bytes) &&
    item.bytes >= 0 &&
    typeof item.usedAt === "number" &&
    Number.isFinite(item.usedAt)
  )
}

/**
 * 磁盘上的那份 → 内存里的账本。坏条目直接丢掉，不能让它把 AI 面板整个带崩。
 *
 * 同时负责 v1 → v2 迁移：v1 存的是 `trackId → 路径` 的映射，没有大小也没有
 * 使用时间。大小按 0 记（未知的不计入预算，等这首歌重新生成时自然会补上真值），
 * 使用时间按迁移那一刻记 —— 否则老用户升级完第一次超预算就会被整批清空。
 */
export function readArtworkIndex(raw: unknown, now: number): AiArtwork[] {
  if (!isRecord(raw)) return []

  const list: AiArtwork[] = Array.isArray(raw.items)
    ? raw.items.filter(validItem)
    : isRecord(raw.artwork)
      ? Object.entries(raw.artwork)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
          .map(([trackId, path]) => ({ trackId, path, bytes: 0, usedAt: now }))
      : []

  // 同一首歌只留一条：重复项会让预算重复计数，淘汰时又只删得掉一个
  const seen = new Set<string>()
  return list.filter((item) => {
    if (seen.has(item.trackId)) return false
    seen.add(item.trackId)
    return true
  })
}

/** 读预算。缺失或超出合理范围时回到默认值，不信磁盘上的数 */
export function readBudget(raw: unknown): number {
  if (!isRecord(raw) || typeof raw.budgetBytes !== "number" || !Number.isFinite(raw.budgetBytes)) {
    return DEFAULT_ARTWORK_BUDGET
  }
  return clampBudget(raw.budgetBytes)
}

export function clampBudget(bytes: number): number {
  return Math.max(MIN_ARTWORK_BUDGET, Math.min(MAX_ARTWORK_BUDGET, Math.round(bytes)))
}

export function findArtwork(items: readonly AiArtwork[], trackId: string): AiArtwork | null {
  return items.find((item) => item.trackId === trackId) ?? null
}

export function totalBytes(items: readonly AiArtwork[]): number {
  return items.reduce((sum, item) => sum + item.bytes, 0)
}

/** 新生成（或重新生成）一张。同一首歌覆盖旧条目，不新增 */
export function rememberArtwork(items: readonly AiArtwork[], next: AiArtwork): AiArtwork[] {
  return [next, ...items.filter((item) => item.trackId !== next.trackId)]
}

/** 套用了某张图 —— 刷新它的使用时间，免得常听的那几首被淘汰掉 */
export function touchArtwork(items: readonly AiArtwork[], trackId: string, now: number): AiArtwork[] {
  return items.map((item) => (item.trackId === trackId ? { ...item, usedAt: now } : item))
}

export function forgetArtwork(items: readonly AiArtwork[], trackId: string): AiArtwork[] {
  return items.filter((item) => item.trackId !== trackId)
}

/**
 * 算出该删哪些。**最近用过的那张永远保住** —— 它多半正挂在画面上，
 * 预算再小也不能把用户眼前的底图删掉变成空白。
 *
 * 大小未知（bytes 为 0，从 v1 迁移来的）的条目不占预算，所以只要还没重新生成过，
 * 它们就既不会触发淘汰、也不会被算进"已用"。等真去重新生成时才补上真值。
 */
export function planEviction(
  items: readonly AiArtwork[],
  budgetBytes: number,
): { keep: AiArtwork[]; evict: AiArtwork[] } {
  if (totalBytes(items) <= budgetBytes) return { keep: [...items], evict: [] }

  // 最久没用到的排前面，从这头开始淘汰
  const byAge = [...items].sort((a, b) => a.usedAt - b.usedAt)
  const newest = byAge.at(-1)

  const evict: AiArtwork[] = []
  let used = totalBytes(items)
  for (const item of byAge) {
    if (used <= budgetBytes) break
    if (item === newest) break
    evict.push(item)
    used -= item.bytes
  }

  const doomed = new Set(evict)
  return { keep: items.filter((item) => !doomed.has(item)), evict }
}

/**
 * 盘上有、账本里没有的文件。
 *
 * 会出现是因为落盘与写账本不是一个原子操作：图片先写出去，账本走的是 800ms
 * 防抖，中间崩一次就留下一个谁也不认识的文件。不扫的话"已用 320MB"是句假话。
 */
export function planOrphanSweep(
  items: readonly AiArtwork[],
  onDisk: readonly { id: string }[],
): string[] {
  const known = new Set(items.map((item) => item.path))
  return onDisk.map((f) => f.id).filter((path) => !known.has(path))
}

/** 曲库里已经没有的曲目，它们的配图也该跟着走 */
export function planLibrarySweep(
  items: readonly AiArtwork[],
  liveTrackIds: ReadonlySet<string>,
): AiArtwork[] {
  return items.filter((item) => !liveTrackIds.has(item.trackId))
}

export function artworkFile(items: readonly AiArtwork[], budgetBytes: number): ArtworkFile {
  return { version: 2, items: [...items], budgetBytes: clampBudget(budgetBytes) }
}

/** "320 MB" 这种给人看的写法 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
