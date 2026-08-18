/**
 * 与上游 lx-music 的 musicSdk 对 diff。
 *
 * 平台接口会变（签名算法、加密参数、字段名），上游一直在跟。我们原样引入就是为了
 * 之后只同步差异、不自己维护一套逆向实现。这个脚本就是那条同步路径：
 * 拉上游最新，逐文件比对，把差异列出来。
 *
 *   node scripts/sync-lx-sdk.mjs          # 只看差异
 *   node scripts/sync-lx-sdk.mjs --apply  # 覆盖本地（覆盖前会提示改了哪些文件）
 *
 * 注意：本地那份的原则是「不要改」。如果 --apply 之后测试挂了，改的应该是
 * src/source/ 的垫片层，不是 vendor 目录。
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

const LOCAL = resolve("src/vendor/lx-music/musicSdk")
const UPSTREAM_DOC = resolve("src/vendor/lx-music/UPSTREAM.md")
const APPLY = process.argv.includes("--apply")

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 })

const sha = gh(["api", "repos/lyswhut/lx-music-desktop/commits/master", "--jq", ".sha"]).trim()
const pinned = (readFileSync(UPSTREAM_DOC, "utf8").match(/同步自 commit \| `([0-9a-f]{40})`/) ?? [])[1]
console.log(`本地钉住 ${pinned?.slice(0, 8) ?? "?"}   上游最新 ${sha.slice(0, 8)}`)
if (pinned === sha) console.log("（同一个 commit，但仍然逐文件比对一遍，防止本地被改过）")

const tmp = mkdtempSync(join(tmpdir(), "lx-sync-"))
const tar = join(tmp, "lx.tar.gz")
// 直接重定向到文件：让 execFileSync 把二进制流经过 Node 的缓冲会损坏 tar
const fd = openSync(tar, "w")
execFileSync("gh", ["api", `repos/lyswhut/lx-music-desktop/tarball/${sha}`], { stdio: ["ignore", fd, "inherit"] })
closeSync(fd)
const tarSize = statSync(tar).size
console.log(`tarball ${(tarSize / 1048576).toFixed(1)} MB`)
if (tarSize < 1_000_000) throw new Error(`tarball 只有 ${tarSize} 字节，下载没完成`)
// 用 cwd + 相对文件名，不要传绝对路径：GNU tar 会把 `C:\...` 当成 host:path 的远程
// 主机名（实测报 "Cannot connect to C: resolve failed"）。整包解开也不过 11MB。
execFileSync("tar", ["-xzf", "lx.tar.gz"], { cwd: tmp })
const root = readdirSync(tmp).find((d) => d.startsWith("lyswhut-"))
const REMOTE = join(tmp, root, "src/renderer/utils/musicSdk")

const walk = (dir, base = dir, out = new Map()) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else out.set(relative(base, p).split(sep).join("/"), readFileSync(p))
  }
  return out
}
const digest = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12)

const local = walk(LOCAL)
const remote = walk(REMOTE)

const changed = []
const added = []
const removed = []
for (const [k, v] of remote) {
  if (!local.has(k)) added.push(k)
  else if (digest(local.get(k)) !== digest(v)) changed.push(k)
}
for (const k of local.keys()) if (!remote.has(k)) removed.push(k)

const show = (label, list) => {
  if (!list.length) return
  console.log(`\n${label}（${list.length}）`)
  for (const f of list.slice(0, 40)) console.log(`  ${f}`)
  if (list.length > 40) console.log(`  …还有 ${list.length - 40} 个`)
}
show("上游新增", added)
show("内容不同", changed)
show("上游已删除（本地多出来的）", removed)

if (!added.length && !changed.length && !removed.length) {
  console.log("\n✓ 与上游完全一致")
} else if (APPLY) {
  for (const f of [...added, ...changed]) {
    const dst = join(LOCAL, f)
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, remote.get(f))
  }
  for (const f of removed) rmSync(join(LOCAL, f))
  const doc = readFileSync(UPSTREAM_DOC, "utf8")
    .replace(/同步自 commit \| `[0-9a-f]{40}`/, `同步自 commit | \`${sha}\``)
    .replace(/引入时间 \| .*/, `引入时间 | ${new Date().toISOString()}`)
  writeFileSync(UPSTREAM_DOC, doc)
  console.log(`\n✓ 已覆盖本地并更新 UPSTREAM.md 到 ${sha.slice(0, 8)}`)
  console.log("  下一步：跑测试。挂了就改 src/source/ 的垫片层，不要改 vendor 目录。")
} else {
  console.log("\n加 --apply 覆盖本地。")
}
rmSync(tmp, { recursive: true, force: true })
