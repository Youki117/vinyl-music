/**
 * 在**打包后的真实应用**里跑检查，而不是 vite dev + 浏览器。
 *
 * 为什么必须单独测：浏览器端到端跑的是 platform/browser.ts，绕过了 Tauri 外壳里
 * 三件只有装机后才会生效的东西 ——
 *   1. fs 能力域（capabilities/default.json 的 fs:scope），决定哪些目录读得动；
 *   2. 真实的文件对话框与拖放事件；
 *   3. 配置真的落到 AppData。
 * 这几样在浏览器实现里全是另一套代码，之前一直没有测试覆盖。
 *
 * 做法：WebView2 认 --remote-debugging-port，用它把 CDP 端口开出来，
 * 再用 Playwright 连上去，就能在真实应用里执行脚本。
 *
 * 脚本自己负责起停应用与铺设初始状态 —— 检查里有好几项（默认读不了域外路径、
 * 音量从 0.8 涨到 0.9）只在**冷启动**下成立，连到一个跑热了的实例上会假报失败。
 *
 *   node scripts/verify-packaged.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const OUT = "tests/__screenshots__"
const PORT = 9222
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const APPDATA = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "com.vinylplayer.desktop")

mkdirSync(OUT, { recursive: true })

/** 在 fs:scope 允许范围内（$HOME/Music/**） */
const SCOPED = join(homedir(), "Music", "VinylPlayerTest")
/** 在允许范围之外 —— 大多数人的音乐库其实都在这种地方 */
const UNSCOPED = resolve("tests/real")

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}，先跑 npm run tauri build`)
  process.exit(1)
}
if (!existsSync(join(UNSCOPED, "ProleteR - April Showers.mp3"))) {
  console.error("tests/real/ 下没有素材，先跑 node scripts/fetch-real-assets.mjs")
  process.exit(1)
}

// ── 铺设初始状态 ─────────────────────────────────────────────────
// 关掉可能还开着的实例：能力域与音量都是进程内状态，跑热了会污染判定
try {
  execFileSync("taskkill", ["/IM", "vinyl-player.exe", "/F"], { stdio: "ignore" })
} catch {
  /* 本来就没在跑 */
}

mkdirSync(APPDATA, { recursive: true })
// 清掉设置，让音量回到默认 0.8
rmSync(join(APPDATA, "settings.json"), { force: true })

// 造一份指向能力域之外的曲库，模拟"上次导入的音乐库在 D 盘"
const track = (name, size, title, duration, artist = "ProleteR", album = "Curses From Past Times (EP)") => {
  const id = join(UNSCOPED, name)
  return {
    id,
    ref: { id, name, size, mtime: 0 },
    title,
    artist,
    album,
    duration,
    playCount: 0,
    liked: false,
    lastPlayed: 0,
    addedAt: 1,
  }
}
writeFileSync(
  join(APPDATA, "library.json"),
  JSON.stringify(
    {
      schemaVersion: 2,
      tracks: [
        track("ProleteR - April Showers.mp3", 10764625, "April Showers", 269.06),
        track("ProleteR - Downtown Irony.ogg", 2635135, "Downtown Irony", 261.46),
        // 这首带内嵌封面（mjpeg 250×250），用来验 SMTC 的缩略图
        track(
          "Multi Panel - Christmas With Mr Rice.mp3",
          3854504,
          "Christmas with Mr. Rice",
          233.56,
          "Multi-Panel",
          "Another Day, Another Way",
        ),
      ],
      playlists: [],
      activeView: "all",
      sort: "added",
      sortDesc: false,
    },
    null,
    2,
  ),
  "utf8",
)

// ── 冷启动 ───────────────────────────────────────────────────────
const app = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    // 这个环境变量会**覆盖** tauri.conf.json 里的 additionalBrowserArgs，
    // 所以那边的开关要原样带上，否则测出来的行为和用户装机后的不一样
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService`,
  },
})
app.unref()

let browser = null
for (let i = 0; i < 30 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 700))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) {
  console.error("等不到应用的调试端口")
  process.exit(1)
}
const ctx = browser.contexts()[0]
const page = ctx.pages()[0]
// 前端 init() 里有配置读取与放行，等它跑完
await page.waitForTimeout(2500)

const checks = []
const check = (name, ok, detail) => checks.push([name, !!ok, detail])

const errors = []
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))

// ── 一、确认真的是打包应用而不是浏览器 ───────────────────────────
const env = await page.evaluate(() => ({
  isTauri: "__TAURI_INTERNALS__" in window,
  href: location.href,
  ua: navigator.userAgent.includes("Edg") ? "WebView2" : navigator.userAgent.slice(0, 40),
}))
console.log(`运行环境：${env.href}  (${env.ua})`)
check("跑在 Tauri 外壳里而不是浏览器", env.isTauri)
check("加载的是打包进去的前端资源", env.href.startsWith("http://tauri.localhost") || env.href.startsWith("tauri://"))

// ── 二、fs 能力域：哪些路径读得动 ────────────────────────────────
// 直接调 platform.readFile，绕开界面，单点验证权限
const probe = async (path) =>
  page.evaluate(async (p) => {
    if (!window.__TAURI_INTERNALS__) return { ok: false, err: "no tauri internals" }
    try {
      const bytes = await window.__TAURI_INTERNALS__.invoke("plugin:fs|read_file", {
        path: p,
        options: null,
      })
      return { ok: true, size: bytes?.length ?? bytes?.byteLength ?? 0 }
    } catch (e) {
      return { ok: false, err: String(e).slice(0, 120) }
    }
  }, path)

const grant = async (paths) =>
  page.evaluate(
    async (ps) => {
      try {
        return { ok: true, n: await window.__TAURI_INTERNALS__.invoke("allow_paths", { paths: ps }) }
      } catch (e) {
        return { ok: false, err: String(e).slice(0, 140) }
      }
    },
    paths,
  )

// 探测"默认读不了"必须挑一个**不在曲库里**的文件：启动时 ensureReadable 会把
// 曲库里的路径全部放行，拿曲库里的曲目去探，测到的是放行后的状态。
const OUTSIDE = join(UNSCOPED, "Riding Alone - Lullaby.ogg")
const OUTSIDE_LRC = join(UNSCOPED, "ProleteR - April Showers.lrc")

const inScope = await probe(join(SCOPED, "ProleteR - April Showers.mp3"))
const beforeGrant = await probe(OUTSIDE)
const granted = await grant([OUTSIDE, OUTSIDE_LRC])
const afterGrant = await probe(OUTSIDE)
const afterGrantLrc = await probe(OUTSIDE_LRC)

console.log(`\nfs 能力域探测：`)
console.log(`  $HOME/Music 内       ${inScope.ok ? `可读 ${inScope.size} 字节` : `✗ ${inScope.err}`}`)
console.log(`  项目目录（域外）      ${beforeGrant.ok ? "可读" : `按预期被拒 —— ${beforeGrant.err.slice(0, 60)}…`}`)
console.log(`  放行 ${granted.n ?? "?"} 条后再读   ${afterGrant.ok ? `可读 ${afterGrant.size} 字节` : `✗ ${afterGrant.err}`}`)

check("能力域内的文件读得动", inScope.ok, inScope.err)
check(
  "域外路径默认读不了（静态白名单确实在生效）",
  !beforeGrant.ok && /forbidden/i.test(beforeGrant.err ?? ""),
  beforeGrant.ok ? "域外竟然也可读，白名单形同虚设" : beforeGrant.err,
)
check("allow_paths 命令可调用", granted.ok, granted.err)
check("放行之后域外音频读得动了（拖放导入的关键）", afterGrant.ok, afterGrant.err)
check("旁边的 .lrc 也一并放行（外挂歌词的关键）", afterGrantLrc.ok, afterGrantLrc.err)

// ── 三、配置能否真的读写 ─────────────────────────────────────────
// 曾经在这里翻过车：capabilities 里给了 fs:allow-read-file / write-file，
// 却没给 read-text-file / write-text-file —— 两者是独立命令。结果打包后
// 所有 JSON 配置（曲库、设置、皮肤、混音）全部 "not allowed by ACL"，
// 而 vite 开发模式走的是 localStorage，完全照不出来。
// 走应用自己的路径，而不是手搓 invoke：按方向键调音量 → setVolume → save()
// → 防抖 1 秒 → writeConfig("settings")。这样测的是产品真正会跑的那条链。
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
})
await page.waitForTimeout(2200)

const cfg = await page.evaluate(async () => {
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a)
  const opt = { baseDir: 13 } // BaseDirectory.AppData
  const out = {}
  try {
    out.exists = await inv("plugin:fs|exists", { path: "settings.json", options: opt })
  } catch (e) {
    out.existsErr = String(e).slice(0, 140)
  }
  if (out.exists) {
    try {
      // 命令层返回的是字节数组，JS 包装器才负责解码；这里直接调命令就得自己解
      const raw = await inv("plugin:fs|read_text_file", { path: "settings.json", options: opt })
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(new Uint8Array(raw))
      const parsed = JSON.parse(text)
      out.volume = parsed.volume
      out.lastTrackId = parsed.lastTrackId
    } catch (e) {
      out.readErr = String(e).slice(0, 140)
    }
  }
  return out
})
console.log(`\n配置往返：settings.json 存在=${cfg.exists}  volume=${cfg.volume ?? cfg.readErr ?? "—"}`)
console.log(`          上次曲目=${cfg.lastTrackId ?? "—"}`)
check("调音量后设置真的写进了 AppData", cfg.exists === true, cfg.existsErr ?? "settings.json 不存在")
check(
  "写进去的设置读得回来（read_text_file 有授权）",
  typeof cfg.volume === "number",
  cfg.readErr ?? String(cfg.volume),
)
check(
  "音量确实按两次上键涨了（0.8 → 0.9）",
  typeof cfg.volume === "number" && Math.abs(cfg.volume - 0.9) < 0.01,
  String(cfg.volume),
)
check(
  "上次播放的曲目被记下来了（下次启动才恢复得回来）",
  typeof cfg.lastTrackId === "string" && cfg.lastTrackId.length > 0,
  String(cfg.lastTrackId),
)

// ── 四、界面确实渲染出来了 ───────────────────────────────────────
const ui = await page.evaluate(() => ({
  stage: !!document.querySelector(".stage"),
  veil: !!document.querySelector("canvas.veil"),
  veilPainted: (() => {
    const c = document.querySelector("canvas.veil")
    return c ? c.width > 0 && c.height > 0 : false
  })(),
  disc: !!document.querySelector(".disc"),
  title: document.querySelector(".masthead h1")?.textContent ?? "",
}))
console.log(`\n界面：标题「${ui.title}」`)
check("舞台已渲染", ui.stage)
check("蒙版画布存在且有尺寸", ui.veil && ui.veilPainted)
check("黑胶已渲染", ui.disc)

await page.screenshot({ path: `${OUT}/packaged-app.png` })

// ── 五、真实文件系统上的外挂歌词 ─────────────────────────────────
// 走 Rust 侧的 exists + read_file，验证 readSidecar 在打包后确实能命中
const sidecar = await page.evaluate(async (dir) => {
  const lrc = `${dir}\\ProleteR - April Showers.lrc`
  try {
    const bytes = await window.__TAURI_INTERNALS__.invoke("plugin:fs|read_file", {
      path: lrc,
      options: null,
    })
    const text = new TextDecoder().decode(new Uint8Array(bytes))
    return { ok: true, head: text.slice(0, 40).replace(/\n/g, "⏎") }
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 120) }
  }
}, SCOPED)
console.log(`\n外挂歌词：${sidecar.ok ? sidecar.head : sidecar.err}`)
check("真实文件系统上的 .lrc 读得到", sidecar.ok, sidecar.err)
check("读出来的是同步歌词而不是乱码", sidecar.ok && /\[\d\d:\d\d/.test(sidecar.head), sidecar.head)

// ── 六、曲库恢复：上次导入的音乐在能力域之外 ─────────────────────
// 这是最容易翻车、也最难在浏览器里测出来的一条路径：能力域每次启动重建，
// 曲库里存的绝对路径不会自动重新放行。测前已往 AppData 写了一份指向
// D:\Project\… 的 library.json（见 README §校验）。
const restored = await page.evaluate(async () => {
  // 曲库是渲染出来的，直接从界面读比翻 store 稳。
  // 抽屉是切换式的，先看状态再决定按不按，否则上一次跑完留下的开着状态会被按关。
  if (!document.querySelector(".library-drawer")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }))
  }
  await new Promise((r) => setTimeout(r, 600))
  const rows = Array.from(document.querySelectorAll(".lib-main ol li")).map((li) => ({
    title: li.querySelector(".row b")?.textContent ?? "",
    missing: li.getAttribute("data-missing") === "true",
  }))
  return rows
})
console.log(`\n曲库恢复：${restored.length} 条`)
for (const r of restored) console.log(`  ${r.title}${r.missing ? "  ✗ 标记为无法播放" : ""}`)

check("重启后域外曲库被恢复出来", restored.length === 3, `${restored.length} 条`)
check("恢复的曲目没有被标记为无法播放", restored.every((r) => !r.missing))

// 真正读一次文件，确认启动时的放行确实生效（而不是界面上看着有、一播就废）
const playable = await probe(join(UNSCOPED, "ProleteR - Downtown Irony.ogg"))
console.log(`  实际读取域外曲目：${playable.ok ? `可读 ${playable.size} 字节` : `✗ ${playable.err}`}`)
check("域外曲目在启动放行后确实读得动", playable.ok, playable.err)

await page.screenshot({ path: `${OUT}/packaged-library.png` })

// ── 七、SMTC：系统真的看得到这个会话吗 ───────────────────────────
// 只能从系统侧问，WebView 里验证不了。放带内嵌封面那首，顺便验缩略图。
await page.evaluate(async () => {
  const rows = Array.from(document.querySelectorAll(".lib-main ol li .row"))
  const target = rows.find((r) => /Christmas/i.test(r.querySelector("b")?.textContent ?? ""))
  ;(target ?? rows[0])?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
})
await page.waitForTimeout(3500)
const nowPlaying = await page.evaluate(() => document.querySelector(".timing b")?.textContent ?? "")
console.log(`\n正在播放：${nowPlaying}`)

let smtc = {}
try {
  // PowerShell 7 去掉了 WinRT 类型投影，必须用 Windows PowerShell 5.1
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/smtc-probe.ps1")],
    { encoding: "utf8", timeout: 30000 },
  )
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    if (m[1] === "SESSION") (smtc.sessions ??= []).push(m[2])
    else smtc[m[1]] = m[2]
  }
} catch (e) {
  smtc.error = String(e).slice(0, 200)
}

console.log(`系统媒体会话：${(smtc.sessions ?? []).join(", ") || smtc.error || "(无)"}`)
console.log(`  标题 ${smtc.TITLE} / 艺术家 ${smtc.ARTIST} / 状态 ${smtc.STATUS} / 封面 ${smtc.HAS_THUMB}`)

check("Windows 认出了本应用的媒体会话", smtc.SMTC_FOUND === "1", smtc.error ?? "未找到 vinyl 会话")
check("会话里的曲名与正在播的一致", smtc.TITLE === nowPlaying, `${smtc.TITLE} vs ${nowPlaying}`)
check("会话里的艺术家也对得上", smtc.ARTIST === "Multi-Panel", smtc.ARTIST)
check("系统认为正在播放", smtc.STATUS === "Playing", smtc.STATUS)
check("上一首/下一首在系统面板里可用", smtc.CAN_NEXT === "True" && smtc.CAN_PREV === "True", `next=${smtc.CAN_NEXT} prev=${smtc.CAN_PREV}`)
check("内嵌封面传到了系统面板", smtc.HAS_THUMB === "True", smtc.HAS_THUMB)
check(
  "只注册了一个媒体会话（WebView2 自带的那个已关掉）",
  (smtc.sessions ?? []).length === 1,
  (smtc.sessions ?? []).join(", "),
)

// 按钮是亮的，和按下去有反应，是两回事 —— 从系统侧真按一下
let acted = {}
try {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/smtc-probe.ps1"), "-Action", "next"],
    { encoding: "utf8", timeout: 30000 },
  )
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m && m[1] !== "SESSION") acted[m[1]] = m[2]
  }
} catch (e) {
  acted.error = String(e).slice(0, 200)
}
await page.waitForTimeout(2500)
const afterNext = await page.evaluate(() => document.querySelector(".timing b")?.textContent ?? "")
console.log(`从系统面板按「下一首」：${nowPlaying} → ${afterNext}`)

check("系统面板的「下一首」被系统接受", acted.ACTION_OK === "True", acted.error ?? acted.ACTION_OK)
check("按下之后应用真的换了歌（事件回到了应用里）", afterNext !== nowPlaying && afterNext.length > 0, `${nowPlaying} → ${afterNext}`)

await browser.close()
try {
  execFileSync("taskkill", ["/IM", "vinyl-player.exe", "/F"], { stdio: "ignore" })
} catch {
  /* 已经退了 */
}

// ── 判定 ─────────────────────────────────────────────────────────
check("无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "))

console.log("")
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  —— ${detail}` : ""}`)
  if (!ok) failed++
}
console.log(`\n截图 → ${OUT}/packaged-app.png`)

if (failed > 0) {
  console.error(`\n✗ ${failed} / ${checks.length} 项未通过`)
  process.exit(1)
}
console.log(`\n✓ 打包应用检查通过（${checks.length} 项）`)
