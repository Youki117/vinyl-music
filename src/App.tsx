import { useEffect, useState } from "react"

import Stage from "@/stage/Stage"
import Masthead from "@/ui/Masthead"
import Lyrics from "@/ui/Lyrics"
import Disc from "@/ui/Disc"
import Progress from "@/ui/Progress"
import Controls from "@/ui/Controls"
import Actions from "@/ui/Actions"
import TitleBar from "@/ui/TitleBar"
import { usePlayer } from "@/store/player"
import { useSkin } from "@/store/skin"
import { platform } from "@/platform"

export default function App() {
  const loadSkin = useSkin((s) => s.load)
  const setBackdrop = useSkin((s) => s.setBackdrop)
  const status = usePlayer((s) => s.status)
  // M2 会把它换成来自播放引擎的订阅；进度刻意不进 store（技术文档 §10）
  const [progress, setProgress] = useState(0.27)

  useEffect(() => {
    void loadSkin()
  }, [loadSkin])

  const toggle = () =>
    usePlayer.setState({ status: status === "playing" ? "paused" : "playing" })

  const importBackdrop = async () => {
    const ref = await platform.pickImage()
    if (ref) await setBackdrop(ref)
  }

  return (
    <Stage>
      <TitleBar />
      <Masthead />
      <Lyrics />
      <div className="disc-ring" />
      <Disc onToggle={toggle} />
      <div className="disc-lighting" />
      <Actions />
      <Progress progress={progress} onSeek={setProgress}>
        <Controls onToggle={toggle} />
      </Progress>
      <button className="sparkle" onClick={importBackdrop} aria-label="更换底图" title="更换底图">
        <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2.6c.7 3.9 2.9 6.1 6.8 6.8-3.9.7-6.1 2.9-6.8 6.8-.7-3.9-2.9-6.1-6.8-6.8 3.9-.7 6.1-2.9 6.8-6.8Z"
          />
        </svg>
      </button>
    </Stage>
  )
}
