/**
 * 给构建产物加代码签名（exe + NSIS 安装包）。
 *
 * 用法：拿到 CA 签发的证书后，设好环境变量再跑 `npm run sign`：
 *
 *   本机证书库里的证书（USB token 导入后的常见形态）：
 *     SIGN_THUMBPRINT=<证书指纹（去掉空格）>
 *
 *   或 PFX 文件（部分 CA 仍提供时）：
 *     SIGN_PFX_PATH=<pfx 路径>  SIGN_PFX_PASSWORD=<密码>
 *
 *   可选：SIGN_TIMESTAMP_URL（默认 DigiCert 的 RFC3161 服务）
 *
 * 什么都没设时**安全空转**并打印指引 —— 所以可以直接串进 CI/构建链，没证书的机器不受影响。
 *
 * 为什么强制时间戳：证书一年一续，带 RFC3161 时间戳的签名在证书过期后依然有效；
 * 不带的话，过期那天起所有历史安装包的签名全部作废。
 */

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const TIMESTAMP_URL = process.env.SIGN_TIMESTAMP_URL ?? "http://timestamp.digicert.com"
const TARGETS = [
  "src-tauri/target/release/vinyl-player.exe",
  // NSIS 安装包：分发时用户先点的是它，不签的话第一道门就被 SmartScreen 拦
  ...readdirSync("src-tauri/target/release/bundle/nsis")
    .filter((f) => f.endsWith("-setup.exe"))
    .map((f) => join("src-tauri/target/release/bundle/nsis", f)),
]

function findSigntool() {
  const hit = execFileSync("where.exe", ["signtool"], { encoding: "utf8" }).split(/\r?\n/)[0]
  if (hit && existsSync(hit)) return hit
  // where 找不到就扫 Windows SDK 的版本目录，取最新
  const root = "C:/Program Files (x86)/Windows Kits/10/bin"
  if (!existsSync(root)) throw new Error("找不到 signtool，请安装 Windows SDK")
  const versions = readdirSync(root).filter((v) => /^\d/.test(v)).sort().reverse()
  for (const v of versions) {
    const p = join(root, v, "x64", "signtool.exe")
    if (existsSync(p)) return p
  }
  throw new Error("找不到 signtool，请安装 Windows SDK")
}

const thumbprint = process.env.SIGN_THUMBPRINT?.replace(/\s/g, "")
const pfxPath = process.env.SIGN_PFX_PATH
const pfxPassword = process.env.SIGN_PFX_PASSWORD

if (!thumbprint && !(pfxPath && pfxPassword)) {
  console.info(
    [
      "未配置签名证书（SIGN_THUMBPRINT 或 SIGN_PFX_PATH/PASSWORD），跳过签名。",
      "配置方法见 scripts/sign.mjs 头部注释。",
    ].join("\n"),
  )
  process.exit(0)
}

const signtool = findSigntool()
const baseArgs = ["sign", "/fd", "SHA256", "/tr", TIMESTAMP_URL, "/td", "SHA256"]
if (thumbprint) baseArgs.push("/sha1", thumbprint)
else baseArgs.push("/f", pfxPath, "/p", pfxPassword)

let failed = false
for (const target of TARGETS) {
  if (!existsSync(target)) {
    console.warn(`跳过（不存在）：${target} —— 先跑 npm run tauri build`)
    continue
  }
  console.info(`签名：${target}`)
  try {
    execFileSync(signtool, [...baseArgs, target], { stdio: "inherit" })
    // 签完立刻验一遍：信任链、时间戳、哈希算法任何一环不对都当场报错，
    // 别等用户那边 SmartScreen 弹窗了才发现签坏了
    execFileSync(signtool, ["verify", "/pa", "/all", target], { stdio: "inherit" })
  } catch {
    failed = true
    console.error(`签名或校验失败：${target}`)
  }
}

process.exit(failed ? 1 : 0)
