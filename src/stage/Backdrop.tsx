import { useEffect, useRef } from "react"

import { usePlayer } from "@/store/player"
import { useSkin, type LoadedMedia } from "@/store/skin"

/**
 * L0 底图。铺满整个舞台，蒙版半透明地压在它上面 —— 这是 Figma 版本没做对的
 * 地方之一：那一版把底图分成左右两半各铺一次，导致白区里透不出底图内容。
 *
 * 底图可以是一张图，也可以是一段视频（见 store/skin 的 `LoadedMedia`）。两者的
 * 铺法是等价的：`object-fit: cover` + `object-position` 就是 `background-size: cover`
 * + `background-position` 的对应物，所以皮肤面板里拖焦点的手感在两种底图上一致，
 * 蒙版、颗粒、内容层全都不用知道底下铺的是什么。
 */
export default function Backdrop() {
  const backdrop = useSkin((s) => s.backdrop)
  const fading = useSkin((s) => s.fading)
  const focus = useSkin((s) => s.skin.backdropFocus)

  return (
    <div className="layer backdrop">
      {/* 没有底图时用内置底纹，与参考图的影棚背景一致 */}
      {!backdrop && <div className="backdrop-builtin" />}

      {/* 淡出的旧底图不给焦点，与改动前一致：转场那 600ms 里它居中就够了 */}
      {fading && <Layer key={`fade-${fading.url}`} media={fading} className="backdrop-out" />}
      {backdrop && (
        <Layer key={backdrop.url} media={backdrop} focus={focus} className="backdrop-in" />
      )}
    </div>
  )
}

function Layer({
  media,
  focus,
  className,
}: {
  media: LoadedMedia
  focus?: { x: number; y: number }
  className: string
}) {
  // 不给焦点时留空，让 CSS 里的 center 生效，而不是在这里再写一份默认值
  const position = focus ? `${focus.x * 100}% ${focus.y * 100}%` : undefined

  if (media.kind === "video") {
    return <VideoLayer media={media} position={position} className={className} />
  }

  return (
    <div
      className={`backdrop-img ${className}`}
      style={{ backgroundImage: `url(${media.url})`, backgroundPosition: position }}
    />
  )
}

/**
 * 视频底图。
 *
 * 两处刻意的暂停，都是为了不让一段循环壁纸在没人看的时候白烧 CPU —— §7 里那次
 * 「蒙版律动 11 个百分点就整体下线」的先例摆在那，视频解码只会更贵：
 *
 * - **曲目暂停时画面也停住**，和黑胶就地停转是同一套语义。但只认 `"paused"`，
 *   不认「非播放中」—— 还没选曲目时（`"empty"`）照放，否则用户刚把视频拖进来
 *   看到的是一张静止的图，第一眼就像坏了。
 * - **窗口不可见时停**。最小化之后没人看得见，解码却还在跑。
 */
function VideoLayer({
  media,
  position,
  className,
}: {
  media: LoadedMedia
  position?: string
  className: string
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const paused = usePlayer((s) => s.status === "paused")

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const sync = (): void => {
      // 属性式的 muted 在 React 里不总能落到 DOM 上，而没静音就没有自动播放许可
      el.muted = true
      if (!paused && document.visibilityState === "visible") {
        // 元素刚挂上或窗口刚切走时 play() 会 reject，是正常竞态，不该冒到控制台
        void el.play().catch(() => {})
      } else {
        el.pause()
      }
    }

    sync()
    document.addEventListener("visibilitychange", sync)
    return () => document.removeEventListener("visibilitychange", sync)
  }, [paused])

  return (
    <video
      ref={ref}
      className={`backdrop-video ${className}`}
      style={{ objectPosition: position }}
      src={media.url}
      /* 首帧解出来之前先顶上取样帧，免得转场中间闪一下黑 */
      poster={media.poster}
      muted
      loop
      playsInline
      preload="auto"
    />
  )
}
