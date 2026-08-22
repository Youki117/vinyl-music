import { useCallback, useEffect, useRef } from "react"

import { usePlayer } from "@/store/player"

/**
 * 换片动效：新的一首**真的开始出声**那一刻，唱片从斜上方落到唱盘上。
 *
 * 动作照参考稿的「合盖」来（`目标效果.html` 里的 pureVinylPlatterDrop），另加了一层
 * 渐显虚化。取舍过程与六个候选版本的并排对照见仓库根目录的 `落盘动效对照台.html`。
 *
 * ## 唱片身上哪些属性能动
 *
 *   `transform`  被 `.disc` 的 `spin` 占着。旋转必须用 play-state 暂停、不能重设动画，
 *                否则唱片瞬间弹回 0°（见 Disc.tsx）。
 *   `translate`  被布局编辑占着（`--off-disc-*`）—— 用户把唱片搬到哪儿，那就是它的落点。
 *
 * 两样都不能覆盖，但 `translate` 可以**叠加**：WAAPI 的 `composite: "add"` 是加在元素
 * 原有值上而不是替换掉它。实测（元素底值 `120px -40px`）：动画起点得到 `120px -70px`、
 * 终点回到 `120px -40px`、取消后底值完好。所以垂直落差走 translate 是安全的。
 *
 * 剩下的 `scale`、`rotate`、`opacity`、`filter` 在 `.disc` 上都没有 CSS 底值，直接替换即可。
 * 于是分成两条动画：**translate 那条是叠加的，其余那条是替换的**。合成顺序是
 * translate → rotate → scale → transform，所以我们的 X 倾角在 spin 的 Z 自转之前生效，
 * 唱片是绕着自己那根（已经倾斜的）轴转 —— 正好是真唱片的样子。
 *
 * 3D 要成立还得有透视，那必须挂在祖先上：见 ui.css 里 `.content` 的 perspective。
 */

/** 参考稿的节奏。改这一个数就能整体调快调慢。 */
const CUE_MS = 2000
/** 参考稿用的曲线（easeOutQuint）：起步快、尾巴长，落定那一下很慢。 */
const CUE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)"
/** 落差与推近量。z 在 820px 透视下约合放大 6%，和 scale 一起构成「从斜上方递过来」。 */
const FROM_Y = "-32px"
const FROM_Z = "50px"
const FROM_SCALE = "1.05"
const FROM_TILT = "15deg"
/**
 * 渐显虚化的起手量。跟着同一条曲线走 —— 那条曲线前 500ms 就跑完九成，
 * 于是虚化在唱片还没落到底时就已经收干净，读起来是「越近越清晰」，
 * 而不是「一团雾慢慢散开」。
 */
const FROM_BLUR = "10px"

/** 认领自己的动画用。`getAnimations()` 里还有 CSS 的 spin，不能一起 cancel 掉。 */
const CUE_ID = "disc-cue"

/**
 * 用法：把返回的 ref 挂到唱片、圆环、光照三个部件上（它们是兄弟节点，共用一组位置变量）。
 * 什么时候放、放几次由 player store 的 `cue` 决定，这里不做任何节流 —— 频繁切歌只放一次
 * 的逻辑在 store 那边，见 `cuedTrackId` 的说明。
 */
export function useDiscCue(): (el: HTMLElement | null) => void {
  const cue = usePlayer((s) => s.cue)
  const parts = useRef(new Set<HTMLElement>())

  const collect = useCallback((el: HTMLElement | null) => {
    if (!el) return
    parts.current.add(el)
    return () => {
      parts.current.delete(el)
    }
  }, [])

  useEffect(() => {
    // 0 是初始值，不是"换了一首"。启动时唱片本来就该在那儿，不该凭空落一次
    if (cue === 0) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    for (const el of parts.current) {
      // 上一次还没落完就又换歌了：让它就地作废，而不是两条动画叠在一起抖
      for (const running of el.getAnimations()) {
        if (running.id === CUE_ID) running.cancel()
      }
      const timing = {
        duration: CUE_MS,
        easing: CUE_EASING,
        // 不保留终值 —— 这几个属性平时归 CSS 管，动画结束就该把它们交还回去
        fill: "none",
        id: CUE_ID,
      } as const

      // 落差：必须叠加，否则会把用户搬过的位置抹掉
      el.animate([{ translate: `0 ${FROM_Y} ${FROM_Z}` }, { translate: "0 0px 0px" }], {
        ...timing,
        composite: "add",
      })

      // 其余几样在 .disc 上没有 CSS 底值，替换即可
      el.animate(
        [
          {
            scale: FROM_SCALE,
            rotate: `x ${FROM_TILT}`,
            opacity: 0,
            filter: `blur(${FROM_BLUR})`,
          },
          // 参考稿在四成处就基本不透明了。留着这个拐点：透明度早早落定，
          // 后面那一大段长尾就纯粹是「在落」，而不是「在显影」
          { offset: 0.4, opacity: 0.95 },
          { scale: "1", rotate: "x 0deg", opacity: 1, filter: "blur(0px)" },
        ],
        timing,
      )
    }
  }, [cue])

  return collect
}
