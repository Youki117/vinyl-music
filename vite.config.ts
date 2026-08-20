import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath, URL } from "node:url"
import { readdirSync } from "node:fs"

/*
 * 构建闸门：源码树里放着音源脚本时，默认**不许**产出发布包。
 *
 * src/source/index.ts 用 import.meta.glob 收 builtin/ 下的 *.js —— 目录里放什么就
 * 静默打包什么。自用构建想带上它是合理的，但同一条命令也会被拿去打发布包，那份
 * 聚合音源脚本一旦进了公开安装包，"不随仓库分发"这条线就等于白划了。
 * （这不是假设：本项目第一次打 v0.1.0 就这么把脚本打进 dist 了，发出去之前才发现。）
 *
 * 拦的正是"顺手构建一下"。确实要带就显式声明 VINYL_BUNDLE_SOURCE=1。dev 不拦。
 */
function assertNoAccidentalSourceScript(): void {
  if (!process.argv.includes("build") || process.env.VINYL_BUNDLE_SOURCE === "1") return
  let scripts: string[] = []
  try {
    scripts = readdirSync(fileURLToPath(new URL("./src/source/builtin", import.meta.url))).filter(
      (f) => f.endsWith(".js"),
    )
  } catch {
    return // 目录不存在就是没有脚本
  }
  if (scripts.length === 0) return
  throw new Error(
    [
      `src/source/builtin/ 里有音源脚本（${scripts.join("、")}），它会被打进发布包。`,
      "发布包不该带音源脚本 —— 先把它移出该目录再构建。",
      "确实要带（自用构建）请显式声明：VINYL_BUNDLE_SOURCE=1 npm run tauri build",
    ].join(String.fromCharCode(10)),
  )
}

assertNoAccidentalSourceScript()

// Tauri 期望一个固定端口，且失败时不要静默换端口
const HOST = process.env.TAURI_DEV_HOST

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  plugins: [
    react(),
  ],
  resolve: {
    /*
     * 用**数组形式**而不是对象形式。
     *
     * 对象形式的 key 是**前缀匹配**：写 `process` 会把 `process/browser` 也改写成
     * `process/browser/browser`，构建当场失败。更坑的是失败的前端构建**不会拦住
     * `tauri build`** —— 它会拿着上一次的 dist 继续打包，于是产物哈希一直不变、
     * 改什么都"没生效"。这个坑排查了很久，所以凡是可能撞前缀的一律用正则精确匹配。
     */
    alias: [
      { find: "@", replacement: p("./src") },

      /*
       * musicSdk 里的裸模块别名。这些 import 路径原样留在 vendored 代码里
       * （原则是不改上游文件，见 src/vendor/lx-music/UPSTREAM.md），所以在这里指到垫片。
       *
       * @renderer/utils 指向**目录**而不是文件：既要满足 `from '@renderer/utils'`
       * （解析到目录下的 index.ts），也要满足
       * `from '@renderer/utils/musicSdk/kg/vendors/infSign.min'`（解析回 vendored 内部）。
       * 所以这一条必须用前缀匹配，排在最后。
       */
      { find: "@renderer/store", replacement: p("./src/vendor/lx-music/store.ts") },
      // 必须排在 @renderer/utils 之前（那条是前缀匹配）。酷狗的 UMD 签名库要单独包一层，
      // 理由与踩过的两条弯路见 stubs/infSign.ts
      {
        find: "@renderer/utils/musicSdk/kg/vendors/infSign.min",
        replacement: p("./src/vendor/lx-music/stubs/infSign.ts"),
      },
      { find: "@common/ipcNames", replacement: p("./src/vendor/lx-music/ipc.ts") },
      { find: "@common/rendererIpc", replacement: p("./src/vendor/lx-music/ipc.ts") },
      { find: "@common/utils/lyricUtils/kg", replacement: p("./src/vendor/lx-music/lyricUtils/kg.js") },
      { find: "@renderer/utils", replacement: p("./src/vendor/lx-music") },

      /*
       * node 内置模块的浏览器实现。
       *
       * musicSdk 跑在 Electron 渲染进程里，直接 import 了 node 的 crypto 与 zlib：
       * QQ 的 signRequest、网易的 eapi 加密、酷狗 KRC 歌词解压都要用，是接口能不能通的
       * 硬依赖，绕不过去。
       *
       * 一度用 vite-plugin-node-polyfills，打包后 `buffer` 被 CJS interop 包错，产物里
       * `d.Buffer` 是 undefined，musicSdk 一加载就炸。改成逐个显式别名，指向哪一目了然。
       *
       * 全部用 /^x$/ 精确匹配，理由见上面 alias 的注释。
       */
      { find: /^crypto$/, replacement: "crypto-browserify" },
      // tx/utils/crypto.js 写的是 `node:crypto`，前缀不同要单独一条，
      // 漏了它 QQ 平台会在运行时炸 "createHash is not a function"
      { find: /^node:crypto$/, replacement: "crypto-browserify" },
      { find: /^zlib$/, replacement: "browserify-zlib" },
      { find: /^stream$/, replacement: "stream-browserify" },
      // browserify-zlib / stream-browserify 内部要 util.inherits、events、assert，
      // 少一个就在运行时炸（实测 "g.inherits is not a function"）
      { find: /^util$/, replacement: "util" },
      { find: /^events$/, replacement: "events" },
      { find: /^assert$/, replacement: "assert" },

      /*
       * dns 只被 musicSdk/utils.js 的 getHostIp/dnsLookup 用到，作用是把域名预解析成 IP
       * 交给请求库做 IP 直连。我们的请求走 Rust 侧的 plugin-http，这层没有意义，
       * 浏览器环境也没有 dns。给个空实现让 import 过得去即可。
       */
      { find: /^dns$/, replacement: p("./src/vendor/lx-music/stubs/dns.ts") },
    ],
  },
  define: {
    // 上游代码里有裸 `global`，浏览器里没有
    global: "globalThis",
  },
  optimizeDeps: {
    // 这几个是 CJS 老包，要预构建成 ESM，否则 dev 下会因为 require 报错
    include: ["crypto-browserify", "browserify-zlib", "stream-browserify", "buffer", "process/browser", "util", "events", "assert"],
  },
  /*
   * 音源脚本跑在 Worker 里（src/source/userApi/worker.ts）。默认的 iife 只影响打包产物，
   * dev server 那边一律按 ES 模块产出 worker 源码 —— 两边不一致的结果是音源功能在 dev
   * 下必崩、打包后才通。这里把打包也钉成 es，与 dev 对齐。
   */
  worker: { format: "es" },
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
