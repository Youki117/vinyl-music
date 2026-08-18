/**
 * 把 Buffer / process 挂成全局。**必须在任何 musicSdk 代码之前执行。**
 *
 * 洛雪的 musicSdk 跑在 Electron 渲染进程里，那里 Buffer 和 process 本来就是全局的，
 * 所以代码里直接写 `Buffer.from(...)` 而不 import。搬到浏览器环境后这些标识符不存在，
 * 打包产物一加载就炸 "Cannot read properties of undefined (reading 'from')"。
 *
 * 为什么不用 vite-plugin-node-polyfills 的 globals 选项：它在打包构建里把 `buffer`
 * 模块经 CJS interop 包错了，产物里 `d.Buffer` 是 undefined —— 补了等于没补，
 * 而且报错位置在压缩后的第三方代码里，极难定位。这里显式挂，出问题一眼能看到。
 *
 * 只挂缺失的，不覆盖已有的：万一将来 WebView 自带了，不要把人家的实现踢掉。
 */
import { Buffer } from "buffer"
// @ts-expect-error process/browser 没有类型声明，它就是个 CJS 老包
import process from "process/browser"

const g = globalThis as unknown as Record<string, unknown>

g.Buffer ??= Buffer
g.process ??= process
g.global ??= globalThis
