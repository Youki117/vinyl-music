import { useSkin } from "@/store/skin"

/**
 * L0 底图。铺满整个舞台，蒙版半透明地压在它上面 —— 这是 Figma 版本没做对的
 * 地方之一：那一版把底图分成左右两半各铺一次，导致白区里透不出底图内容。
 */
export default function Backdrop() {
  const backdrop = useSkin((s) => s.backdrop)
  const fading = useSkin((s) => s.fading)
  const focus = useSkin((s) => s.skin.backdropFocus)

  return (
    <div className="layer backdrop">
      {/* 没有底图时用内置底纹，与参考图的影棚背景一致 */}
      {!backdrop && <div className="backdrop-builtin" />}

      {fading && (
        <div
          key={`fade-${fading.url}`}
          className="backdrop-img backdrop-out"
          style={{ backgroundImage: `url(${fading.url})` }}
        />
      )}
      {backdrop && (
        <div
          key={backdrop.url}
          className="backdrop-img backdrop-in"
          style={{
            backgroundImage: `url(${backdrop.url})`,
            backgroundPosition: `${focus.x * 100}% ${focus.y * 100}%`,
          }}
        />
      )}
    </div>
  )
}
