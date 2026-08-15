import { useSkin } from "@/store/skin"

/** E1–E4：主标题、副标题、年份、署名条。文案全部来自皮肤，不硬编码。 */
export default function Masthead() {
  const text = useSkin((s) => s.skin.text)

  return (
    <>
      <div className="masthead">
        <h1>{text.title}</h1>
        <p>{text.subtitle}</p>
        <small>{text.year}</small>
      </div>
      <div className="byline">{text.byline}</div>
    </>
  )
}
