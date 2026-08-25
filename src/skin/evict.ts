/** 缓存里一条记录中与淘汰有关的部分。 */
export type EvictEntry = { id: string; kind: "image" | "video" }

/** 两条上限。视频那条比总量那条严得多，理由见 planEviction。 */
export type EvictLimits = { total: number; video: number }

/**
 * 决定底图缓存该撤掉哪几条。
 *
 * `entries` 按**最旧在前**排列（Map 的插入顺序天然如此），`pinned` 里的一律不动
 * ——正在显示的那两张被撤掉，画面会当场变白。
 *
 * ## 为什么视频要单独一条上限
 *
 * 总量上限（6）是按图片定的：一张 2MB 的 jpg 留 6 张才 12MB，为"切回上一张"留着
 * 很划算。视频不是一个量级 —— 底图走的是"整个文件读进内存"，一段 80MB 的壁纸就
 * 实打实占 80MB，在皮肤面板里试过 A、B、C 三段之后，A 和 B 的完整字节还挂着，
 * 白占两百多兆。而"切回上一段视频"本来就是低频动作，换不回这个代价。
 *
 * ## 两轮的顺序不能反
 *
 * 先收视频再收总量。反过来的话，六个格子可能已经被视频占满，总量那一轮只按新旧
 * 淘汰、不看类型，收完仍旧是一堆视频，等于视频那条上限没生效。
 */
export function planEviction(
  entries: readonly EvictEntry[],
  pinned: readonly string[],
  limits: EvictLimits,
): string[] {
  const doomed = new Set<string>()

  const pass = (match: (e: EvictEntry) => boolean, max: number): void => {
    let alive = entries.filter((e) => match(e) && !doomed.has(e.id)).length
    for (const e of entries) {
      if (alive <= max) return
      if (doomed.has(e.id) || pinned.includes(e.id) || !match(e)) continue
      doomed.add(e.id)
      alive--
    }
  }

  pass((e) => e.kind === "video", limits.video)
  pass(() => true, limits.total)

  return [...doomed]
}
