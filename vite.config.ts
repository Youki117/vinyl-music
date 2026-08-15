import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath, URL } from "node:url"

// Tauri 期望一个固定端口，且失败时不要静默换端口
const HOST = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
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
