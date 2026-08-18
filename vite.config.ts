import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import commonjs from "@rollup/plugin-commonjs"
import { fileURLToPath, URL } from "node:url"

// Tauri 期望一个固定端口，且失败时不要静默换端口
const HOST = process.env.TAURI_DEV_HOST

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    /*
     * 洛雪的 musicSdk 跑在 Electron 渲染进程里，直接 import 了 node 的 crypto 与 zlib：
     * 各平台的请求签名（QQ 的 signRequest、网易的 eapi）和酷狗 KRC 歌词解压都要用。
     * 这是接口能不能通的硬依赖，绕不过去，只能补 polyfill。dns 是唯一例外，见下面 alias。
     */
    nodePolyfills({
      include: ["crypto", "zlib", "buffer", "stream", "util"],
      // 必须显式打开全局注入：musicSdk 里多处直接用 `Buffer.from(...)` 而不 import，
      // 只补模块不补全局的话，打包后会在运行时炸 "Cannot read properties of undefined (reading 'from')"。
      globals: { Buffer: true, global: true, process: true },
    }),
    /*
     * 酷狗的签名库 infSign.min.js 是 UMD 格式。Vite 在 src/ 下把 .js 一律按 ESM 处理，
     * 不做 CJS 转换，于是报 "does not provide an export named 'default'"。
     *
     * 一度用 `new Function` 在运行时当 CommonJS 加载器执行它 —— 开发时能跑，**打包后被 CSP 拦死**
     * （script-src 没有 unsafe-eval）。放宽 CSP 是拿安全换方便，不做。改成构建期转换。
     *
     * include 只圈这一个文件，避免误伤其它模块。
     */
    commonjs({ include: [/infSign\.min\.js$/], transformMixedEsModules: true }),
  ],
  resolve: {
    alias: {
      "@": p("./src"),

      /*
       * musicSdk 里的裸模块别名。这些 import 路径原样留在 vendored 代码里
       * （原则是不改上游文件，见 src/vendor/lx-music/UPSTREAM.md），所以在这里指到垫片。
       *
       * @renderer/utils 指向**目录**而不是文件：既要满足 `from '@renderer/utils'`
       * （解析到目录下的 index.ts），也要满足
       * `from '@renderer/utils/musicSdk/kg/vendors/infSign.min'`（解析回 vendored 内部）。
       */
      "@renderer/store": p("./src/vendor/lx-music/store.ts"),
      "@renderer/utils": p("./src/vendor/lx-music"),
      "@common/ipcNames": p("./src/vendor/lx-music/ipc.ts"),
      "@common/rendererIpc": p("./src/vendor/lx-music/ipc.ts"),
      "@common/utils/lyricUtils/kg": p("./src/vendor/lx-music/lyricUtils/kg.js"),

      /*
       * dns 只被 musicSdk/utils.js 的 getHostIp/dnsLookup 用到，作用是把域名预解析成 IP
       * 交给请求库做 IP 直连。我们的请求走 Rust 侧的 plugin-http，这一层没有意义，
       * 浏览器环境也没有 dns。给个空实现让 import 过得去即可。
       */
      dns: p("./src/vendor/lx-music/stubs/dns.ts"),
    },
  },
  // 着色器以字符串导入
  assetsInclude: ["**/*.vert", "**/*.frag"],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: HOST || false,
    hmr: HOST ? { protocol: "ws", host: HOST, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 是 Chromium，可以放心用现代语法
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    // 测试只覆盖纯逻辑，不需要 DOM 环境
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
})
