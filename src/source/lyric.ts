/**
 * 洛雪的逐字歌词格式 → 增强型 LRC。**纯逻辑，单独成模块是为了能被单测覆盖** ——
 * source/index.ts 一加载就会拉起整个 musicSdk 与 Tauri 插件，在 node 测试环境里跑不起来。
 */

const TIME_TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/

/**
 * 把洛雪的 `lxlyric` 转成**增强型 LRC**（`<mm:ss.xx>` 词标记）。
 *
 * 两种格式描述的是同一件事，只是坐标系不同：洛雪用「相对行首的毫秒偏移 + 时长」，
 * 增强型 LRC 用绝对时间戳。转过去之后，本项目现成的逐字擦除（lyrics/parse.ts）
 * 一行不用改就能吃 —— 比给解析器再加一种方言划算得多。
 */
export function lxLyricToEnhancedLrc(lxlyric: string): string {
  const out: string[] = []
  for (const line of lxlyric.split("\n")) {
    const m = TIME_TAG.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const ms = m[3] ?? "0"
    const base =
      Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(ms.padEnd(3, "0").slice(0, 3))
    const body = line.slice(m[0].length)
    if (!/<\d+,\d+>/.test(body)) {
      out.push(line)
      continue
    }
    const at = (t: number) => {
      const mm = String(Math.floor(t / 60000)).padStart(2, "0")
      const ss = String(Math.floor((t % 60000) / 1000)).padStart(2, "0")
      const xx = String(t % 1000).padStart(3, "0")
      return `<${mm}:${ss}.${xx}>`
    }
    out.push(m[0] + body.replace(/<(\d+),(\d+)>/g, (_, off: string) => at(base + Number(off))))
  }
  return out.join("\n")
}

