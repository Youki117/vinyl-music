/**
 * 验证假设：veil.frag 的 sin-hash 在这块 GPU 上塌陷，导致噪声晶格变成实心矩形。
 *
 * 线索链：
 *   1. 藏掉蒙版画布，矩形消失            → 来源是蒙版
 *   2. 画布 dpr1 下 1:1，频谱纹理 LINEAR  → 不是缩放也不是纹理阶梯
 *   3. 帧间差分的边缘是笔直的水平/竖直台阶 → 轴对齐 ⇒ 噪声晶格
 *   4. headless（SwiftShader 软件光栅）完全正常，真机 Intel Arc 有问题 → GPU 相关
 *
 * `fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)` 是最常见的 GLSL 伪随机写法，
 * 也是最脆的：它要求 sin 在大幅角上仍有足够精度。不同厂商的 sin 实现（尤其是走 ANGLE
 * → D3D11 的快速近似）在幅角变大后会丢精度，相邻晶格点被映射到同一个 hash 值 ——
 * 于是整块晶格变成同一个值，表现就是**轴对齐的实心矩形**。
 *
 * 做法：在真实 WebView2 里编译同一套 hash/noise/fbm，渲染到离屏画布再读回像素，
 * 和 CPU 上用双精度算的同一函数逐像素比。GPU 与 CPU 结构性不一致就坐实了。
 *
 *   node scripts/perf/dbg-hash.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { PNG } from "pngjs"

const OUT = "tests/__screenshots__"
const PORT = 9226
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const N = 256 // 渲染尺寸
mkdirSync(OUT, { recursive: true })

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}`)
  process.exit(1)
}
const running = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "@(Get-Process -Name vinyl-player -ErrorAction SilentlyContinue).Count"],
  { encoding: "utf8" },
).trim()
if (running !== "0") {
  console.error(`已有 ${running} 个实例在跑，先手动关掉`)
  process.exit(1)
}

const app = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${PORT} ` +
      `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService`,
  },
})
app.unref()
const stopApp = () => {
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
  } catch {
    /* 已经退了 */
  }
}

let browser = null
for (let i = 0; i < 30 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 700))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) {
  console.error("等不到调试端口")
  stopApp()
  process.exit(1)
}
const page = browser.contexts()[0].pages()[0]
await page.waitForTimeout(3500)

const result = await page.evaluate((n) => {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = n
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false })
  if (!gl) return { error: "无 WebGL2" }

  const dbg = gl.getExtension("WEBGL_debug_renderer_info")
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "未知"

  const vs = `#version 300 es
  const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
  out vec2 vUv;
  void main(){ vec2 p = P[gl_VertexID]; vUv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`

  // 与 src/stage/veil/veil.frag 完全一致的 hash / noise / fbm
  const fs = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 fragColor;
  uniform int uMode;
  // 现行写法：依赖 sin 在大幅角下的精度
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

  // 候选替代：纯整数位运算，不碰任何超越函数，因此与 GPU 的 sin 实现无关
  uint hashU(uvec2 x){
    uint h = x.x * 374761393u + x.y * 668265263u;
    h = (h ^ (h >> 13)) * 1274126177u;
    return h ^ (h >> 16);
  }
  float hash2(vec2 p){ return float(hashU(uvec2(ivec2(p) + 4096))) / 4294967295.0; }

  float noise(vec2 p, int kind){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    #define H(q) (kind == 0 ? hash(q) : hash2(q))
    return mix(mix(H(i), H(i+vec2(1.,0.)), u.x),
               mix(H(i+vec2(0.,1.)), H(i+vec2(1.,1.)), u.x), u.y);
  }
  float fbm(vec2 p, int kind){
    float v=0.0, a=0.5;
    for(int i=0;i<4;i++){ v += a*noise(p, kind); p *= 2.03; a *= 0.5; }
    return v;
  }
  void main(){
    // 0：晶格上的原始 hash    1：现行 fbm    2：换整数 hash 的 fbm
    float v = uMode == 0 ? hash(floor(vUv * 64.0))
            : uMode == 1 ? fbm(vec2(vUv.x*3.0, vUv.y*6.0), 0)
            :              fbm(vec2(vUv.x*3.0, vUv.y*6.0), 1);
    fragColor = vec4(v, v, v, 1.0);
  }`

  const mk = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "编译失败")
    return s
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs))
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(prog)
  gl.useProgram(prog)
  gl.bindVertexArray(gl.createVertexArray())

  const shots = {}
  for (const mode of [0, 1, 2]) {
    gl.uniform1i(gl.getUniformLocation(prog, "uMode"), mode)
    gl.viewport(0, 0, n, n)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const px = new Uint8Array(n * n * 4)
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px)
    shots[mode] = Array.from(px)
  }
  return { renderer, shots }
}, N)

if (result.error) {
  console.error(result.error)
  stopApp()
  process.exit(1)
}
console.log(`GPU: ${result.renderer}\n`)

/** CPU 双精度参考实现，与着色器逐字对应 */
const hashCpu = (x, y) => {
  const d = x * 127.1 + y * 311.7
  const v = Math.sin(d) * 43758.5453
  return v - Math.floor(v)
}

function analyze(px, label, cpu) {
  const at = (x, y) => px[((N - 1 - y) * N + x) * 4] // readPixels 是上下颠倒的
  const vals = new Set()
  let horizRuns = 0
  for (let y = 0; y < N; y++) {
    vals.add(at(0, y))
    for (let x = 1; x < N; x++) {
      vals.add(at(x, y))
      if (at(x, y) !== at(x - 1, y)) horizRuns++
    }
  }
  // 硬边计数：平滑的 fbm 在这个尺度下相邻像素最多差 1~2 级，
  // 差到 6 级以上只可能是不连续 —— 也就是矩形块的边
  let hardEdges = 0
  let maxJump = 0
  for (let y = 1; y < N; y++) {
    for (let x = 1; x < N; x++) {
      const d = Math.max(Math.abs(at(x, y) - at(x - 1, y)), Math.abs(at(x, y) - at(x, y - 1)))
      if (d >= 6) hardEdges++
      if (d > maxJump) maxJump = d
    }
  }

  console.log(`${label}`)
  console.log(`  不同取值 ${vals.size} / 256`)
  console.log(`  平均每行 ${(horizRuns / N).toFixed(1)} 次变化（256 列）`)
  console.log(`  硬边像素 ${hardEdges}（相邻差 ≥6 级），最大跳变 ${maxJump} 级`)

  if (cpu) {
    // 与 CPU 参考比：取 64×64 晶格上的 hash
    let maxErr = 0
    let same = 0
    for (let gy = 0; gy < 64; gy++) {
      for (let gx = 0; gx < 64; gx++) {
        const px_ = Math.round((gx + 0.5) * (N / 64))
        const py_ = Math.round((gy + 0.5) * (N / 64))
        const gpu = at(Math.min(px_, N - 1), Math.min(py_, N - 1)) / 255
        const ref = hashCpu(gx, gy)
        const err = Math.abs(gpu - ref)
        if (err > maxErr) maxErr = err
        if (err < 0.01) same++
      }
    }
    console.log(`  与 CPU 双精度参考：${same}/4096 个晶格点吻合，最大偏差 ${maxErr.toFixed(3)}`)
    if (same < 4096 * 0.9) {
      console.log(`  ⚠ GPU 的 sin 与 CPU 结果大面积不一致 —— sin-hash 在这块卡上不可靠`)
    }
  }

  const png = new PNG({ width: N, height: N })
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4
      const v = at(x, y)
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

writeFileSync(`${OUT}/hash-lattice.png`, analyze(result.shots[0], "① hash(floor(uv*64))：晶格上的原始 hash", true))
console.log()
writeFileSync(`${OUT}/hash-fbm.png`, analyze(result.shots[1], "② fbm — 现行的 sin hash", false))
console.log()
writeFileSync(`${OUT}/hash-fbm-int.png`, analyze(result.shots[2], "③ fbm — 换成整数位运算 hash", false))

console.log(`\n图：${OUT}/hash-fbm.png（现状）  ${OUT}/hash-fbm-int.png（候选修法）`)
console.log(`两者的"硬边像素"差多少，就是这个改动能消掉多少矩形`)
await browser.close().catch(() => {})
stopApp()
