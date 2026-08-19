import { describe, expect, it } from "vitest"
import { lxLyricToEnhancedLrc } from "@/source/lyric"

/**
 * 洛雪的逐字歌词用「相对行首的毫秒偏移 + 时长」，增强型 LRC 用绝对时间戳。
 * 转错了不会报错，只会让逐字擦除的进度对不上，所以这里逐条钉死。
 */
describe("lxLyricToEnhancedLrc", () => {
  it("把相对偏移换算成绝对时间戳", () => {
    const out = lxLyricToEnhancedLrc("[00:31.810]<0,270>有<270,270>些<540,990>人")
    expect(out).toBe("[00:31.810]<00:31.810>有<00:32.080>些<00:32.350>人")
  })

  it("跨分钟进位", () => {
    const out = lxLyricToEnhancedLrc("[00:59.500]<0,300>啊<600,300>哦")
    expect(out).toBe("[00:59.500]<00:59.500>啊<01:00.100>哦")
  })

  it("行首时间没有毫秒时按 0 算", () => {
    expect(lxLyricToEnhancedLrc("[01:02]<0,100>甲<500,100>乙")).toBe(
      "[01:02]<01:02.000>甲<01:02.500>乙",
    )
  })

  it("没有词标记的行原样保留", () => {
    const src = "[00:01.000]这是一整行歌词"
    expect(lxLyricToEnhancedLrc(src)).toBe(src)
  })

  it("元数据行与空行原样保留", () => {
    const src = "[ti:后来]\n[by:]\n\n[00:00.000]<0,100>词"
    expect(lxLyricToEnhancedLrc(src)).toBe("[ti:后来]\n[by:]\n\n[00:00.000]<00:00.000>词")
  })

  it("时长字段只是被丢弃，不参与计算", () => {
    // 第二个词的起点是它自己的 offset，不是「上一个 offset + 上一个时长」
    expect(lxLyricToEnhancedLrc("[00:00.000]<0,9999>甲<100,50>乙")).toBe(
      "[00:00.000]<00:00.000>甲<00:00.100>乙",
    )
  })

  it("空串不炸", () => {
    expect(lxLyricToEnhancedLrc("")).toBe("")
  })
})
