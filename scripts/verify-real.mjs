/**
 * 用真实素材端到端实测（不是 ffmpeg 生成的正弦波）。
 *
 * 素材全部来自公开渠道，见 tests/real/SOURCES.md：
 *  - 音频：archive.org 上 CC 授权的 netlabel 发行，带真实 ID3 标签与内嵌封面
 *  - 歌词：lrclib.net 的同步歌词，时长与音频对得上
 *  - 图片：Wikimedia Commons 的公有领域 / CC 授权人像
 *
 * 覆盖：真实标签解析 → 外挂歌词 → 逐字推进 → 间奏收高亮 → 换底图联动
 *      → 真实音频混音 → m3u 导入导出。
 *
 * 前置：npm run dev 已在 1420 端口运行。
 *
 *   node scripts/verify-real.mjs
 */
import { chromium } from "playwright"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const OUT = "tests/__screenshots__"
const REAL = resolve("tests/real")

if (!existsSync(REAL)) {
  console.error("tests/real/ 不存在，先跑 scripts/fetch-real-assets.mjs 下载素材")
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

const all = readdirSync(REAL)
const audio = all.filter((f) => /\.(mp3|ogg|flac|m4a|wav)$/i.test(f)).map((f) => resolve(REAL, f))
const lrc = all.filter((f) => /\.lrc$/i.test(f)).map((f) => resolve(REAL, f))
const images = all.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => resolve(REAL, f))
const m3u = all.filter((f) => /\.m3u8?$/i.test(f)).map((f) => resolve(REAL, f))

if (audio.length < 2 || lrc.length < 1 || images.length < 2) {
  console.error(`素材不足：音频 ${audio.length}（需 ≥2）、歌词 ${lrc.length}（需 ≥1）、图片 ${images.length}（需 ≥2）`)
  process.exit(1)
}

console.log(`音频 ${audio.length}、歌词 ${lrc.length}、图片 ${images.length}、歌单 ${m3u.length}\n`)

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: 1243, height: 688 }, deviceScaleFactor: 1 })

const errors = []
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`)
})

const checks = []
const check = (name, ok, detail) => {
  checks.push([name, !!ok, detail])
}

await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForTimeout(600)

// ── 一、导入真实音频 + 外挂歌词 ───────────────────────────────────
// 歌词与音频一起选中：浏览器实现会把同批文件全部记名，readSidecar 才查得到
const chooser = page.waitForEvent("filechooser")
await page.click('button:has-text("添加音乐文件")')
await (await chooser).setFiles([...audio, ...lrc])
await page.waitForTimeout(3500)

await page.keyboard.press("p")
await page.waitForTimeout(500)
const lib = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".lib-main ol li .row")).map((r) => ({
    title: r.querySelector("b")?.textContent ?? "",
    artist: r.querySelector("span")?.textContent ?? "",
    duration: r.querySelector("em")?.textContent ?? "",
  })),
)
await page.screenshot({ path: `${OUT}/real-library.png` })
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

console.log("导入结果：")
for (const t of lib) console.log(`  ${t.title.padEnd(34)} ${t.artist.padEnd(16)} ${t.duration}`)
console.log("")

check("四个真实音频全部导入", lib.length === audio.length, `${lib.length}/${audio.length}`)
check(
  "标题取自 ID3 标签而非文件名",
  lib.some((t) => t.title === "April Showers"),
  lib.map((t) => t.title).join(" / "),
)
check(
  "艺术家取自标签",
  lib.some((t) => t.artist === "ProleteR") && lib.some((t) => t.artist === "Multi-Panel"),
)
check(
  "时长解析正确（April Showers 应为 04:29）",
  lib.find((t) => t.title === "April Showers")?.duration === "04:29",
  lib.find((t) => t.title === "April Showers")?.duration,
)
check(
  "OGG 的 Vorbis 注释也读得出标题",
  lib.some((t) => /Downtown Irony/i.test(t.title)),
)

// ── 二、播放真实文件 ──────────────────────────────────────────────
// 四个文件里只有 Christmas with Mr. Rice 带内嵌封面（mjpeg 250×250），
// 先放它，验证还没设底图时唱片中心用的是曲目自带的专辑封面
await playTrack(page, lib, (t) => /Christmas/i.test(t.title))
const covered = await readPlayback(page)
check("带内嵌封面的曲目：封面被提取出来当唱片贴纸", covered.labelHasImage)
check("贴纸用的正是内嵌封面而不是别处的图", covered.labelIsCover, covered.labelUrl.slice(0, 40))

await playTrack(page, lib, (t) => t.title === "April Showers")
const playing = await readPlayback(page)
check("真实 MP3 能播放", playing.playing)
check("进度在推进", playing.time > 0.5, `${playing.time.toFixed(2)}s`)
// 进度条上方那段小波形已删（见 src/ui/Progress.tsx），播放路径不再算峰值
check("没有内嵌封面的曲目留空盘，不会串用上一首的封面", !playing.labelHasImage)

// 大标题：在播时显示曲目信息而不是皮肤的装饰文案。
// 原来画面上最大的字永远是 FASHION，真正的歌名只有进度条底下 10px 的小字。
const head = await readMasthead(page)
console.log(`\n大标题：「${head.title}」${head.titlePx}px / 「${head.subtitle}」/「${head.third}」`)
check("在播时大标题换成歌名", head.title === "April Showers", head.title)
check("副标题换成艺术家", head.subtitle === "ProleteR", head.subtitle)
check(
  "歌名比装饰文案长，字号自动缩过（不再是 97px）",
  head.titlePx > 0 && head.titlePx < 97,
  `${head.titlePx}px`,
)
check("缩完仍在容器内，没压到黑胶上", head.overflow <= 1, `溢出 ${head.overflow}px`)

// ── 三、外挂歌词 ──────────────────────────────────────────────────
// April Showers 的歌词第一句是 [01:02.27]，第二句 [01:03.96]，跳到两者之间
await seekTo(page, 63)
const atVerse = await readLyrics(page)
console.log(`\n01:03 处歌词：「${atVerse.active}」`)
check("外挂 .lrc 被自动挂上并显示", atVerse.lines.length > 0)
check(
  "当前行是歌词第一句",
  /March winds and April showers/i.test(atVerse.active),
  atVerse.active,
)
await page.screenshot({ path: `${OUT}/real-lyrics.png` })

await seekTo(page, 68)
const atNext = await readLyrics(page)
check("时间前进后当前行跟着换", atNext.active !== atVerse.active, `${atVerse.active} → ${atNext.active}`)

// 当前行必须钉在同一个高度，歌词从它下面滚过去 —— 这是和主流播放器观感差距最大的一点。
// 原实现按 active±3 切片渲染，歌刚开始时当前行贴在栏顶，唱到第四句才挪到中间。
// 这个 bug 对拍脚本一直发现不了：占位歌词把 active 硬编码成 2，截图里永远是居中的。
await seekTo(page, 240) // 歌快唱完，当前行序号很大
const atLate = await readLyrics(page)
console.log(`当前行 y：01:03 处 ${atVerse.activeY}px，01:08 处 ${atNext.activeY}px，04:00 处 ${atLate.activeY}px`)
check(
  "当前行始终固定在同一高度（整首歌不漂移）",
  atVerse.activeY !== null &&
    Math.abs(atNext.activeY - atVerse.activeY) <= 2 &&
    (atLate.activeY === null || Math.abs(atLate.activeY - atVerse.activeY) <= 2),
  `${atVerse.activeY} / ${atNext.activeY} / ${atLate.activeY}`,
)
check(
  "当前行上方留出了两行的位置，不是贴着栏顶",
  atVerse.activeY >= 40 && atVerse.activeY <= 62,
  `${atVerse.activeY}px`,
)

// 间奏：01:21.72 唱完，下一句要到 02:03。这段时间不该继续高亮
await seekTo(page, 95)
const atGap = await readLyrics(page)
console.log(`01:35（间奏）高亮行数：${atGap.activeCount}`)
check("间奏期间高亮被收掉，不会让上一句挂着 45 秒", atGap.activeCount === 0)

// ── 四、逐字歌词 ──────────────────────────────────────────────────
// Downtown Irony 挂的是词级时间戳版本
await playTrack(page, lib, (t) => /Downtown Irony/i.test(t.title))

// [01:06.48] 那句最长（到 01:11.76，5.3 秒），采样窗口留在它内部才比得出单调性
await seekTo(page, 67)
const fillA = await readFill(page)
await page.waitForTimeout(1200)
const fillB = await readFill(page)
console.log(`逐字擦除：${fmtFill(fillA)} → ${fmtFill(fillB)}（行：「${fillB.line}」）`)
await page.screenshot({ path: `${OUT}/real-lyrics-word.png` })

check("逐字擦除层已渲染", fillA.has || fillB.has)
check("两次采样落在同一句内", fillA.line === fillB.line && fillA.line !== "", `${fillA.line} / ${fillB.line}`)
check(
  "同一句内擦除进度随时间推进",
  fillB.has && fillA.has && fillB.pct > fillA.pct,
  `${fmtFill(fillA)} → ${fmtFill(fillB)}`,
)
check(
  "擦除比例落在 0–100% 之间",
  !fillB.has || (fillB.pct >= 0 && fillB.pct <= 100),
  fmtFill(fillB),
)
check(
  "逐字模式下当前行不是一进来就整行点亮",
  !fillA.has || fillA.pct < 99,
  fmtFill(fillA),
)

// ── 五、换底图（核心需求）────────────────────────────────────────
const skinBefore = await readSkin(page)
const c1 = page.waitForEvent("filechooser")
await page.click('button[aria-label="更换底图"]')
await (await c1).setFiles(images[0])
await page.waitForTimeout(1600)
const skin1 = await readSkin(page)
await page.screenshot({ path: `${OUT}/real-skin-1.png` })

check("底图铺上去了", skin1.backdropCount > 0)
check("底图 cover 铺满", skin1.backdropSize === "cover")
check("唱片贴纸自动跟随底图切换", skin1.labelUrl === skin1.backdropUrl && skin1.labelUrl !== "")
check("文字配色随底图重推", skin1.inkPrimary !== "" && skin1.inkPrimary !== skinBefore.inkPrimary)

// 再换一张，确认是"可随意切换"而不是只能设一次
await page.keyboard.press("Escape")
await page.waitForTimeout(300)
const c2 = page.waitForEvent("filechooser")
await page.click('button[aria-label="更换底图"]')
await (await c2).setFiles(images[1])
await page.waitForTimeout(1600)
const skin2 = await readSkin(page)
await page.screenshot({ path: `${OUT}/real-skin-2.png` })

console.log(`\n底图切换：${short(skin1.backdropUrl)} → ${short(skin2.backdropUrl)}`)
console.log(`配色变化：${skinBefore.inkPrimary} → ${skin1.inkPrimary} → ${skin2.inkPrimary}`)
check("第二次换图同样生效", skin2.backdropUrl !== skin1.backdropUrl)
check("贴纸第二次也跟着换", skin2.labelUrl === skin2.backdropUrl)
check("蒙版仍由 WebGL 画（没退化成 CSS 兜底）", skin2.veilIsShader)

// 黑边填充。舞台是固定 1243×688 等比缩放居中的，窗口比例一变就多出黑边；
// 本脚本平时用的视口正好是设计比例，所以这条路以前一次都没走到过。
// 换成 16:10（笔记本上最常见的比例之一，理论上约 11% 的上下黑边）来验。
{
  const { PNG } = await import("pngjs")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(600)

  const box = await page.evaluate(() => {
    const v = document.querySelector(".viewport")?.getBoundingClientRect()
    const s = document.querySelector(".stage")?.getBoundingClientRect()
    const b = document.querySelector(".viewport-bleed")
    return {
      barY: v && s ? Math.round(v.height - s.height) : 0,
      stageTop: s ? Math.round(s.top) : 0,
      hasBleed: !!b,
      bleedCoversAll:
        b && v
          ? b.getBoundingClientRect().width >= v.width && b.getBoundingClientRect().height >= v.height
          : false,
    }
  })
  console.log(`\n16:10 视口下上下黑边合计 ${box.barY}px，舞台顶边在 y=${box.stageTop}`)
  check("换成 16:10 后确实出现了letterbox（否则这条用例没测到东西）", box.barY > 40, `${box.barY}px`)
  check("底图延伸层已渲染并铺满整个窗口", box.hasBleed && box.bleedCoversAll)

  // 真正的证据：黑边区域里取一个像素，它不该还是纯黑
  await page.screenshot({ path: `${OUT}/real-letterbox.png` })
  const shot = PNG.sync.read(await page.screenshot())
  const y = Math.max(2, Math.round(box.stageTop / 2)) // 上方黑边的中间
  const px = (x) => {
    const i = (y * shot.width + x) * 4
    return [shot.data[i], shot.data[i + 1], shot.data[i + 2]]
  }
  const samples = [px(80), px(640), px(1200)]
  const brightest = Math.max(...samples.flat())
  console.log(`黑边取样 y=${y}：${samples.map((s) => s.join(",")).join("  |  ")}`)
  check("黑边已被底图填掉，不再是纯黑", brightest > 12, `最亮通道 ${brightest}`)

  await page.setViewportSize({ width: 1243, height: 688 })
  await page.waitForTimeout(500)
}

await page.keyboard.press("Escape")
await page.waitForTimeout(300)

// ── 六、真实音频混音 ──────────────────────────────────────────────
await page.keyboard.press("x")
await page.waitForTimeout(500)
const beforeLayer = await countAudio(page)
await page.click('button:has-text("＋ 添加")')
await page.waitForTimeout(400)
const pick = await page.$(".track-picker button")
if (pick) {
  await pick.click()
  await page.waitForTimeout(3000)
}
const withLayer = await countAudio(page)
await page.screenshot({ path: `${OUT}/real-mix.png` })

// 时间轴曾经写死 384px，比抽屉内容区宽，右端连同曲目结尾一起被裁掉
const tl = await page.evaluate(() => {
  const el = document.querySelector(".timeline")
  const box = el?.parentElement
  if (!el || !box) return null
  const cs = getComputedStyle(el)
  const bx = Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.borderRightWidth)
  return {
    w: el.getBoundingClientRect().width,
    // 位图铺的是内容盒，比较时要把边框刨掉
    contentW: el.getBoundingClientRect().width - bx,
    boxW: box.getBoundingClientRect().width,
    canvasW: el.width / (window.devicePixelRatio || 1),
  }
})
console.log(
  `\n时间轴宽度：边框盒 ${tl?.w.toFixed(0)}px / 内容盒 ${tl?.contentW.toFixed(0)}px / 位图 ${tl?.canvasW.toFixed(0)}px / 容器 ${tl?.boxW.toFixed(0)}px`,
)
check("时间轴没有超出面板被裁掉", tl && tl.w <= tl.boxW + 1, tl ? `${tl.w.toFixed(0)} > ${tl.boxW.toFixed(0)}` : "无时间轴")
check(
  "位图分辨率与内容盒 1:1（不拉伸、末端可点到）",
  tl && Math.abs(tl.canvasW - tl.contentW) < 1.5,
  tl ? `${tl.canvasW.toFixed(1)} vs ${tl.contentW.toFixed(1)}` : "",
)

console.log(`\n混音：加层前 ${beforeLayer.playing} 个音频在播，加层后 ${withLayer.playing} 个`)
check("加叠加轨前只有一个音频在播", beforeLayer.playing === 1, String(beforeLayer.playing))
check("两首真实音乐同时发声", withLayer.playing === 2, String(withLayer.playing))
check(
  "两轨播放位置各自独立",
  withLayer.times.length === 2 && withLayer.times.every((t) => t >= 0),
  withLayer.times.map((t) => t.toFixed(2) + "s").join(" / "),
)
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

// ── 七、m3u 导入 ──────────────────────────────────────────────────
let importedCount = 0
let playlistOrder = []
if (m3u.length > 0) {
  await page.keyboard.press("p")
  await page.waitForTimeout(400)
  const c3 = page.waitForEvent("filechooser")
  await page.click('button:has-text("导入歌单")')
  await (await c3).setFiles(m3u[0])
  await page.waitForTimeout(1800)

  const note = await page.$eval(".lib-note", (e) => e.textContent).catch(() => "")
  playlistOrder = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".lib-main ol li .row b")).map((e) => e.textContent),
  )
  importedCount = playlistOrder.length
  const sideNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".lib-side-group button span")).map((e) => e.textContent),
  )
  await page.screenshot({ path: `${OUT}/real-m3u.png` })

  console.log(`\nm3u 导入回执：${note}`)
  console.log(`导入后的歌单内容：${playlistOrder.join(" → ")}`)

  check("m3u 导入建出了同名歌单", sideNames.includes("测试歌单"), sideNames.join("/"))
  check("三条有效条目全部匹配上", importedCount === 3, String(importedCount))
  check("失效的那条被计入未找到而不是静默吞掉", /1 首找不到文件/.test(note ?? ""), note)
  check(
    "保持 m3u 里的顺序（不是曲库顺序）",
    /Downtown Irony/i.test(playlistOrder[0] ?? "") && /April Showers/i.test(playlistOrder[2] ?? ""),
    playlistOrder.join(" → "),
  )
  await page.keyboard.press("Escape")
}

await browser.close()

// ── 判定 ──────────────────────────────────────────────────────────
check("全程无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "))

console.log("")
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  —— 实际：${detail}` : ""}`)
  if (!ok) failed++
}
if (errors.length) {
  console.log("\n页面报错：")
  for (const e of errors.slice(0, 8)) console.log("  " + e)
}
console.log(`\n截图 → ${OUT}/real-*.png`)

if (failed > 0) {
  console.error(`\n✗ ${failed} / ${checks.length} 项未通过`)
  process.exit(1)
}
console.log(`\n✓ 真实素材端到端全部通过（${checks.length} 项）`)

// ── 工具 ──────────────────────────────────────────────────────────
function short(u) {
  return u ? u.slice(0, 40) + (u.length > 40 ? "…" : "") : "(无)"
}

function fmtFill(f) {
  return f.has ? `${f.pct.toFixed(1)}%` : "(无擦除层)"
}

async function seekTo(page, seconds) {
  await page.evaluate((s) => {
    const el = document.querySelector('audio[data-role="host"]') ?? document.querySelector("audio")
    if (el) el.currentTime = s
  }, seconds)
  await page.waitForTimeout(700)
}

/** 在曲库抽屉里双击某首歌开始播放 */
async function playTrack(page, lib, predicate) {
  const i = lib.findIndex(predicate)
  if (i < 0) throw new Error("曲库里没有符合条件的曲目")
  await page.keyboard.press("p")
  await page.waitForTimeout(400)
  await page.dblclick(`.lib-main ol li:nth-child(${i + 1}) .row`)
  await page.waitForTimeout(2600)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
}

async function readPlayback(page) {
  return page.evaluate(() => {
    const disc = document.querySelector(".disc")
    const el = document.querySelector("audio")
    const label = document.querySelector(".disc-label")
    const bg = label ? getComputedStyle(label).backgroundImage : ""
    const m = /url\("?([^")]+)"?\)/.exec(bg || "")
    const labelUrl = m ? m[1] : ""
    // 内嵌封面走 background-size: cover；底图派生的贴纸是放大取景，尺寸是百分比
    const labelSize = label ? getComputedStyle(label).backgroundSize : ""
    return {
      playing: disc?.getAttribute("data-playing") === "true",
      time: el?.currentTime ?? 0,
      labelHasImage: labelUrl !== "",
      labelUrl,
      labelIsCover: labelUrl !== "" && labelSize === "cover",
    }
  })
}

async function readMasthead(page) {
  return page.evaluate(() => {
    const box = document.querySelector(".masthead")
    if (!box) return null
    const px = (el) => (el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 0)
    const h1 = box.querySelector("h1")
    return {
      title: h1?.textContent ?? "",
      subtitle: box.querySelector("p")?.textContent ?? "",
      third: box.querySelector("small")?.textContent ?? "",
      titlePx: px(h1),
      // 缩完字号之后仍然不能超出容器，否则会压到黑胶上
      overflow: h1 ? h1.scrollWidth - box.clientWidth : 0,
    }
  })
}

async function readLyrics(page) {
  return page.evaluate(() => {
    // 逐字擦除层是整行副本，textContent 会把同一句读到两遍。只取第一个文本节点。
    const textOf = (n) => Array.from(n.childNodes).find((c) => c.nodeType === 3)?.nodeValue ?? ""
    const nodes = Array.from(document.querySelectorAll(".lyric-line"))
    const act = nodes.filter((n) => n.dataset.active === "true")
    const box = document.querySelector(".lyrics")
    return {
      lines: nodes.map(textOf),
      active: act[0] ? textOf(act[0]) : "",
      activeCount: act.length,
      // 当前行相对歌词栏顶部的 y。参考图里当前行永远在同一个高度，
      // 所以这个值在整首歌里必须是常数
      activeY:
        act[0] && box
          ? Math.round(act[0].getBoundingClientRect().top - box.getBoundingClientRect().top)
          : null,
    }
  })
}

async function readFill(page) {
  return page.evaluate(() => {
    const textOf = (n) => Array.from(n.childNodes).find((c) => c.nodeType === 3)?.nodeValue ?? ""
    const el = document.querySelector(".lyric-fill")
    if (!el) return { has: false, pct: 0, line: "" }
    return {
      has: true,
      pct: Number.parseFloat(el.style.getPropertyValue("--fill")) || 0,
      // 擦除进度只在同一行内单调；跨行会归零，比较时必须确认还是同一句
      line: el.parentElement ? textOf(el.parentElement) : "",
    }
  })
}

async function readSkin(page) {
  return page.evaluate(() => {
    const url = (v) => {
      const m = /url\("?([^")]+)"?\)/.exec(v || "")
      return m ? m[1] : ""
    }
    const img = document.querySelector(".backdrop-img")
    const label = document.querySelector(".disc-label")
    const stage = document.querySelector(".stage")
    const veil = document.querySelector("canvas.veil")
    return {
      backdropCount: document.querySelectorAll(".backdrop-img").length,
      backdropSize: img ? getComputedStyle(img).backgroundSize : "",
      backdropUrl: url(img ? getComputedStyle(img).backgroundImage : ""),
      labelUrl: url(label ? getComputedStyle(label).backgroundImage : ""),
      inkPrimary: stage ? getComputedStyle(stage).getPropertyValue("--ink-primary").trim() : "",
      // 蒙版必须是 WebGL 画的：着色器挂了会静默退回 CSS 渐变，肉眼分不出
      veilIsShader: !!veil && !!(veil.getContext("webgl2") || veil.width > 0),
    }
  })
}

async function countAudio(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("audio"))
    return {
      playing: els.filter((e) => !e.paused && !e.ended).length,
      times: els.map((e) => e.currentTime),
    }
  })
}
