import { useMemo, useState } from "react"

import {
  ONLINE_QUALITY_OPTIONS,
  qualityForTrack,
  usePlayer,
  type OnlineQuality,
} from "@/store/player"
import { useDismiss } from "./useDismiss"

const labelOf = (quality: OnlineQuality): string =>
  ONLINE_QUALITY_OPTIONS.find((item) => item.id === quality)?.label ?? quality

/** 播放控制区的在线音质选择。首选档位全局保存，当前曲目缺档位时明确显示实际降级结果。 */
export default function QualityControl() {
  const [open, setOpen] = useState(false)
  const track = usePlayer((s) => s.current())
  const preferred = usePlayer((s) => s.onlineQuality)
  const active = usePlayer((s) => s.activeOnlineQuality)
  const status = usePlayer((s) => s.qualityStatus)
  const error = usePlayer((s) => s.qualityError)
  const setQuality = usePlayer((s) => s.setOnlineQuality)
  const rootRef = useDismiss<HTMLDivElement>(open, () => setOpen(false))

  const available = useMemo(
    () =>
      new Set(
        track?.origin.kind === "online"
          ? track.origin.qualities.filter((q): q is OnlineQuality =>
              ONLINE_QUALITY_OPTIONS.some((item) => item.id === q),
            )
          : [],
      ),
    [track],
  )
  const effective = track?.origin.kind === "online" ? qualityForTrack(track, preferred) : preferred
  const shown = track?.origin.kind === "online" ? (active ?? effective) : preferred
  const unavailable = track?.origin.kind === "online" && available.size > 0 && !available.has(preferred)

  return (
    <div ref={rootRef} className="quality-control">
      <button
        className="quality-trigger"
        data-on={open || status === "switching"}
        onClick={() => setOpen((v) => !v)}
        aria-label={`播放音质：${labelOf(shown)}`}
        aria-expanded={open}
        title={`播放音质：${labelOf(shown)}`}
      >
        <span>{status === "switching" ? "···" : labelOf(shown)}</span>
      </button>

      {open && (
        <section className="quality-popover" aria-label="播放音质选择">
          <header>
            <div>
              <b>播放音质</b>
              <span>在线歌曲切换后尽量保持当前进度</span>
            </div>
            {track?.origin.kind === "local" && <em>本地原音</em>}
          </header>

          <div className="quality-options">
            {ONLINE_QUALITY_OPTIONS.map((item) => {
              const knownUnavailable =
                track?.origin.kind === "online" && available.size > 0 && !available.has(item.id)
              return (
                <button
                  key={item.id}
                  data-on={preferred === item.id}
                  data-unavailable={knownUnavailable}
                  onClick={() => void setQuality(item.id)}
                >
                  <span>{item.label}</span>
                  <em>{item.detail}</em>
                </button>
              )
            })}
          </div>

          {status === "switching" && (
            <p className="quality-note">正在准备新音质，完成前继续播放当前音频…</p>
          )}
          {status === "error" && error && <p className="quality-note error">切换失败：{error}</p>}
          {track?.origin.kind === "local" && (
            <p className="quality-note">本地文件始终按原文件播放；这里的选择用于下一首在线歌曲。</p>
          )}
          {!track && <p className="quality-note">选择会保存为下一首在线歌曲的首选音质。</p>}
          {unavailable && status !== "switching" && (
            <p className="quality-note">
              当前歌曲没有“{labelOf(preferred)}”，实际使用“{labelOf(effective)}”。
            </p>
          )}
        </section>
      )}
    </div>
  )
}
