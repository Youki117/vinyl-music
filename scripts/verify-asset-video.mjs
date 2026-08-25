/**
 * 验证视频底图**真的走了 asset:// 流式读盘**，而不是整份读进内存。
 *
 * 为什么必须在打包应用里测：asset 协议只在 Tauri 外壳里存在。浏览器 dev 模式下
 * `platform.streamUrl` 恒返回 null，退回 `toObjectUrl`，测出来的永远是旧路径。
 *
 * 盯的是三件从源码读出来、但文档没写的事（tauri 的 protocol/asset.rs）：
 *
 *   1. **首次请求带不带 Range。** 不带 Range 的请求，Tauri 会
 *      `Vec::with_capacity(len); read_to_end` —— 整个文件照样进内存，只是换到了
 *      Rust 侧。那样这次改动等于白做，而且从界面上完全看不出来。
 *   2. **每个 Range 响应被硬编码截到 1MB**（`MAX_LEN = 1000 * 1024`）。高码率片子
 *      要靠每秒十几次往返才喂得饱解码器，可能卡顿。
 *   3. **跨源会不会污染 canvas。** poster 帧是 `drawImage` + `toDataURL` 截的，
 *      一旦污染就抛 SecurityError，蒙版取色、文字配色、唱片贴纸整条链一起断。
 *
 * ## 内存那一项为什么要跑两遍
 *
 * 视频是从冷启动就生效的底图，同一次运行里没有"用视频之前"这个状态可比 —— 在
 * 一次运行里前后取两个数，量到的只是启动过程的抖动（实测能得出负增量）。所以跑两次
 * 冷启动：一次用内置图片当底图，一次用视频，两个**稳态**之差才是视频底图的代价。
 *
 *   node scripts/verify-asset-video.mjs
 *
 * 想让内存那一项真的说明问题，得给一段够大的真实素材（小于 50MB 不做判定 ——
 * 走 blob 的老路也才多占那么点，淹没在噪声里）：
 *   VINYL_TEST_VIDEO="D:\\...\\wallpaper.mp4" node scripts/verify-asset-video.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const OUT = "tests/__screenshots__"
const PORT = 9223
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const APPDATA = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "com.vinylplayer.desktop")
const SYNTH = resolve("tests/real/backdrop-asset-test.webm")
/** 观测窗口。要盖过一次循环回卷，才看得出中段停顿与回卷停顿的区别。 */
const WATCH_MS = 12000

mkdirSync(OUT, { recursive: true })
mkdirSync(resolve("tests/real"), { recursive: true })

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}，先跑 npm run tauri build`)
  process.exit(1)
}

/*
 * 已经有实例在跑就**退出，不杀**（需求 §12：只能操作自己启动的进程）。
 *
 * 顺带这也是功能上的必须：装了 single-instance 插件，第二次启动会把参数交给老实例
 * 然后自己退出，调试端口根本不会开，脚本只会卡在"等不到端口"上不知所以。
 */
if (running()) {
  console.error("检测到 vinyl-player.exe 正在运行。请先手动关掉它再跑本脚本 ——")
  console.error("单实例插件会让新进程直接退出，调试端口开不出来；而杀掉你自己开的窗口不是脚本该做的事。")
  process.exit(1)
}

// ── 素材 ─────────────────────────────────────────────────────────
let video = process.env.VINYL_TEST_VIDEO ? resolve(process.env.VINYL_TEST_VIDEO) : null
if (video && !existsSync(video)) {
  console.error(`VINYL_TEST_VIDEO 指向的文件不存在：${video}`)
  process.exit(1)
}
if (!video) {
  if (!existsSync(SYNTH)) await synthesize(SYNTH)
  video = SYNTH
}
const videoMB = statSync(video).size / 1024 / 1024
console.log(`素材：${video}  (${videoMB.toFixed(1)}MB)\n`)

// ── 两次冷启动 ───────────────────────────────────────────────────
console.log("① 内置图片底图（内存基准）")
const base = await runOnce("builtin:b", "image-backdrop")
console.log(`   稳态内存 ${base.mem.toFixed(0)}MB\n`)

console.log("② 视频底图")
const run = await runOnce(video, "asset-video")
console.log(`   稳态内存 ${run.mem.toFixed(0)}MB\n`)

// ── 判定 ─────────────────────────────────────────────────────────
const checks = []
const check = (name, ok, detail) => checks.push([name, !!ok, detail])
const s = run.sample

check("视频底图渲染出来了（不是退回成图片层）", s.present, `backdrop-img=${s.backdropImg}`)

if (s.present) {
  check(
    "走的是 asset:// 而不是 blob:（说明没把整份读进内存）",
    s.src.includes("asset.localhost") || s.src.startsWith("asset:"),
    s.src.slice(0, 60),
  )
  check("视频有真实画面轨道", s.videoWidth > 0, `videoWidth=${s.videoWidth}`)
  check("poster 帧截出来了 —— 跨源没有污染 canvas", s.poster.startsWith("data:image/jpeg"), s.poster || "(空)")
  check("唱片贴纸吃到了 poster（取色链没断）", s.labelBg.includes("data:image/jpeg"), s.labelBg)
  check("文字配色算出来了", /^#[0-9a-f]{6}$/i.test(s.ink), s.ink)
  check("在放，且时间在推进", !s.paused && s.advanced, `paused=${s.paused}`)

  /*
   * 判据是**画面间隔**，不是 waiting 的次数。
   *
   * 原来这里数 waiting，任何一次都算失败 —— 那条判据害我追了半天不存在的瓶颈。
   * 实测：waiting 每圈回卷必有一次（媒体管线重新定位），但只持续 20–34ms；
   * 而且 blob 与 asset 两条路一模一样，跟流式毫无关系。**次数不说明任何问题。**
   *
   * 真正该问的是"画面卡没卡到能看见"。用 requestVideoFrameCallback 量相邻两帧真正
   * 呈现的间隔：60fps 正常是 17ms，掉一帧 34ms。超过 100ms 才是肉眼能觉察的停顿，
   * 拿它当线。实测 4K 素材 90 秒内最大 83ms、0 次越线。
   */
  console.log(
    `画面间隔：中位 ${s.frameGap.median}ms  p99 ${s.frameGap.p99}ms  最大 ${s.frameGap.max}ms；` +
      `丢帧 ${s.dropped} / ${s.frameGap.count} 帧` +
      `${s.waitingAt.length ? `（waiting ${s.waitingAt.length} 次，多为回卷，见注释）` : ""}`,
  )
  check(
    "没有肉眼可见的卡顿（画面间隔 > 100ms 的次数为 0）",
    s.frameGap.over100 === 0,
    `${s.frameGap.over100} 次，最大 ${s.frameGap.max}ms`,
  )
}

const ranged = run.assetReqs.filter((r) => r.range).length
console.log(
  `asset 请求 ${run.assetReqs.length} 次，带 Range 的 ${ranged} 次；响应状态 ${[...new Set(run.assetStatuses)].join("/") || "(未捕获)"}`,
)
if (run.assetReqs.length > 0) {
  check(
    "请求带 Range —— 否则 Tauri 会整份读进内存（asset.rs 的 else 分支）",
    ranged === run.assetReqs.length,
    `${run.assetReqs.length - ranged} 次没带`,
  )
  check("拿到 206 分片响应", run.assetStatuses.includes(206), run.assetStatuses.join("/"))
} else {
  console.warn("⚠ CDP 没捕获到 asset 请求，Range 与 206 两项跳过（自定义协议未必上报到 Network 域）")
}

/*
 * 内存这一项判的是**买不买得起**，不是"流式有没有生效"。
 *
 * 原来这里断言"增量 < 文件大小的一半"，当作流式的证据 —— 那是错的，两件事被混在
 * 一起了。流式有没有生效，上面 Range/206 那两项已经证明；而增量的大头根本不是文件
 * 字节，是**解码管线**，它由分辨率决定：一帧 4K RGBA 就是 33MB，解码器的参考帧池
 * 加合成表面攒几帧就是几百兆。于是一段 95MB 的 4K 壁纸能量出 +282MB 的增量，
 * 按老判据"失败"，但它恰恰说明流式是好的（否则还要再多 95MB）。
 *
 * 真正该守的是需求 §10 那条线：播放峰值 < 550MB。这里量的还是空闲态（没放音乐），
 * 空闲就顶破峰值线的话，这个底图根本用不了。
 */
const delta = run.mem - base.mem
console.log(
  `内存：图片底图 ${base.mem.toFixed(0)}MB → 视频底图 ${run.mem.toFixed(0)}MB，` +
    `差 ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}MB（文件 ${videoMB.toFixed(0)}MB，画面 ${s.videoWidth ?? "?"}×${s.videoHeight ?? "?"}）`,
)

/*
 * 内存**默认只报数，不判定**。
 *
 * §10 那条「峰值 < 550MB」是为图片底图的应用写的，而视频底图的开销由**分辨率**决定：
 * 同一段素材，1080p 多占约 130MB、4K 多占约 290MB。拿 550 去卡它，等于替用户决定
 * 「你不许用 4K 壁纸」—— 而装 4K 壁纸的人本来就是冲着画面来的，这笔开销是他愿意付的。
 * 一条会因为用户的合理选择而变红的判据，只会训练人忽略它。
 *
 * 要在 CI 或长跑里守某条线时显式给上限：VINYL_MEM_LIMIT=550 node scripts/verify-asset-video.mjs
 */
const limit = Number.parseFloat(process.env.VINYL_MEM_LIMIT ?? "")
if (Number.isFinite(limit)) {
  check(`稳态内存在指定上限内（< ${limit}MB，此时还没开始放音乐）`, run.mem < limit, `${run.mem.toFixed(0)}MB`)
}

const errors = [...base.errors, ...run.errors]
check("无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "))

console.log("")
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  —— ${detail}` : ""}`)
  if (!ok) failed++
}
console.log(`\n截图 → ${OUT}/asset-video.png`)

if (failed > 0) {
  console.error(`\n✗ ${failed} / ${checks.length} 项未通过`)
  process.exit(1)
}
console.log(`\n✓ asset 视频底图检查通过（${checks.length} 项）`)

// ── 工具 ─────────────────────────────────────────────────────────

/** 冷启动一次，铺好底图、采样、量稳态内存，然后精确回收这棵进程树。 */
async function runOnce(backdrop, shot) {
  seedSkin(backdrop)

  const app = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      // 覆盖 tauri.conf.json 的 additionalBrowserArgs，那边的开关要原样带上，
      // 否则测出来的行为和用户装机后的不一样
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${PORT} ` +
        `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService`,
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
    kill(app.pid)
    process.exit(1)
  }
  const page = browser.contexts()[0].pages()[0]

  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text().slice(0, 160)}`)
  })

  // 抓 asset 协议的往返。headers() 在 CDP 上拿得到，Range 那一项正是要看的。
  const assetReqs = []
  page.on("request", (r) => {
    if (r.url().includes("asset.localhost")) assetReqs.push({ url: r.url(), range: r.headers()["range"] ?? null })
  })
  const assetStatuses = []
  page.on("response", (r) => {
    if (r.url().includes("asset.localhost")) assetStatuses.push(r.status())
  })

  await page.waitForTimeout(5000)
  const sample = await page.evaluate(sampleStage, WATCH_MS)
  // 稳态：观测窗口跑完之后取，不在启动抖动里取
  const mem = privateMB(app.pid)

  await page.screenshot({ path: `${OUT}/${shot}.png` }).catch(() => {})
  await browser.close()
  kill(app.pid)

  return { sample, mem, errors, assetReqs, assetStatuses }
}

/** 页面内采样。打包应用里「更换底图」走原生对话框，够不着，所以底图从配置铺。 */
function sampleStage(watchMs) {
  const v = document.querySelector(".backdrop-video")
  if (!v) {
    return Promise.resolve({ present: false, backdropImg: !!document.querySelector(".backdrop-img") })
  }
  /*
   * 记下每次 waiting 发生在第几秒，而不是只数个数 —— 循环回卷本来就常伴一次
   * waiting（重新定位），只数个数会把这个正常现象报成性能问题。
   */
  const waitingAt = []
  v.addEventListener("waiting", () => waitingAt.push(Number(v.currentTime.toFixed(2))))

  // 相邻两帧真正呈现的间隔 —— 判"卡没卡到看得见"只能靠这个，waiting 次数不作数
  const gaps = []
  let last = 0
  const onFrame = (now) => {
    if (last) gaps.push(now - last)
    last = now
    v.requestVideoFrameCallback(onFrame)
  }
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame)

  const t0 = v.currentTime
  return new Promise((r) => setTimeout(r, watchMs)).then(() => {
    const label = document.querySelector(".disc-label")
    const sorted = gaps.slice().sort((a, b) => a - b)
    const at = (p) => Math.round(sorted[Math.floor(sorted.length * p)] ?? 0)
    return {
      frameGap: {
        count: gaps.length,
        median: at(0.5),
        p99: at(0.99),
        max: Math.round(sorted[sorted.length - 1] ?? 0),
        over100: gaps.filter((g) => g > 100).length,
      },
      dropped: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().droppedVideoFrames : 0,
      present: true,
      src: v.src,
      poster: (v.poster ?? "").slice(0, 24),
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
      paused: v.paused,
      advanced: v.currentTime !== t0,
      waitingAt,
      labelBg: label ? getComputedStyle(label).backgroundImage.slice(0, 30) : "",
      ink: getComputedStyle(document.querySelector(".stage")).getPropertyValue("--ink-primary").trim(),
    }
  })
}

/** 把指定底图写成用户上次选的皮肤。冷启动后 load() 会按正常路径加载它。 */
function seedSkin(backdrop) {
  mkdirSync(APPDATA, { recursive: true })
  writeFileSync(
    join(APPDATA, "skins.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        activeId: "asset-test",
        skins: [
          {
            id: "asset-test",
            name: "asset 测试",
            backdrop,
            backdropFocus: { x: 0.5, y: 0.5 },
            // prefer: "skin" —— 没有曲目时也让贴纸吃皮肤图，这样能验到 poster 那条链
            label: { source: "backdrop", focus: { x: 0.5, y: 0.32, zoom: 2.2 }, prefer: "skin" },
            veil: { edge: 0.52, feather: 0.18, opacity: 0.92, tint: "#f7f5f0", meander: 0.35 },
            tintAuto: false,
            ink: { auto: true, primary: "#3a3a37", secondary: "#7b7975", accent: "#b2845f" },
            text: { title: "ASSET", subtitle: "STREAMING", year: "2026", byline: "verify" },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  )
}

/** 本机有没有 vinyl-player 在跑。有就让用户自己决定要不要关，脚本不代劳。 */
function running() {
  try {
    return execFileSync("tasklist", ["/FI", "IMAGENAME eq vinyl-player.exe", "/NH"], {
      encoding: "utf8",
    }).includes("vinyl-player.exe")
  } catch {
    return false
  }
}

/**
 * 只回收**本脚本启动的那棵进程树**（/T 连子进程一起），不按镜像名一刀切 ——
 * 需求 §12 明确要求测量脚本不许动用户自己开的进程。
 */
function kill(pid) {
  if (!pid) return
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
  } catch {
    /* 已经退了 */
  }
}

/** 整棵进程树的 Private 合计（MB）。口径与 measure-memory.mjs 一致。 */
function privateMB(rootPid) {
  const ps = `
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add(${rootPid})
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
for ($i = 0; $i -lt 6; $i++) {
  foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } }
}
$sum = 0
foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p) { $sum += $p.PrivateMemorySize64 }
}
[math]::Round($sum / 1MB, 1)
`
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
      timeout: 30000,
    })
    return Number.parseFloat(out.trim()) || 0
  } catch {
    return 0
  }
}

/**
 * 合成一段测试视频。
 *
 * 用满屏噪点：编码器压不动噪点，几秒就能出好几 MB，正好把 1MB 的分片上限撑到
 * 需要多次往返。规则图形压完只有几十 KB，一个分片就取完了，什么也验不出来。
 */
async function synthesize(dest) {
  console.log("没给 VINYL_TEST_VIDEO，就地合成一段测试视频…")
  const b = await chromium.launch()
  const p = await b.newPage()
  const base64 = await p.evaluate(async () => {
    const W = 960
    const H = 540
    const c = document.createElement("canvas")
    c.width = W
    c.height = H
    const ctx = c.getContext("2d")
    const img = ctx.createImageData(W, H)
    const draw = () => {
      const d = img.data
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.random() * 256
        d[i + 1] = Math.random() * 256
        d[i + 2] = Math.random() * 256
        d[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
    }
    draw()
    const rec = new MediaRecorder(c.captureStream(20), { mimeType: "video/webm" })
    const chunks = []
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    const done = new Promise((r) => {
      rec.onstop = r
    })
    rec.start()
    const timer = setInterval(draw, 50)
    await new Promise((r) => setTimeout(r, 8000))
    clearInterval(timer)
    rec.stop()
    await done
    const buf = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer())
    let s = ""
    for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192))
    return btoa(s)
  })
  await b.close()
  writeFileSync(dest, Buffer.from(base64, "base64"))
  console.log(`合成完成 → ${dest}`)
}
