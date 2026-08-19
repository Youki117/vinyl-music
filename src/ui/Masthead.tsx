import { useLayoutEffect, useRef } from "react"

import { usePlayer } from "@/store/player"
import { useSkin } from "@/store/skin"

/**
 * 含中日韩字符。
 *
 * 展示字体（Cormorant Garamond）为了把 1168KB 压到 17KB，只子集化了拉丁字母，
 * 一个汉字都没有。中文歌名走这套字体会一路掉到通用 serif —— Windows 上就是宋体，
 * 97px 的宋体和这套版式完全不搭。所以中文标题要换字体栈。
 */
const hasCjk = (s: string) => /[㐀-鿿豈-﫿぀-ヿ가-힯]/.test(s)

/**
 * 把字号压到内容能放进容器为止。
 *
 * 基准字号故意不写死在这里：先清掉内联样式让它回到样式表的值再读，
 * 这样字号只在 CSS 里定义一处，改版式不用两边对。
 *
 * **必须迭代，不能按比例一次算出来。** `letter-spacing` 是固定像素、不随字号缩放，
 * 「April Showers」十三个字符光字距就占 39px；按 `新字号 = 旧字号 × 容器宽/内容宽`
 * 一次到位会系统性地缩不够 —— 实测溢出 5px（verify-real.mjs 里有这条断言）。
 * 每轮至少减 1px 保证收敛。
 */
function fitText(el: HTMLElement | null, min: number): void {
  if (!el) return
  el.style.fontSize = ""
  const maxW = el.parentElement?.clientWidth ?? 0
  if (!maxW || el.scrollWidth <= maxW) return

  let size = parseFloat(getComputedStyle(el).fontSize)
  for (let i = 0; i < 24 && el.scrollWidth > maxW && size > min; i++) {
    size = Math.max(min, Math.min(size - 1, Math.floor(size * (maxW / el.scrollWidth))))
    el.style.fontSize = `${size}px`
  }
}

/**
 * E1–E4：主标题、副标题、第三行、署名条。
 *
 * **在播时显示曲目信息，空闲时回到皮肤文案。**
 *
 * 原来这三行永远是皮肤里的装饰文案（FASHION / SELP-PORTRAIT / 1901），而真正的歌名
 * 只有进度条底下那个 10px 的小字，艺术家在主视图里根本不出现 —— 信息层级是反的：
 * 画面上最大的字是装饰，最小的字才是内容。
 *
 * 但装饰文案不能删：design-ref 的参考图就是这么排的，SSIM 硬关口比对的正是左侧 52%，
 * 大标题就在里面。折中办法是按状态切换 —— 没在播时保持参考图原样（对拍脚本本来就
 * 不加载曲目，关口不受影响），一旦开始播就换成歌名/艺术家/专辑。
 *
 * 署名条不跟着换：那是"这张皮肤是给谁的"，属于皮肤而不是曲目。
 */
export default function Masthead() {
  const text = useSkin((s) => s.skin.text)
  const track = usePlayer((s) => s.current())

  const titleRef = useRef<HTMLHeadingElement>(null)
  const subtitleRef = useRef<HTMLParagraphElement>(null)

  const title = track?.title || text.title
  const subtitle = track ? track.artist : text.subtitle
  // 专辑常常是空的，空了就不占一行，版式不塌
  const third = track ? track.album : text.year

  useLayoutEffect(() => {
    const run = () => {
      fitText(titleRef.current, 34)
      fitText(subtitleRef.current, 16)
    }
    run()
    // 展示字体是异步加载的，字体换上之后宽度会变，必须再量一次，
    // 否则首屏会按兜底字体的宽度定字号，字体到位后要么撑出去要么缩太多
    void document.fonts?.ready.then(run).catch(() => {})
  }, [title, subtitle])

  return (
    <>
      <div className="masthead" data-part="masthead">
        <h1 ref={titleRef} data-cjk={hasCjk(title)} title={title}>
          {title}
        </h1>
        <p ref={subtitleRef} data-cjk={hasCjk(subtitle)}>
          {subtitle}
        </p>
        {third && <small data-cjk={hasCjk(third)}>{third}</small>}
      </div>
      <div className="byline" data-part="byline">{text.byline}</div>
    </>
  )
}
