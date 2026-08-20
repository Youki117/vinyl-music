import { usePlayer } from "@/store/player"

/**
 * 音量控件。作为右侧工具栏的一项。
 *
 * 原来挂在左上角标题栏上，和最小化/最大化/关闭排在一条 —— 那条应该只管窗口，
 * 音量是应用功能，归属不对。挪进右侧栏之后左上角只剩窗口控制，画面也清爽了。
 *
 * 竖栏只有 44px 宽，塞不下滑块，所以做成**按钮 + 悬停左侧飞出滑块**：
 * 平时只占一个和其它工具一样大的图标位，要调的时候才展开。飞出层用
 * opacity + visibility 而不是 display，才有渐变；visibility 保证收起时点不到。
 */
export default function VolumeControl() {
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)

  const level = muted ? 0 : volume

  return (
    <div className="sb-volume">
      <button
        className="sb-tool"
        onClick={toggleMute}
        aria-label={muted ? "取消静音" : "静音"}
        title={`音量 ${Math.round(level * 100)}%　静音 (M)`}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
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

      <div className="sb-volume-flyout">
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
    </div>
  )
}
