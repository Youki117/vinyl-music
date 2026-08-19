/**
 * 音量归一化端到端：**拿真曲子解码、按 EBU R128 量一遍**，验证归一化真的把响度拉齐了。
 *
 * 为什么要这个脚本：单测（tests/loudness.test.ts）用的是合成正弦，验的是滤波器和门限
 * 算得对；但"换歌不会音量跳一档"这句承诺只有拿两首真实响度差很多的曲子才验得出来。
 * 而 decodeAudioData 只有浏览器里才有，node 里跑不了。
 *
 * 前置：npm run dev 已在 1420 端口运行。
 *
 *   node scripts/verify-loudness.mjs
 */
import { chromium } from "playwright"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"

/** 真实素材。它们的响度本来就差得开，正好用来验"拉齐"这件事 */
const TRACKS = [
  "tests/real/ProleteR - April Showers.mp3",
  "tests/real/Multi Panel - Christmas With Mr Rice.mp3",
  "tests/real/Riding Alone - Lullaby.ogg",
  "tests/real/ProleteR - Downtown Irony.ogg",
]

const missing = TRACKS.filter((t) => !existsSync(resolve(t)))
if (missing.length) {
  console.error(`缺素材：${missing.join("、")}\n先跑 node scripts/fetch-real-assets.mjs`)
  process.exit(1)
}

const checks = []
const check = (name, ok, detail = "") => checks.push([name, !!ok, detail])

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (e) => errors.push(e.message))

await page.goto(URL, { waitUntil: "domcontentloaded" })

/*
 * 直接引 dev server 上的源码模块。vite 把项目根目录整个服务出去，所以页面里既能
 * `import('/src/audio/loudness.ts')` 拿到刚改的实现，也能 fetch 到 tests/real 下的音频。
 * 比起从 node 侧把几 MB 字节序列化进页面，这条路快得多，测的也是同一份代码。
 */
const measured = await page.evaluate(async (paths) => {
  const m = await import("/src/audio/loudness.ts")
  const out = []
  for (const p of paths) {
    const bytes = new Uint8Array(await (await fetch(`/${p}`)).arrayBuffer())
    const t0 = performance.now()
    const first = await m.loadLoudness(p, bytes)
    const t1 = performance.now()
    // 第二次必须走缓存：不解码，所以要快一个数量级
    const second = await m.loadLoudness(p, bytes)
    const t2 = performance.now()
    out.push({
      path: p,
      megabytes: bytes.byteLength / 1024 / 1024,
      lufs: first?.lufs ?? null,
      peak: first?.peak ?? null,
      gainDb: first ? m.gainDbFor(first.lufs, first.peak) : null,
      cachedLufs: second?.lufs ?? null,
      measureMs: t1 - t0,
      cachedMs: t2 - t1,
    })
  }
  return { target: m.TARGET_LUFS, rows: out }
}, TRACKS)

const rows = measured.rows
const target = measured.target

console.log(`目标响度 ${target} LUFS\n`)
for (const r of rows) {
  const name = r.path.split("/").pop()
  console.log(
    `${name.padEnd(42)} ${r.lufs === null ? "  测不出" : r.lufs.toFixed(2).padStart(7)} LUFS` +
      `  峰值 ${r.peak?.toFixed(3)}  →  ${r.gainDb >= 0 ? "+" : ""}${r.gainDb?.toFixed(2)} dB` +
      `  （${r.measureMs.toFixed(0)}ms，缓存 ${r.cachedMs.toFixed(0)}ms）`,
  )
}
console.log()

const ok = rows.filter((r) => r.lufs !== null && Number.isFinite(r.lufs))
check("每首都量出了响度", ok.length === rows.length, `${ok.length} / ${rows.length}`)

// 音乐的整体响度基本都落在这个区间；超出说明量错了而不是这首歌特别
check(
  "读数落在音乐的合理区间（-40 ~ -3 LUFS）",
  ok.every((r) => r.lufs > -40 && r.lufs < -3),
  ok.map((r) => r.lufs.toFixed(1)).join(" , "),
)

// 有损格式解出来的采样峰值可以超过 1.0（编解码过冲），所以上界不是 1 而是"没离谱"
check(
  "峰值在合理范围（0 < peak < 2）",
  ok.every((r) => r.peak > 0 && r.peak < 2),
  ok.map((r) => r.peak.toFixed(3)).join(" , "),
)

check(
  "第二次读缓存，结果一致且快一个数量级",
  ok.every((r) => r.cachedLufs === r.lufs && r.cachedMs * 10 < r.measureMs),
  ok.map((r) => `${r.measureMs.toFixed(0)}→${r.cachedMs.toFixed(0)}ms`).join(" , "),
)

/*
 * 这一条才是这个功能的全部意义：归一化之后，几首歌之间的响度差要显著变小。
 * 加 g dB 之后的响度就是 lufs + g（线性增益对 LUFS 是等量平移），所以不用再解码一遍。
 */
const spread = (xs) => Math.max(...xs) - Math.min(...xs)
const before = spread(ok.map((r) => r.lufs))
const after = spread(ok.map((r) => r.lufs + r.gainDb))
check(
  "归一化后曲目之间的响度差显著变小",
  after < before / 2,
  `${before.toFixed(2)} LU → ${after.toFixed(2)} LU`,
)

// 只压不推的曲目（峰值已经没余量）达不到目标是设计使然，但**绝不能比目标更响**
check(
  "没有哪首被推过目标响度",
  ok.every((r) => r.lufs + r.gainDb <= target + 0.1),
  ok.map((r) => (r.lufs + r.gainDb).toFixed(1)).join(" , "),
)

// 需要衰减的那些没有任何借口，必须精确落在目标上
const attenuated = ok.filter((r) => r.gainDb < 0)
check(
  "需要衰减的曲目精确对齐到目标",
  attenuated.length > 0 && attenuated.every((r) => Math.abs(r.lufs + r.gainDb - target) < 0.1),
  attenuated.map((r) => (r.lufs + r.gainDb).toFixed(2)).join(" , "),
)

check("全程无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "))

await browser.close()

let bad = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? `  —— ${detail}` : ""}`)
  if (!pass) bad++
}
console.log(bad ? `\n✗ ${bad} / ${checks.length} 项未通过` : `\n✓ 响度检查全部通过（${checks.length} 项）`)
process.exit(bad ? 1 : 0)
