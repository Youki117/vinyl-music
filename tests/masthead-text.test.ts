import { describe, expect, it } from "vitest"

import { splitLeadingTitleTag } from "../src/ui/Masthead"

describe("splitLeadingTitleTag", () => {
  it.each([
    ["【FREE】 lucky", "【", "FREE", "】", "lucky"],
    ["[Live] April Showers", "[", "Live", "]", "April Showers"],
    ["（纯享版）24/7", "（", "纯享版", "）", "24/7"],
    ["《翻唱》 下一首", "《", "翻唱", "》", "下一首"],
  ])("keeps a leading paired tag intact for %s", (title, open, label, close, rest) => {
    expect(splitLeadingTitleTag(title)).toEqual({ open, label, close, rest })
  })

  it.each(["24/7（纯享版）", "【FREE】", "【未闭合 lucky", "普通歌名"])(
    "leaves non-leading or incomplete tags unchanged for %s",
    (title) => {
      expect(splitLeadingTitleTag(title)).toBeNull()
    },
  )
})
