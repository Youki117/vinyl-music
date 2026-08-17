/**
 * 生成合成曲库：N 个带内嵌封面的真 MP3。
 *
 * 为什么要造假曲库：M1（导入即物化封面）与 H1（面板整店订阅）的开销都随曲库线性/平方
 * 增长，手头的十几首测试音频量不出任何东西 —— 上一轮蒙版优化就栽在"孤立基准漂亮、
 * 真实场景只省 11MB"上，这次不再拿推算当结论。
 *
 * 造出来的东西是真的，不是糊弄解析器的字节：
 *   - 封面是 pngjs 编的真 PNG（随机噪声，压不动，所以尺寸可控），能真的解码显示
 *   - 音频是合法的 MPEG-1 Layer III 帧（128kbps / 44.1kHz / 立体声），帧体全零 =
 *     静音，music-metadata 能从帧头正常算出时长
 *   - 标签是标准 ID3v2.3，TIT2/TPE1/TALB/APIC 齐全
 *
 * 用法：
 *   node scripts/perf/gen-library.mjs --count=600 --out=D:\tmp\synth-lib
 *   node scripts/perf/gen-library.mjs --count=600 --cover=320 --seconds=15
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PNG } from "pngjs"

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const COUNT = Number(arg("count", "600"))
const OUT = arg("out", join(process.env.TEMP ?? ".", "vinyl-synth-lib"))
/** 封面边长。320×320 的随机噪声 PNG ≈ 300KB，正好是常见内嵌封面的量级 */
const COVER_SIDE = Number(arg("cover", "320"))
const SECONDS = Number(arg("seconds", "15"))

// ── ID3v2.3 ──────────────────────────────────────────────────────

/** 同步安全整数：每字节只用低 7 位，避免和 MPEG 同步字 0xFF 撞上 */
function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function frame(id, body) {
  const head = Buffer.alloc(10)
  head.write(id, 0, "latin1")
  head.writeUInt32BE(body.length, 4) // v2.3 的帧长是普通大端，不是同步安全整数
  return Buffer.concat([head, body])
}

/**
 * 文本帧一律用 UTF-16（编码字节 0x01 + BOM）。
 *
 * 不能图省事用 ISO-8859-1：中文按 latin1 写下去读回来是乱码，而应用的 looksCorrupt()
 * 会认出乱码并退回文件名 —— 那样基准测的就不是真实曲库的行为了。真实曲库里 CJK 标签
 * 很常见，字符串内存与排序成本都得照着来。
 */
const textFrame = (id, text) =>
  frame(
    id,
    Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from([0xff, 0xfe]), // UTF-16LE BOM
      Buffer.from(text, "utf16le"),
    ]),
  )

function apicFrame(png) {
  return frame(
    "APIC",
    Buffer.concat([
      Buffer.from([0x00]), // 编码：ISO-8859-1
      Buffer.from("image/png\0", "latin1"),
      Buffer.from([0x03]), // 图片类型：封面（正面）
      Buffer.from("\0", "latin1"), // 空描述
      png,
    ]),
  )
}

function id3Tag(frames) {
  const body = Buffer.concat(frames)
  const head = Buffer.concat([
    Buffer.from("ID3", "latin1"),
    Buffer.from([0x03, 0x00, 0x00]), // v2.3.0，无标志位
    syncsafe(body.length),
  ])
  return Buffer.concat([head, body])
}

// ── MPEG-1 Layer III ─────────────────────────────────────────────
// 0xFF 0xFB = 同步字 + MPEG1 + Layer III + 无 CRC
// 0x90     = 128kbps + 44100Hz + 无填充
// 0x00     = 立体声
const MPEG_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x00])
/** 帧长 = 144 × 比特率 ÷ 采样率 = 144 × 128000 ÷ 44100 = 417 */
const FRAME_BYTES = 417
/** 每帧 1152 个采样 ÷ 44100 ≈ 26.12ms */
const FRAME_SECONDS = 1152 / 44100

function silentAudio(seconds) {
  const count = Math.max(1, Math.round(seconds / FRAME_SECONDS))
  const one = Buffer.concat([MPEG_HEADER, Buffer.alloc(FRAME_BYTES - 4)])
  return Buffer.concat(Array.from({ length: count }, () => one))
}

// ── 封面 ─────────────────────────────────────────────────────────

/**
 * 随机噪声 PNG。用噪声是因为它压不动 —— 纯色图会被 deflate 压成几 KB，
 * 那就完全测不出封面的内存开销了。
 */
function noisePng(side, seed) {
  const png = new PNG({ width: side, height: side })
  let x = seed | 1
  for (let i = 0; i < png.data.length; i += 4) {
    // xorshift32，够随机且不用引依赖
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    png.data[i] = x & 0xff
    png.data[i + 1] = (x >>> 8) & 0xff
    png.data[i + 2] = (x >>> 16) & 0xff
    png.data[i + 3] = 0xff
  }
  return PNG.sync.write(png)
}

// ── 生成 ─────────────────────────────────────────────────────────

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const audio = silentAudio(SECONDS)
const ARTISTS = ["柏林电台", "Nova Drift", "青柠时序", "Halcyon", "旧城胶片", "Miru"]
const ALBUMS = ["夜航", "Parallax", "长曝", "Static Bloom", "回声练习"]

let bytes = 0
for (let i = 0; i < COUNT; i++) {
  // 每首一张不同的封面：复用同一张的话，操作系统的页缓存和 V8 的字符串驻留
  // 都会让结果偏乐观，测不出真实曲库的样子
  const cover = noisePng(COVER_SIDE, 0x9e3779b9 ^ (i * 2654435761))
  const tag = id3Tag([
    textFrame("TIT2", `Synthetic Track ${String(i + 1).padStart(4, "0")}`),
    textFrame("TPE1", ARTISTS[i % ARTISTS.length]),
    textFrame("TALB", ALBUMS[i % ALBUMS.length]),
    apicFrame(cover),
  ])
  const file = Buffer.concat([tag, audio])
  writeFileSync(join(OUT, `synth-${String(i + 1).padStart(4, "0")}.mp3`), file)
  bytes += file.length
  if ((i + 1) % 100 === 0) process.stdout.write(`  已生成 ${i + 1}/${COUNT}\r`)
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`
console.log(`\n生成 ${COUNT} 首 → ${OUT}`)
console.log(`  单首约 ${mb(bytes / COUNT)}（音频 ${mb(audio.length)} + 封面约 ${mb(bytes / COUNT - audio.length)}）`)
console.log(`  合计 ${mb(bytes)}`)
