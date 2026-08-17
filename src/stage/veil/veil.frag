#version 300 es
precision highp float;

// 白色蒙版及其雾化右缘。
//
// 这层的存在理由见 docs/TECH-DESIGN.md §4.3：CSS 渐变做得出"柔和"，做不出
// 目标图那种不规则、不等宽、带云絮质感的边界。
//
// **现在它只在参数变化时画一次，不再逐帧动。** 原来的「蒙版跟随音乐做 S 型波动」
// 已删：实测那套逐帧驱动要吃掉播放时约四分之一的 CPU，而观感达不到预期。
//
// 留着着色器而不是换成一张静态 PNG，是因为边缘位置、羽化、蜿蜒、颜色四个参数都还要
// 能调（三色自动取色也是靠改颜色参数生效的）；而一次性渲染的开销本来就和贴张图差不多。

in  vec2 vUv;              // 舞台内归一化坐标，(0,0) = 左下
out vec4 fragColor;

uniform float uTime;       // 相位。渲染器传的是常量 —— 蒙版只在参数变化时画一次，不再逐帧动
uniform float uEdgeX;      // 静止边缘位置
uniform float uSoftness;   // 过渡带半宽
uniform float uOpacity;    // 蒙版最大不透明度（上限 0.92，底图必须能透出来）
uniform vec3  uTint;       // 蒙版色，线性 0..1
uniform float uRipple;     // 边缘起伏强度 0..1（原 uBreath；不再有音频驱动）
uniform float uWander;     // 边缘大尺度蜿蜒幅度，实测参考图约 0.13

#ifndef OCTAVES
#define OCTAVES 4
#endif

/**
 * 晶格伪随机。
 *
 * ⚠ 这里**不能**用最常见的 `fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)`。
 * 那个写法要求 sin 在幅角变大后仍有足够精度，而这依赖具体 GPU 的实现：
 * 实测 Intel Arc（ANGLE → D3D11）上，fbm 叠到第三四个八度时相邻晶格点会被映射到
 * 同一个值，整块晶格变成平的 —— 因为晶格是 floor(p) 的整数网格，塌陷出来的就是
 * **轴对齐的硬边矩形**，画面上一眼可见。
 *
 * 实测对比（scripts/perf/dbg-hash.mjs，同一块卡，fbm(x*3, y*6) 渲染到 256×256）：
 *   sin 写法    相邻像素最大跳变 52 级，硬边像素 2804
 *   整数写法    相邻像素最大跳变 10 级，硬边像素 1705   ← 剩下的是正常高频噪声
 *
 * 这个坑之前没暴露，是因为视觉回归跑在 headless Chromium 上 —— 那是 SwiftShader
 * 软件光栅，sin 算得准，图是完美的。**软件路径下"复现不出来"什么也不能说明。**
 *
 * 换成纯整数位运算之后不碰任何超越函数，与 GPU 的 sin 实现无关；顺带还解决了
 * "uTime 越大幅角越大、画面跑久了越糟"的隐患。
 */
uint hashU(uvec2 x) {
  uint h = x.x * 374761393u + x.y * 668265263u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

float hash(vec2 p) {
  // p 传进来的一定是 floor 过的整数值，转 int 是精确的；
  // 加偏移只是让坐标离零远一点，负值本身对哈希无碍
  return float(hashU(uvec2(ivec2(p) + 4096))) / 4294967295.0;
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i),             hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < OCTAVES; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  float y = vUv.y;

  // ① S 型行波。1.5 个波长跨越画面高度 —— 这正是"S 形"的来源；
  //    再叠一个 3.7 的波数，两者不可通约，肉眼看不出周期重复。
  float slow = sin(6.2831853 * (y * 1.5) + uTime * 0.55);
  float fast = sin(6.2831853 * (y * 3.7) - uTime * 0.90 + 1.7);

  // ② 起伏强度。这里原本接的是 16 段频谱包络（蒙版跟着音乐波动），已删除：
  //    实测那套逐帧驱动要吃掉播放时约四分之一的 CPU，而效果达不到预期。
  //    数学形状原样保留，只是驱动源从"频谱"换成了一个静态参数 ——
  //    以后想换别的驱动方式，接回这里即可。
  float drive = uRipple * 0.18;
  float wave  = (slow * 0.60 + fast * 0.25) * (0.35 + 0.65 * drive);

  // ③ 大尺度游走。实测参考图的边缘沿竖直方向蜿蜒达画面宽度的 11%~13%
  //    （scripts/analyze-ref.mjs），这才是"看不出是渐变"的主因 —— 只靠细噪声
  //    远远不够。低频噪声负责这段蜿蜒。
  float wander = fbm(vec2(0.7, y * 1.8) + uTime * 0.02) - 0.5;

  // ④ 云絮质感：细噪声同时扰动边缘位置与过渡带宽度。
  //    "宽度本身沿竖直方向变化"是与纯线性渐变拉开差距的另一半原因。
  float grain = fbm(vec2(vUv.x * 3.0, y * 6.0) + uTime * 0.03);

  float edge = uEdgeX
             + wander * uWander
             + (grain - 0.5) * uSoftness * 0.6
             + wave * 0.06 * uRipple;
  float soft = uSoftness * (0.7 + 0.6 * grain);

  float a = (1.0 - smoothstep(edge - soft, edge + soft, vUv.x)) * uOpacity;

  // ⑤ 径向亮斑。参考图的白区不是均匀一片 —— 亮度在左中部有个明显的热点，
  //    向四角衰减。少了这层，白区会显得像一块平涂的色板。
  vec2 d = (vUv - vec2(0.20, 0.48)) * vec2(1.0, 0.62);
  a *= mix(0.62, 1.0, 1.0 - smoothstep(0.10, 0.60, length(d)));

  // ⑥ 合成。canvas 是 premultipliedAlpha，所以 rgb 要预乘 —— 写成
  //    vec4(uTint, a) 会在过渡带出现一圈白边。
  fragColor = vec4(uTint * a, a);
}
