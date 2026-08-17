/**
 * 蒙版渲染器。纯 TS，不认识 React、不认识播放器 —— 只接受一组参数，
 * 所以可以脱离应用单独驱动测试。
 *
 * **只在参数变化时画一次**，没有动画循环。因此上下文必须开 preserveDrawingBuffer，
 * 否则内容被合成一次之后就变成未定义，画面会随机变空。
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
  /**
   * 边缘起伏强度 0..1。
   *
   * 旧名 `breath`（配合已删除的音频波动做"静音时的呼吸"）。现在没有任何东西在动，
   * 它就是一个纯静态的形状参数：控制那条 S 形边缘起伏得多厉害。
   */
  ripple: number
  /** 边缘大尺度蜿蜒幅度 */
  wander: number
}

/**
 * 渲染相位。曾经是流逝的时间，现在是个常量 —— 蒙版不动了。
 * 换个值会得到另一副雾的形状，留着这个自由度是为了以后需要时能当风格旋钮用。
 */
const PHASE = 0

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
  ripple: 1,
  wander: 0.12,
}

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
    // info log 为 null 通常意味着上下文已丢失，而不是源码有语法错误
    const kind = type === gl.VERTEX_SHADER ? "顶点" : "片元"
    const lost = gl.isContextLost() ? "（上下文已丢失）" : ""
    throw new Error(`${kind}着色器编译失败${lost}: ${log ?? "无 info log"}`)
  }
  return sh
}

type Uniforms = Record<string, WebGLUniformLocation | null>

export class VeilRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private u: Uniforms = {}
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
      // 只画一次就不再画了。不保留绘制缓冲的话，内容被合成一次之后按规范就是未定义的，
      // 画面会在某些时机（窗口切换、重新合成）随机变空。
      preserveDrawingBuffer: true,
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
      "uRipple",
      "uWander",
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

  /**
   * 宽高是物理像素，不是 CSS 像素。
   *
   * 返回是否真的改了尺寸 —— 改 canvas 的 width/height 会清空绘制缓冲，调用方据此
   * 决定要不要补一次 render()。以前每帧都画，丢一帧无所谓；现在不补就是一直空着。
   */
  resize(width: number, height: number): boolean {
    const c = this.gl.canvas as HTMLCanvasElement
    if (c.width === width && c.height === height) return false
    c.width = width
    c.height = height
    return true
  }

  /** 画一帧。参数或尺寸变了才需要调，没有动画循环。 */
  render(): void {
    if (this.disposed || !this.program) return
    const { gl, u, params } = this
    const c = gl.canvas as HTMLCanvasElement
    gl.viewport(0, 0, c.width, c.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)

    gl.uniform1f(u.uTime!, PHASE)
    gl.uniform1f(u.uEdgeX!, params.edgeX)
    gl.uniform1f(u.uSoftness!, params.softness)
    gl.uniform1f(u.uOpacity!, Math.min(params.opacity, 0.92))
    gl.uniform3fv(u.uTint!, hexToRgb(params.tint))
    gl.uniform1f(u.uRipple!, params.ripple)
    gl.uniform1f(u.uWander!, params.wander)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const { gl } = this
    if (this.program) gl.deleteProgram(this.program)

    // 刻意不调 WEBGL_lose_context.loseContext()：canvas 元素与 GL 上下文是
    // 一一绑定的，一旦丢弃，后续在同一个 canvas 上 getContext('webgl2') 拿回的
    // 还是那个已失效的上下文，着色器编译会永久失败。React StrictMode 的
    // 挂载→清理→再挂载正好会触发这条路径，表现是蒙版静默降级成 CSS 渐变而
    // 且不报有效错误（getShaderInfoLog 返回 null）。删掉自己创建的资源即可，
    // 上下文随 canvas 一起回收。
  }
}
