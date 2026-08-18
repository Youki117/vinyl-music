/**
 * 音源端到端：**发真实网络请求**搜索一首歌，验证 musicSdk 在我们的环境里跑得通。
 *
 * 为什么必须打真实接口：这套代码的全部价值就在于它跟得上平台接口的变化，
 * 用 mock 测等于什么都没测 —— 签名算错、字段改名、加密参数过期，mock 一个都照不出来。
 * 代价是这个脚本依赖网络，平台抽风时会红。所以它不进 CI 的必过项，是手动核查用的。
 *
 * 前置：npm run dev 已在 1420 端口运行。
 *
 *   node scripts/verify-source.mjs            # 全部平台
 *   node scripts/verify-source.mjs kw kg      # 只测指定平台
 */
import { chromium } from "playwright"
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const KEYWORD = process.env.KEYWORD ?? "后来"
const ONLY = process.argv.slice(2)
const ALL = ["kw", "kg", "tx", "wy", "mg"]
const TARGETS = ONLY.length ? ONLY : ALL

const NAMES = { kw: "酷我", kg: "酷狗", tx: "QQ", wy: "网易云", mg: "咪咕" }

const checks = []
const check = (name, ok, detail) => checks.push([name, !!ok, detail])

/**
 * 必须跑在**打包应用里**，不能用普通浏览器。
 *
 * musicSdk 的请求走 `@tauri-apps/plugin-http`，那是 Tauri 注入的 `__TAURI_INTERNALS__.invoke`，
 * 普通 Chromium 里没有（实测报 "Cannot read properties of undefined (reading 'invoke')"）。
 * 而这恰恰是这套东西的要害：请求必须从 Rust 侧发，否则音乐平台的接口全被 CORS 挡死。
 * 所以：起打包应用 → CDP 连进去 → 导航到 dev server（拿得到源码路径，也仍在 Tauri 运行时里）。
 */
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const PORT = 9224
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
})

let browser = null
for (let i = 0; i < 40 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) {
  console.error("连不上打包应用的 CDP，先确认 src-tauri/target/release/vinyl-player.exe 存在")
  app.kill()
  process.exit(1)
}
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"))
const errors = []
page.on("pageerror", (e) => errors.push(e.message))

// 应用自己的源，window.__source 由 App.tsx 挂上（那里写了为什么需要这个入口）
await page.waitForFunction(() => !!window.__source, null, { timeout: 30000 })

console.log(`关键词「${KEYWORD}」，平台：${TARGETS.map((t) => NAMES[t] ?? t).join(" ")}\n`)

for (const source of TARGETS) {
  const got = await page.evaluate(
    async ({ source, keyword }) => {
      try {
        const res = await window.__source.searchMusic(source, keyword, 1, 10)
        return {
          total: res.total,
          count: res.list.length,
          first: res.list[0] ?? null,
        }
      } catch (e) {
        return { err: String(e?.message ?? e) }
      }
    },
    { source, keyword: KEYWORD },
  )

  const label = NAMES[source] ?? source
  if (got.err) {
    check(`${label} 搜索`, false, got.err)
    continue
  }
  check(`${label} 搜索返回结果`, got.count > 0, `${got.count} 条（总计 ${got.total}）`)
  if (got.first) {
    const t = got.first
    check(`${label} 字段归一化正确`, !!t.title && !!t.artist && !!t.id,
      `${t.title} — ${t.artist}｜${t.album || "?"}｜${t.duration || "?"}｜id=${t.id.slice(0, 14)}`)
    check(`${label} 带音质档位`, t.qualities.length > 0, t.qualities.join(",") || "无")
  }
}

/*
 * 音源脚本：加载 → 解析播放地址。
 *
 * 搜索/歌词是 musicSdk 自带的，不需要脚本；**播放地址必须由脚本解析**（上游
 * api-source.js 的 allApi 是空的）。所以这一段才是"能不能听歌"的判据。
 *
 * 脚本目录默认取用户放音源的地方，可用 LX_SCRIPT_DIR 覆盖。没有脚本就跳过，
 * 不算失败 —— 这台机器上没有不代表功能坏了。
 */
const SCRIPT_DIR = process.env.LX_SCRIPT_DIR ?? String.raw`D:\Downloads\洛雪音乐\音源`
const scripts = existsSync(SCRIPT_DIR)
  ? readdirSync(SCRIPT_DIR).filter((f) => f.endsWith(".js"))
  : []

if (!scripts.length) {
  console.log(`
（${SCRIPT_DIR} 下没有音源脚本，跳过播放地址检查）`)
} else {
  const pick = process.env.LX_SCRIPT ?? scripts[0]
  const script = readFileSync(join(SCRIPT_DIR, pick), "utf8")
  console.log(`
音源脚本：${pick}（${(script.length / 1024).toFixed(0)} KB）`)

  const loaded = await page.evaluate(async (src) => {
    try {
      const r = await window.__source.loadUserApi(src)
      return { name: r.info.name, version: r.info.version, sources: Object.keys(r.sources) }
    } catch (e) {
      return { err: String(e?.message ?? e) }
    }
  }, script)

  if (loaded.err) {
    check("音源脚本加载", false, loaded.err)
  } else {
    check("音源脚本加载并初始化", loaded.sources.length > 0,
      `${loaded.name} ${loaded.version}｜支持 ${loaded.sources.join(",")}`)

    // 挑一个脚本支持的平台，搜一首再要播放地址
    const got = await page.evaluate(
      async ({ source, keyword }) => {
        try {
          const res = await window.__source.searchMusic(source, keyword, 1, 5)
          if (!res.list.length) return { err: "搜不到结果" }
          const t = res.list[0]
          const url = await window.__source.getMusicUrl(t)
          return { title: t.title, artist: t.artist, quality: t.qualities[0], url }
        } catch (e) {
          return { err: String(e?.message ?? e) }
        }
      },
      { source: loaded.sources.find((s) => s !== "local") ?? loaded.sources[0], keyword: KEYWORD },
    )

    if (got.err) {
      /*
       * 区分两种失败，别混为一谈：
       *   - 脚本能加载、能发请求、拿回了服务端的错误文案 → **我们的集成是通的**，
       *     是脚本自己被它的服务端拒了（音源脚本寿命很短，过期就 403）
       *   - 加载就挂 / 根本没发出请求 → 那才是我们的问题
       * 前者不该报成代码缺陷，但也不能悄悄放过，所以照样标红并写清原因。
       */
      check("解析播放地址（脚本可能已过期）", false,
        `${got.err}　—— 脚本能加载并发出请求、拿回了服务端应答，说明集成链路通；` +
        `这条错来自音源服务端。换一份新的音源脚本再试。`)
    } else {
      check("解析出播放地址", /^https?:/.test(got.url ?? ""),
        `${got.title} — ${got.artist}｜${got.quality}｜${(got.url ?? "").slice(0, 68)}…`)
    }
  }
}

check("全程无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "))

await browser.close().catch(() => {})
app.kill()

let bad = 0
for (const [n, ok, d] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${n}${d ? `  —— ${d}` : ""}`)
  if (!ok) bad++
}
console.log(bad ? `\n✗ ${bad} / ${checks.length} 项未通过` : `\n✓ 音源检查全部通过（${checks.length} 项）`)
process.exit(bad ? 1 : 0)
