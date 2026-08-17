import { describe, expect, it } from "vitest"

import { isUnderDir, normalizeWin } from "@/lib/path"

const ROOT = "C:\\Users\\me\\AppData\\Roaming\\com.vinylplayer.desktop"

describe("normalizeWin", () => {
  it("统一分隔符并压平重复分隔符", () => {
    expect(normalizeWin("C:/Users//me/x.jpg")).toBe("C:\\Users\\me\\x.jpg")
  })

  it("消掉 . 与 ..", () => {
    expect(normalizeWin("C:\\a\\.\\b\\..\\c")).toBe("C:\\a\\c")
  })

  it("保留 UNC 前缀", () => {
    expect(normalizeWin("\\\\server\\share\\x.jpg")).toBe("\\\\server\\share\\x.jpg")
  })

  it("越过根的 .. 不抛错，退化成相对段（调用方按不通过处理）", () => {
    expect(normalizeWin("C:\\..\\..\\x")).toBe("x")
  })
})

describe("isUnderDir", () => {
  it("放行目录内的文件", () => {
    expect(isUnderDir(ROOT, `${ROOT}\\skins\\cover-ab12.jpg`)).toBe(true)
    expect(isUnderDir(ROOT, `${ROOT}/cache/peaks-x.bin`)).toBe(true)
  })

  it("大小写不敏感", () => {
    expect(isUnderDir(ROOT, `${ROOT.toUpperCase()}\\skins\\a.jpg`)).toBe(true)
  })

  // 这两条是围栏真正要挡的东西，裸 startsWith 会全部放过
  it("挡住用 .. 穿出去的路径", () => {
    expect(isUnderDir(ROOT, `${ROOT}\\..\\..\\..\\Music\\song.mp3`)).toBe(false)
    expect(isUnderDir(ROOT, `${ROOT}\\skins\\..\\..\\Music\\song.mp3`)).toBe(false)
  })

  it("挡住前缀相同的兄弟目录", () => {
    expect(isUnderDir(ROOT, `${ROOT}-backup\\x.jpg`)).toBe(false)
  })

  it("挡住完全无关的路径与根目录自身", () => {
    expect(isUnderDir(ROOT, "D:\\Music\\song.mp3")).toBe(false)
    expect(isUnderDir(ROOT, ROOT)).toBe(false)
    expect(isUnderDir("", "C:\\x")).toBe(false)
  })
})
