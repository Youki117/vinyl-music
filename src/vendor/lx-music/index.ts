/**
 * musicSdk 依赖的格式化函数。**垫片，不是上游代码。**
 *
 * 上游这些散在 @common/utils/common、@common/utils/renderer 等好几个模块里，
 * 那些模块又牵着 electron-log、i18n、window.lx 一整串 Electron 环境。
 * 这里只实现 musicSdk 真正 import 到的 7 个符号（grep 逐个确认过），不搬那一串依赖。
 */
import { createHash } from "crypto"

export const toMD5 = (str: string): string => createHash("md5").update(str).digest("hex")

/** 上游用 DOMParser 反转义 HTML 实体：搜索结果里的歌名经常带 &amp; &#39; */
export const decodeName = (str: string | null = ""): string => {
  if (!str) return ""
  return new DOMParser().parseFromString(str, "text/html").body.textContent ?? ""
}

/** 秒 → mm:ss（超过一小时给 hh:mm:ss） */
export const formatPlayTime = (time: number): string => {
  if (!Number.isFinite(time) || time < 0) return "00:00"
  const s = Math.floor(time % 60)
  const m = Math.floor(time / 60) % 60
  const h = Math.floor(time / 3600)
  const p = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}

/** 字节 → 人类可读 */
export const sizeFormate = (size: number): string => {
  if (!size) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
  return `${(size / 1024 ** i).toFixed(2)} ${units[i]}`
}

/** 播放量，沿用上游口径 */
export const formatPlayCount = (num: number): string => {
  if (num > 100000000) return `${Math.trunc(num / 10000000) / 10}亿`
  if (num > 10000) return `${Math.trunc(num / 1000) / 10}万`
  return String(num)
}

export const dateFormat = (time: number | Date, format = "Y-M-D"): string => {
  const d = time instanceof Date ? time : new Date(time)
  const p = (n: number) => String(n).padStart(2, "0")
  return format
    .replace("Y", String(d.getFullYear()))
    .replace("M", p(d.getMonth() + 1))
    .replace("D", p(d.getDate()))
    .replace("h", p(d.getHours()))
    .replace("m", p(d.getMinutes()))
    .replace("s", p(d.getSeconds()))
}

/** 上游按「几分钟前」显示，这里不需要相对时间，退回绝对日期 */
export const dateFormat2 = (time: number): string => dateFormat(time)
