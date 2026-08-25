import { useRef, useState } from "react"

import { platform } from "@/platform"
import { BUILTIN_BACKDROPS } from "@/skin/backdrops"
import { labelBackground } from "@/skin/resolve"
import { useSkin } from "@/store/skin"
import { IconPlus } from "../icons"
import AiTab from "./AiTab"
import WeRail from "./WeRail"
import { useDismiss } from "../useDismiss"
import { useRailWheel } from "../useRailWheel"

/**
 * 皮肤面板：导入底图、调整取景框、调蒙版参数、查看固定标题规则。
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
  const skins = useSkin((s) => s.skins)
  const tintColors = useSkin((s) => s.tintColors)
  const customBackdrops = useSkin((s) => s.customBackdrops)
  const saveAs = useSkin((s) => s.saveAs)
  const activate = useSkin((s) => s.activate)
  const removeSkin = useSkin((s) => s.removeSkin)
  const applyVeilFrom = useSkin((s) => s.applyVeilFrom)
  const [tab, setTab] = useState<"image" | "veil" | "text" | "ai">("image")
  const [presetName, setPresetName] = useState("")

  const dragRef = useRef<{ mode: "backdrop" | "label"; x: number; y: number } | null>(null)
  const backdropRailRef = useRef<HTMLDivElement>(null)
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)

  useRailWheel(backdropRailRef, open && tab === "image")

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

  // 名字留空就按序号给一个，不拦着用户存
  const savePreset = () => {
    void saveAs(presetName.trim() || `预设 ${skins.length + 1}`)
    setPresetName("")
  }

  const onLabelWheel = (e: React.WheelEvent) => {
    const zoom = Math.min(6, Math.max(1, skin.label.focus.zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
    patchSkin({ label: { ...skin.label, focus: { ...skin.label.focus, zoom } } })
  }

  return (
    <div ref={rootRef} className="drawer skin-editor" role="dialog" aria-label="皮肤设置">
      <header className="panel-header">
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

      <div className="panel-scroll skin-body">
        {tab === "image" && (
          <>
            <section className="panel-section">
            {/*
              背景图片。装完不选图就只有一层 CSS 渐变，而整套配色都是从底图现算的，
              没有图等于看不出效果。setBackdrop 只用 ref.id，所以这里给个合成的
              FileRef 就够，loadMedia 见到 builtin: 前缀会走打包后的资源 URL。
              用户手动选过的图保留小缩略图和原路径，排在内置图之后；最后一格才是
              “继续选择”，这样它与其它选项等大，也不用每次从独立大按钮重新进入。
            */}
            <p className="hint">背景图片</p>
            <div ref={backdropRailRef} className="builtin-backdrops" aria-label="背景图片选择">
              {BUILTIN_BACKDROPS.map((b) => (
                <button
                  key={b.id}
                  className="builtin-backdrop"
                  data-on={skin.backdrop === b.id}
                  style={{ backgroundImage: `url(${b.url})` }}
                  onClick={() => void setBackdrop({ id: b.id, name: b.name, size: 0, mtime: 0 })}
                  aria-label={b.name}
                  aria-pressed={skin.backdrop === b.id}
                  title={b.name}
                />
              ))}
              {customBackdrops.map((item) => (
                <button
                  key={item.id}
                  className="builtin-backdrop"
                  data-on={skin.backdrop === item.id}
                  style={{ backgroundImage: `url(${item.thumbnail})` }}
                  onClick={() =>
                    void setBackdrop({ id: item.id, name: item.name, size: 0, mtime: 0 })
                  }
                  aria-label={`使用自定义底图 ${item.name}`}
                  aria-pressed={skin.backdrop === item.id}
                  title={item.name}
                />
              ))}
              <button
                className="builtin-backdrop backdrop-picker"
                onClick={() => void platform.pickImage().then((r) => r && setBackdrop(r))}
                aria-label="添加自定义背景图片"
                title="添加自定义背景图片"
              >
                <IconPlus size={16} />
                <span>自定义</span>
              </button>
            </div>
            </section>

            <WeRail activeId={skin.backdrop} onPick={(ref) => void setBackdrop(ref)} />

            {backdrop ? (
              <>
                <section className="panel-section">
                <p className="hint">拖动可调整底图焦点，避免人脸被裁掉</p>
                <div
                  className="preview backdrop-preview"
                  style={{
                    backgroundImage: `url(${backdrop.poster})`,
                    backgroundPosition: `${skin.backdropFocus.x * 100}% ${skin.backdropFocus.y * 100}%`,
                  }}
                  onPointerDown={startDrag("backdrop")}
                  onPointerMove={onDragMove}
                />
                </section>

                <section className="panel-section">
                <label className="row-field">
                  <span>黑胶中心优先显示</span>
                  <select
                    value={skin.label.prefer}
                    onChange={(e) =>
                      patchSkin({
                        label: { ...skin.label, prefer: e.target.value as "cover" | "skin" },
                      })
                    }
                  >
                    <option value="cover">曲目封面</option>
                    <option value="skin">背景图片</option>
                  </select>
                </label>
                <p className="hint">
                  {skin.label.prefer === "cover"
                    ? "有内嵌封面就显示封面；没有封面的曲目（在线曲目、没打标签的文件）退回下面这张图。"
                    : "永远用下面这张图，曲目自带的封面不显示。"}
                </p>

                <p className="hint">
                  唱片贴纸 —— 拖动调位置，滚轮调缩放
                  {skin.label.source === "backdrop" ? "（正跟随底图）" : "（已脱离底图）"}
                </p>
                <div className="label-row">
                  <div
                    className="preview label-preview"
                    style={label ? labelBackground(label.poster, skin.label.focus, label.width, label.height) : undefined}
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
                </section>
              </>
            ) : (
              <div className="panel-empty">还没有底图。当前用的是内置底纹。</div>
            )}
          </>
        )}

        {tab === "veil" && (
          <>
            <section className="panel-section veil-sliders">
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
              label="边缘起伏"
              value={skin.veil.ripple}
              min={0}
              max={1}
              onChange={(ripple) => patchVeil({ ripple })}
            />
            </section>
            <section className="panel-section">
            <label className="row-field row-switch">
              <span>自动从底图取色</span>
              <span className="switch">
                <input
                  type="checkbox"
                  checked={skin.tintAuto}
                  onChange={(e) => patchSkin({ tintAuto: e.target.checked })}
                />
                <span aria-hidden="true" />
              </span>
            </label>

            {skin.tintAuto &&
              (tintColors.length > 0 ? (
                <div className="tint-swatches" aria-label="从底图取到的三个主色">
                  {tintColors.map((c, i) => (
                    <span key={`${c}-${i}`} style={{ background: c }} title={`第 ${i + 1} 段 ${c}`} />
                  ))}
                  <em>按播放进度依次切换，每色 1/3 时长</em>
                </div>
              ) : (
                <p className="hint">还没有底图，取不到色 —— 先在「底图」页选一张图。</p>
              ))}

            {/* 取色开着时也保留这个色板：动它就是"我要自己来"，patchVeil 会自动把上面
                那个开关关掉。这比逼用户先找开关再调色顺手。 */}
            <label className="row-field">
              <span>蒙版色{skin.tintAuto && "（手动）"}</span>
              <input
                autoComplete="off"
                type="color"
                value={skin.veil.tint}
                onChange={(e) => patchVeil({ tint: e.target.value })}
              />
            </label>

            <p className="hint">
              自动取色只影响蒙版颜色，而且<b>不会写进皮肤</b>。你一旦动了上面的色板，
              自动取色就自动关掉、以你选的为准；想让它接管回去，把开关打开即可。
            </p>
            <p className="hint">不透明度上限 0.92：底图必须能透出来，做成纯白就失去层次了。</p>
            </section>

            <section className="panel-section">
            <p className="section-title">预设</p>
            <div className="preset-save">
              <input
                autoComplete="off"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder={`预设 ${skins.length + 1}`}
                aria-label="预设名称"
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePreset()
                }}
              />
              <button onClick={savePreset}>保存当前</button>
            </div>

            <ul className="preset-list">
              {skins.map((p) => (
                <li key={p.id} data-on={p.id === skin.id}>
                  <span title={p.name}>{p.name}</span>
                  <button
                    onClick={() => void applyVeilFrom(p.id)}
                    title="只把这个预设的蒙版参数搬过来，保留当前底图与标题显示规则"
                  >
                    只套蒙版
                  </button>
                  <button
                    onClick={() => void activate(p.id)}
                    title="套用整张皮肤，底图与配色也会一起换"
                    disabled={p.id === skin.id}
                  >
                    全部套用
                  </button>
                  <button
                    className="danger"
                    onClick={() => void removeSkin(p.id)}
                    aria-label={`删除预设 ${p.name}`}
                    title="删除这个预设"
                    disabled={skins.length <= 1}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <p className="hint">
              预设存的是<b>整张皮肤</b>（底图、取景、蒙版、配色）。只想换雾的感觉就点
              「只套蒙版」—— 它会保留你当前的底图，并按新的蒙版参数重推一次文字配色。
            </p>
            </section>
          </>
        )}

        {tab === "text" && (
          <section className="panel-section text-fields">
            <div className="row-field fixed-copy-row">
              <span>主标题</span>
              <output>当前歌曲名</output>
            </div>
            <div className="row-field fixed-copy-row">
              <span>品牌行</span>
              <output>MYRIAD AUDIO</output>
            </div>
            <div className="row-field fixed-copy-row">
              <span>署名条</span>
              <output>当前歌手名</output>
            </div>
            <label className="row-field">
              <span>自动配色</span>
              <input
                type="checkbox"
                checked={skin.ink.auto}
                onChange={(e) => patchSkin({ ink: { ...skin.ink, auto: e.target.checked } })}
              />
            </label>
            <p className="hint">
              标题区按参考图固定位置和字号显示；超长歌名会省略，成对标签符号会完整保留。
            </p>
          </section>
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
