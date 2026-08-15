import { useRef, useState } from "react"
import referenceArtwork from "@/imports/4d957542dd607e240fa080f9732245bc.png"

const tracks = ["林檎星瀑", "一个人不喝酒", "夜航星", "山明水秀不比你有看头"]

function Icon({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`icon ${className}`} aria-hidden="true">{children}</span>
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [background, setBackground] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [liked, setLiked] = useState(false)
  const [progress, setProgress] = useState(27)
  const [track, setTrack] = useState(0)

  const importBackground = (event: React.ChangeEvent<HTMLInputElement>) => {
    const image = event.target.files?.[0]
    if (!image) return
    if (background) URL.revokeObjectURL(background)
    setBackground(URL.createObjectURL(image))
  }

  const next = () => setTrack((value) => (value + 1) % tracks.length)
  const previous = () => setTrack((value) => (value + tracks.length - 1) % tracks.length)

  return (
    <main className="stage">
      <section
        className={`player ${background ? "custom-background" : ""}`}
        style={{
          "--album-art": `url(${referenceArtwork})`,
          ...(background ? { "--uploaded-background": `url(${background})` } : {}),
        } as React.CSSProperties}
        aria-label="音乐播放器"
      >
        <div className="light-field" />
        <div className="dark-field" />
        <div className="grain" />

        <label className="background-import" title="导入背景图片">
          <input ref={inputRef} type="file" accept="image/*" onChange={importBackground} />
          <span>导入背景</span>
        </label>

        <div className="masthead">
          <h1>FASHION</h1>
          <p>SELP-PORTRAIT</p>
          <small>1901</small>
        </div>

        <div className="music-chip">Xiaojie-for you</div>

        <article className="lyrics">
          <p>震颤一分抖的感动</p>
          <p>是否至上一个人不喝酒过后</p>
          <strong>山明水秀不比你有看头</strong>
          <p>帮着俯视了一道定制副后</p>
          <p>这一首急急如风</p>
          <p>没有暮色的晚空</p>
        </article>

        <div className="album-disc" aria-label="专辑封面">
          <div className="album-art" />
          <div className="disc-highlight" />
        </div>

        <div className="heart-stack">
          <button className={liked ? "liked" : ""} onClick={() => setLiked(!liked)} aria-label="收藏">
            <span>♥</span><em>8.8w</em>
          </button>
          <button className="comment" aria-label="评论"><span>☷</span><em>661</em></button>
        </div>

        <div className="playback">
          <div className="wave-row">
            <div className="tiny-wave" aria-hidden="true">
              {[7, 16, 10, 23, 34, 14, 28, 11, 20, 9, 17, 7, 13, 8, 5].map((height, index) => <i key={index} style={{ height }} />)}
            </div>
          </div>
          <input aria-label="播放进度" type="range" min="0" max="100" value={progress} onChange={(e) => setProgress(Number(e.target.value))} style={{ "--progress": `${progress}%` } as React.CSSProperties} />
          <div className="timing"><span>01:00</span><b>{tracks[track]}</b><span>05:00</span></div>
          <nav className="controls" aria-label="播放控制">
            <button aria-label="循环播放"><Icon>⟳</Icon></button>
            <button onClick={previous} aria-label="上一首"><Icon>◀</Icon><i className="bar" /></button>
            <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "暂停" : "播放"}>{playing ? <Icon>Ⅱ</Icon> : <Icon>Ⅱ</Icon>}</button>
            <button onClick={next} aria-label="下一首"><i className="bar" /><Icon>▶</Icon></button>
            <button aria-label="播放列表"><Icon>☷</Icon></button>
          </nav>
        </div>

        <div className="sparkle">✦</div>
      </section>
    </main>
  )
}
