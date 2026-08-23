import { useDismiss } from "./useDismiss"

/**
 * 快捷键速查表。按 <kbd>?</kbd> 打开。
 *
 * 为什么需要它：快捷键有十七个，全藏在 App.tsx 的一个 switch 里，界面上一处提示
 * 都没有 —— 除非去读源码，否则只有当初写它的人知道。三个新加的（Q 队列、
 * F11 全屏、Ctrl+M 迷你）更是没人猜得到。
 *
 * **加快捷键要同时改两处**：App.tsx 里那个 onKey 的 switch（行为），和下面这张表
 * （说明）。两处分开是因为一个是命令式分支、一个是数据，硬要合成一处反而绕。
 */
const GROUPS: { title: string; items: [key: string, label: string][] }[] = [
  {
    title: "播放",
    items: [
      ["空格", "播放 / 暂停"],
      ["← / →", "后退 / 前进 5 秒"],
      ["↑ / ↓", "音量 ±5%"],
      ["M", "静音"],
      ["L", "A-B 循环：设 A → 设 B → 清除"],
    ],
  },
  {
    title: "面板",
    items: [
      ["P", "曲库与歌单"],
      ["Q", "播放队列"],
      ["F", "在线搜索与歌单导入"],
      ["E", "播放与调音设置"],
      ["X", "混音台"],
      ["S", "底图、蒙版与 AI 配图"],
    ],
  },
  {
    title: "窗口",
    items: [
      ["F11", "全屏（盖住任务栏，和最大化不是一回事）"],
      ["Ctrl + M", "迷你模式"],
      ["Esc", "退一层：关面板 → 退全屏 / 退迷你"],
      ["?", "这张表"],
    ],
  },
]

export default function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rootRef = useDismiss<HTMLDivElement>(open, onClose)
  if (!open) return null

  return (
    <div className="keys-backdrop" role="presentation">
      <div ref={rootRef} className="keys-sheet" role="dialog" aria-modal="true" aria-label="快捷键">
        <header className="panel-header">
          <h2>快捷键</h2>
          <button className="drawer-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="keys-body">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([key, label]) => (
                  <div key={key}>
                    <dt>
                      <kbd>{key}</kbd>
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="keys-note">输入框里打字时快捷键不生效，不会把字母吃掉。</p>
      </div>
    </div>
  )
}
