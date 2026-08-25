import { describe, expect, it } from "vitest"

import { planEviction, type EvictEntry } from "@/skin/evict"

/** 缓存的真实排列：最旧在前（Map 的插入顺序）。 */
const img = (id: string): EvictEntry => ({ id, kind: "image" })
const vid = (id: string): EvictEntry => ({ id, kind: "video" })

const LIMITS = { total: 6, video: 1 }

describe("planEviction", () => {
  it("没超限时一条都不撤", () => {
    const entries = [img("a"), img("b"), vid("c")]
    expect(planEviction(entries, [], LIMITS)).toEqual([])
  })

  it("超总量时从最旧的开始撤", () => {
    const entries = ["a", "b", "c", "d", "e", "f", "g"].map(img)
    expect(planEviction(entries, [], LIMITS)).toEqual(["a"])
  })

  it("钉住的不撤，哪怕它最旧", () => {
    const entries = ["a", "b", "c", "d", "e", "f", "g"].map(img)
    // a 正在显示，撤了画面当场变白，只能顺延到 b
    expect(planEviction(entries, ["a"], LIMITS)).toEqual(["b"])
  })

  it("视频只留 1 份，即使总量远没到上限", () => {
    // 这是这个模块存在的理由：三段 80MB 的壁纸挂着就是两百多兆，
    // 而总量那条线（6）看它们只占 3 个格子，根本不会触发
    const entries = [vid("v1"), vid("v2"), vid("v3")]
    expect(planEviction(entries, [], LIMITS)).toEqual(["v1", "v2"])
  })

  it("留下的是最新那一份视频", () => {
    const entries = [vid("v1"), img("a"), vid("v2")]
    const doomed = planEviction(entries, [], LIMITS)
    expect(doomed).toContain("v1")
    expect(doomed).not.toContain("v2")
    expect(doomed).not.toContain("a")
  })

  it("转场那 700ms 里两段视频都钉着，一段都不撤", () => {
    // 旧的在淡出、新的在淡入，两份必须同时在场，否则交叉淡入会闪
    const entries = [vid("old"), vid("new")]
    expect(planEviction(entries, ["old", "new"], LIMITS)).toEqual([])
  })

  it("视频那一轮跑在总量之前 —— 否则视频上限形同虚设", () => {
    /*
     * 六个格子全被视频占满。要是先按总量收，只会撤掉最旧的一个（凑够 6），
     * 剩下五段视频原样挂着，视频那条上限一点没生效。
     */
    const entries = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"].map(vid)
    const doomed = planEviction(entries, [], LIMITS)
    expect(doomed).toEqual(["v1", "v2", "v3", "v4", "v5", "v6"])
  })

  it("刚读好的那份必须一起钉住，否则预读会被自己撤掉", () => {
    /*
     * 视频换视频：setBackdrop 会先预读一次确认目标能打开，而那一刻 pinnedIds 还是
     * 上一轮的（只有旧视频）。第一条断言就是没钉时的下场 —— 刚读好的 new 当场被判死，
     * refreshImages 只好把整套 probeVideo（metadata + seek + 全分辨率 toDataURL）重跑一遍。
     * 所以 evictMedia 要接 justLoaded 一并钉住。
     */
    const entries = [vid("old"), vid("new")]
    expect(planEviction(entries, ["old"], LIMITS)).toEqual(["new"])
    expect(planEviction(entries, ["old", "new"], LIMITS)).toEqual([])
  })

  it("图片不受视频那条上限影响", () => {
    const entries = [img("a"), img("b"), img("c"), vid("v")]
    expect(planEviction(entries, [], LIMITS)).toEqual([])
  })
})
