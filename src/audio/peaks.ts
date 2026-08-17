import { platform } from "@/platform"
import type { FileRef } from "@/platform"

/** 进度条只有 300px 宽，500 个桶绰绰有余 */
export const PEAK_BUCKETS = 500

/**
 * 解码用的采样率。
 *
 * decodeAudioData 会把音频重采样到目标 AudioContext 的采样率，所以这个值直接
 * 决定解码出来的 PCM 有多大。原先用 44100：一首 4.5 分钟的立体声解出来是
 * `269s × 44100 × 2ch × 4B ≈ 95MB`，而我们只是要画一条 300px 宽的波形。
 * 降到 8000Hz，同样的曲子约 17MB，**省掉 82%**。
 *
 * 选 8000 不是因为它是引擎下限（Chromium 实际能到 3000），而是因为它是 Web Audio
 * 规范要求所有实现都必须支持的区间下界（8000–96000）—— 再往下就依赖具体实现了，
 * 而波形精度在这个量级上早已过剩，没有理由拿可移植性去换。
 *
 * 精度够不够：500 个桶摊到 269 秒，每桶 0.54 秒；8kHz 下每桶仍有 4300 个采样，
 * 再按 stride 16 抽样也有 260 个点参与 RMS。波形形状看不出区别。
 */
const DECODE_RATE = 8000

/**
 * 计算波形峰值。
 *
 * ⚠ decodeAudioData 会把传入的 ArrayBuffer 转移（detach），之后原 buffer 长度变 0。
 * 同一份字节还要给 Blob 和元数据解析用，所以必须传 slice(0) 的副本。这个坑的表现
 * 是"播放正常但元数据全空"或反过来，而且不报任何错。
 */
export async function computePeaks(bytes: Uint8Array): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE)
  const copy = bytes.slice().buffer as ArrayBuffer
  const buf = await ctx.decodeAudioData(copy)

  const ch = buf.getChannelData(0)
  const peaks = new Float32Array(PEAK_BUCKETS)
  const step = Math.max(1, Math.floor(ch.length / PEAK_BUCKETS))
  // 降到 8kHz 之后每桶的采样数已经不多，抽稀比例跟着放小，否则短曲子会取样不足
  const stride = Math.max(1, Math.floor(step / 256))

  let max = 1e-6
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    const from = i * step
    const to = Math.min(ch.length, from + step)
    let sum = 0
    let n = 0
    for (let j = from; j < to; j += stride) {
      sum += ch[j] * ch[j]
      n++
    }
    // RMS 比取绝对值峰值更接近人耳感受
    const v = n > 0 ? Math.sqrt(sum / n) : 0
    peaks[i] = v
    if (v > max) max = v
  }
  for (let i = 0; i < PEAK_BUCKETS; i++) peaks[i] = Math.min(1, peaks[i] / max)
  return peaks
}

/**
 * 峰值算法的版本号。**改了 computePeaks 的输出就要 +1。**
 *
 * 缓存键只含路径/大小/mtime 的话，算法变了但文件没变，旧 .bin 会被无条件复用 ——
 * 表现是"改了算法但波形纹丝不动"，而且不报任何错。带上版本号，旧缓存自然失效。
 * （DECODE_RATE 与 stride 那次改动就落在这个坑边上，当时输出确实变了。）
 */
const PEAKS_ALGO_VERSION = 2

function cacheKey(ref: FileRef): string {
  // 路径 + 大小 + mtime：文件被替换后缓存自动失效
  let h = 2166136261
  const s = `v${PEAKS_ALGO_VERSION}|${ref.id}|${ref.size}|${ref.mtime}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `peaks-${(h >>> 0).toString(36)}.bin`
}

/**
 * 带磁盘缓存的峰值获取。500 个 Float32 = 2KB，一万首歌也才 20MB。
 *
 * `bytes` 可以传一个惰性取字节的函数：缓存键只需要路径/大小/mtime 就能算出来，
 * 命中时根本不需要文件内容。播放路径的字节本来就在手上，直接传；而混音面板每选一层
 * 都要画波形，先读整个文件再进来的话，命中缓存那次的整份读盘（Tauri 下还要过 IPC）
 * 就是纯浪费。
 */
export async function loadPeaks(
  ref: FileRef,
  bytes: Uint8Array | (() => Promise<Uint8Array>),
): Promise<Float32Array> {
  const key = cacheKey(ref)
  try {
    const hit = await platform.readCache(key)
    if (hit && hit.byteLength === PEAK_BUCKETS * 4) {
      return new Float32Array(hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength))
    }
  } catch {
    // 缓存读失败不该影响播放
  }

  const peaks = await computePeaks(typeof bytes === "function" ? await bytes() : bytes)
  void platform.writeCache(key, new Uint8Array(peaks.buffer.slice(0))).catch(() => {})
  return peaks
}
