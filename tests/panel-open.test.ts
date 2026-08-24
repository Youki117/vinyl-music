import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * 抽屉/浮层组件的开合契约：**收起来是组件自己的事**。
 *
 * 这条是被一个真 bug 逼出来的。队列面板漏了 `if (!open) return null`，于是它一直
 * 挂在 DOM 里 —— z-index 7，盖住右半屏 —— 而 `open` 成了一个没人读的入参：按 Q、
 * 点叉号都会把 panel 置空，界面却纹丝不动，看起来就是"面板关不掉"。
 *
 * 单测环境是 node、没有 DOM（vite.config.ts 里写着"测试只覆盖纯逻辑"），为一条
 * 不变式引进 jsdom + testing-library 不成比例。所以这里直接读源码检查 ——
 * 检的是一条真实的结构性约定，不是措辞。
 */

const UI_DIR = join(process.cwd(), "src", "ui")

/** 递归收集 src/ui 下的所有 .tsx */
function componentFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...componentFiles(full))
    else if (entry.name.endsWith(".tsx")) out.push(full)
  }
  return out
}

/** 声明了 `open: boolean` 入参的，就是走这条契约的组件 */
const panels = componentFiles(UI_DIR)
  .map((path) => ({ path, src: readFileSync(path, "utf8") }))
  .filter(({ src }) => /\bopen:\s*boolean/.test(src))

describe("面板的开合契约", () => {
  it("能找到若干个带 open 入参的面板 —— 找不到说明这条检查本身失效了", () => {
    expect(panels.length).toBeGreaterThanOrEqual(6)
  })

  for (const { path, src } of panels) {
    const name = path.slice(path.indexOf("src"))

    it(`${name} 在 open=false 时返回 null`, () => {
      expect(src, "少了这一句，抽屉会一直挂在 DOM 上，open 变成没人读的入参").toMatch(
        /if\s*\(!open\)\s*return null/,
      )
    })

    it(`${name} 的提前返回排在所有 hook 之后`, () => {
      const guard = src.search(/if\s*\(!open\)\s*return null/)
      // 组件体内的 hook 调用：行首缩进 + use 开头。JSX 里的 onXxx 回调不会命中
      const hooks = [...src.matchAll(/^\s+(?:const .*?=\s*)?use[A-Z]\w*\(/gm)]
      const last = hooks.length > 0 ? hooks[hooks.length - 1].index : -1
      expect(guard, "提前返回跑到了 hook 前面，会打乱 hook 顺序").toBeGreaterThan(last)
    })
  }
})

/**
 * 右键菜单只能由 ui/ContextMenu.tsx 渲染。
 *
 * 这条同样是被真 bug 逼出来的：菜单原先直接写在抽屉里，`position: fixed` 本以为
 * 按视口定位，而 `.drawer` 上的 `backdrop-filter` 会让它成为 fixed 后代的包含块 ——
 * 于是 `left: 1016px` 变成相对抽屉左边缘，实测落到 x≈1910，视口只有 1280 宽。
 * 菜单每次都正常打开，只是整个在屏幕外面，看起来就是"右键没反应"。
 *
 * 解法是 portal 到 body。抽成一个组件之后，这条检查保证不会有人再手写一个 ——
 * 手写的那个会重新踩进同一个包含块里，而且照样没有任何静态信号。
 */
describe("右键菜单必须走 ContextMenu 组件", () => {
  const OWNER = "ContextMenu.tsx"

  const writers = componentFiles(UI_DIR).filter((path) => {
    if (path.endsWith(OWNER)) return false
    return /className="ctx-menu"/.test(readFileSync(path, "utf8"))
  })

  it("除 ContextMenu.tsx 外，没有别处手写 ctx-menu", () => {
    expect(writers.map((p) => p.slice(p.indexOf("src"))), "手写的菜单会掉进抽屉的包含块里，整个跑到屏幕外").toEqual([])
  })

  it("ContextMenu.tsx 确实 portal 到了 body", () => {
    const src = readFileSync(join(UI_DIR, OWNER), "utf8")
    expect(src).toMatch(/createPortal\(/)
    expect(src).toMatch(/document\.body/)
    // portal 出去之后不再是抽屉的后代，得靠这个属性豁免抽屉的"点外面就关"
    expect(src, "少了 data-keep-panel，点菜单会把底下的抽屉一起关掉").toMatch(/data-keep-panel/)
  })
})
