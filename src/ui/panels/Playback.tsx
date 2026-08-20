import { useEffect, useState } from "react"

import { engine } from "@/audio/engine"
import { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, EQ_PRESETS } from "@/audio/eq"
import { formatTime } from "@/lib/format"
import { usePlayer } from "@/store/player"
import { useDismiss } from "../useDismiss"

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SLEEP_OPTIONS = [15, 30, 45, 60, 90]

/** 播放设置：均衡器、倍速、睡眠定时器、输出设备。 */
export default function Playback({ open, onClose }: { open: boolean; onClose: () => void }) {
  const speed = usePlayer((s) => s.speed)
  const setSpeed = usePlayer((s) => s.setSpeed)
  const setOutputDevice = usePlayer((s) => s.setOutputDevice)
  // EQ 也走 store：engine 上的值只有 save() 会读，而 save() 只被 store 的
  // setter 触发。直接调 engine 的话，调完 EQ 不碰别的设置就退出，这次调整就丢了
  const setEqEnabled = usePlayer((s) => s.setEqEnabled)
  const setEqGains = usePlayer((s) => s.setEqGains)
  const normalize = usePlayer((s) => s.normalize)
  const setNormalize = usePlayer((s) => s.setNormalize)

  const [eqOn, setEqOn] = useState(engine.eqEnabled)
  const [gains, setGains] = useState<number[]>(engine.eqGains)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [sleepChoice, setSleepChoice] = useState<number | null>(null)
  const [afterTrack, setAfterTrack] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState(engine.outputDevice)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  /**
   * 当前这首被加了多少 dB。engine 上这个值不是响应式的，而且它可能在测量完成后
   * 才落定 —— 跟着下面那个每秒一次的定时器读就够了，为一行只读文字单开一条订阅不值。
   */
  const [gainDb, setGainDb] = useState(engine.trackGainDb)

  const [loop, setLoop] = useState(engine.loop)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)

  useEffect(
    () =>
      engine.onSleepChange((ms) => {
        setRemaining(ms)
        if (ms === null) setSleepChoice(null)
      }),
    [],
  )
  useEffect(() => engine.onLoopChange(setLoop), [])

  useEffect(() => {
    if (!open) return
    // 每秒刷新倒计时
    const id = window.setInterval(() => {
      setRemaining(engine.sleepRemaining)
      setGainDb(engine.trackGainDb)
    }, 1000)
    void engine.listOutputDevices().then(setDevices)
    return () => window.clearInterval(id)
  }, [open])

  if (!open) return null

  const applyGains = (next: number[]) => {
    setGains(next)
    setEqGains(next)
    if (!eqOn) {
      setEqOn(true)
      setEqEnabled(true)
    }
  }
  const activePreset = EQ_PRESETS.find((preset) =>
    preset.gains.every((gain, i) => Math.abs(gain - (gains[i] ?? 0)) < 0.01),
  )?.name

  return (
    <div ref={rootRef} className="drawer settings-drawer" role="dialog" aria-label="播放设置">
      <header className="panel-header">
        <h2>播放与调音设置</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      <div className="panel-scroll settings-body">
        <section className="panel-section">
          <div className="panel-title-row">
            <h3>音频输出设备</h3>
            <span>{devices.find((d) => d.deviceId === device)?.label || "系统默认"}</span>
          </div>
          <select
            className="wide-select"
            value={device}
            onChange={(e) => {
              const id = e.target.value
              setDevice(id)
              setDeviceError(null)
              // 走 store 而不是直接调 engine：设备选择要跟 EQ、速度一样落盘
              setOutputDevice(id).catch((err) => setDeviceError(String(err.message ?? err)))
            }}
          >
            <option value="">系统默认</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `设备 ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
          {deviceError && <p className="hint danger-text">{deviceError}</p>}
          {devices.length === 0 && (
            <p className="hint">未枚举到设备；部分环境需要先授予系统音频设备访问权限。</p>
          )}
        </section>

        <section className="panel-section">
          <div className="panel-title-row">
            <h3>播放倍速</h3>
            <span>变速不变调</span>
          </div>
          <div className="chip-row grid-six">
            {SPEEDS.map((s) => (
              <button key={s} data-on={Math.abs(speed - s) < 0.01} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <div className="panel-title-row">
            <h3>A-B 段落循环</h3>
            <span>
              {loop.a === null
                ? "未启用"
                : loop.b === null
                  ? `A ${formatTime(loop.a)} · 等待 B 点`
                  : `${formatTime(loop.a)} → ${formatTime(loop.b)}`}
            </span>
          </div>
          <p className="hint">
            在段落头尾设置 A、B 点，播放到 B 点会自动回到 A 点；快捷键 <code>L</code>。
          </p>
          <div className="chip-row grid-three">
            <button data-on={loop.a !== null} onClick={() => engine.setLoop(engine.currentTime, null)}>
              设 A 点
            </button>
            <button disabled={loop.a === null || loop.b !== null} onClick={() => engine.cycleLoop()}>
              设 B 点
            </button>
            <button disabled={loop.a === null} onClick={() => engine.setLoop(null, null)}>
              清除循环
            </button>
          </div>
        </section>

        <section className="panel-section">
          <div className="panel-title-row">
            <h3>睡眠定时</h3>
            <span>{remaining === null ? "未启用" : `剩 ${Math.ceil(remaining / 60000)} 分钟`}</span>
          </div>
          <div className="chip-row grid-five">
            {SLEEP_OPTIONS.map((m) => (
              <button
                key={m}
                data-on={sleepChoice === m}
                onClick={() => {
                  setSleepChoice(m)
                  engine.setSleepTimer(m, afterTrack)
                }}
              >
                {m}m
              </button>
            ))}
          </div>
          <div className="setting-toggle-row">
            <div>
              <b>播完当前歌曲后再停止</b>
              <span>到点时不切断正在播放的歌曲</span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={afterTrack}
                onChange={(e) => setAfterTrack(e.target.checked)}
              />
              <span />
            </label>
          </div>
          {remaining !== null && (
            <button
              className="panel-link danger"
              onClick={() => {
                setSleepChoice(null)
                engine.cancelSleepTimer()
              }}
            >
              取消睡眠定时
            </button>
          )}
        </section>

        <section className="panel-section">
          <div className="panel-title-row">
            <div>
              <h3>专业均衡器（EQ）</h3>
              <p>预设与 10 段频率增益微调</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={eqOn}
                onChange={(e) => {
                  setEqOn(e.target.checked)
                  setEqEnabled(e.target.checked)
                }}
              />
              <span />
            </label>
          </div>
          <div className="chip-row eq-presets">
            {EQ_PRESETS.map((p) => (
              <button
                key={p.name}
                data-on={activePreset === p.name}
                onClick={() => applyGains(p.gains)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="eq-grid" data-off={!eqOn}>
            {EQ_BANDS.map((hz, i) => (
              <div key={hz} className="eq-band">
                <input
                  type="range"
                  min={EQ_MIN_DB}
                  max={EQ_MAX_DB}
                  step={0.5}
                  value={gains[i] ?? 0}
                  onChange={(e) => {
                    const next = [...gains]
                    next[i] = Number(e.target.value)
                    applyGains(next)
                  }}
                  aria-label={`${hz}Hz`}
                />
                <em>{hz >= 1000 ? `${hz / 1000}k` : hz}</em>
                <i>{(gains[i] ?? 0) > 0 ? `+${gains[i]}` : (gains[i] ?? 0)}</i>
              </div>
            ))}
          </div>
          <p className="hint">关闭时整条滤波器链会旁路，不占额外 CPU。</p>
        </section>

        <section className="panel-section">
          <div className="setting-toggle-row">
            <div>
              <b>音量智能归一化</b>
              <span>
                EBU R128 标准，换歌不再忽大忽小
                {normalize && gainDb !== 0
                  ? ` · 当前 ${gainDb > 0 ? "+" : ""}${gainDb.toFixed(1)} dB`
                  : ""}
              </span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={normalize}
                onChange={(e) => setNormalize(e.target.checked)}
              />
              <span />
            </label>
          </div>
          <p className="hint">
            优先读取 ReplayGain；没有标签时会在后台测量并缓存，同一文件只计算一次。
          </p>
        </section>
      </div>
    </div>
  )
}
