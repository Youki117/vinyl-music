import { usePlayer } from "@/store/player"

/**
 * 音量控件。放在悬停才显现的标题栏里 —— 效果图上没有这个元素，硬塞进主画面
 * 会破坏版式，但只留快捷键又不好用（设计原则 1：能藏起来就藏起来）。
 */
export default function VolumeControl() {
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)

  const level = muted ? 0 : volume

  return (
    <div className="volume">
      <button onClick={toggleMute} aria-label={muted ? "取消静音" : "静音"} title="静音 (M)">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path fill="currentColor" d="M4 9.2h3.4L12 5.2v13.6l-4.6-4H4z" />
          {level === 0 ? (
            <path
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              d="m15.4 9.6 4.4 4.8m0-4.8-4.4 4.8"
            />
          ) : (
            <>
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                d="M15.3 9.4a3.6 3.6 0 0 1 0 5.2"
              />
              {level > 0.5 && (
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  d="M17.9 7.2a7 7 0 0 1 0 9.6"
                />
              )}
            </>
          )}
        </svg>
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={level}
        onChange={(e) => setVolume(Number(e.target.value))}
        aria-label="音量"
        title={`音量 ${Math.round(level * 100)}%`}
      />
    </div>
  )
}
