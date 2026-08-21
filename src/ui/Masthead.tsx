import { usePlayer } from "@/store/player"

/**
 * 含中日韩字符。
 *
 * 展示字体（Cormorant Garamond）为了把 1168KB 压到 17KB，只子集化了拉丁字母，
 * 一个汉字都没有。中文歌名走这套字体会一路掉到通用 serif —— Windows 上就是宋体，
 * 大字号的宋体和这套版式完全不搭。所以中文标题要换字体栈。
 */
const hasCjk = (s: string) => /[㐀-鿿豈-﫿぀-ヿ가-힯]/.test(s)

const TITLE_TAG_PAIRS = [
  ["【", "】"],
  ["［", "］"],
  ["[", "]"],
  ["（", "）"],
  ["(", ")"],
  ["《", "》"],
] as const

export type LeadingTitleTag = {
  open: string
  label: string
  close: string
  rest: string
}

/**
 * 提取歌名前面的版本/场景标签。
 *
 * 固定大字号下直接对整串文字做省略，`【FREE】 lucky` 会变成 `【FREE…`，闭合括号
 * 被吃掉。把成对前缀单独排版后，括号始终成对显示，省略只发生在标签内容或正文中。
 */
export function splitLeadingTitleTag(title: string): LeadingTitleTag | null {
  const value = title.trimStart()

  for (const [open, close] of TITLE_TAG_PAIRS) {
    if (!value.startsWith(open)) continue
    const closeAt = value.indexOf(close, open.length)
    if (closeAt <= open.length) return null

    const rest = value.slice(closeAt + close.length).trimStart()
    if (!rest) return null

    return {
      open,
      label: value.slice(open.length, closeAt),
      close,
      rest,
    }
  }

  return null
}

/**
 * E1–E4：主标题、副标题、第三行、署名条。
 *
 * 固定字号海报排版，超长直接省略号。
 */
export default function Masthead() {
  const track = usePlayer((s) => s.current())

  const title = track?.title || "歌名"
  const byline = track?.artist || "歌手名"
  const titleTag = splitLeadingTitleTag(title)

  return (
    <>
      <div className="masthead" data-part="masthead">
        <h1 data-cjk={hasCjk(title)} title={title} aria-label={title}>
          {titleTag ? (
            <>
              <span
                className="masthead-title-tag"
                data-wide={/[【［（《]/u.test(titleTag.open)}
                aria-hidden="true"
              >
                <span className="masthead-title-bracket">{titleTag.open}</span>
                <span className="masthead-title-tag-label">{titleTag.label}</span>
                <span className="masthead-title-bracket">{titleTag.close}</span>
              </span>
              <span className="masthead-title-main" aria-hidden="true">
                {titleTag.rest}
              </span>
            </>
          ) : (
            <span className="masthead-title-main" aria-hidden="true">
              {title}
            </span>
          )}
        </h1>
        <p>MYRIAD AUDIO</p>
        <small>117</small>
      </div>
      {/* 署名条保持为标题组的兄弟节点，自定义布局仍可单独移动它。 */}
      <div className="byline" data-part="byline" title={byline}>
        {byline}
      </div>
    </>
  )
}
