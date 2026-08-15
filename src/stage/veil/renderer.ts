/**
 * 蒙版渲染器。纯 TS，不认识 React、不认识播放器 —— 只接受一组参数和一条 16 段
 * 能量包络，所以可以用假数据单独驱动测试。
 */
import vertSource from "./veil.vert?raw"
import fragSource from "./veil.frag?raw"

export type VeilParams = {
  /** 静止边缘位置，0..1 */
  edgeX: number
  /** 过渡带半宽，0..0.5 */
  softness: number
  /** 蒙版最大不透明度。上限 0.92，底图必须能透出来 */
  opacity: number
  /** 蒙版色，#rrggbb */
  tint: string
  /** 音频波动强度 0..1。静态阶段为 0 */
  waveAmp: number
  /** 静音时的呼吸底噪 0..1 */
  breath: number
  /** 边缘大尺度蜿蜒幅度 */
  wander: number
}

/**
 * 默认值来自 scripts/analyze-ref.mjs 对参考图的实测，不是估的：
 *   edgeX    参考图中位 0.428 / 0.408
 *   softness 过渡带全宽中位 0.188 / 0.178，取半
 *   opacity  白区亮度 P90 为 0.886 / 0.890
 *   wander   边缘沿 y 的起伏幅度 0.130 / 0.106
 */
export const DEFAULT_VEIL: VeilParams = {
  edgeX: 0.42,
  softness: 0.092,
  opacity: 0.89,
  tint: "#f7f5f0",
  waveAmp: 0,
  breath: 1,
  wander: 0.12,
}

export const BAND_COUNT = 16

/** 允许的 fbm 八度数，越小越省 GPU。降级时从 4 往下走。 */
export type Octaves = 2 | 3 | 4

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [1, 1, 1]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error("createShader 失败")
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`着色器编译失败: ${log}`)
  }
  return sh
}

type Uniforms = Record<string, WebGLUniformLocation | null>

export class VeilRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private u: Uniforms = {}
  private bandTex: WebGLTexture
  private bandData = new Uint8Array(BAND_COUNT)
  private params: VeilParams = { ...DEFAULT_VEIL }
  private octaves: Octaves = 4
  private disposed = false

  /** WebGL2 不可用时返回 null，调用方据此降级到静态 PNG 蒙版。 */
  static create(canvas: HTMLCanvasElement): VeilRenderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    })
    if (!gl) return null
    try {
      return new VeilRenderer(gl)
    } catch (err) {
      console.error("[veil] 初始化失败，将降级到静态蒙版", err)
      return null
    }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl

    const tex = gl.createTexture()
    if (!tex) throw new Error("createTexture 失败")
    this.bandTex = tex
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, BAND_COUNT, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.bandData)

    this.buildProgram()
    gl.clearColor(0, 0, 0, 0)
  }

  private buildProgram(): void {
    const { gl } = this
    if (this.program) gl.deleteProgram(this.program)

    // #version 必须是第一行，所以 #define 得插在它后面而不是文件开头
    const frag = fragSource.replace(
      /^(#version[^\n]*\n)/,
      `$1#define OCTAVES ${this.octaves}\n`,
    )
    const vs = compile(gl, gl.VERTEX_SHADER, vertSource)
    const fs = compile(gl, gl.FRAGMENT_SHADER, frag)
    const prog = gl.createProgram()
    if (!prog) throw new Error("createProgram 失败")
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog)
      gl.deleteProgram(prog)
      throw new Error(`着色器链接失败: ${log}`)
    }
    this.program = prog

    this.u = {}
    for (const name of [
      "uTime",
      "uEdgeX",
      "uSoftness",
      "uOpacity",
      "uTint",
      "uWaveAmp",
      "uBreath",
      "uWander",
      "uBands",
    ]) {
      this.u[name] = gl.getUniformLocation(prog, name)
    }
  }

  setOctaves(n: Octaves): void {
    if (this.octaves === n || this.disposed) return
    this.octaves = n
    this.buildProgram()
  }

  get currentOctaves(): Octaves {
    return this.octaves
  }

  setParams(p: Partial<VeilParams>): void {
    this.params = { ...this.params, ...p }
  }

  /** env 长度须为 BAND_COUNT，取值 0..1。 */
  setBands(env: ArrayLike<number>): void {
    for (let i = 0; i < BAND_COUNT; i++) {
      const v = i < env.length ? env[i] : 0
      this.bandData[i] = Math.max(0, Math.min(255, Math.round(v * 255)))
    }
    const { gl } = this
    gl.bindTexture(gl.TEXTURE_2D, this.bandTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BAND_COUNT, 1, gl.RED, gl.UNSIGNED_BYTE, this.bandData)
  }

  /** 宽高是物理像素，不是 CSS 像素。 */
  resize(width: number, height: number): void {
    const c = this.gl.canvas as HTMLCanvasElement
    if (c.width === width && c.height === height) return
    c.width = width
    c.height = height
  }

  render(timeSec: number): void {
    if (this.disposed || !this.program) return
    const { gl, u, params } = this
    const c = gl.canvas as HTMLCanvasElement
    gl.viewport(0, 0, c.width, c.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)

    gl.uniform1f(u.uTime!, timeSec)
    gl.uniform1f(u.uEdgeX!, params.edgeX)
    gl.uniform1f(u.uSoftness!, params.softness)
    gl.uniform1f(u.uOpacity!, Math.min(params.opacity, 0.92))
    gl.uniform3fv(u.uTint!, hexToRgb(params.tint))
    gl.uniform1f(u.uWaveAmp!, params.waveAmp)
    gl.uniform1f(u.uBreath!, params.breath)
    gl.uniform1f(u.uWander!, params.wander)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.bandTex)
    gl.uniform1i(u.uBands!, 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const { gl } = this
    if (this.program) gl.deleteProgram(this.program)
    gl.deleteTexture(this.bandTex)
    gl.getExtension("WEBGL_lose_context")?.loseContext()
  }
}
