import { describe, expect, it } from "vitest"

import {
  BACKDROP_HISTORY_LIMIT,
  backdropHistoryFile,
  readBackdropHistory,
  rememberBackdrop,
  type CustomBackdrop,
} from "@/skin/backdropHistory"

const item = (id: string): CustomBackdrop => ({
  id: `D:\\Pictures\\${id}.jpg`,
  name: `${id}.jpg`,
  thumbnail: `data:image/jpeg;base64,${id}`,
})

describe("自定义底图历史", () => {
  it("忽略损坏配置和不完整条目", () => {
    expect(readBackdropHistory(null)).toEqual([])
    expect(readBackdropHistory({ version: 2, items: [item("a")] })).toEqual([])
    expect(
      readBackdropHistory({
        version: 1,
        items: [item("a"), { id: "D:\\bad.jpg", name: "bad.jpg", thumbnail: "not-an-image" }],
      }),
    ).toEqual([item("a")])
  })

  it("重复选择同一路径时更新缩略图并移到最前", () => {
    const updated = { ...item("a"), thumbnail: "data:image/jpeg;base64,new" }
    expect(rememberBackdrop([item("b"), item("a")], updated)).toEqual([updated, item("b")])
  })

  it("读取配置时去掉重复路径，避免渲染出重复选项", () => {
    expect(readBackdropHistory({ version: 1, items: [item("a"), item("b"), item("a")] })).toEqual([
      item("a"),
      item("b"),
    ])
  })

  it("限制历史数量并生成稳定的配置结构", () => {
    const many = Array.from({ length: BACKDROP_HISTORY_LIMIT + 3 }, (_, i) => item(String(i)))
    const remembered = rememberBackdrop(many, item("latest"))
    expect(remembered).toHaveLength(BACKDROP_HISTORY_LIMIT)
    expect(remembered[0].name).toBe("latest.jpg")
    expect(backdropHistoryFile(remembered)).toEqual({ version: 1, items: remembered })
  })
})
