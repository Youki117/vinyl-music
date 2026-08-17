import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_SKIN, type Skin } from "@/skin/model"

/**
 * 皮肤预设：保存 / 套用 / 只套蒙版 / 删除。
 *
 * 这套数据层其实早就写好了（saveAs / activate），只是一直没有界面能碰到它。
 * 这次接出口时补了 removeSkin 与 applyVeilFrom，最容易出事的是"删掉的正好是
 * 当前正在用的那一个"—— 处理不好会让界面停在一个已经不在列表里的皮肤上。
 */

vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id),
})
vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} })

// 蒙版取色要 document.createElement("canvas") 画一遍底图再读像素，node 环境里没有。
// getContext 返回 null 时 extractTints 会干净地返回空数组（等于"没取到色"），
// 不补的话每个用例都往 stderr 刷一条警告 —— 噪音会让人不再看测试输出。
vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) })

// skin.ts 靠 new Image() 量底图尺寸，node 环境里没有这个构造函数。
// 不补的话每个用例都会往 stderr 刷一条"图片加载失败"，断言仍然过 —— 而这正是
// 最坏的情况：噪音把真问题埋掉。
vi.stubGlobal(
  "Image",
  class {
    naturalWidth = 1200
    naturalHeight = 800
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) {
      queueMicrotask(() => this.onload?.())
    }
  },
)

vi.mock("@/platform", () => ({
  platform: {
    readConfig: vi.fn(async () => null),
    writeConfig: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array([1])),
    saveImage: vi.fn(async () => ({ id: "x", name: "x", size: 1, mtime: 0 })),
    removeFile: vi.fn(async () => {}),
  },
  // skin.ts 加载底图时用它。漏了这个导出，refreshImages 会抛出来 ——
  // 断言照样过（那条路径不影响预设逻辑），但控制台会刷一片红，久了就没人看测试输出了
  toObjectUrl: vi.fn(async () => "blob:fake"),
}))

// 取色要读真实图片，测试环境里没有；不影响预设逻辑本身
vi.mock("fast-average-color", () => ({
  FastAverageColor: class {
    async getColorAsync() {
      return { value: [128, 128, 128, 255] }
    }
  },
}))

async function freshSkin() {
  vi.resetModules()
  return (await import("@/store/skin")).useSkin
}

const preset = (id: string, name: string, tint: string): Skin => ({
  ...DEFAULT_SKIN,
  id,
  name,
  backdrop: `${id}.jpg`,
  veil: { ...DEFAULT_SKIN.veil, tint, opacity: 0.5 },
})

let useSkin: Awaited<ReturnType<typeof freshSkin>>

beforeEach(async () => {
  useSkin = await freshSkin()
})

describe("皮肤预设", () => {
  it("保存当前会新增一个预设并切到它", async () => {
    await useSkin.getState().saveAs("我的雾")
    const s = useSkin.getState()
    expect(s.skins).toHaveLength(2)
    expect(s.skin.name).toBe("我的雾")
    // 必须是副本而不是同一个对象，否则改新预设会连原来那个一起改
    expect(s.skin.id).not.toBe(DEFAULT_SKIN.id)
  })

  it("只套蒙版：换掉蒙版参数，底图与文案原样不动", async () => {
    useSkin.setState({
      skins: [preset("a", "A", "#ff0000"), preset("b", "B", "#00ff00")],
      skin: preset("a", "A", "#ff0000"),
    })

    await useSkin.getState().applyVeilFrom("b")

    const s = useSkin.getState()
    expect(s.skin.veil.tint).toBe("#00ff00") // 蒙版换了
    expect(s.skin.id).toBe("a") // 还是原来那张皮肤
    expect(s.skin.backdrop).toBe("a.jpg") // 底图没被换掉
  })

  it("全部套用：整张换过去", async () => {
    useSkin.setState({
      skins: [preset("a", "A", "#ff0000"), preset("b", "B", "#00ff00")],
      skin: preset("a", "A", "#ff0000"),
    })

    await useSkin.getState().activate("b")

    const s = useSkin.getState()
    expect(s.skin.id).toBe("b")
    expect(s.skin.backdrop).toBe("b.jpg")
  })

  it("删掉当前正在用的那个，会自动切到剩下的第一个", async () => {
    useSkin.setState({
      skins: [preset("a", "A", "#ff0000"), preset("b", "B", "#00ff00")],
      skin: preset("b", "B", "#00ff00"),
    })

    await useSkin.getState().removeSkin("b")

    const s = useSkin.getState()
    expect(s.skins.map((x) => x.id)).toEqual(["a"])
    // 关键：不能停在一个已经不在列表里的皮肤上
    expect(s.skin.id).toBe("a")
    expect(s.skins.some((x) => x.id === s.skin.id)).toBe(true)
  })

  it("删掉别的预设，当前这个不受影响", async () => {
    useSkin.setState({
      skins: [preset("a", "A", "#ff0000"), preset("b", "B", "#00ff00")],
      skin: preset("a", "A", "#ff0000"),
    })

    await useSkin.getState().removeSkin("b")

    expect(useSkin.getState().skins.map((x) => x.id)).toEqual(["a"])
    expect(useSkin.getState().skin.id).toBe("a")
  })

  it("只剩一个时不允许删，否则界面会没有可用皮肤", async () => {
    useSkin.setState({ skins: [preset("a", "A", "#ff0000")], skin: preset("a", "A", "#ff0000") })

    await useSkin.getState().removeSkin("a")

    expect(useSkin.getState().skins).toHaveLength(1)
  })

  it("手调蒙版色 → 自动取色让位（用户优先）", async () => {
    useSkin.setState({ skin: { ...preset("a", "A", "#ff0000"), tintAuto: true } })

    useSkin.getState().patchVeil({ tint: "#123456" })

    expect(useSkin.getState().skin.tintAuto).toBe(false)
    expect(useSkin.getState().skin.veil.tint).toBe("#123456")
  })

  it("调蒙版的其他参数不影响自动取色（只有颜色才算'我要自己来'）", async () => {
    useSkin.setState({ skin: { ...preset("a", "A", "#ff0000"), tintAuto: true } })

    useSkin.getState().patchVeil({ softness: 0.2 })
    useSkin.getState().patchVeil({ ripple: 0.5 })
    useSkin.getState().patchVeil({ edgeX: 0.3 })

    expect(useSkin.getState().skin.tintAuto).toBe(true)
  })

  it("开关能把自动取色重新打开", async () => {
    useSkin.setState({ skin: { ...preset("a", "A", "#ff0000"), tintAuto: false } })

    useSkin.getState().patchSkin({ tintAuto: true })

    expect(useSkin.getState().skin.tintAuto).toBe(true)
  })

  it("只套蒙版会带上预设自己的自动取色状态", async () => {
    // 预设 b 是用户手调后存的（tintAuto=false），套过去就该保持手动
    useSkin.setState({
      skins: [
        { ...preset("a", "A", "#ff0000"), tintAuto: true },
        { ...preset("b", "B", "#00ff00"), tintAuto: false },
      ],
      skin: { ...preset("a", "A", "#ff0000"), tintAuto: true },
    })

    await useSkin.getState().applyVeilFrom("b")

    expect(useSkin.getState().skin.tintAuto).toBe(false)
    expect(useSkin.getState().skin.veil.tint).toBe("#00ff00")
  })

  it("反过来也成立：从自动模式存的预设，套过去仍是自动", async () => {
    useSkin.setState({
      skins: [
        { ...preset("a", "A", "#ff0000"), tintAuto: false },
        { ...preset("b", "B", "#00ff00"), tintAuto: true },
      ],
      skin: { ...preset("a", "A", "#ff0000"), tintAuto: false },
    })

    await useSkin.getState().applyVeilFrom("b")

    expect(useSkin.getState().skin.tintAuto).toBe(true)
  })

  it("删一个不存在的 id 不会误伤别人", async () => {
    useSkin.setState({
      skins: [preset("a", "A", "#ff0000"), preset("b", "B", "#00ff00")],
      skin: preset("a", "A", "#ff0000"),
    })

    await useSkin.getState().removeSkin("nope")

    expect(useSkin.getState().skins).toHaveLength(2)
  })
})
