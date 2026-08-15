import { useEffect, useRef, useState } from "react"

import { subscribe, onSustainedSlowdown } from "./clock"
import { useStageFit } from "./useStageFit"
import { VeilRenderer, type Octaves } from "./veil/renderer"
import { useSkin } from "@/store/skin"

/**
 * L1 白色蒙版。
 *
 * 渲染器是被动的：本组件负责把参数喂进去并按时钟驱动它，渲染器自己不认识
 * React 也不认识播放器。
 */
export default function Veil() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<VeilRenderer | null>(null)
  const [fallback, setFallback] = useState(false)
  const fit = useStageFit()
  const veil = useSkin((s) => s.skin.veil)

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

  useEffect(() => {
    rendererRef.current?.resize(fit.deviceW, fit.deviceH)
  }, [fit.deviceW, fit.deviceH])

  useEffect(() => {
    rendererRef.current?.setParams(veil)
  }, [veil])

  // 掉帧自动降级：先降八度数，再降分辨率（技术文档 §11）
  useEffect(() => {
    return onSustainedSlowdown(() => {
      const r = rendererRef.current
      if (!r) return
      const next = (r.currentOctaves - 1) as Octaves
      if (next >= 2) {
        console.warn(`[veil] 持续掉帧，fbm 八度降至 ${next}`)
        r.setOctaves(next)
      }
    })
  }, [])

  useEffect(() => {
    if (fallback) return
    // 蒙版静止时（waveAmp=0 且 breath=0）没必要 60fps 重画同样的画面
    const still = veil.waveAmp === 0 && veil.breath === 0
    return subscribe((t) => rendererRef.current?.render(t), still ? 0.5 : 60)
  }, [fallback, veil.waveAmp, veil.breath])

  if (fallback) {
    return (
      <div
        className="layer veil-fallback"
        style={{
          background: `linear-gradient(100deg,
            ${veil.tint} 0%,
            ${veil.tint} ${(veil.edgeX - veil.softness) * 100}%,
            transparent ${(veil.edgeX + veil.softness) * 100}%)`,
          opacity: veil.opacity,
        }}
      />
    )
  }

  return <canvas ref={canvasRef} className="layer veil" />
}
