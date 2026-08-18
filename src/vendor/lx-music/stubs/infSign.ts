/**
 * 把酷狗的签名库（UMD 压缩包）接成 ESM。**垫片，不是上游代码。**
 *
 * `musicSdk/kg/vendors/infSign.min.js` 是 UMD，三个分支依次判断：
 *   1. typeof exports === 'object' && typeof module !== 'undefined'  → module.exports = factory()
 *   2. typeof define === 'function' && define.amd                    → define(factory)
 *   3. 都不满足                                                       → globalThis.infSign = factory()
 *
 * ESM 环境里 module / define 都不存在，所以它走第 3 条，把自己挂到全局。
 * 于是这里只要**当副作用导入**，再把全局取出来即可 —— 文件本身没有任何 import/export，
 * 作为副作用模块是合法 ESM，Vite 不会报错。
 *
 * 前面试过两条路，都不行，记在这里免得再走：
 *   - 运行时 `new Function` 当 CommonJS 加载器：dev 能跑，**打包后被 CSP 拦死**
 *     （script-src 没有 unsafe-eval）。放宽 CSP 是拿安全换方便，不做。
 *   - `@rollup/plugin-commonjs`：build 能过，**dev 模式挂**，它会产生 Vite 解析不了的
 *     虚拟模块 `\0commonjsHelpers.js`，页面 500。
 *
 * 关键是**不动 vendored 文件本身**，这样上游更新时 diff 仍然干净。
 */
import "../musicSdk/kg/vendors/infSign.min.js"

const g = globalThis as unknown as { infSign?: (...args: unknown[]) => unknown }

if (!g.infSign) {
  throw new Error("infSign.min.js 没有挂到全局 —— 上游可能改了打包格式，检查 stubs/infSign.ts")
}

export default g.infSign
