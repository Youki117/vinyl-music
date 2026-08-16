/**
 * 从行级 LRC 派生一份增强型（逐字）LRC，用于测试逐字歌词的解析与渲染。
 *
 * 说明清楚它是什么：**词级时间戳是插值出来的，不是人工打轴的**。每行的时间跨度
 * 按各词字符数等比分配。真实的逐字歌词是逐词听打的，节奏并不均匀。
 *
 * 之所以要这么造：公开渠道（LRCLIB 等）提供的都是行级歌词，主流平台的逐字格式
 * （QRC / KRC）是加密私有的，拿不到合法样本。而逐字这条渲染路径必须有真实长度、
 * 真实句读的数据去压，否则只能靠手写几行片段自欺欺人。
 *
 *   node scripts/make-word-lrc.mjs <输入.lrc> <输出.lrc>
 */
import { readFileSync, writeFileSync } from "node:fs"

const [, , src, dst] = process.argv
if (!src || !dst) {
  console.error("用法：node scripts/make-word-lrc.mjs <输入.lrc> <输出.lrc>")
  process.exit(1)
}

const TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/

const lines = readFileSync(src, "utf8").replace(/^﻿/, "").split(/\r\n?|\n/)

/** 先把所有带时间戳的行读出来，才知道每行到下一行有多长 */
const parsed = []
for (const raw of lines) {
  const m = TAG.exec(raw.trim())
  if (!m) {
    parsed.push({ raw, t: null })
    continue
  }
  const frac = m[3] ? Number.parseInt(m[3], 10) / 10 ** m[3].length : 0
  const t = Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10) + frac
  parsed.push({ raw, t, tag: m[0], text: raw.trim().slice(m[0].length).trim() })
}

const stamp = (t) => {
  const mm = Math.floor(t / 60)
  const ss = Math.floor(t % 60)
  const cs = Math.round((t - Math.floor(t)) * 100)
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(Math.min(99, cs)).padStart(2, "0")}`
}

const out = []
for (let i = 0; i < parsed.length; i++) {
  const cur = parsed[i]
  if (cur.t === null || !cur.text) {
    out.push(cur.raw)
    continue
  }

  // 下一条时间戳决定本行能占多久；末行给 3 秒
  const nextT = parsed.slice(i + 1).find((p) => p.t !== null)?.t
  const span = Math.min(nextT !== undefined ? nextT - cur.t : 3, 6)
  if (span <= 0.05) {
    out.push(cur.raw)
    continue
  }

  // 按空格切词，保留分隔符，这样拼回去与原文逐字符相同
  const words = cur.text.split(/(?<=\s)/)
  const total = words.reduce((n, w) => n + w.length, 0)
  let acc = 0
  let body = ""
  for (const w of words) {
    body += `<${stamp(cur.t + (span * acc) / total)}>${w}`
    acc += w.length
  }
  body += `<${stamp(cur.t + span)}>` // 收尾标记
  out.push(`[${stamp(cur.t)}]${body}`)
}

writeFileSync(dst, out.join("\n") + "\n", "utf8")
console.log(`已写出 ${dst}（词级时间戳为插值，非人工打轴）`)
