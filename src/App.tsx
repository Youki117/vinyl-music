import { useEffect, useState } from "react"

import Stage from "@/stage/Stage"
import Masthead from "@/ui/Masthead"
import Lyrics from "@/ui/Lyrics"
import Disc from "@/ui/Disc"
import Progress from "@/ui/Progress"
import Controls from "@/ui/Controls"
import Actions from "@/ui/Actions"
import TitleBar from "@/ui/TitleBar"
import Playlist from "@/ui/panels/Playlist"
import SkinEditor from "@/ui/panels/SkinEditor"
import { engine } from "@/audio/engine"
import { usePlayer } from "@/store/player"
import { useSkin } from "@/store/skin"
import { platform } from "@/platform"

export default function App() {
  const loadSkin = useSkin((s) => s.load)
  const setBackdrop = useSkin((s) => s.setBackdrop)
  const init = usePlayer((s) => s.init)
  const addFiles = usePlayer((s) => s.addFiles)
  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const error = usePlayer((s) => s.error)
  const queueLength = usePlayer((s) => s.queue.length)
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const [skinOpen, setSkinOpen] = useState(false)

  useEffect(() => {
    void loadSkin()
    void init()
  }, [loadSkin, init])

  // 应用内快捷键（F8.8）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
      const p = usePlayer.getState()
      switch (e.key) {
        case " ":
          e.preventDefault()
          p.toggle()
          break
        case "ArrowLeft":
          engine.seekBy(-5)
          break
        case "ArrowRight":
          engine.seekBy(5)
          break
        case "ArrowUp":
          e.preventDefault()
          p.setVolume(Math.min(1, p.volume + 0.05))
          break
        case "ArrowDown":
          e.preventDefault()
          p.setVolume(Math.max(0, p.volume - 0.05))
          break
        case "m":
        case "M":
          p.toggleMute()
          break
        case "p":
        case "P":
          setPlaylistOpen((v) => !v)
          break
        case "s":
        case "S":
          setSkinOpen((v) => !v)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // 黑胶右键直接换底图，是 PRD §6.2 要求的三步内完成的主路径
  const importBackdrop = async () => {
    const ref = await platform.pickImage()
    if (ref) {
      await setBackdrop(ref)
      setSkinOpen(true)
    }
  }

  return (
    <Stage>
      <TitleBar />
      <Masthead />
      <Lyrics />
      <div className="disc-ring" />
      <Disc onToggle={toggle} onContextMenu={() => setSkinOpen(true)} />
      <div className="disc-lighting" />
      <Actions />
      <Progress>
        <Controls
          onToggle={toggle}
          onPrev={() => void prev()}
          onNext={() => void next()}
          onOpenPlaylist={() => setPlaylistOpen(true)}
        />
      </Progress>

      {queueLength === 0 && (
        <div className="empty-hint">
          <button onClick={() => void platform.pickAudioFiles().then(addFiles)}>添加音乐文件</button>
          {" 或 "}
          <button onClick={() => void platform.pickAudioFolder().then(addFiles)}>选择文件夹</button>
        </div>
      )}

      {error && <div className="toast">{error}</div>}

      <button className="sparkle" onClick={importBackdrop} aria-label="更换底图" title="更换底图">
        <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2.6c.7 3.9 2.9 6.1 6.8 6.8-3.9.7-6.1 2.9-6.8 6.8-.7-3.9-2.9-6.1-6.8-6.8 3.9-.7 6.1-2.9 6.8-6.8Z"
          />
        </svg>
      </button>

      <Playlist open={playlistOpen} onClose={() => setPlaylistOpen(false)} />
      <SkinEditor open={skinOpen} onClose={() => setSkinOpen(false)} />
    </Stage>
  )
}
