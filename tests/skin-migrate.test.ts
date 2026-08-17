import { describe, expect, it } from "vitest"

import { DEFAULT_SKIN, SKIN_SCHEMA_VERSION, migrateSkins } from "@/skin/model"

/**
 * 皮肤配置的版本迁移。
 *
 * 这段动的是**用户已经存在磁盘上的数据**，迁错了就是把人家调好的皮肤洗掉，
 * 而且不会报错、只会"看起来变了"。所以每加一级迁移都要有对应的用例。
 *
 * v1 → v2：蒙版律动删除，`veil.breath` 更名 `veil.ripple`，`veil.waveAmp` 移除。
 */

/** 一份 v1 时代写下去的配置，字段按当时的样子 */
const v1File = {
  schemaVersion: 1,
  activeId: "s1",
  skins: [
    {
      id: "s1",
      name: "旧皮肤",
      backdrop: "D:/pic.jpg",
      backdropFocus: { x: 0.4, y: 0.3 },
      label: { source: "backdrop", focus: { x: 0.5, y: 0.32, zoom: 2.2 } },
      veil: {
        edgeX: 0.5,
        softness: 0.11,
        opacity: 0.8,
        tint: "#ffeedd",
        wander: 0.2,
        breath: 0.37, // ← 要搬到 ripple
        waveAmp: 0.9, // ← 要丢掉
      },
      ink: { auto: false, primary: "#111", secondary: "#222", accent: "#333" },
      text: { title: "T", subtitle: "S", year: "Y", byline: "B" },
    },
  ],
}

describe("migrateSkins · v1 → v2", () => {
  it("把 breath 搬成 ripple，保住用户调过的值", () => {
    const out = migrateSkins(v1File)!
    expect(out.skins[0].veil.ripple).toBe(0.37)
  })

  it("丢掉 waveAmp，且不残留在对象上", () => {
    const out = migrateSkins(v1File)!
    expect("waveAmp" in out.skins[0].veil).toBe(false)
    expect("breath" in out.skins[0].veil).toBe(false)
  })

  it("其余字段一个都不动", () => {
    const out = migrateSkins(v1File)!
    const s = out.skins[0]
    expect(s.veil.edgeX).toBe(0.5)
    expect(s.veil.softness).toBe(0.11)
    expect(s.veil.opacity).toBe(0.8)
    expect(s.veil.tint).toBe("#ffeedd")
    expect(s.veil.wander).toBe(0.2)
    expect(s.backdrop).toBe("D:/pic.jpg")
    expect(s.ink.auto).toBe(false)
    expect(s.text.title).toBe("T")
    expect(out.activeId).toBe("s1")
  })

  it("版本号升到当前值", () => {
    expect(migrateSkins(v1File)!.schemaVersion).toBe(SKIN_SCHEMA_VERSION)
  })

  it("没有版本号的按 v1 处理（v1 写盘时版本标记并不可靠）", () => {
    const { schemaVersion: _drop, ...noVersion } = v1File
    const out = migrateSkins(noVersion)!
    expect(out.skins[0].veil.ripple).toBe(0.37)
  })

  it("已经是 v2 的不再迁移，ripple 原样保留", () => {
    const v2 = {
      schemaVersion: 2,
      activeId: "s1",
      skins: [{ ...v1File.skins[0], veil: { ...DEFAULT_SKIN.veil, ripple: 0.12 } }],
    }
    expect(migrateSkins(v2)!.skins[0].veil.ripple).toBe(0.12)
  })

  it("坏数据不抛，返回 null 让调用方退回默认皮肤", () => {
    expect(migrateSkins(null)).toBeNull()
    expect(migrateSkins("nope")).toBeNull()
    expect(migrateSkins({ skins: "not-an-array" })).toBeNull()
  })

  it("veil 整个缺失时补默认值而不是崩掉", () => {
    const broken = { schemaVersion: 1, activeId: "x", skins: [{ id: "x", name: "x" }] }
    const out = migrateSkins(broken)!
    expect(out.skins[0].veil.ripple).toBe(DEFAULT_SKIN.veil.ripple)
  })
})
