import { describe, expect, it } from "vitest"

import { compactCount, formatTime } from "@/lib/format"

describe("formatTime", () => {
  it("按 mm:ss 补零", () => {
    expect(formatTime(0)).toBe("00:00")
    expect(formatTime(9)).toBe("00:09")
    expect(formatTime(60)).toBe("01:00")
    expect(formatTime(305)).toBe("05:05")
  })

  it("超过一小时不截断分钟", () => {
    expect(formatTime(3725)).toBe("62:05")
  })

  it("非法输入退回 00:00 而不是 NaN:NaN", () => {
    expect(formatTime(NaN)).toBe("00:00")
    expect(formatTime(-5)).toBe("00:00")
    expect(formatTime(Infinity)).toBe("00:00")
  })
})

describe("compactCount", () => {
  it("一万以下直接显示", () => {
    expect(compactCount(0)).toBe("0")
    expect(compactCount(661)).toBe("661")
    expect(compactCount(9999)).toBe("9999")
  })

  it("一万以上用 w，与效果图一致", () => {
    expect(compactCount(10000)).toBe("1w")
    expect(compactCount(45000)).toBe("4.5w")
    expect(compactCount(88000)).toBe("8.8w")
  })

  it("百万以上不带小数", () => {
    expect(compactCount(1_200_000)).toBe("120w")
  })
})
