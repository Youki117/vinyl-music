import { describe, expect, it } from "vitest"

import { cleanTitle } from "@/lib/text"

/**
 * 歌名清洗。三个调用点（在线 normalize、本地 buildMeta、曲库 load）都只是把结果
 * 套一层，真正会出错的全在这个函数里，所以测试也集中在这儿。
 *
 * 最要紧的是**别误伤**：歌名里的圆括号和方括号带着版本信息，洗掉就分不清
 * 原唱与伴奏、国语与粤语了。
 */
describe("cleanTitle", () => {
  it("【】降级成连字符", () => {
    expect(cleanTitle("【Free】Lucky")).toBe("Free-Lucky")
  })

  it("括号夹在中间时两边都接上", () => {
    expect(cleanTitle("走马【伴奏】完整版")).toBe("走马-伴奏-完整版")
  })

  it("括号后面带空格，不会留下多余空白", () => {
    expect(cleanTitle("【高音质】 晴天")).toBe("高音质-晴天")
  })

  it("整个歌名就是一对括号时，只留里面的内容", () => {
    expect(cleanTitle("【纯音乐】")).toBe("纯音乐")
  })

  it("多组括号逐个降级", () => {
    expect(cleanTitle("【Free】【Type Beat】Lucky")).toBe("Free-Type Beat-Lucky")
  })

  it("只有半边括号也认", () => {
    expect(cleanTitle("【Free Lucky")).toBe("Free Lucky")
  })

  /*
   * 下面这组是这个函数存在的边界。圆括号、方括号、书名号在歌名里都是**有信息的**，
   * 一起洗掉的话「晴天」「晴天 (Live)」「晴天 (伴奏版)」就成了同一个名字 ——
   * 而 findSameTrack 换源时正是按歌名找同一首，名字糊在一起会换错歌。
   */
  it("不动其它括号：版本信息全靠它们区分", () => {
    for (const t of [
      "晴天 (Live)",
      "夜曲 (伴奏版)",
      "海阔天空 (粤语)",
      "告白气球 [Explicit]",
      "夜的第七章（三部曲）",
      "《不能说的秘密》主题曲",
    ]) {
      expect(cleanTitle(t)).toBe(t)
    }
  })

  it("普通歌名原样返回", () => {
    expect(cleanTitle("晴天")).toBe("晴天")
    expect(cleanTitle("")).toBe("")
  })

  it("洗完什么都不剩时保留原文 —— 空标题比难看的标题糟得多", () => {
    expect(cleanTitle("【】")).toBe("【】")
    expect(cleanTitle("【 】")).toBe("【 】")
  })
})
