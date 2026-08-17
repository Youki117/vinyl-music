import { useEffect, useState } from "react"

import { engine } from "@/audio/engine"

/**
 * 当前该用第几个主色。
 *
 * 按播放进度均分：三个色就是每色 1/3 时长，不做渐变，到点直接换。
 *
 * 刻意不用 useProgress()：那个 hook 每来一次进度事件就让消费组件重渲染，
 * 而这里一首歌只需要变三次。所以直接订阅引擎，且只在档位真的变了才 setState ——
 * 传函数式更新并原样返回旧值时 React 会跳过重渲染。
 *
 * @param enabled 关闭时恒为 0，不订阅
 * @param count   分几档
 */
export function useTintPhase(enabled: boolean, count = 3): number {
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    if (!enabled || count < 1) {
      setPhase(0)
      return
    }
    return engine.onProgress((time, duration) => {
      // 时长还没解析出来时停在第一档，别让画面在 0 和 2 之间乱跳
      const next = duration > 0 ? Math.min(count - 1, Math.max(0, Math.floor((time / duration) * count))) : 0
      setPhase((cur) => (cur === next ? cur : next))
    })
  }, [enabled, count])

  return phase
}
