/** 控件图标。全部内联 SVG —— 离线应用不引图标字体，也便于跟随 currentColor 换色。 */

type P = { size?: number; className?: string }

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
}

export function IconRepeat({ size = 22, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9.4" />
      <path {...stroke} d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4 14.6" />
      <path {...stroke} d="M20 5.6v3.9h-3.9" />
    </svg>
  )
}

export function IconRepeatOne({ size = 22, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9.4" />
      <path {...stroke} d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4 14.6" />
      <path {...stroke} d="M20 5.6v3.9h-3.9" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="8" fill="currentColor" stroke="none">
        1
      </text>
    </svg>
  )
}

export function IconShuffle({ size = 22, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M3 6.5h3.6l3.2 4.2M3 17.5h3.6l3.2-4.2" />
      <path {...stroke} d="M14.2 6.5H21m0 0-2.6-2.4M21 6.5l-2.6 2.4" />
      <path {...stroke} d="M14.2 17.5H21m0 0-2.6-2.4M21 17.5l-2.6 2.4" />
      <path {...stroke} d="m11.6 8.6 2.6-2.1M11.6 15.4l2.6 2.1" />
    </svg>
  )
}

export function IconArrowRight({ size = 22, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M3.5 12h17" />
      <path {...stroke} d="m16.5 7.5 4.5 4.5-4.5 4.5" />
    </svg>
  )
}

/** 歌单工具使用同一套 1.6px 圆角线条，避免再用“导入 / 导”文字冒充图标。 */
export function IconImport({ size = 18, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M12 3.5v11M8 10.5l4 4 4-4" />
      <path {...stroke} d="M5 15.5v3.5c0 .8.7 1.5 1.5 1.5h11c.8 0 1.5-.7 1.5-1.5v-3.5" />
    </svg>
  )
}

export function IconExport({ size = 18, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M12 15V4M8 8l4-4 4 4" />
      <path {...stroke} d="M5 14.5V19c0 .8.7 1.5 1.5 1.5h11c.8 0 1.5-.7 1.5-1.5v-4.5" />
    </svg>
  )
}

export function IconPlus({ size = 18, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M12 4.5v15M4.5 12h15" />
    </svg>
  )
}

export function IconTrash({ size = 18, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M5.5 7.5h13M9 4.5h6l1 3H8l1-3Z" />
      <path {...stroke} d="m7.2 7.5.7 12h8.2l.7-12M10 10.5v6M14 10.5v6" />
    </svg>
  )
}

export function IconPrev({ size = 20, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path fill="currentColor" d="M8.5 12 18 5.6v12.8z" />
      <rect fill="currentColor" x="5.4" y="5.6" width="2.3" height="12.8" rx="0.6" />
    </svg>
  )
}

export function IconNext({ size = 20, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path fill="currentColor" d="M15.5 12 6 18.4V5.6z" />
      <rect fill="currentColor" x="16.3" y="5.6" width="2.3" height="12.8" rx="0.6" />
    </svg>
  )
}

export function IconPause({ size = 30, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <rect fill="currentColor" x="6.6" y="4.4" width="3.5" height="15.2" rx="1" />
      <rect fill="currentColor" x="13.9" y="4.4" width="3.5" height="15.2" rx="1" />
    </svg>
  )
}

export function IconPlay({ size = 30, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path fill="currentColor" d="M7.5 4.6 19 12 7.5 19.4z" />
    </svg>
  )
}

export function IconList({ size = 22, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path {...stroke} d="M4 7h16M4 12h11M4 17h16" />
    </svg>
  )
}

export function IconHeart({ size = 26, filled = true, className }: P & { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="M12 20.6c-.4 0-.8-.15-1.1-.43C6.3 16.1 3.4 13.5 3.4 10.2c0-2.6 2-4.6 4.5-4.6 1.5 0 2.9.7 3.8 1.9l.3.4.3-.4c.9-1.2 2.3-1.9 3.8-1.9 2.5 0 4.5 2 4.5 4.6 0 3.3-2.9 5.9-7.5 9.97-.3.28-.7.43-1.1.43Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.5}
      />
    </svg>
  )
}

export function IconPlayCount({ size = 22, className }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <rect {...stroke} x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4" />
      <path fill="currentColor" d="M10.4 9.2 15 12l-4.6 2.8z" />
    </svg>
  )
}
