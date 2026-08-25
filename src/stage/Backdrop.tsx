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

      {/*
        淡出的旧底图**只放静帧，不解码**（still），也不给焦点 —— 转场那 600ms 里
        它居中就够了。

        视频底图下这一条是省内存的大头：这里的 key 与下面那层不同（同一段视频重选
        自己时不能撞 key），所以旧底图挪到淡出层是"销毁再新建"而不是移动 —— 从前
        等于为了淡出 600ms 从零再起一条解码管线，还得从头开始播。一段 4K 的管线是
        两三百兆（§10.1），而观众在这 600ms 里看的是一张正在变透明的图，动不动根本
        看不出来。
      */}
      {fading && <Layer key={`fade-${fading.url}`} media={fading} className="backdrop-out" still />}
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
  still = false,
}: {
  media: LoadedMedia
  focus?: { x: number; y: number }
  className: string
  /** 只要静帧，不要解码。视频底图在淡出层用它。 */
  still?: boolean
}) {
  // 不给焦点时留空，让 CSS 里的 center 生效，而不是在这里再写一份默认值
  const position = focus ? `${focus.x * 100}% ${focus.y * 100}%` : undefined

  if (media.kind === "video" && !still) {
    return <VideoLayer media={media} position={position} className={className} />
  }

  /*
   * 一路吃 poster：图片底图的 poster 就是 url 自己，视频底图的是那张取样帧，
   * 所以图片与"静帧模式的视频"在这里是同一条路，不用分叉。
   *
   * 铺法与 .backdrop-video 等价 —— background-size: cover + center 对应
   * object-fit: cover + 默认 object-position，换过去画面不会跳一下。
   */
  return (
    <div
      className={`backdrop-img ${className}`}
      style={{ backgroundImage: `url(${media.poster})`, backgroundPosition: position }}
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

  /*
   * 卸载时**显式解绑**。
   *
   * 只把节点从 DOM 里摘掉是不够的 —— 元素还攥着解码器、参考帧池和那份缓冲，
   * 要等 GC 才还得回去。`probeVideo` 里对探测元素做的就是这一套（"只丢引用的话
   * 它还攥着解码器和这份 blob 不放"），挂载着的这个同样需要，之前漏了。
   *
   * 差别在换底图的峰值上：一段 4K 视频的解码管线是两三百兆（§10.1），不主动还
   * 就会拖出一条十几秒的长尾，连切几段时几条尾巴叠在一起，峰值能翻几倍。
   *
   * 必须单独一个空依赖的 effect：合进上面那个的话，`paused` 一变清理就会跑，
   * 等于每次暂停都把视频源拆了。
   */
  useEffect(() => {
    const el = ref.current
    return () => {
      if (!el) return
      el.pause()
      el.removeAttribute("src")
      el.load()
    }
  }, [])

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
