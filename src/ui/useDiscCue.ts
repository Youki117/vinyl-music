import { useCallback, useEffect, useRef } from "react"

import { usePlayer } from "@/store/player"

/**
 * 换片动效：新的一首**真的开始出声**那一刻，黑胶轻轻淡入。
 *
 * ## 为什么用 Web Animations 而不是 CSS
 *
 * 唱片这三个部件身上，能动的属性只剩下这么几样：
 *
 *   `transform`  被 `.disc` 的 `spin` 占着（旋转必须用 play-state 暂停，不能重设动画，
 *                否则唱片会瞬间弹回 0°，见 Disc.tsx）
 *   `translate`  被布局编辑占着（`--off-disc-*`，用户搬过唱片之后那是它的落点）
 *
 * 动这两样任何一个，唱片要么弹回 0°，要么被扯离用户摆好的位置。剩下 `opacity`、
 * `scale`、`filter` 三样是自由的 —— 而"轻、缓、渐显"要的正好就是这三样，`scale`
 * 是独立属性，和 `transform: rotate()` 叠加而不是覆盖。
 *
 * 至于为什么不写成 CSS 类：`.disc` 已经有一条 `animation` 简写了，再加一条就得把
 * `spin` 的全套参数在第二个规则里重抄一遍（`animation-name: spin, disc-cue` 之后
 * duration / timing / iteration / play-state 全要写成两项的列表），两处各写一份
 * 转速迟早会对不上。`element.animate()` 天然是叠加的，也天然可以重放。
 */

/** 动效时长。够慢才谈得上"缓"，再长就开始拖住换歌的节奏了。 */
const CUE_MS = 760
/** 光晕比唱片多化一会儿，让高光最后落定；三个部件同时到位反而显得硬。 */
const SHEEN_EXTRA_MS = 180
/** 起手的收缩与虚化。幅度必须小 —— 这是"把唱片放上唱盘"，不是"弹出来"。 */
const FROM_SCALE = 0.94
const FROM_BLUR = 7
/** 认领自己的动画用。`getAnimations()` 里还有 CSS 的 spin，不能一起 cancel 掉。 */
const CUE_ID = "disc-cue"

/**
 * 用法：把返回的 ref 挂到唱片、圆环、光照三个部件上（它们是兄弟节点，共用一组
 * 位置变量）。什么时候放、放几次由 player store 的 `cue` 决定，这里不做任何节流 ——
 * 频繁切歌只放一次的逻辑在 store 那边，见 `cuedTrackId` 的说明。
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
    // 0 是初始值，不是"换了一首"。启动时唱片本来就该在那儿，不该凭空淡入一次
    if (cue === 0) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    for (const el of parts.current) {
      // 上一次还没放完就又换歌了：让它就地作废，而不是两条动画叠在一起闪
      for (const running of el.getAnimations()) {
        if (running.id === CUE_ID) running.cancel()
      }
      const sheen = el.classList.contains("disc-lighting")
      el.animate(
        [
          { opacity: 0, scale: String(FROM_SCALE), filter: `blur(${FROM_BLUR}px)` },
          { opacity: 1, scale: "1", filter: "blur(0px)" },
        ],
        {
          duration: CUE_MS + (sheen ? SHEEN_EXTRA_MS : 0),
          /*
           * 起步和收尾都收着，中段稍快。实测过 easeOut（0.22,0.61,0.36,1）——
           * 那条曲线走到四分之一时间就已经 59% 不透明了，唱片像被"弹"出来，
           * 和"轻、缓"是反的。这条在同一处只到 35%，剩下的路慢慢落定。
           */
          easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          // 不保留终值 —— 这几个属性平时归 CSS 管，动画结束就该把它们交还回去
          fill: "none",
          id: CUE_ID,
        },
      )
    }
  }, [cue])

  return collect
}
