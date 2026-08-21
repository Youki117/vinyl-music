import { describe, expect, it } from "vitest"

import { buildLyricDigest, composeImagePrompt, extractLyricLines } from "@/ai/prompt"
import {
  DEFAULT_AI,
  configWarning,
  isConfigured,
  resolveImageEndpoint,
  resolveTextEndpoint,
} from "@/ai/config"

describe("extractLyricLines", () => {
  it("从 LRC 里取出正文，丢掉时间戳", () => {
    const lrc = "[00:01.00]第一行\n[00:05.00]第二行"
    expect(extractLyricLines(lrc)).toEqual(["第一行", "第二行"])
  })

  it("丢掉元信息行", () => {
    expect(extractLyricLines("[ti:歌名]\n[ar:歌手]\n[00:01.00]正文")).toEqual(["正文"])
  })

  it("同一句副歌挂多个时间戳时只保留一次", () => {
    const lrc = "[00:30.00][01:30.00][02:30.00]副歌\n[00:40.00]别的"
    expect(extractLyricLines(lrc)).toEqual(["副歌", "别的"])
  })

  it("纯文本歌词（没有时间戳）也能用", () => {
    expect(extractLyricLines("第一行\n\n第二行\n  ")).toEqual(["第一行", "第二行"])
  })

  it("空歌词返回空数组", () => {
    expect(extractLyricLines(null)).toEqual([])
    expect(extractLyricLines("")).toEqual([])
    expect(extractLyricLines("   \n  ")).toEqual([])
  })
})

/*
 * 平台歌词几乎都在正文前挂一串制作人员署名，纯音乐则返回一句占位说明。
 * 这些不是歌词，喂给模型只会得到"一个叫某某的人在录音棚里"或者对着
 * "请您欣赏"编出来的画面。
 */
describe("不是歌词的那些行", () => {
  it("丢掉制作人员署名，中英文冒号都认", () => {
    const lrc = [
      "[00:00.00]作词 : 张三",
      "[00:01.00]作曲：李四",
      "[00:02.00]和声 : 王五",
      "[00:03.00]混音：赵六",
      "[00:04.00]Producer: Someone",
      "[00:05.00]走在冷风里",
    ].join("\n")
    expect(extractLyricLines(lrc)).toEqual(["走在冷风里"])
  })

  it("不会因为含「作曲」两个字就误伤正经歌词", () => {
    // 卡的是"行首职能词 + 冒号"这个形状，不是关键词
    const lrc = "[00:01.00]作曲家的手在发抖\n[00:02.00]词句散落一地"
    expect(extractLyricLines(lrc)).toEqual(["作曲家的手在发抖", "词句散落一地"])
  })

  it("丢掉平台给纯音乐的占位说明", () => {
    expect(extractLyricLines("此歌曲为没有填词的纯音乐，请您欣赏")).toEqual([])
    expect(extractLyricLines("[00:00.00]纯音乐，请欣赏")).toEqual([])
    expect(extractLyricLines("暂无歌词")).toEqual([])
  })

  it("纯音乐会走「没有可用歌词」那条，而不是拿占位句去生图", () => {
    const d = buildLyricDigest({
      title: "夜航",
      artist: "某人",
      album: "",
      lyrics: "[00:00.00]此歌曲为没有填词的纯音乐，请您欣赏",
    })
    expect(d).toContain("没有可用的歌词")
    expect(d).not.toContain("请您欣赏")
  })

  it("整份歌词只有署名时，同样当作没有歌词", () => {
    const d = buildLyricDigest({
      title: "夜航",
      artist: "某人",
      album: "",
      lyrics: "作词 : 张三\n作曲 : 李四\n和声 : 王五",
    })
    expect(d).toContain("没有可用的歌词")
    expect(d).not.toContain("张三")
  })

  it("一行就有画面感的歌词要留住，不能因为短就丢掉", () => {
    // 曾经按行数卡过门槛，把这类误伤了 —— 它正是 prompt.ts 举例的那种
    const d = buildLyricDigest({
      title: "山明水秀",
      artist: "",
      album: "",
      lyrics: "[00:01.00]没有星星的夜空",
    })
    expect(d).toContain("没有星星的夜空")
  })
})

describe("配置陷阱预警", () => {
  const filled = {
    ...DEFAULT_AI,
    enabled: true,
    textApiKey: "sk-x",
    imageModel: "some-image-model",
  }

  it("图像接口留空回落到 DeepSeek 时提前警告", () => {
    // DeepSeek 没有 /images/generations，等第二步 404 才发现时钱已经花了
    expect(configWarning(filled)).toContain("没有生图接口")
  })

  it("单独填了支持生图的接口就不再警告", () => {
    expect(configWarning({ ...filled, imageBaseUrl: "https://open.bigmodel.cn/api/paas/v4" })).toBeNull()
  })

  it("功能没开时不打扰", () => {
    expect(configWarning({ ...filled, enabled: false })).toBeNull()
  })
})

describe("buildLyricDigest", () => {
  const base = { title: "山明水秀", artist: "Xiaojie", album: "FASHION", lyrics: null }

  it("有歌词时带上歌词", () => {
    const d = buildLyricDigest({ ...base, lyrics: "[00:01.00]没有星星的夜空" })
    expect(d).toContain("歌名：山明水秀")
    expect(d).toContain("艺术家：Xiaojie")
    expect(d).toContain("没有星星的夜空")
  })

  it("没歌词时明确告诉模型只能靠歌名想象", () => {
    const d = buildLyricDigest(base)
    expect(d).toContain("没有可用的歌词")
    expect(d).toContain("山明水秀")
  })

  it("不把占位的「未知艺术家」塞给模型", () => {
    const d = buildLyricDigest({ ...base, artist: "未知艺术家" })
    expect(d).not.toContain("未知艺术家")
  })

  it("超长歌词被截断，避免撑爆上下文也避免多花钱", () => {
    const long = Array.from({ length: 400 }, (_, i) => `这是第${i}行歌词内容`).join("\n")
    const d = buildLyricDigest({ ...base, lyrics: long })
    expect(d.length).toBeLessThan(1500)
    expect(d).toContain("…")
  })
})

describe("composeImagePrompt", () => {
  it("拼上风格后缀", () => {
    expect(composeImagePrompt("一个人站在雨里", "电影感")).toBe("一个人站在雨里。电影感")
  })

  it("剥掉模型爱加的引号", () => {
    expect(composeImagePrompt("「一个人站在雨里」", "x")).toBe("一个人站在雨里。x")
    expect(composeImagePrompt('"a scene"', "x")).toBe("a scene。x")
  })

  it("后缀为空时不留下多余句号", () => {
    expect(composeImagePrompt("场景", "")).toBe("场景")
  })

  it("默认风格后缀必须要求主体偏右、左侧留白", () => {
    // 画面左侧要压白色蒙版，主体画在左边会被盖掉——这是硬约束不是审美偏好
    expect(DEFAULT_AI.styleSuffix).toContain("右侧")
    expect(DEFAULT_AI.styleSuffix).toContain("左侧留出")
  })
})

describe("config", () => {
  it("默认关闭 —— 不开就仍然全程离线", () => {
    expect(DEFAULT_AI.enabled).toBe(false)
    expect(DEFAULT_AI.auto).toBe(false)
  })

  it("图像接口留空时复用文本那套", () => {
    const cfg = { ...DEFAULT_AI, textBaseUrl: "https://a.com/v1", textApiKey: "k1" }
    expect(resolveImageEndpoint(cfg)).toEqual({ baseUrl: "https://a.com/v1", apiKey: "k1" })
  })

  it("图像接口单独填了就用自己的", () => {
    const cfg = {
      ...DEFAULT_AI,
      textBaseUrl: "https://a.com/v1",
      textApiKey: "k1",
      imageBaseUrl: "https://b.com/v1",
      imageApiKey: "k2",
    }
    expect(resolveImageEndpoint(cfg)).toEqual({ baseUrl: "https://b.com/v1", apiKey: "k2" })
  })

  it("去掉地址结尾多余的斜杠，避免拼出 //chat/completions", () => {
    expect(resolveTextEndpoint({ ...DEFAULT_AI, textBaseUrl: "https://a.com/v1///" }).baseUrl).toBe(
      "https://a.com/v1",
    )
  })

  it("配置不全时 isConfigured 为假", () => {
    expect(isConfigured(DEFAULT_AI)).toBe(false)
    expect(isConfigured({ ...DEFAULT_AI, enabled: true })).toBe(false)
    expect(isConfigured({ ...DEFAULT_AI, enabled: true, textApiKey: "k" })).toBe(false)
  })

  it("填齐后为真", () => {
    expect(
      isConfigured({
        ...DEFAULT_AI,
        enabled: true,
        textApiKey: "k",
        imageModel: "cogview-3",
      }),
    ).toBe(true)
  })

  it("即使填齐，enabled 为假也不算可用", () => {
    expect(
      isConfigured({ ...DEFAULT_AI, enabled: false, textApiKey: "k", imageModel: "m" }),
    ).toBe(false)
  })
})
