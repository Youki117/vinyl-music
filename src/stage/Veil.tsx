import { useEffect, useRef, useState } from "react"

import { useStageFit } from "./useStageFit"
import { useTintPhase } from "./useTintPhase"
import { VeilRenderer } from "./veil/renderer"
import { useSkin } from "@/store/skin"

/**
 * L1 白色蒙版。
 *
 * **没有动画循环 —— 只在参数或尺寸变化时画一帧。**
 *
 * 原来这里挂着一条时钟订阅，按 0.5/12/60fps 三档持续重画，60fps 那档还每帧从引擎
 * 取一次频谱包络喂给着色器（蒙版跟随音乐波动）。实测那套逐帧驱动要吃掉播放时约
 * 四分之一的 CPU（scripts/perf/dbg-veil-cpu.mjs：律动开 38.6% vs 关 27.8%），而观感
 * 达不到预期，所以整条驱动链连同 audio/analyser.ts 一起删掉了。
 *
 * 保留着色器而不是换成一张静态 PNG：边缘位置、羽化、蜿蜒、颜色四个参数都还要能调，
 * 三色自动取色也是靠改颜色参数生效的。一次性渲染的开销本来就和贴张图差不多。
 *
 * 渲染器仍然是被动的：本组件负责把参数喂进去并决定何时画，渲染器不认识 React。
 */
export default function Veil() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<VeilRenderer | null>(null)
  const [fallback, setFallback] = useState(false)
  const fit = useStageFit()
  const veil = useSkin((s) => s.skin.veil)

  /*
   * 蒙版色：自动取色开着且真的取到了色，就用底图的主色，按播放进度每首歌换三次；
   * 否则用皮肤里存的 tint。
   *
   * 自动色**只在这里生效，不写回皮肤**。写回去的话一首歌要往配置里落三次盘，
   * 还会把用户存在预设里的颜色悄悄改掉 —— 那正是"用户优先"要防的事。
   */
  const tintAuto = useSkin((s) => s.skin.tintAuto)
  const tintColors = useSkin((s) => s.tintColors)
  const autoOn = tintAuto && tintColors.length > 0
  const phase = useTintPhase(autoOn, tintColors.length || 3)
  const tint = autoOn ? tintColors[Math.min(phase, tintColors.length - 1)] : veil.tint

  // 渲染器的生命周期与 canvas 绑定，与参数变化无关
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const r = VeilRenderer.create(canvas)
    if (!r) {
      // WebGL2 不可用（老显卡 / 远程桌面 / 驱动异常）→ 降级到静态蒙版
      console.warn("[veil] WebGL2 不可用，降级到 CSS 静态蒙版")
      setFallback(true)
      return
    }
    rendererRef.current = r
    return () => {
      r.dispose()
      rendererRef.current = null
    }
  }, [])

  /*
   * 尺寸和参数合并成同一个效果：两者都必须触发重画，而且顺序有讲究 ——
   * 改 canvas 的 width/height 会清空绘制缓冲，先 resize 再 render 才不会留下空白。
   *
   * 依赖里带上 fallback，是因为首帧可能还没建出渲染器（create 失败会走降级），
   * 这个效果要在渲染器就位之后再跑一次。
   */
  useEffect(() => {
    const r = rendererRef.current
    if (!r) return
    r.resize(fit.veilW, fit.veilH)
    r.setParams({ ...veil, tint })
    r.render()
  }, [fallback, fit.veilW, fit.veilH, veil, tint])

  if (fallback) {
    return (
      <div
        className="layer veil-fallback"
        style={{
          background: `linear-gradient(100deg,
            ${tint} 0%,
            ${tint} ${(veil.edgeX - veil.softness) * 100}%,
            transparent ${(veil.edgeX + veil.softness) * 100}%)`,
          opacity: veil.opacity,
        }}
      />
    )
  }

  return <canvas ref={canvasRef} className="layer veil" />
}
