import { platform } from "@/platform"
import type { FileRef } from "@/platform"

/** 进度条只有 300px 宽，500 个桶绰绰有余 */
export const PEAK_BUCKETS = 500

/**
 * 计算波形峰值。
 *
 * ⚠ decodeAudioData 会把传入的 ArrayBuffer 转移（detach），之后原 buffer 长度变 0。
 * 同一份字节还要给 Blob 和元数据解析用，所以必须传 slice(0) 的副本。这个坑的表现
 * 是"播放正常但元数据全空"或反过来，而且不报任何错。
 */
export async function computePeaks(bytes: Uint8Array): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const copy = bytes.slice().buffer as ArrayBuffer
  const buf = await ctx.decodeAudioData(copy)

  const ch = buf.getChannelData(0)
  const peaks = new Float32Array(PEAK_BUCKETS)
  const step = Math.max(1, Math.floor(ch.length / PEAK_BUCKETS))
  // 每 16 个采样取一个：够用，且快 16 倍
  const stride = 16

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

function cacheKey(ref: FileRef): string {
  // 路径 + 大小 + mtime：文件被替换后缓存自动失效
  let h = 2166136261
  const s = `${ref.id}|${ref.size}|${ref.mtime}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `peaks-${(h >>> 0).toString(36)}.bin`
}

/** 带磁盘缓存的峰值获取。500 个 Float32 = 2KB，一万首歌也才 20MB。 */
export async function loadPeaks(ref: FileRef, bytes: Uint8Array): Promise<Float32Array> {
  const key = cacheKey(ref)
  try {
    const hit = await platform.readCache(key)
    if (hit && hit.byteLength === PEAK_BUCKETS * 4) {
      return new Float32Array(hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength))
    }
  } catch {
    // 缓存读失败不该影响播放
  }

  const peaks = await computePeaks(bytes)
  void platform.writeCache(key, new Uint8Array(peaks.buffer.slice(0))).catch(() => {})
  return peaks
}
