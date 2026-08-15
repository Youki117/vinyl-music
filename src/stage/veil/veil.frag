#version 300 es
precision highp float;

// 白色蒙版及其雾化右缘。
//
// 这层的存在理由见 docs/TECH-DESIGN.md §4.3：CSS 渐变做得出"柔和"，做不出
// 目标图那种不规则、不等宽、带云絮质感的边界；更要紧的是后续「蒙版跟随音乐
// 做 S 型竖向波动」必须复用同一套管线，CSS 方案到时得推倒重写。
//
// 静态阶段把 uTime 与 uWaveAmp 固定为 0 即可，得到的就是一张不动的雾化蒙版。

in  vec2 vUv;              // 舞台内归一化坐标，(0,0) = 左下
out vec4 fragColor;

uniform float uTime;       // 秒
uniform float uEdgeX;      // 静止边缘位置
uniform float uSoftness;   // 过渡带半宽
uniform float uOpacity;    // 蒙版最大不透明度（上限 0.92，底图必须能透出来）
uniform vec3  uTint;       // 蒙版色，线性 0..1
uniform float uWaveAmp;    // 波动强度 0..1
uniform float uBreath;     // 静音时的呼吸底噪强度 0..1
uniform float uWander;     // 边缘大尺度蜿蜒幅度，实测参考图约 0.13
uniform sampler2D uBands;  // 16x1 频谱包络，R 通道

#ifndef OCTAVES
#define OCTAVES 4
#endif

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
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

  // ② 音频驱动：按高度采样频谱包络。低频在下、高频在上。
  float band = texture(uBands, vec2(y, 0.5)).r;

  // 静音时留一层缓慢的呼吸，避免暂停后画面彻底死掉
  float drive = max(band * uWaveAmp, uBreath * 0.18);
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
             + wave * 0.06 * max(uWaveAmp, uBreath);
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
