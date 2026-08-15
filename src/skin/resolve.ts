import type { CSSProperties } from "react"
import type { LabelFocus, Skin } from "./model"

/**
 * 唱片贴纸不另存一张图，而是把同一张底图用不同的 background-size /
 * background-position 呈现 —— 省一份存储，也保证贴纸与底图永远同步。
 *
 * @param imgW/imgH 原图像素尺寸
 */
export function labelBackground(
  url: string,
  focus: LabelFocus,
  imgW: number,
  imgH: number,
): CSSProperties {
  if (imgW <= 0 || imgH <= 0) return { backgroundImage: `url(${url})`, backgroundSize: "cover" }

  const zoom = Math.max(1, focus.zoom)
  // 取景框是正方形，边长 = 短边 / zoom
  const side = Math.min(imgW, imgH) / zoom
  const scaleX = (imgW / side) * 100
  const scaleY = (imgH / side) * 100

  // background-position 的百分比语义是"图片该点对齐容器该点"，
  // 焦点落在 0..1 时需要按 (f - 0) / (1 - side/img) 换算，否则边缘处会跑偏
  const spanX = 1 - side / imgW
  const spanY = 1 - side / imgH
  const px = spanX > 0 ? clamp01((focus.x - side / imgW / 2) / spanX) : 0.5
  const py = spanY > 0 ? clamp01((focus.y - side / imgH / 2) / spanY) : 0.5

  return {
    backgroundImage: `url(${url})`,
    backgroundSize: `${scaleX}% ${scaleY}%`,
    backgroundPosition: `${px * 100}% ${py * 100}%`,
    backgroundRepeat: "no-repeat",
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 贴纸实际用哪张图：跟随底图，还是单独指定的那张。 */
export function labelSourceId(skin: Skin): string | null {
  return skin.label.source === "backdrop" ? skin.backdrop : skin.label.source
}
