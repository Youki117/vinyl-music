import { REPEAT_LABEL, usePlayer } from "@/store/player"
import {
  IconArrowRight,
  IconList,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
} from "./icons"

/** E13：循环模式 / 上一首 / 播放暂停 / 下一首 / 播放列表。 */
export default function Controls({
  onToggle,
  onPrev,
  onNext,
  onOpenPlaylist,
}: {
  onToggle?: () => void
  onPrev?: () => void
  onNext?: () => void
  onOpenPlaylist?: () => void
}) {
  const status = usePlayer((s) => s.status)
  const mode = usePlayer((s) => s.mode)
  const cycleMode = usePlayer((s) => s.cycleMode)
  const playing = status === "playing"

  const ModeIcon =
    mode === "one" ? IconRepeatOne : mode === "shuffle" ? IconShuffle : mode === "once" ? IconArrowRight : IconRepeat

  return (
    <nav className="controls" aria-label="播放控制">
      <button onClick={cycleMode} aria-label={`播放模式：${REPEAT_LABEL[mode]}`} title={REPEAT_LABEL[mode]}>
        <ModeIcon />
      </button>
      <button onClick={onPrev} aria-label="上一首">
        <IconPrev />
      </button>
      <button className="play" onClick={onToggle} aria-label={playing ? "暂停" : "播放"}>
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <button onClick={onNext} aria-label="下一首">
        <IconNext />
      </button>
      <button onClick={onOpenPlaylist} aria-label="播放列表">
        <IconList />
      </button>
    </nav>
  )
}
