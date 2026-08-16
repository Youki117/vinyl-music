/**
 * 片段模型。
 *
 * 一个片段说的是：主音轨第 `at` 秒起、持续 `duration` 秒，播放源文件从
 * `sourceStart` 开始的那一段。剪辑师的全部操作——分割、删除、移动、裁剪、
 * 复制——都是对这张表的增删改，音频引擎只负责按表播。
 *
 * 硬限制：同一层内片段不得重叠。一个 <audio> 元素放不了同一文件的两个位置，
 * 所以所有编辑操作都要保证这一点。
 */

export type Clip = {
  id: string
  /** 主音轨时间轴上的起点，秒 */
  at: number
  /** 时长，秒 */
  duration: number
  /** 取自源文件的哪个位置，秒 */
  sourceStart: number
  /** 本片段音量 0..1，叠在整轨音量之上 */
  gain: number
}

/** 片段边缘的固定淡入淡出，消除咔哒声。不做成可调，省掉一堆参数。 */
export const CLIP_FADE = 0.02

/** 短于这个长度的片段没有意义，操作时据此拒绝 */
export const MIN_CLIP = 0.05

export const clipEnd = (c: Clip): number => c.at + c.duration

/** 找出覆盖某时刻的片段。片段不重叠，所以最多一个。 */
export function clipAt(clips: Clip[], t: number): Clip | null {
  for (const c of clips) {
    if (t >= c.at && t < clipEnd(c)) return c
  }
  return null
}

/** 片段边缘的淡入淡出系数 0..1。 */
export function fadeFactor(clip: Clip, t: number): number {
  const into = t - clip.at
  const left = clipEnd(clip) - t
  if (into < 0 || left < 0) return 0
  // 片段本身比两段淡变还短时，按比例压缩，避免永远到不了满音量
  const fade = Math.min(CLIP_FADE, clip.duration / 2)
  if (fade <= 0) return 1
  return clamp01(Math.min(into / fade, left / fade, 1))
}

/** 某时刻本层应有的增益倍率（不含整轨音量）。 */
export function gainAt(clips: Clip[], t: number): number {
  const c = clipAt(clips, t)
  return c ? c.gain * fadeFactor(c, t) : 0
}

function sorted(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.at - b.at)
}

let seq = 0
function newId(): string {
  return `c${Date.now().toString(36)}${(seq++).toString(36)}`
}

/**
 * 在 t 处把片段一刀两断。t 不落在任何片段内则原样返回。
 * 切出的两半都必须够长，否则不切——避免切出一堆零碎。
 */
export function splitAt(clips: Clip[], t: number): Clip[] {
  const target = clipAt(clips, t)
  if (!target) return clips
  const leftLen = t - target.at
  const rightLen = clipEnd(target) - t
  if (leftLen < MIN_CLIP || rightLen < MIN_CLIP) return clips

  const left: Clip = { ...target, duration: leftLen }
  const right: Clip = {
    ...target,
    id: newId(),
    at: t,
    duration: rightLen,
    sourceStart: target.sourceStart + leftLen,
  }
  return sorted(clips.filter((c) => c.id !== target.id).concat(left, right))
}

export function removeClip(clips: Clip[], id: string): Clip[] {
  return clips.filter((c) => c.id !== id)
}

/**
 * 整体平移片段。会被前后邻居挡住，不会叠在一起。
 * 源内位置不变——移动的是"什么时候放"，不是"放哪一段"。
 */
export function moveClip(clips: Clip[], id: string, newAt: number, hostDuration: number): Clip[] {
  const target = clips.find((c) => c.id === id)
  if (!target) return clips
  const others = sorted(clips.filter((c) => c.id !== id))

  let lo = 0
  let hi = Math.max(0, hostDuration - target.duration)
  for (const o of others) {
    if (clipEnd(o) <= target.at) lo = Math.max(lo, clipEnd(o))
    if (o.at >= clipEnd(target)) hi = Math.min(hi, o.at - target.duration)
  }
  const at = clamp(newAt, lo, Math.max(lo, hi))
  return sorted(others.concat({ ...target, at }))
}

/**
 * 拖动片段边缘。
 *
 * 拖左缘会同时改变源内起点——这正是剪辑里"从后面一点开始放"的语义；
 * 拖右缘只改时长。
 */
export function trimClip(
  clips: Clip[],
  id: string,
  side: "start" | "end",
  t: number,
  sourceDuration: number,
): Clip[] {
  const target = clips.find((c) => c.id === id)
  if (!target) return clips
  const others = sorted(clips.filter((c) => c.id !== id))

  if (side === "start") {
    const prevEnd = others.filter((o) => clipEnd(o) <= target.at).reduce((m, o) => Math.max(m, clipEnd(o)), 0)
    // 源内不能倒退到 0 之前
    const minAt = Math.max(prevEnd, target.at - target.sourceStart)
    const maxAt = clipEnd(target) - MIN_CLIP
    const at = clamp(t, minAt, maxAt)
    const delta = at - target.at
    return sorted(
      others.concat({
        ...target,
        at,
        duration: target.duration - delta,
        sourceStart: target.sourceStart + delta,
      }),
    )
  }

  const nextStart = others
    .filter((o) => o.at >= clipEnd(target))
    .reduce((m, o) => Math.min(m, o.at), Number.POSITIVE_INFINITY)
  // 源文件放完就到头了
  const maxEnd = Math.min(
    Number.isFinite(nextStart) ? nextStart : Number.POSITIVE_INFINITY,
    target.at + (sourceDuration - target.sourceStart),
  )
  const end = clamp(t, target.at + MIN_CLIP, maxEnd)
  return sorted(others.concat({ ...target, duration: end - target.at }))
}

/**
 * 复制一份，放到第一个放得下的空隙里。
 * 放不下就贴在末尾（若主音轨还有空间）。
 */
export function duplicateClip(clips: Clip[], id: string, hostDuration: number): Clip[] {
  const target = clips.find((c) => c.id === id)
  if (!target) return clips
  const list = sorted(clips)

  let at = clipEnd(target)
  for (;;) {
    const blocker = list.find((c) => c.id !== id && at < clipEnd(c) && at + target.duration > c.at)
    if (!blocker) break
    at = clipEnd(blocker)
    if (at + target.duration > hostDuration) return clips
  }
  if (at + target.duration > hostDuration) return clips

  return sorted(list.concat({ ...target, id: newId(), at }))
}

export function setGain(clips: Clip[], id: string, gain: number): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, gain: clamp01(gain) } : c))
}

/** 新建一层时的初始片段：整段铺开，但不超过主音轨长度。 */
export function initialClips(sourceDuration: number, hostDuration: number): Clip[] {
  const duration = Math.max(MIN_CLIP, Math.min(sourceDuration, hostDuration))
  return [{ id: newId(), at: 0, duration, sourceStart: 0, gain: 1 }]
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function clamp01(v: number): number {
  return clamp(v, 0, 1)
}
