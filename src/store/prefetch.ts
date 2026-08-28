import { platform } from "@/platform"
import { engine } from "@/audio/engine"
import { loadLoudness } from "@/audio/loudness"
import {
  fetchOnlineBytes,
  loudnessKey,
  qualityForTrack,
  shuffle,
  usePlayer,
  type OnlineQuality,
} from "./player"
import { localRef } from "./library"

// ── 预加载下一首（F1.6：切换间隔 < 200ms）────────────────────

/**
 * 预取好的下一首。**只留一首。**
 *
 * 切歌那一刻才开始读文件（Tauri 下还要整个过一遍 IPC）或者才开始解析在线地址并下载，
 * 是切歌延迟里最贵的一块 —— 在线那条动辄一两秒。提前一首把字节拿在手上，
 * 切过去就只剩建 Blob 和等 loadedmetadata。
 *
 * 代价是常驻一份下一首的字节（几 MB 到几十 MB）。留两首就是双倍代价换一个更不准的
 * 猜测：用户按下一首的次数远多于按下下一首。
 */
let prefetched: { id: string; quality: OnlineQuality | null; bytes: Uint8Array } | null = null
/** 预取序号，用来作废在途的过期预取（切歌比下载快时会发生） */
let prefetchSeq = 0
let prefetchTimer = 0

/**
 * 太大的文件不预取。40MB 的无损专辑轨常驻在内存里，为的只是省掉一次读盘 ——
 * 这笔账在 §10 那份内存账单面前划不来。
 */
const PREFETCH_MAX_BYTES = 32 * 1024 * 1024

/**
 * 等这么久再开始预取。
 *
 * 刚起播的那一两秒，在线曲目正在拉歌词和封面、本地曲目正在解封面，
 * 这时候再插一个整文件读取进去，抢的是用户马上就能看见的东西。
 */
const PREFETCH_DELAY_MS = 1500

export function dropPrefetch(): void {
  window.clearTimeout(prefetchTimer)
  // 序号一变，在途的那次预取回来时会发现自己已经过期，直接丢掉
  prefetchSeq++
  prefetched = null
}

/**
 * 预取命中就交出字节（本地曲目 quality 传 null，不看档位），没有则 null。
 * 命中即清空 —— 字节只能被消费一次。
 */
export function takePrefetch(id: string, quality: OnlineQuality | null): Uint8Array | null {
  if (prefetched?.id !== id) return null
  if (quality !== null && prefetched.quality !== quality) return null
  const bytes = prefetched.bytes
  prefetched = null
  return bytes
}

/**
 * 下一首在队列里的下标。null 表示没有下一首、或者**现在还不知道**。
 *
 * 随机模式走到本轮最后一首时就是"还不知道"：下一轮是那时才洗的。
 * 单曲循环也返回 null —— 下一首就是它自己，字节还在 `<audio>` 里。
 */
function peekNextIndex(): number | null {
  const { queue, index, mode } = usePlayer.getState()
  if (queue.length === 0 || index < 0) return null
  if (mode === "one") return null
  if (mode === "shuffle") return shuffle.peek(queue.length)
  const last = index >= queue.length - 1
  if (last && mode === "once") return null
  return last ? 0 : index + 1
}

async function prefetchNext(): Promise<void> {
  const i = peekNextIndex()
  if (i == null) return
  const track = usePlayer.getState().queue[i]
  if (!track) return
  const ref = localRef(track)
  const quality = ref ? null : qualityForTrack(track, usePlayer.getState().onlineQuality)
  if (prefetched?.id === track.id && prefetched.quality === quality) return

  if (ref && ref.size > PREFETCH_MAX_BYTES) return

  const mine = ++prefetchSeq
  try {
    const bytes = ref ? await platform.readFile(ref) : await fetchOnlineBytes(track, quality!)
    // 切歌比下载快时会走到这里：这份字节已经没人要了，别占着内存
    if (mine !== prefetchSeq || bytes.byteLength > PREFETCH_MAX_BYTES) return
    prefetched = { id: track.id, quality, bytes }

    // 顺带把响度也量出来。测量要解码整首歌（几百毫秒），放在这里意味着下一首
    // 一开声就是对齐的，不用等测量回来再滑一次音量
    if (engine.normalize && track.gainDb == null) {
      void loadLoudness(loudnessKey(track), bytes)
    }
  } catch {
    // 预取失败无所谓：真播到的时候会走正常路径再来一遍，该报的错在那里报
  }
}

export function schedulePrefetch(): void {
  window.clearTimeout(prefetchTimer)
  prefetchTimer = window.setTimeout(() => void prefetchNext(), PREFETCH_DELAY_MS)
}
