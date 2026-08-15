#version 300 es
// 全屏三角形：比四边形少一次插值，且没有对角线接缝。
// 不需要顶点缓冲，靠 gl_VertexID 推导。
out vec2 vUv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
