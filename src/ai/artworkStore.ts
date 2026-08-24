/**
 * AI 配图的图库账本。
 *
 * 功能模型（v3，与用户确认过）：
 *
 *   基础底图  只有一个槽 —— 内置图 / 手选的图 / 自定义提示词生成的 AI 图。
 *             它是持久的，存在 skin.backdrop 里。
 *   专属图    为某首歌手动生成的图，**只在那首歌播放时临时盖上去**，切走就回到基础。
 *             同一首歌可以生成多张，默认用最新的；用户也可以在图库里指定用回旧的。
 *
 * 所以这里存的是"一堆图 + 两个指针"：图本身是平的一张表，谁当基础、每首歌用哪张，
 * 都是指向表里某个 id 的引用。这样同一张图既能当基础底图又能是某首歌的专属图，
 * 不必存两份。
 *
 * 纯函数，不碰磁盘也不碰 store：淘汰与"这首歌该用哪张"是仅有的两段容易写错又
 * 看不出来的逻辑（错了的表现是"图莫名其妙没了"或"回到这首歌换了张图"），必须能单测。
 */

/** 一张图是怎么来的 */
export type ArtworkOrigin =
  | { kind: "song"; trackId: string; title: string; artist: string }
  | { kind: "custom" }

export type AiArtwork = {
  /** 稳定主键。不用 trackId —— 同一首歌可以有多张 */
  id: string
  /** 图片的绝对路径，可直接当底图用 */
  path: string
  /** 小尺寸 JPEG data URL。图库列表只渲染它，不解码原图 */
  thumbnail: string
  /** 文件字节数。0 表示未知（旧版本迁移来的条目没记过大小） */
  bytes: number
  createdAt: number
  /** 最后一次被当作底图用上的时间。淘汰按这个排，不是按生成时间 */
  usedAt: number
  origin: ArtworkOrigin
  /** 真正送给生图模型的完整提示词。旧版本迁移来的没有，为空串 */
  prompt: string
  /** 文本模型给出的画面描述；自定义提示词直接生成时为 null */
  scene: string | null
}

export type ArtworkFile = {
  version: 3
  items: AiArtwork[]
  /** 每首歌指定用哪张（不指定就用最新的一张） */
  pinned: Record<string, string>
  /** 磁盘预算（字节）。超出就从最久没用到的开始淘汰 */
  budgetBytes: number
}

/** 默认给 AI 配图 500MB。按 2–3MB 一张算，够放两百来张 */
export const DEFAULT_ARTWORK_BUDGET = 500 * 1024 * 1024
export const MIN_ARTWORK_BUDGET = 100 * 1024 * 1024
export const MAX_ARTWORK_BUDGET = 8 * 1024 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validOrigin(v: unknown): v is ArtworkOrigin {
  if (!isRecord(v)) return false
  if (v.kind === "custom") return true
  return (
    v.kind === "song" &&
    typeof v.trackId === "string" &&
    v.trackId.length > 0 &&
    typeof v.title === "string" &&
    typeof v.artist === "string"
  )
}

function validItem(item: unknown): item is AiArtwork {
  return (
    isRecord(item) &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.path === "string" &&
    item.path.length > 0 &&
    typeof item.thumbnail === "string" &&
    typeof item.bytes === "number" &&
    Number.isFinite(item.bytes) &&
    item.bytes >= 0 &&
    typeof item.createdAt === "number" &&
    Number.isFinite(item.createdAt) &&
    typeof item.usedAt === "number" &&
    Number.isFinite(item.usedAt) &&
    typeof item.prompt === "string" &&
    (item.scene === null || typeof item.scene === "string") &&
    validOrigin(item.origin)
  )
}

/**
 * 磁盘上的那份 → 内存里的账本。坏条目直接丢掉，不能让它把 AI 面板整个带崩。
 *
 * 同时负责历史格式迁移：
 *   v1  `artwork: { trackId: 路径 }`
 *   v2  `items: [{ trackId, path, bytes, usedAt }]`
 * 两者都没有 id、缩略图、提示词与来源信息。缩略图留空（首次打开图库时按原图现补），
 * 提示词是真找不回来了。使用时间按迁移那一刻记 —— 记成 0 的话，老用户升级后
 * 第一次超预算就会被整批清空。
 */
export function readArtworkIndex(raw: unknown, now: number): AiArtwork[] {
  if (!isRecord(raw)) return []

  let list: AiArtwork[]
  if (Array.isArray(raw.items) && raw.version === 3) {
    list = raw.items.filter(validItem)
  } else if (Array.isArray(raw.items)) {
    list = raw.items.filter(isRecord).flatMap((old) => migrateLegacy(old, now))
  } else if (isRecord(raw.artwork)) {
    list = Object.entries(raw.artwork).flatMap(([trackId, path]) =>
      typeof path === "string" && path
        ? migrateLegacy({ trackId, path, bytes: 0, usedAt: now }, now)
        : [],
    )
  } else {
    list = []
  }

  // 同一个 id 只留一条：重复项会让预算重复计数，淘汰时又只删得掉一个
  const seen = new Set<string>()
  return list.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** v1/v2 的一条 → v3。缺的信息补成空值，不编造 */
function migrateLegacy(old: Record<string, unknown>, now: number): AiArtwork[] {
  const trackId = typeof old.trackId === "string" ? old.trackId : ""
  const path = typeof old.path === "string" ? old.path : ""
  if (!trackId || !path) return []
  return [
    {
      // 旧数据一首歌只有一张，拿 trackId 当 id 既稳定又不会撞
      id: `legacy:${trackId}`,
      path,
      thumbnail: "",
      bytes: typeof old.bytes === "number" && old.bytes >= 0 ? old.bytes : 0,
      createdAt: typeof old.usedAt === "number" ? old.usedAt : now,
      usedAt: typeof old.usedAt === "number" ? old.usedAt : now,
      origin: { kind: "song", trackId, title: "", artist: "" },
      prompt: "",
      scene: null,
    },
  ]
}

/** 读"每首歌指定用哪张"。只保留确实指向现存图片的那些 */
export function readPinned(raw: unknown, items: readonly AiArtwork[]): Record<string, string> {
  if (!isRecord(raw) || !isRecord(raw.pinned)) return {}
  const ids = new Set(items.map((i) => i.id))
  const out: Record<string, string> = {}
  for (const [trackId, artworkId] of Object.entries(raw.pinned)) {
    if (typeof artworkId === "string" && ids.has(artworkId)) out[trackId] = artworkId
  }
  return out
}

export function readBudget(raw: unknown): number {
  if (!isRecord(raw) || typeof raw.budgetBytes !== "number" || !Number.isFinite(raw.budgetBytes)) {
    return DEFAULT_ARTWORK_BUDGET
  }
  return clampBudget(raw.budgetBytes)
}

export function clampBudget(bytes: number): number {
  return Math.max(MIN_ARTWORK_BUDGET, Math.min(MAX_ARTWORK_BUDGET, Math.round(bytes)))
}

export function findById(items: readonly AiArtwork[], id: string | null): AiArtwork | null {
  if (!id) return null
  return items.find((item) => item.id === id) ?? null
}

/**
 * 这首歌该用哪张图。
 *
 * 用户在图库里指定过就用指定的；否则用**最新生成**的那张。没有就返回 null，
 * 调用方回到基础底图。
 */
export function artworkForTrack(
  items: readonly AiArtwork[],
  pinned: Readonly<Record<string, string>>,
  trackId: string,
): AiArtwork | null {
  const chosen = findById(items, pinned[trackId] ?? null)
  if (chosen) return chosen

  let latest: AiArtwork | null = null
  for (const item of items) {
    if (item.origin.kind !== "song" || item.origin.trackId !== trackId) continue
    if (!latest || item.createdAt > latest.createdAt) latest = item
  }
  return latest
}

/** 某首歌名下的全部图，最新的排前面 */
export function artworksOfTrack(items: readonly AiArtwork[], trackId: string): AiArtwork[] {
  return items
    .filter((i) => i.origin.kind === "song" && i.origin.trackId === trackId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function totalBytes(items: readonly AiArtwork[]): number {
  return items.reduce((sum, item) => sum + item.bytes, 0)
}

/** 新生成一张。同一首歌的旧图**不删** —— 用户要能翻回去 */
export function addArtwork(items: readonly AiArtwork[], next: AiArtwork): AiArtwork[] {
  return [next, ...items.filter((item) => item.id !== next.id)]
}

/** 用上了某张 —— 刷新使用时间，免得常听的那几首被淘汰掉 */
export function touchArtwork(items: readonly AiArtwork[], id: string, now: number): AiArtwork[] {
  return items.map((item) => (item.id === id ? { ...item, usedAt: now } : item))
}

/** 补上迁移过来的条目缺失的缩略图 */
export function attachThumbnail(
  items: readonly AiArtwork[],
  id: string,
  thumbnail: string,
): AiArtwork[] {
  return items.map((item) => (item.id === id ? { ...item, thumbnail } : item))
}

export function removeById(items: readonly AiArtwork[], id: string): AiArtwork[] {
  return items.filter((item) => item.id !== id)
}

/** 删图之后，指向它的那些"指定"也要一起清掉，否则会指向不存在的图 */
export function prunePinned(
  pinned: Readonly<Record<string, string>>,
  items: readonly AiArtwork[],
): Record<string, string> {
  const ids = new Set(items.map((i) => i.id))
  return Object.fromEntries(Object.entries(pinned).filter(([, id]) => ids.has(id)))
}

/**
 * 算出该删哪些。
 *
 * **两类图永远保住**：最近用过的那张（多半正挂在画面上，删了画面当场变空白），
 * 以及当前的基础底图（它是用户明确选定的，不该被后台清理顺手删掉）。
 *
 * 大小未知（bytes 为 0，从旧版本迁移来）的条目不占预算，所以只要还没重新生成过，
 * 它们既不会触发淘汰、也不会被算进"已用"。
 */
export function planEviction(
  items: readonly AiArtwork[],
  budgetBytes: number,
  keepIds: readonly string[] = [],
): { keep: AiArtwork[]; evict: AiArtwork[] } {
  if (totalBytes(items) <= budgetBytes) return { keep: [...items], evict: [] }

  const byAge = [...items].sort((a, b) => a.usedAt - b.usedAt)
  const protectedIds = new Set<string>(keepIds)
  const newest = byAge.at(-1)
  if (newest) protectedIds.add(newest.id)

  const evict: AiArtwork[] = []
  let used = totalBytes(items)
  for (const item of byAge) {
    if (used <= budgetBytes) break
    if (protectedIds.has(item.id)) continue
    evict.push(item)
    used -= item.bytes
  }

  const doomed = new Set(evict.map((i) => i.id))
  return { keep: items.filter((item) => !doomed.has(item.id)), evict }
}

/**
 * 盘上有、账本里没有的文件。
 *
 * 会出现是因为落盘与写账本不是一个原子操作：图片先写出去，账本走的是防抖，
 * 中间崩一次就留下一个谁也不认识的文件。不扫的话"已用 320MB"是句假话。
 */
export function planOrphanSweep(
  items: readonly AiArtwork[],
  onDisk: readonly { id: string }[],
): string[] {
  const known = new Set(items.map((item) => item.path))
  return onDisk.map((f) => f.id).filter((path) => !known.has(path))
}

/** 曲库里已经没有的曲目，它们的专属图也该跟着走（自定义提示词生成的不受影响） */
export function planLibrarySweep(
  items: readonly AiArtwork[],
  liveTrackIds: ReadonlySet<string>,
): AiArtwork[] {
  return items.filter((i) => i.origin.kind === "song" && !liveTrackIds.has(i.origin.trackId))
}

export function artworkFile(
  items: readonly AiArtwork[],
  pinned: Readonly<Record<string, string>>,
  budgetBytes: number,
): ArtworkFile {
  return {
    version: 3,
    items: [...items],
    pinned: prunePinned(pinned, items),
    budgetBytes: clampBudget(budgetBytes),
  }
}

/** "320 MB" 这种给人看的写法 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
