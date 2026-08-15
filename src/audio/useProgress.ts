import { useEffect, useState } from "react"

import { engine } from "./engine"

/**
 * 订阅播放进度。
 *
 * 刻意不走 store：进度每秒变化几十次，进 store 会让整棵组件树跟着重渲染
 * （技术文档 §10）。只有真正需要进度的组件调用本 hook，重渲染范围就被限制在
 * 它们自己身上。
 */
export function useProgress(): { time: number; duration: number; frac: number } {
  const [state, setState] = useState(() => ({
    time: engine.currentTime,
    duration: engine.duration,
  }))

  useEffect(() => engine.onProgress((time, duration) => setState({ time, duration })), [])

  return {
    ...state,
    frac: state.duration > 0 ? state.time / state.duration : 0,
  }
}
