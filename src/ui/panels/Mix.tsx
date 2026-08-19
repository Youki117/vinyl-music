import { useEffect, useState } from "react"

import { engine } from "@/audio/engine"
import { useProgress } from "@/audio/useProgress"
import { loadPeaks } from "@/audio/peaks"
import {
  clipAt,
  duplicateClip,
  removeClip,
  setGain,
  splitAt,
  type Clip,
} from "@/audio/clips"
import { formatTime } from "@/lib/format"
import { platform } from "@/platform"
import { localRef, useLibrary } from "@/store/library"
import { useMix } from "@/store/mix"
import { usePlayer } from "@/store/player"
import Timeline from "./Timeline"
import { useDismiss } from "../useDismiss"

/**
 * 混音面板：在当前曲目之上叠加其他音轨，按片段编排。
 *
 * 片段模型而非曲线包络——「这段不要」直接删掉那块，比画四个控制点把中间压到 0
 * 直观得多，也正是剪辑软件的做法。
 *
 * 全程只是运行时混音，不改动也不产出任何音频文件。
 */
export default function Mix({ open, onClose }: { open: boolean; onClose: () => void }) {
  const host = usePlayer((s) => s.current())
  const mix = useMix((s) => s.current())
  const selectedLayerId = useMix((s) => s.selectedId)
  const loading = useMix((s) => s.loading)
  const error = useMix((s) => s.error)
  const addLayer = useMix((s) => s.addLayer)
  const removeLayer = useMix((s) => s.removeLayer)
  const patchLayer = useMix((s) => s.patchLayer)
  const setClips = useMix((s) => s.setClips)
  const selectLayer = useMix((s) => s.select)
  const tracks = useLibrary((s) => s.tracks)
  const byId = useLibrary((s) => s.byId)

  const [picking, setPicking] = useState(false)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const { time } = useProgress()
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)

  const layers = mix?.layers ?? []
  const layer = layers.find((l) => l.id === selectedLayerId) ?? layers[0] ?? null
  const sourceTrack = layer ? byId(layer.trackId) : undefined
  const hostDuration = host?.duration || engine.duration || 60

  // 为选中层算波形。剪辑必须看得见波形，否则是盲剪。
  useEffect(() => {
    setPeaks(null)
    if (!sourceTrack) return
    let alive = true
    void (async () => {
      try {
        // 波形要把整段音频解码一遍，只有本地文件做得到；混音本来也只接受本地曲目
        const ref = localRef(sourceTrack)
        if (!ref) return
        // 惰性传字节：波形缓存命中时（换层来回切基本都命中）连文件都不用读
        const p = await loadPeaks(ref, () => platform.readFile(ref))
        if (alive) setPeaks(p)
      } catch {
        // 算不出波形不影响编辑，只是看不见形状
      }
    })()
    return () => {
      alive = false
    }
  }, [sourceTrack])

  if (!open) return null

  const clips = layer?.clips ?? []
  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null
  const clipUnderPlayhead = clipAt(clips, time)
  const apply = (next: Clip[]) => layer && setClips(layer.id, next)

  return (
    <div ref={rootRef} className="drawer skin-editor mix-panel" role="dialog" aria-label="混音">
      <header>
        <nav className="tabs">
          <button data-on>混音</button>
        </nav>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      <div className="skin-body">
        {!host ? (
          <p className="hint">先播放一首歌，叠加轨会挂在它上面。</p>
        ) : (
          <>
            <p className="section-title">主音轨</p>
            <p className="hint host-name">
              {host.title}
              <b> · {formatTime(hostDuration)}</b>
            </p>

            <p className="section-title">
              叠加轨
              <button className="mini-add" onClick={() => setPicking((v) => !v)}>
                {picking ? "收起" : "＋ 添加"}
              </button>
            </p>

            {picking && (
              <div className="track-picker">
                {tracks
                  .filter((t) => t.id !== host.id && !layers.some((l) => l.trackId === t.id))
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        void addLayer(t.id)
                        setPicking(false)
                      }}
                    >
                      <span>{t.title}</span>
                      <em>{formatTime(t.duration)}</em>
                    </button>
                  ))}
                {tracks.length <= 1 && <p className="hint">曲库里还没有别的曲目。</p>}
              </div>
            )}

            {layers.length === 0 && !picking && (
              <p className="hint">还没有叠加轨。点「＋ 添加」挑一首叠上来。</p>
            )}

            {layers.map((l) => (
              <div key={l.id} className="layer-row" data-on={l.id === layer?.id}>
                <button className="layer-name" onClick={() => selectLayer(l.id)}>
                  {l.name}
                  <em>{l.clips.length} 段</em>
                </button>
                <div className="layer-ctl">
                  <button
                    onClick={() => patchLayer(l.id, { muted: !l.muted })}
                    title={l.muted ? "取消静音" : "静音"}
                  >
                    {l.muted ? "🔇" : "🔊"}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={l.volume}
                    onChange={(e) => patchLayer(l.id, { volume: Number(e.target.value) })}
                    aria-label={`${l.name} 音量`}
                  />
                  <em>{Math.round(l.volume * 100)}</em>
                  <button className="danger" onClick={() => removeLayer(l.id)} title="移除这一层">
                    ✕
                  </button>
                </div>
              </div>
            ))}

            {layer && (
              <>
                <p className="section-title">音轨编辑 · {layer.name}</p>
                <Timeline
                  hostDuration={hostDuration}
                  sourceDuration={sourceTrack?.duration ?? 0}
                  clips={clips}
                  peaks={peaks}
                  selectedId={selectedClipId}
                  onSelect={setSelectedClipId}
                  onChange={apply}
                />

                <div className="chip-row">
                  <button
                    disabled={!clipUnderPlayhead}
                    onClick={() => {
                      apply(splitAt(clips, time))
                      setSelectedClipId(null)
                    }}
                    title="在播放头位置把片段切成两段"
                  >
                    ✂ 在播放头分割
                  </button>
                  <button
                    className="danger"
                    disabled={!selectedClip}
                    onClick={() => {
                      if (!selectedClip) return
                      apply(removeClip(clips, selectedClip.id))
                      setSelectedClipId(null)
                    }}
                    title="删掉选中的片段，那段就静音了"
                  >
                    删除片段
                  </button>
                  <button
                    disabled={!selectedClip}
                    onClick={() => selectedClip && apply(duplicateClip(clips, selectedClip.id, hostDuration))}
                    title="复制一份放到后面的空位"
                  >
                    复制片段
                  </button>
                </div>

                {selectedClip ? (
                  <>
                    <p className="section-title">选中片段</p>
                    <p className="hint clip-info">
                      {formatTime(selectedClip.at)} – {formatTime(selectedClip.at + selectedClip.duration)}
                      <b> · 取自源 {formatTime(selectedClip.sourceStart)}</b>
                    </p>
                    <label className="slider">
                      <span>片段音量</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={selectedClip.gain}
                        onChange={(e) => apply(setGain(clips, selectedClip.id, Number(e.target.value)))}
                      />
                      <em>{Math.round(selectedClip.gain * 100)}</em>
                    </label>
                  </>
                ) : (
                  <p className="hint">在时间轴上点一个片段来选中它。</p>
                )}

                <p className="hint">
                  拖片段中间移位，拖两端裁剪长度。片段之间的空白就是静音——
                  「只留副歌」的做法是：在副歌前后各分割一刀，再把两边删掉。
                  每段边缘有 20ms 自动淡变，不会咔哒。
                </p>
              </>
            )}

            {loading && <p className="hint">正在载入叠加轨…</p>}
            {error && <p className="hint danger-text">{error}</p>}
            <p className="hint">
              全程只是实时混音，不会改动也不会生成任何音频文件，原始文件始终原样不动。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
