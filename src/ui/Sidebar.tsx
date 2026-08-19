/**
 * 右侧工具栏。常隐，鼠标碰到右边缘才显现。
 *
 * 这几个按钮原来在左上角标题栏里，和窗口最小化/最大化/关闭挤在同一条上 ——
 * 一条里混着"应用功能"和"窗口控制"两类东西，性质不一样。挪到右侧边独立成栏之后，
 * 后续要加的入口（蒙版预设、布局编辑、底图取色）都往这儿放，不会再去挤标题栏。
 *
 * 显隐用的是和标题栏完全一样的一招：整条 opacity: 0，:hover / :focus-within 时
 * 渐显。opacity 为 0 的元素照样接收指针事件，所以"碰到边缘就出来"是天然的，
 * 不需要额外的命中区域。focus-within 那半边是给键盘用户的，Tab 进来也会显形。
 *
 * data-keep-panel：点这里是"换一个面板"，不是"点到面板外面去了"，不该触发关闭。
 */
export default function Sidebar({
  onOpenPlayback,
  onOpenSkin,
  onOpenMix,
  onOpenOnline,
  active,
}: {
  onOpenPlayback?: () => void
  onOpenSkin?: () => void
  onOpenMix?: () => void
  onOpenOnline?: () => void
  /** 当前打开的面板，用来给对应按钮加选中态 */
  active?: string | null
}) {
  return (
    <div className="sidebar" data-keep-panel>
      <button
        className="sb-tool"
        data-on={active === "playback"}
        onClick={onOpenPlayback}
        aria-label="播放设置"
        aria-pressed={active === "playback"}
        title="播放设置 (E)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            d="M4 7h10M18 7h2M4 12h3M11 12h9M4 17h8M16 17h4"
          />
          <circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="14" cy="17" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>

      <button
        className="sb-tool"
        data-on={active === "skin"}
        onClick={onOpenSkin}
        aria-label="皮肤设置"
        aria-pressed={active === "skin"}
        title="皮肤设置 (S)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            d="M4 16.5 13 7.5l3.5 3.5-9 9H4z"
          />
          <path fill="none" stroke="currentColor" strokeWidth="1.6" d="m15 5.5 3.5 3.5" />
        </svg>
      </button>

      <button
        className="sb-tool"
        data-on={active === "online"}
        onClick={onOpenOnline}
        aria-label="在线音乐"
        aria-pressed={active === "online"}
        title="在线音乐 (F)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            d="m15.5 15.5 4 4"
          />
        </svg>
      </button>

      <button
        className="sb-tool"
        data-on={active === "mix"}
        onClick={onOpenMix}
        aria-label="混音"
        aria-pressed={active === "mix"}
        title="混音 (X)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            d="M3 18V9M8 18V5M13 18v-6M18 18V8M21 18v-4"
          />
        </svg>
      </button>
    </div>
  )
}
