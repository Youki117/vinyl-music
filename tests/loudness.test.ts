import { describe, expect, it } from "vitest"

import { TARGET_LUFS, gainDbFor, measureLoudness, parseGainTag } from "@/audio/loudness"

/** 一段正弦。amplitudeDb 是相对满刻度的 dB（-23 → 幅度 10^(-23/20)） */
function sine(seconds: number, rate: number, freq: number, amplitudeDb: number): Float32Array {
  const amp = Math.pow(10, amplitudeDb / 20)
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

const stereo = (ch: Float32Array) => [ch, Float32Array.from(ch)]

/**
 * EBU Tech 3341 的合规信号。1kHz 正弦读数必须等于它的 dBFS 值 —— 这一条同时验了
 * K 计权滤波器、门限逻辑和那个 -0.691 的常数：三者任意一处写错都过不了。
 */
describe("整体响度（EBU Tech 3341）", () => {
  it("1kHz 正弦 -23 dBFS → -23.0 LUFS", () => {
    const got = measureLoudness(stereo(sine(5, 48000, 1000, -23)), 48000)
    expect(got.lufs).toBeCloseTo(-23, 1)
  })

  it("1kHz 正弦 -33 dBFS → -33.0 LUFS", () => {
    const got = measureLoudness(stereo(sine(5, 48000, 1000, -33)), 48000)
    expect(got.lufs).toBeCloseTo(-33, 1)
  })

  /**
   * 同一个信号换采样率读数必须一样。规范只给了 48kHz 的系数表，我们是按采样率现推的，
   * 推错了就是这一条会红 —— 而实际解码用的正是 48kHz 之外的采样率。
   */
  it("换采样率读数不变（滤波器系数是按采样率现推的）", () => {
    for (const rate of [16000, 44100, 48000]) {
      const got = measureLoudness(stereo(sine(5, rate, 1000, -23)), rate)
      expect(got.lufs).toBeCloseTo(-23, 1)
    }
  })

  it("单声道按双单声道算 —— 播放时本来就是两个喇叭一起响", () => {
    const mono = measureLoudness([sine(5, 48000, 1000, -23)], 48000)
    const dual = measureLoudness(stereo(sine(5, 48000, 1000, -23)), 48000)
    expect(mono.lufs).toBeCloseTo(dual.lufs, 5)
  })

  it("峰值是采样绝对值峰值", () => {
    const got = measureLoudness(stereo(sine(1, 48000, 1000, -6)), 48000)
    expect(got.peak).toBeCloseTo(Math.pow(10, -6 / 20), 2)
  })
})

describe("门限", () => {
  it("全静音没有响度可言", () => {
    const got = measureLoudness(stereo(new Float32Array(48000)), 48000)
    expect(got.lufs).toBe(-Infinity)
    expect(got.peak).toBe(0)
  })

  it("空输入不炸", () => {
    expect(measureLoudness([], 48000).lufs).toBe(-Infinity)
    expect(measureLoudness([new Float32Array(0)], 48000).lufs).toBe(-Infinity)
  })

  it("短于一个 400ms 块就测不出来", () => {
    expect(measureLoudness(stereo(sine(0.2, 48000, 1000, -23)), 48000).lufs).toBe(-Infinity)
  })

  /**
   * 曲末那段长静音不该把整首歌的读数拉低。绝对门限（-70 LUFS）就是干这个的 ——
   * 没有它，一首后面接了 30 秒静音的歌会被判定成"很轻"，然后被推得很响。
   */
  it("尾部长静音被绝对门限挡掉，不拉低整体读数", () => {
    const rate = 48000
    const tone = sine(5, rate, 1000, -23)
    const withTail = new Float32Array(tone.length + rate * 20)
    withTail.set(tone)
    // 20 秒静音只让读数动了 0.13 —— 那点差值来自跨在响/静交界上的几个块，
    // 它们只装了半个块的能量。规范就是这个行为，不是误差
    expect(Math.abs(measureLoudness(stereo(withTail), rate).lufs + 23)).toBeLessThan(0.3)
  })

  /**
   * 相对门限：比平均低 10 LU 以上的段落不计入。这里让一半时间是 -23、一半是 -50，
   * 结果应当贴近 -23，而不是两者的能量平均。
   */
  it("远低于平均的段落被相对门限挡掉", () => {
    const rate = 48000
    const loud = sine(5, rate, 1000, -23)
    const quiet = sine(5, rate, 1000, -50)
    const mixed = new Float32Array(loud.length + quiet.length)
    mixed.set(loud)
    mixed.set(quiet, loud.length)
    const got = measureLoudness(stereo(mixed), rate).lufs
    // 一半 -23 一半 -50，不做门限的话能量平均是 -26.7 左右。读数贴着 -23
    // 才说明后半段真的被挡掉了
    expect(Math.abs(got + 23)).toBeLessThan(0.3)
  })
})

describe("该加多少 dB", () => {
  it("比目标轻就往上推，比目标响就往下压", () => {
    // 峰值给得很小，让防削波那条不介入
    expect(gainDbFor(TARGET_LUFS - 6, 0.01)).toBeCloseTo(6, 5)
    expect(gainDbFor(TARGET_LUFS + 6, 0.01)).toBeCloseTo(-6, 5)
    expect(gainDbFor(TARGET_LUFS, 0.01)).toBeCloseTo(0, 5)
  })

  /**
   * 防削波：一首很轻但峰值已经顶满的歌（安静的曲子里来一下鼓击就会这样），
   * 按响度该推 +10dB，但推上去就削了 —— 提升要被压掉。
   */
  it("峰值顶满时不许再往上推", () => {
    expect(gainDbFor(TARGET_LUFS - 10, 1.0)).toBe(0)
  })

  it("峰值有余量时，提升只推到天花板为止", () => {
    // 峰值 0.5 时离 -1dBFS 还有约 5dB 的余量，所以 +10 只能给到 +5 上下
    const db = gainDbFor(TARGET_LUFS - 10, 0.5)
    expect(db).toBeGreaterThan(4)
    expect(db).toBeLessThan(6)
    expect(0.5 * Math.pow(10, db / 20)).toBeLessThanOrEqual(0.9)
  })

  /**
   * 有损格式解码后的采样峰值经常超过 1.0（实测真曲子有 1.001 / 1.008 / 1.044），
   * 那是编解码的过冲。不能因为这个把一首本来就该提升的曲子压得比不归一化还轻 ——
   * 那等于为了防一个它原本就已经存在的削波，把归一化本身废掉。
   */
  it("峰值已经超过 1 的曲子，最多不推，但不会被压低", () => {
    expect(gainDbFor(TARGET_LUFS - 2, 1.044)).toBe(0)
    // 该衰减的照样衰减 —— 峰值不参与"往下压"这个方向
    expect(gainDbFor(TARGET_LUFS + 6, 1.044)).toBeCloseTo(-6, 5)
  })

  it("测不出响度就不动它", () => {
    expect(gainDbFor(-Infinity, 0.5)).toBe(0)
    expect(gainDbFor(NaN, 0.5)).toBe(0)
  })

  it("增益有上下限，不至于把底噪放大到听得见", () => {
    expect(gainDbFor(-90, 0.001)).toBeLessThanOrEqual(12)
    expect(gainDbFor(10, 0.001)).toBeGreaterThanOrEqual(-30)
  })
})

describe("ReplayGain 标签", () => {
  it("各家写法都要收下", () => {
    expect(parseGainTag("-6.48 dB")).toBeCloseTo(-6.48, 5)
    expect(parseGainTag("-6.48dB")).toBeCloseTo(-6.48, 5)
    expect(parseGainTag("+3.2 DB")).toBeCloseTo(3.2, 5)
    expect(parseGainTag("-6.48")).toBeCloseTo(-6.48, 5)
    expect(parseGainTag(-6.48)).toBeCloseTo(-6.48, 5)
    // music-metadata 解 ID3v2.4 的 RVA2 帧给的是 { dB, ratio }
    expect(parseGainTag({ dB: -6.48, ratio: 0.47 })).toBeCloseTo(-6.48, 5)
  })

  it("解析不出返回 null，由调用方决定退回自己测", () => {
    expect(parseGainTag("")).toBe(null)
    expect(parseGainTag("很响")).toBe(null)
    expect(parseGainTag(undefined)).toBe(null)
    expect(parseGainTag(null)).toBe(null)
    expect(parseGainTag(NaN)).toBe(null)
  })
})
