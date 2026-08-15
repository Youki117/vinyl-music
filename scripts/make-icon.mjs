/**
 * 生成应用图标源图：一张黑胶唱片，中心是品牌铜金色。
 * 产物交给 `npx tauri icon` 派生出各尺寸与 .ico。
 *
 *   node scripts/make-icon.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { PNG } from "pngjs"

const S = 1024
const png = new PNG({ width: S, height: S })
const c = S / 2

const ACCENT = [178, 132, 95] // #b2845f

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const dx = x - c
    const dy = y - c
    const r = Math.hypot(dx, dy) / c // 0..1

    if (r > 0.97) {
      png.data[i + 3] = 0 // 圆外透明
      continue
    }

    let rgb
    if (r < 0.13) {
      // 中心标签
      rgb = ACCENT
    } else if (r < 0.155) {
      rgb = [24, 24, 24]
    } else {
      // 沟槽：正弦纹路 + 斜向高光
      const groove = 0.5 + 0.5 * Math.sin(r * 190)
      const base = 12 + groove * 16
      const sheen = Math.max(0, Math.cos(Math.atan2(dy, dx) - 2.4)) ** 6 * 46
      const v = Math.min(255, base + sheen)
      rgb = [v, v, v]
    }

    // 边缘一圈抗锯齿
    const alpha = r > 0.94 ? Math.round(255 * (1 - (r - 0.94) / 0.03)) : 255
    png.data[i] = rgb[0]
    png.data[i + 1] = rgb[1]
    png.data[i + 2] = rgb[2]
    png.data[i + 3] = Math.max(0, Math.min(255, alpha))
  }
}

mkdirSync("src-tauri", { recursive: true })
writeFileSync("src-tauri/app-icon.png", PNG.sync.write(png))
console.log("已生成 src-tauri/app-icon.png (1024×1024)")
