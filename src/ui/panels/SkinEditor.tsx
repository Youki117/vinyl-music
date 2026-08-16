import { useRef, useState } from "react"

import { platform } from "@/platform"
import { labelBackground } from "@/skin/resolve"
import { useSkin } from "@/store/skin"
import AiTab from "./AiTab"
import { useDismiss } from "../useDismiss"

/**
 * 皮肤面板：导入底图、调整取景框、调蒙版参数、改文案。
 *
 * 取景框所见即所得 —— 左边拖底图焦点，右边拖/滚轮调贴纸取景，两边实时反映到
 * 舞台上。默认值（中心偏上、zoom 2.2）对人物照片通常一次就能取到脸，
 * 用户可以直接关掉面板不调（PRD F5.3）。
 */
export default function SkinEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const skin = useSkin((s) => s.skin)
  const backdrop = useSkin((s) => s.backdrop)
  const label = useSkin((s) => s.label)
  const setBackdrop = useSkin((s) => s.setBackdrop)
  const setLabelSource = useSkin((s) => s.setLabelSource)
  const patchVeil = useSkin((s) => s.patchVeil)
  const patchSkin = useSkin((s) => s.patchSkin)
  const [tab, setTab] = useState<"image" | "veil" | "text" | "ai">("image")

  const dragRef = useRef<{ mode: "backdrop" | "label"; x: number; y: number } | null>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)

  if (!open) return null

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || e.buttons !== 1) return
    const rect = e.currentTarget.getBoundingClientRect()
    const dx = (e.clientX - d.x) / rect.width
    const dy = (e.clientY - d.y) / rect.height
    dragRef.current = { ...d, x: e.clientX, y: e.clientY }

    if (d.mode === "backdrop") {
      patchSkin({
        backdropFocus: {
          x: clamp01(skin.backdropFocus.x - dx),
          y: clamp01(skin.backdropFocus.y - dy),
        },
      })
    } else {
      patchSkin({
        label: {
          ...skin.label,
          focus: {
            ...skin.label.focus,
            x: clamp01(skin.label.focus.x - dx / skin.label.focus.zoom),
            y: clamp01(skin.label.focus.y - dy / skin.label.focus.zoom),
          },
        },
      })
    }
  }

  const startDrag = (mode: "backdrop" | "label") => (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { mode, x: e.clientX, y: e.clientY }
  }

  const onLabelWheel = (e: React.WheelEvent) => {
    const zoom = Math.min(6, Math.max(1, skin.label.focus.zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
    patchSkin({ label: { ...skin.label, focus: { ...skin.label.focus, zoom } } })
  }

  return (
    <div ref={rootRef} className="drawer skin-editor" role="dialog" aria-label="皮肤设置">
      <header>
        <nav className="tabs">
          <button data-on={tab === "image"} onClick={() => setTab("image")}>
            底图
          </button>
          <button data-on={tab === "veil"} onClick={() => setTab("veil")}>
            蒙版
          </button>
          <button data-on={tab === "text"} onClick={() => setTab("text")}>
            文案
          </button>
          <button data-on={tab === "ai"} onClick={() => setTab("ai")}>
            AI 配图
          </button>
        </nav>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>

      <div className="skin-body">
        {tab === "image" && (
          <>
            <button
              className="wide"
              onClick={() => void platform.pickImage().then((r) => r && setBackdrop(r))}
            >
              选择底图图片…
            </button>

            {backdrop ? (
              <>
                <p className="hint">拖动可调整底图焦点，避免人脸被裁掉</p>
                <div
                  className="preview backdrop-preview"
                  style={{
                    backgroundImage: `url(${backdrop.url})`,
                    backgroundPosition: `${skin.backdropFocus.x * 100}% ${skin.backdropFocus.y * 100}%`,
                  }}
                  onPointerDown={startDrag("backdrop")}
                  onPointerMove={onDragMove}
                />

                <p className="hint">
                  唱片贴纸 —— 拖动调位置，滚轮调缩放
                  {skin.label.source === "backdrop" ? "（正跟随底图）" : "（已脱离底图）"}
                </p>
                <div className="label-row">
                  <div
                    className="preview label-preview"
                    style={label ? labelBackground(label.url, skin.label.focus, label.width, label.height) : undefined}
                    onPointerDown={startDrag("label")}
                    onPointerMove={onDragMove}
                    onWheel={onLabelWheel}
                  />
                  <div className="label-actions">
                    <button
                      onClick={() => void platform.pickImage().then((r) => r && setLabelSource(r))}
                    >
                      单独指定贴纸图
                    </button>
                    <button
                      disabled={skin.label.source === "backdrop"}
                      onClick={() => void setLabelSource("backdrop")}
                    >
                      恢复跟随底图
                    </button>
                    <button
                      onClick={() =>
                        patchSkin({
                          label: { ...skin.label, focus: { x: 0.5, y: 0.32, zoom: 2.2 } },
                        })
                      }
                    >
                      重置取景
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <p className="hint">还没有底图。当前用的是内置底纹。</p>
            )}
          </>
        )}

        {tab === "veil" && (
          <>
            <Slider
              label="边缘位置"
              value={skin.veil.edgeX}
              min={0.15}
              max={0.85}
              onChange={(edgeX) => patchVeil({ edgeX })}
            />
            <Slider
              label="羽化宽度"
              value={skin.veil.softness}
              min={0.01}
              max={0.3}
              onChange={(softness) => patchVeil({ softness })}
            />
            <Slider
              label="不透明度"
              value={skin.veil.opacity}
              min={0.2}
              max={0.92}
              onChange={(opacity) => patchVeil({ opacity })}
            />
            <Slider
              label="边缘蜿蜒"
              value={skin.veil.wander}
              min={0}
              max={0.3}
              onChange={(wander) => patchVeil({ wander })}
            />
            <Slider
              label="呼吸强度"
              value={skin.veil.breath}
              min={0}
              max={1}
              onChange={(breath) => patchVeil({ breath })}
            />
            <Slider
              label="随音乐波动"
              value={skin.veil.waveAmp}
              min={0}
              max={1}
              onChange={(waveAmp) => patchVeil({ waveAmp })}
            />
            <label className="row-field">
              <span>蒙版色</span>
              <input
                type="color"
                value={skin.veil.tint}
                onChange={(e) => patchVeil({ tint: e.target.value })}
              />
            </label>
            <p className="hint">不透明度上限 0.92：底图必须能透出来，做成纯白就失去层次了。</p>
          </>
        )}

        {tab === "text" && (
          <>
            {(["title", "subtitle", "year", "byline"] as const).map((k) => (
              <label key={k} className="row-field">
                <span>{{ title: "主标题", subtitle: "副标题", year: "年份", byline: "署名" }[k]}</span>
                <input
                  value={skin.text[k]}
                  onChange={(e) => patchSkin({ text: { ...skin.text, [k]: e.target.value } })}
                />
              </label>
            ))}
            <label className="row-field">
              <span>自动配色</span>
              <input
                type="checkbox"
                checked={skin.ink.auto}
                onChange={(e) => patchSkin({ ink: { ...skin.ink, auto: e.target.checked } })}
              />
            </label>
            <p className="hint">
              SELP-PORTRAIT 是效果图原样保留的拼写（还原优先），这里可以随时改掉。
            </p>
          </>
        )}

        {tab === "ai" && <AiTab />}
      </div>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.005}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <em>{value.toFixed(2)}</em>
    </label>
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
