import { useEffect, useState } from "react"

import { engine } from "@/audio/engine"
import { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, EQ_PRESETS } from "@/audio/eq"
import { usePlayer } from "@/store/player"

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SLEEP_OPTIONS = [15, 30, 45, 60, 90]

/** 播放设置：均衡器、倍速、睡眠定时器、输出设备。 */
export default function Playback({ open, onClose }: { open: boolean; onClose: () => void }) {
  const speed = usePlayer((s) => s.speed)
  const setSpeed = usePlayer((s) => s.setSpeed)

  const [eqOn, setEqOn] = useState(engine.eqEnabled)
  const [gains, setGains] = useState<number[]>(engine.eqGains)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [afterTrack, setAfterTrack] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState(engine.outputDevice)
  const [deviceError, setDeviceError] = useState<string | null>(null)

  useEffect(() => engine.onSleepChange(setRemaining), [])

  useEffect(() => {
    if (!open) return
    // 每秒刷新倒计时
    const id = window.setInterval(() => setRemaining(engine.sleepRemaining), 1000)
    void engine.listOutputDevices().then(setDevices)
    return () => window.clearInterval(id)
  }, [open])

  if (!open) return null

  const applyGains = (next: number[]) => {
    setGains(next)
    engine.setEqGains(next)
    if (!eqOn) {
      setEqOn(true)
      engine.setEqEnabled(true)
    }
  }

  return (
    <div className="drawer skin-editor" role="dialog" aria-label="播放设置">
      <header>
        <nav className="tabs">
          <button data-on>播放设置</button>
        </nav>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      <div className="skin-body">
        <p className="section-title">播放速度</p>
        <div className="chip-row">
          {SPEEDS.map((s) => (
            <button key={s} data-on={Math.abs(speed - s) < 0.01} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <p className="hint">变速不变调，1.5 倍速也不会把人声唱成花栗鼠。</p>

        <p className="section-title">
          睡眠定时器
          {remaining !== null && <b> · 剩 {Math.ceil(remaining / 60000)} 分钟</b>}
        </p>
        <div className="chip-row">
          {SLEEP_OPTIONS.map((m) => (
            <button key={m} onClick={() => engine.setSleepTimer(m, afterTrack)}>
              {m} 分钟
            </button>
          ))}
          <button className="danger" onClick={() => engine.cancelSleepTimer()}>
            取消
          </button>
        </div>
        <label className="row-field">
          <span>播完再停</span>
          <input
            type="checkbox"
            checked={afterTrack}
            onChange={(e) => setAfterTrack(e.target.checked)}
          />
        </label>
        <p className="hint">勾上后，到点会等当前这首播完再暂停，不会把歌切断。</p>

        <p className="section-title">
          均衡器
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={eqOn}
              onChange={(e) => {
                setEqOn(e.target.checked)
                engine.setEqEnabled(e.target.checked)
              }}
            />
            启用
          </label>
        </p>

        <div className="chip-row">
          {EQ_PRESETS.map((p) => (
            <button key={p.name} onClick={() => applyGains(p.gains)}>
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
        <p className="hint">关闭时整条滤波器链会被旁路，不占 CPU。</p>

        <p className="section-title">输出设备</p>
        <select
          className="wide-select"
          value={device}
          onChange={(e) => {
            const id = e.target.value
            setDevice(id)
            setDeviceError(null)
            engine.setOutputDevice(id).catch((err) => setDeviceError(String(err.message ?? err)))
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
        {devices.length === 0 && <p className="hint">未枚举到设备（部分环境需先授权麦克风才会给出设备名）。</p>}
      </div>
    </div>
  )
}
