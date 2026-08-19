import { platform } from "@/platform"

/**
 * 响度测量与音量归一化（PRD F7.4）。
 *
 * 不同专辑的母带响度能差 10dB 以上，没有归一化就是换首歌音量跳一档 —— 这是列表
 * 连播时最扎眼的一件事。
 *
 * 两条来源，优先级从高到低：
 *
 *   1. **ReplayGain 标签**。文件里本来就写着，读一下就有，零成本。
 *   2. **自己按 EBU R128 / ITU-R BS.1770 量一遍**。要解码整首歌，所以结果落盘缓存，
 *      同一个文件只算一次。
 *
 * PRD 原文写的是「无标签时按峰值估算」。这里没有照做，因为**峰值和响度基本无关** ——
 * 一首安静的曲子只要有一下鼓击就顶到 0dBFS，按峰值归一化等于什么都没做，
 * 而这正是 ReplayGain 当年被发明出来要解决的问题。峰值仍然要用，但用途是**防削波**
 * （见 gainDbFor），不是拿来估响度。
 */

/** 目标响度。ReplayGain 2.0 的基准，也是绝大多数带 RG 标签的文件所对齐的值。 */
export const TARGET_LUFS = -18

/** 提升上限。再往上就是在放大底噪，而且几乎必然要靠限幅器兜底 */
const MAX_BOOST_DB = 12
/** 衰减下限。低于这个说明测量本身出了问题，不如不动 */
const MIN_GAIN_DB = -30

/**
 * 防削波的峰值天花板，约 -1 dBFS。
 *
 * 留这 1dB 不是迷信：我们量的是**采样峰值**，而重建出来的模拟波形（以及有损编码
 * 解码后的波形）会超过采样点连成的包络，业界管这个叫 true peak。真按 1.0 顶满，
 * 一部分曲子在 DAC 那一端就削了。
 */
const PEAK_CEILING = 0.891

export type Loudness = {
  /** 整体响度，LUFS。全静音时是 -Infinity */
  lufs: number
  /** 采样峰值，0..1 */
  peak: number
}

// ── ITU-R BS.1770 的 K 计权 ──────────────────────────────────

type Biquad = { b: [number, number, number]; a: [number, number, number] }

/**
 * K 计权的两级滤波器系数，**按采样率现算**。
 *
 * 规范只给了 48kHz 的系数表。照抄那张表意味着只有 48kHz 的素材量得准，而我们解码用的
 * 是别的采样率（见 DECODE_RATE）。这里用双线性变换从模拟原型现推，做法与 libebur128
 * 一致 —— 那是这套标准事实上的参考实现。
 *
 * 第一级是高架滤波器（模拟头部与耳廓对高频的抬升），第二级是 RLB 高通（压低低频，
 * 因为低频对响度感知的贡献远小于它的能量占比）。
 */
export function kWeightingFilters(rate: number): [Biquad, Biquad] {
  const shelfF0 = 1681.974450955533
  const shelfG = 3.999843853973347
  const shelfQ = 0.7071752369554196
  const kShelf = Math.tan((Math.PI * shelfF0) / rate)
  const vh = Math.pow(10, shelfG / 20)
  const vb = Math.pow(vh, 0.4996667741545416)
  const shelfA0 = 1 + kShelf / shelfQ + kShelf * kShelf
  const shelf: Biquad = {
    b: [
      (vh + (vb * kShelf) / shelfQ + kShelf * kShelf) / shelfA0,
      (2 * (kShelf * kShelf - vh)) / shelfA0,
      (vh - (vb * kShelf) / shelfQ + kShelf * kShelf) / shelfA0,
    ],
    a: [1, (2 * (kShelf * kShelf - 1)) / shelfA0, (1 - kShelf / shelfQ + kShelf * kShelf) / shelfA0],
  }

  const hpF0 = 38.13547087602444
  const hpQ = 0.5003270373238773
  const kHp = Math.tan((Math.PI * hpF0) / rate)
  const hpA0 = 1 + kHp / hpQ + kHp * kHp
  const highpass: Biquad = {
    b: [1, -2, 1],
    a: [1, (2 * (kHp * kHp - 1)) / hpA0, (1 - kHp / hpQ + kHp * kHp) / hpA0],
  }

  return [shelf, highpass]
}

/** 直接 II 型转置的双二阶滤波，原地覆盖输入 */
function biquad(x: Float32Array, { b, a }: Biquad): void {
  let z1 = 0
  let z2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    const y = b[0] * v + z1
    z1 = b[1] * v - a[1] * y + z2
    z2 = b[2] * v - a[2] * y
    x[i] = y
  }
}

/** 一个 400ms 门限块的时长与步进（75% 重叠），单位秒。规范定的，不是可调参数。 */
const BLOCK_SEC = 0.4
const STEP_SEC = 0.1
/** 绝对门限：静音与极弱的段落不参与统计 */
const ABSOLUTE_GATE = -70
/** 相对门限：比"未被绝对门限挡掉的平均响度"低 10 LU 的块也不算 */
const RELATIVE_GATE_LU = 10
/** 规范里的那个常数。它的作用是让 1kHz 正弦的读数正好等于它的 dBFS 值 */
const OFFSET_DB = -0.691

/**
 * 整体响度（integrated loudness），单位 LUFS。
 *
 * **纯函数**：收 Float32Array 通道数组，不碰 Web Audio，所以能直接用 EBU Tech 3341
 * 的合规信号单测（1kHz 正弦 -23 dBFS 必须读出 -23.0 LUFS）。
 *
 * 单声道会被**复制成两路**再测。播放时 Web Audio 把单声道上混到两个喇叭，实际听感
 * 就是双单声道；按一路算会低 3dB，归一化之后单声道曲目一律偏响。
 */
export function measureLoudness(channels: Float32Array[], rate: number): Loudness {
  if (channels.length === 0 || channels[0].length === 0) return { lufs: -Infinity, peak: 0 }

  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i])
      if (v > peak) peak = v
    }
  }

  const used = channels.length === 1 ? [channels[0], channels[0]] : channels
  const filters = kWeightingFilters(rate)
  // 滤波是原地的，不能改到调用方的数组上
  const weighted = used.map((ch) => {
    const copy = Float32Array.from(ch)
    for (const f of filters) biquad(copy, f)
    return copy
  })

  const blockLen = Math.round(BLOCK_SEC * rate)
  const stepLen = Math.round(STEP_SEC * rate)
  const n = weighted[0].length
  if (blockLen === 0 || n < blockLen) return { lufs: -Infinity, peak }

  /** 每个块的加权均方和（各通道权重都是 1.0：我们只处理单/立体声） */
  const blocks: number[] = []
  for (let start = 0; start + blockLen <= n; start += stepLen) {
    let sum = 0
    for (const ch of weighted) {
      let s = 0
      for (let i = start; i < start + blockLen; i++) s += ch[i] * ch[i]
      sum += s / blockLen
    }
    blocks.push(sum)
  }
  if (blocks.length === 0) return { lufs: -Infinity, peak }

  const loudnessOf = (meanSquare: number) =>
    meanSquare > 0 ? OFFSET_DB + 10 * Math.log10(meanSquare) : -Infinity

  // 一道门：绝对门限
  const passed = blocks.filter((ms) => loudnessOf(ms) > ABSOLUTE_GATE)
  if (passed.length === 0) return { lufs: -Infinity, peak }

  // 二道门：相对门限。先按一道门后的平均算出阈值，再筛一遍
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const threshold = loudnessOf(mean(passed)) - RELATIVE_GATE_LU
  const kept = passed.filter((ms) => loudnessOf(ms) > threshold)
  if (kept.length === 0) return { lufs: -Infinity, peak }

  return { lufs: loudnessOf(mean(kept)), peak }
}

/**
 * 把一个增益压进能用的范围：不削波、不过度提升。
 *
 * **峰值只用来限制"往上推"，不用来强制"往下压"。** 这条是拿真曲子跑出来的：
 * 有损格式解码后的采样峰值经常超过 1.0（实测 tests/real 里两首 mp3 是 1.001 和 1.008，
 * 一首 ogg 到 1.044）—— 那是有损编解码本来就有的过冲，不是文件"响到爆"。
 * 早先的写法是无条件 `min(db, 峰值允许的上限)`，于是一首本该 +2dB 的安静曲子
 * 因为峰值 1.044 反被压到 -1.37dB，比原来更偏离目标：为了防一个它原本就已经存在的
 * 削波，把归一化这件事本身给废了。
 *
 * 现在的规矩：该衰减多少就衰减多少；该提升时，提升幅度不得让峰值越过天花板，
 * 顶多不推（0dB），但不会因此变得比不归一化还轻。
 *
 * 峰值未知（标签里没写）时不做任何防削波，只守住上下限。
 */
export function clampGainDb(db: number, peak: number | null): number {
  let out = db
  if (peak != null && peak > 0) {
    const headroom = 20 * Math.log10(PEAK_CEILING / peak)
    out = Math.min(out, Math.max(0, headroom))
  }
  return Math.max(MIN_GAIN_DB, Math.min(MAX_BOOST_DB, out))
}

/**
 * 该给这首歌加多少 dB。
 *
 * 先按目标响度算出需要的增益，再用峰值把它压回不削波的范围 —— 两件事都要做：
 * 只看响度会削波，只看峰值等于没归一化。
 */
export function gainDbFor(lufs: number, peak: number): number {
  if (!Number.isFinite(lufs)) return 0
  return clampGainDb(TARGET_LUFS - lufs, peak)
}

/** dB → 线性倍率 */
export const dbToGain = (db: number): number => Math.pow(10, db / 20)

/**
 * 解析 ReplayGain 标签的值。`"-6.48 dB"` / `"-6.48"` / `-6.48` 都收。
 *
 * 标签是文本，各家写法不一 —— 有的带单位有的不带，有的带正号。解析不出返回 null，
 * 由调用方决定退回自己测。
 */
export function parseGainTag(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (value && typeof value === "object" && "dB" in value) {
    const db = (value as { dB: unknown }).dB
    return typeof db === "number" && Number.isFinite(db) ? db : null
  }
  if (typeof value !== "string") return null
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:db)?\s*$/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

// ── 解码与缓存 ────────────────────────────────────────────

/**
 * 测量用的解码采样率。
 *
 * 16kHz 是拿准确度换内存的结果：一首 4 分钟的立体声在这个采样率下解出来约 30MB，
 * 48kHz 则要 92MB —— 后者正好顶在 §10 那份内存账单上。代价是 8kHz 以上的内容被
 * 重采样滤掉，而 K 计权对 2kHz 以上有约 +4dB 的抬升，所以偏亮的素材会被量得略低
 * （实测量级在 0.5 LU 以内，小于人耳能察觉的 1 LU）。
 *
 * 这个数进缓存键的版本号，改了它旧缓存会自然失效。
 */
const DECODE_RATE = 16000

/** 算法版本。改了 measureLoudness 或 DECODE_RATE 就要 +1，否则旧缓存会被无条件复用 */
const ALGO_VERSION = 1

function hashKey(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * 解码并测量。
 *
 * ⚠ decodeAudioData 会把传入的 ArrayBuffer 转移（detach），之后原 buffer 长度变 0。
 * 同一份字节还要给 `<audio>` 的 Blob 用，所以必须传副本 —— 这个坑在 peaks.ts 里
 * 已经踩过一次，表现是"播放正常但元数据全空"且不报任何错。
 */
export async function measureBytes(bytes: Uint8Array): Promise<Loudness> {
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE)
  const buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
  const channels: Float32Array[] = []
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c))
  return measureLoudness(channels, buf.sampleRate)
}

/** 缓存里存的就是两个 double：lufs 与 peak */
const CACHE_BYTES = 16

/**
 * 带磁盘缓存的响度。**同一个文件只解码一次**，之后每次播放都是读 16 个字节。
 *
 * @param key 曲目的稳定标识。本地文件要带上 size/mtime，文件被替换后缓存自动失效；
 *            在线曲目只有 id，换了音质响度也不会有可闻的变化，够用。
 */
export async function loadLoudness(
  key: string,
  /** 传 null 表示**只查缓存，不解码**：用户播到一半才打开归一化时走这条，
   *  为一个开关去解码整首歌不值得，那一首就先不归一化，下一首自然就有了 */
  bytes: Uint8Array | (() => Promise<Uint8Array>) | null,
): Promise<Loudness | null> {
  const name = `loud-${hashKey(`v${ALGO_VERSION}|${DECODE_RATE}|${key}`)}.bin`
  try {
    const hit = await platform.readCache(name)
    if (hit && hit.byteLength === CACHE_BYTES) {
      const view = new DataView(hit.buffer, hit.byteOffset, hit.byteLength)
      return { lufs: view.getFloat64(0, true), peak: view.getFloat64(8, true) }
    }
  } catch {
    // 缓存读不出来只是白算一次，不该影响播放
  }

  if (bytes == null) return null

  try {
    const got = await measureBytes(typeof bytes === "function" ? await bytes() : bytes)
    const out = new Uint8Array(CACHE_BYTES)
    const view = new DataView(out.buffer)
    view.setFloat64(0, got.lufs, true)
    view.setFloat64(8, got.peak, true)
    void platform.writeCache(name, out).catch(() => {})
    return got
  } catch {
    // 解不了的格式（或者根本不是音频）不该让播放跟着失败
    return null
  }
}
