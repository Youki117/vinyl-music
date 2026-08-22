/**
 * 音源到底是"服务端不给了"还是"被代理挡了"。
 *
 * probe-source.mjs 已经证明问题不在本应用（脚本在纯 Node 里跑也拿不到地址）。
 * 剩下的岔口只有一个：本机 TUN 代理让国外域名从境外节点出去，而音源服务端普遍
 * 按地区判客 —— 这正是"昨天还能用今天就不行"最常见的原因。
 *
 * 这个脚本只做一件事：把音源用到的域名逐个直连一遍，报出每个的真实结果。
 * **跑两次**，一次开着代理、一次关掉代理，对比两份输出：
 *
 *   两次都失败    → 服务端的问题，等它恢复或换音源，改本应用没有用
 *   关代理后能通  → 代理的锅，把这些域名加进直连规则即可
 *
 *   node scripts/source-vs-proxy.mjs
 */

/** 音源脚本实际会打的域名，取自 probe-source 的真实请求日志 */
const TARGETS = [
  { name: "野草 urlinfo", url: "http://grass.tempmusics.tk/v1/urlinfo/1.0.0" },
  { name: "野草 取地址", url: "http://grass.tempmusics.tk/v1/url/kw/51685512/128k" },
  { name: "野花 urlinfo", url: "http://flower.tempmusics.tk/v1/urlinfo/1.0.0" },
  { name: "野花 取地址", url: "http://flower.tempmusics.tk/v1/url/kw/51685512/128k" },
  { name: "qdy huibq", url: "https://api.huibq.com/api/url/kg/b3a52a7a958bf0aed0ebfba2e9a818b7/128k" },
  { name: "qdy lingchuan", url: "https://api.lingchuan.com/v1/url?source=kg&songId=x&quality=128k" },
  { name: "qdy gdstudio", url: "https://music-api.gdstudio.xyz/api.php?types=url&source=kugou&id=x&br=128" },
  { name: "qdy oiapi", url: "https://oiapi.net/api/Kuwo?msg=%E6%99%B4%E5%A4%A9&n=1&br=7" },
]

const UA = "lx-music/desktop"

async function reportExitIp() {
  for (const [label, url] of [
    ["国内出口", "https://myip.ipip.net/"],
    ["国外出口", "https://ifconfig.me/all"],
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const text = (await res.text()).replace(/\s+/g, " ").trim()
      console.log(`  ${label}  ${text.slice(0, 110)}`)
    } catch (err) {
      console.log(`  ${label}  取不到（${err instanceof Error ? err.message : err}）`)
    }
  }
}

async function probe(target) {
  const t0 = Date.now()
  try {
    const res = await fetch(target.url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(12000),
    })
    const body = (await res.text()).replace(/\s+/g, " ").slice(0, 90)
    const verdict = res.ok ? "✓ 通" : `✗ HTTP ${res.status}`
    console.log(`  ${target.name.padEnd(16)} ${verdict.padEnd(12)} ${Date.now() - t0}ms  ${body}`)
    return res.ok
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ${target.name.padEnd(16)} ${"✗ 连不上".padEnd(12)} ${Date.now() - t0}ms  ${msg}`)
    return false
  }
}

console.log("网络出口")
await reportExitIp()

console.log("\n逐个域名直连")
const results = []
for (const t of TARGETS) results.push(await probe(t))

const ok = results.filter(Boolean).length
console.log(`\n${ok} / ${TARGETS.length} 个通`)
console.log(
  ok === 0
    ? "全都不通。开着代理就关掉代理再跑一次；两次都是 0 的话是服务端的问题，改本应用没有用。"
    : "有通的。对比开/关代理两次的输出，只在关代理时才通的域名，加进直连规则即可。",
)
