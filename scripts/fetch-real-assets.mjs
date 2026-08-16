/**
 * 下载实测用的公开素材到 tests/real/。
 *
 * 素材本身不入库（约 24MB，且是第三方作品），用这个脚本按需重建。
 * 每一项的来源与许可见 tests/real/SOURCES.md。
 *
 *   node scripts/fetch-real-assets.mjs
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs"
import { resolve, join } from "node:path"
import { execFileSync } from "node:child_process"

const DIR = resolve("tests/real")
const UA = "vinyl-player-test/0.1 (local music player; testing metadata + lyrics)"

mkdirSync(DIR, { recursive: true })

/** archive.org 上 CC 授权的 netlabel 发行，带真实 ID3 标签，其中一个有内嵌封面 */
const AUDIO = [
  {
    file: "ProleteR - April Showers.mp3",
    url: "https://archive.org/download/DWK123/ProleteR_-_01_-_April_Showers.mp3",
  },
  {
    file: "ProleteR - Downtown Irony.ogg",
    url: "https://archive.org/download/DWK123/ProleteR_-_02_-_Downtown_Irony.ogg",
  },
  {
    file: "Riding Alone - Lullaby.ogg",
    url: "https://archive.org/download/badpanda018/01RidingAloneForThousandsOfMiles-Lullaby.ogg",
  },
  {
    file: "Multi Panel - Christmas With Mr Rice.mp3",
    url: "https://archive.org/download/NS050/01-NS050-Multi-Panel_Christmas-With-Mr-Rice.mp3",
  },
]

/** Wikimedia Commons 的自由许可人像，用来试换底图 */
const IMAGES = [
  { file: "backdrop-1.jpg", title: "File:A Tibetan Pilgrim Lighting Ghee Lamps.jpg" },
  { file: "backdrop-2.jpg", title: "File:A smoky day at the Sugar Bowl--Hupa.jpg" },
]

async function get(url, asBuffer = true) {
  const res = await fetch(url, { headers: { "User-Agent": UA } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.json()
}

async function download(file, url) {
  const dst = join(DIR, file)
  if (existsSync(dst) && statSync(dst).size > 0) {
    console.log(`跳过（已存在） ${file}`)
    return
  }
  writeFileSync(dst, await get(url))
  console.log(`已下载 ${file}  ${(statSync(dst).size / 1024).toFixed(0)} KB`)
}

// ── 音频 ──────────────────────────────────────────────────────────
for (const a of AUDIO) {
  try {
    await download(a.file, a.url)
  } catch (e) {
    console.error(`✗ ${a.file}：${e.message}`)
  }
}

// ── 图片 ──────────────────────────────────────────────────────────
// Commons 会对连续请求返回 429，逐张下并留间隔
for (const img of IMAGES) {
  const dst = join(DIR, img.file)
  if (existsSync(dst) && statSync(dst).size > 0) {
    console.log(`跳过（已存在） ${img.file}`)
    continue
  }
  try {
    const api =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo" +
      "&iiprop=url%7Cextmetadata&iiurlwidth=1500&titles=" +
      encodeURIComponent(img.title)
    const meta = await get(api, false)
    const page = Object.values(meta.query.pages)[0]
    const info = page.imageinfo[0]
    writeFileSync(dst, await get(info.thumburl))
    console.log(
      `已下载 ${img.file}  ${(statSync(dst).size / 1024).toFixed(0)} KB  [${info.extmetadata.LicenseShortName.value}]`,
    )
    await new Promise((r) => setTimeout(r, 1500))
  } catch (e) {
    console.error(`✗ ${img.file}：${e.message}`)
  }
}

// ── 歌词 ──────────────────────────────────────────────────────────
// lrclib.net 上有 April Showers 的同步歌词，挑时长与音频对得上的那条
const LRC = join(DIR, "ProleteR - April Showers.lrc")
if (existsSync(LRC)) {
  console.log("跳过（已存在） ProleteR - April Showers.lrc")
} else {
  try {
    const hits = await get(
      "https://lrclib.net/api/search?artist_name=ProleteR&track_name=April%20Showers",
      false,
    )
    const best = hits
      .filter((h) => h.syncedLyrics)
      .sort((a, b) => Math.abs(a.duration - 269.06) - Math.abs(b.duration - 269.06))[0]
    if (!best) throw new Error("没有带时间轴的结果")
    writeFileSync(LRC, best.syncedLyrics, "utf8")
    console.log(`已下载 ProleteR - April Showers.lrc（时长 ${best.duration}s，音频 269.06s）`)
  } catch (e) {
    console.error(`✗ 歌词：${e.message}`)
  }
}

// 逐字歌词：公开渠道拿不到合法样本，由行级歌词插值派生，详见脚本头部说明
const WORD_LRC = join(DIR, "ProleteR - Downtown Irony.lrc")
if (existsSync(WORD_LRC)) {
  console.log("跳过（已存在） ProleteR - Downtown Irony.lrc")
} else if (existsSync(LRC)) {
  execFileSync(process.execPath, [resolve("scripts/make-word-lrc.mjs"), LRC, WORD_LRC], {
    stdio: "inherit",
  })
}

console.log(`\n完成。素材在 ${DIR}\n接着跑：node scripts/verify-real.mjs`)
