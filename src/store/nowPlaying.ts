import { platform } from "@/platform"
import { engine } from "@/audio/engine"
import type { Track } from "./library"

/** 上一次报给系统媒体面板的曲目与状态，用来判断有没有必要再报一次 */
let smtcKey = ""
/** 曲目 id → 封面文件路径。由 library.ensureCover 落盘后回填。 */
const coverPaths = new Map<string, string>()

/**
 * 上报原因。三种情况对去重与节流的要求不一样，用一个 boolean 的 force 区分不开：
 *
 * - `state` 切歌、播放/暂停：按 曲目|状态 去重，位置每秒变四次不该跟着报
 * - `cover` 封面异步解出来后补报：曲目与状态都没变，必须绕过去重，否则任务栏那格
 *   永远是空的。频率极低，直发
 * - `seek`  跳转：也要绕过去重（否则面板位置停在旧值直到下次暂停或切歌），但拖进度条
 *   时每个 pointermove 都会触发一次，直发等于几秒内上百次 IPC 打进 COM，必须节流
 */
export type PushReason = "state" | "cover" | "seek"

/** 拖动时的上报间隔。给足平滑感，又不至于把 IPC 打爆 */
const SEEK_PUSH_MS = 250
let seekTimer = 0
let seekPending: { track: Track; playing: boolean; position: number } | null = null

function sendNowPlaying(track: Track, playing: boolean, position: number): void {
  smtcKey = `${track.id}|${playing}`
  void platform.updateNowPlaying({
    title: track.title,
    artist: track.artist,
    album: track.album,
    playing,
    duration: track.duration || engine.duration,
    position,
    coverPath: coverPaths.get(track.id) ?? null,
  })
}

/** 报给系统媒体面板。 */
export function pushNowPlaying(
  track: Track | null,
  playing: boolean,
  position: number,
  reason: PushReason = "state",
): void {
  if (!track) return

  if (reason === "seek") {
    // 首尾都发：首帧让面板立刻跟上，尾帧保证松手后的最终位置一定落地 ——
    // 只做前沿节流的话，拖完停在哪儿面板是不知道的
    seekPending = { track, playing, position }
    if (seekTimer) return
    seekPending = null
    sendNowPlaying(track, playing, position)
    seekTimer = window.setTimeout(() => {
      seekTimer = 0
      const p = seekPending
      seekPending = null
      if (p) sendNowPlaying(p.track, p.playing, p.position)
    }, SEEK_PUSH_MS)
    return
  }

  if (reason === "state" && `${track.id}|${playing}` === smtcKey) return
  sendNowPlaying(track, playing, position)
}

/** 封面落盘后回填路径，下一次上报就会带上。 */
export function setNowPlayingCoverPath(id: string, path: string): void {
  coverPaths.set(id, path)
}
