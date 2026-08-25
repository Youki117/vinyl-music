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

/**
 * 要签的东西。**必须惰性求值**：这个函数早先是顶层的一个数组字面量，
 * 于是那句 readdirSync 跑在"没配证书就空转"之前 —— 还没打过包的机器（CI 上签名步骤
 * 排在 bundle 之前也一样）拿到的不是那条友好提示，是一个 ENOENT 堆栈。
 */
function targets() {
  const nsis = "src-tauri/target/release/bundle/nsis"
  return [
    "src-tauri/target/release/vinyl-player.exe",
    // NSIS 安装包：分发时用户先点的是它，不签的话第一道门就被 SmartScreen 拦
    ...(existsSync(nsis)
      ? readdirSync(nsis)
          .filter((f) => f.endsWith("-setup.exe"))
          .map((f) => join(nsis, f))
      : []),
  ]
}

function findSigntool() {
  // where 找不到时是**非零退出**，execFileSync 会抛 —— 而"找不到"正是要走下面
  // 那段 SDK 兜底的情形。不接住的话兜底永远执行不到，等于白写。
  let hit = ""
  try {
    // stderr 丢掉：where 找不到时会自己打一行"信息: 用提供的模式无法找到文件"，
    // 而这条路径上"找不到"是预期分支，不该在构建日志里冒充错误
    hit = execFileSync("where.exe", ["signtool"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/)[0]
  } catch {
    hit = ""
  }
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
for (const target of targets()) {
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
