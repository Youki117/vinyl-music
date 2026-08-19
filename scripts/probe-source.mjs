/**
 * 音源体检：**脱离本应用**，在纯 Node 里按洛雪的契约跑一遍音源脚本。
 *
 * 为什么要有这个脚本：音源出问题时只有两种可能 —— 要么是我们这一侧（Worker 隔离、
 * globalThis.lx 的形状、请求代发）没照着洛雪的契约来，要么是音源自己的服务端不给了。
 * 混在应用里查，这两件事永远分不开。所以这里把洛雪 userApi 的 preload 契约在 Node 里
 * 重新实现一遍，不碰 Tauri、不碰 Vite、不碰我们任何一行运行时代码：
 *
 *   这里能跑通 + 应用里跑不通  →  是我们的问题
 *   这里也跑不通              →  是音源服务端的问题，改我们的代码没有用
 *
 * 还会先报一次出口 IP。本机开着代理（TUN 模式）时，国外域名会从代理节点出去，
 * 而音源服务端普遍按地区判客，这一项经常就是"昨天还能用今天就不行"的真凶。
 * 想排除代理的影响：**关掉代理再跑一次这个脚本**，对比两次的输出。
 *
 *   node scripts/probe-source.mjs                       # 跑默认目录下的全部脚本
 *   node scripts/probe-source.mjs 野草.js                # 只跑一个
 *   node scripts/probe-source.mjs https://.../latest.js  # 跑一个在线音源
 *   node scripts/probe-source.mjs --dir D:\其它\音源
 *   node scripts/probe-source.mjs --keyword 晴天 --quality 320k
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, isAbsolute, basename } from "node:path"
import crypto from "node:crypto"
import zlib from "node:zlib"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

// ── 参数 ─────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const DEFAULT_DIR = String.raw`D:\Downloads\洛雪音乐\音源`
const DIR = flag("dir", DEFAULT_DIR)
const KEYWORD = flag("keyword", "后来")
const QUALITY = flag("quality", "128k")
// 脚本会把这两个值拼进 User-Agent / ver 头，音源服务端会校验。默认与洛雪桌面端一致。
const LX_ENV = flag("env", "desktop")
const LX_VERSION = flag("lxver", "2.0.0")
const targets = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"))

const PLATFORM = { kw: "酷我", kg: "酷狗", tx: "QQ", wy: "网易云", mg: "咪咕" }

/*
 * 音源脚本能直接够到 Node 的 process（vm.runInThisContext 用的就是本进程的全局），
 * 而六音实测会**主动把进程结束掉** —— 静默退出、退出码 0、一行输出都没有，
 * 看上去就像工具自己坏了。先把这几个出口堵上，脚本再想跑路就只是记一笔。
 * 我们自己退出用 realExit，不受影响。
 */
const trueExit = process.exit.bind(process)
const trueReallyExit = process.reallyExit.bind(process)
let exitAttempt = null
process.exit = (code) => {
  exitAttempt = code ?? 0
}
// 也得堵 reallyExit：process.exit 只是它的外壳，堵了外壳没堵里子等于没堵
process.reallyExit = () => {}
process.abort = () => {}
/** 我们自己退出：先把两个出口还原，否则 exit 会被自己设的那道防护挡下来 */
const realExit = (code) => {
  process.exit = trueExit
  process.reallyExit = trueReallyExit
  trueExit(code)
}

// ── 出口 IP：代理开着的时候，这几行往往就解释了一切 ────────────
async function reportNetwork() {
  const get = async (url, headers = {}) => {
    const r = await fetch(url, { headers: { "User-Agent": "curl/8", ...headers } })
    return (await r.text()).trim()
  }
  console.log("网络出口")
  try {
    const cn = await get("http://ip.3322.net")
    console.log(`  国内域名走的出口   ${cn}`)
  } catch (e) {
    console.log(`  国内域名走的出口   查不到（${e.message}）`)
  }
  try {
    const abroad = await get("http://ip-api.com/line/?fields=query,country,isp")
    console.log(`  国外域名走的出口   ${abroad.split("\n").join(" / ")}`)
  } catch (e) {
    console.log(`  国外域名走的出口   查不到（${e.message}）`)
  }
  const { promises: dns } = await import("node:dns")
  try {
    const [ip] = await dns.resolve4("example.com")
    // 198.18.0.0/15 是 RFC2544 基准测试段，Clash/Mihomo 的 fake-ip 模式就用它
    const fake = ip.startsWith("198.18.") || ip.startsWith("198.19.")
    console.log(`  DNS 返回 ${ip}${fake ? "  ← fake-ip，代理的 TUN 模式正开着" : ""}`)
  } catch {
    /* 查不到就算了，不是重点 */
  }
  console.log()
}

// ── 洛雪 userApi 的 preload 契约 ──────────────────────────
/** 头部注释里的 @name / @version / ...，取法与上游一致 */
function parseScriptInfo(script) {
  const pick = (key) => {
    for (const line of script.slice(0, 4000).split("\n")) {
      const t = line.replace(/^[\s*!]+/, "").trim()
      if (t.startsWith(`@${key} `)) return t.slice(key.length + 2).trim()
    }
    return ""
  }
  return {
    name: pick("name") || "未命名音源",
    description: pick("description"),
    version: pick("version"),
    author: pick("author"),
    homepage: pick("homepage"),
    rawScript: script,
  }
}

/**
 * 起一个音源脚本，返回它声明支持的平台和一个"要播放地址"的函数。
 * `trace` 收下每一条请求与应答 —— 音源查不通的时候，唯一有用的就是这个。
 */
function runScript(script, trace) {
  const info = parseScriptInfo(script)
  let requestHandler = null
  let inited = null
  let fatal = null

  const lx = {
    EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },
    request(url, options, callback) {
      const headers = options?.headers ?? {}
      // 拷一份再记：脚本复用同一个 headers 对象，直接存引用的话打印出来的是它**后来**改成的样子
      const snapshot = { ...headers }
      const method = (options?.method ?? "GET").toUpperCase()
      const started = Date.now()
      const ctl = new AbortController()
      fetch(url, { method, headers, body: options?.body, signal: ctl.signal })
        .then(async (r) => {
          const raw = await r.text()
          let body = raw
          try {
            body = JSON.parse(raw)
          } catch {
            // 不是 JSON 就保留原文，上游脚本自己会再处理
          }
          trace.push({ method, url, headers: snapshot, status: r.status, body, ms: Date.now() - started })
          callback(null, { statusCode: r.status, headers: Object.fromEntries(r.headers), body }, body)
        })
        .catch((e) => {
          trace.push({ method, url, headers: snapshot, err: e.message, ms: Date.now() - started })
          callback(e, null, null)
        })
      return () => ctl.abort()
    },
    on(name, handler) {
      if (name !== "request") return Promise.reject(new Error(`不支持的事件: ${name}`))
      requestHandler = handler
      return Promise.resolve()
    },
    send(name, data) {
      if (name === "inited") {
        inited = data
        return Promise.resolve()
      }
      if (name === "updateAlert") {
        trace.push({ note: `脚本提示更新：${data?.log ?? ""} ${data?.updateUrl ?? ""}` })
        return Promise.resolve()
      }
      return Promise.reject(new Error(`未知事件: ${name}`))
    },
    utils: {
      crypto: {
        aesEncrypt: (buf, mode, key, iv) => {
          const c = crypto.createCipheriv(mode, key, iv)
          return Buffer.concat([c.update(buf), c.final()])
        },
        rsaEncrypt: (buf, key) =>
          crypto.publicEncrypt(
            { key, padding: crypto.constants.RSA_NO_PADDING },
            Buffer.concat([Buffer.alloc(128 - buf.length), buf]),
          ),
        randomBytes: crypto.randomBytes,
        md5: (str) => crypto.createHash("md5").update(str).digest("hex"),
      },
      buffer: {
        from: (...a) => Buffer.from(...a),
        bufToString: (buf, format) => Buffer.from(buf).toString(format),
      },
      zlib: {
        inflate: (buf) => new Promise((res, rej) => zlib.inflate(buf, (e, d) => (e ? rej(e) : res(d)))),
        deflate: (buf) => new Promise((res, rej) => zlib.deflate(buf, (e, d) => (e ? rej(e) : res(d)))),
      },
    },
    currentScriptInfo: info,
    version: LX_VERSION,
    env: LX_ENV,
  }

  globalThis.lx = lx
  globalThis.Buffer = Buffer
  try {
    vm.runInThisContext(script, { filename: info.name })
  } catch (e) {
    fatal = e.message
  }

  return {
    info,
    get fatal() {
      return fatal
    },
    get inited() {
      return inited
    },
    get ready() {
      return !!requestHandler && !!inited
    },
    musicUrl: (source, musicInfo, type) =>
      requestHandler({ source, action: "musicUrl", info: { musicInfo, type } }),
  }
}

const waitFor = async (pred, ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return pred()
}

// ── 找一首真实存在的歌 ────────────────────────────────────
/*
 * 音源脚本要的是平台内的真实曲目 id，随便编一个必然查不到，那样拿到的失败没有意义。
 * 这里只实现 kw / kg 两个平台的搜索 —— 它们的接口不需要签名，几行就够；
 * tx / wy / mg 要签名与加密（那正是 src/vendor/lx-music 整个搬进来的原因），
 * 为了让这个脚本能脱离应用独立跑，就不在这里重复一遍了。
 */
const finders = {
  async kw(keyword) {
    const u = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=1&rformat=json&encoding=utf8`
    const t = await (await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } })).text()
    const rid = /MUSICRID['"]?:\s*['"]?MUSIC_(\d+)/.exec(t)?.[1]
    const name = /['"]NAME['"]:\s*['"]([^'"]+)/.exec(t)?.[1] ?? keyword
    return rid ? { songmid: rid, hash: "", copyrightId: "", name } : null
  },
  async kg(keyword) {
    const u = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=1&showtype=1`
    const j = await (await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } })).json()
    const s = j?.data?.info?.[0]
    return s ? { hash: s.hash, songmid: s.hash, copyrightId: s.album_audio_id ?? "", name: s.songname } : null
  },
}

/** 拿到播放地址之后必须真的去拉一段，否则"拿到 url"不等于"能放" */
async function canPlay(url) {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-2047" } })
    const type = r.headers.get("content-type") ?? ""
    const len = r.headers.get("content-length") ?? "?"
    const ok = (r.status === 200 || r.status === 206) && !/text|html|json/.test(type)
    return { ok, detail: `HTTP ${r.status}｜${type}｜${len} 字节` }
  } catch (e) {
    return { ok: false, detail: `拉流失败：${e.message}` }
  }
}

// ── 逐个脚本体检 ─────────────────────────────────────────
function printTrace(trace) {
  for (const t of trace) {
    if (t.note) {
      console.log(`    · ${t.note}`)
      continue
    }
    console.log(`    → ${t.method} ${t.url}`)
    const h = Object.entries(t.headers ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("  ")
    if (h) console.log(`      ${h}`)
    const body = typeof t.body === "string" ? t.body : JSON.stringify(t.body)
    console.log(`    ← ${t.err ? `网络错误 ${t.err}` : `HTTP ${t.status}  ${String(body).slice(0, 220)}`}  (${t.ms}ms)`)
  }
}

async function probe(label, script) {
  console.log(`\n${"─".repeat(72)}\n${label}`)
  const trace = []
  const run = runScript(script, trace)
  console.log(`  ${run.info.name}  ${run.info.version}${run.info.homepage ? `  ${run.info.homepage}` : ""}`)

  if (run.fatal) {
    console.log(`  ✗ 脚本执行就失败了：${run.fatal}`)
    printTrace(trace)
    return { label, verdict: "脚本本身跑不起来" }
  }

  if (exitAttempt !== null) {
    console.log(`  ✗ 脚本一上来就调 process.exit(${exitAttempt}) 把进程结束掉了 —— 它认定当前环境不对`)
    printTrace(trace)
    return { label, verdict: `脚本主动退出（process.exit(${exitAttempt})）` }
  }

  if (!(await waitFor(() => run.ready, 25000))) {
    console.log("  ✗ 25s 内没有完成 inited 握手 —— 服务端没放行这个脚本")
    printTrace(trace)
    return { label, verdict: "初始化未通过（服务端）" }
  }

  const sources = Object.keys(run.inited?.sources ?? {})
  console.log(`  ✓ 初始化通过，声明支持：${sources.map((s) => PLATFORM[s] ?? s).join("、")}`)

  const testable = sources.filter((s) => finders[s])
  if (!testable.length) {
    console.log(`  · 这几个平台本脚本查不了曲目 id（只内置了酷我/酷狗的搜索），到此为止`)
    printTrace(trace)
    return { label, verdict: "初始化通过，播放地址未测" }
  }

  const results = []
  for (const source of testable) {
    const song = await finders[source](KEYWORD).catch(() => null)
    if (!song) {
      console.log(`  · ${PLATFORM[source]}：搜不到「${KEYWORD}」，跳过`)
      continue
    }
    try {
      const url = await run.musicUrl(source, song, QUALITY)
      const play = await canPlay(url)
      console.log(`  ${play.ok ? "✓" : "✗"} ${PLATFORM[source]} ${song.name}：${String(url).slice(0, 80)}`)
      console.log(`      ${play.detail}`)
      results.push(play.ok)
    } catch (e) {
      console.log(`  ✗ ${PLATFORM[source]} ${song.name}：解析播放地址失败 —— ${e.message || "（脚本没给出错误文案）"}`)
      results.push(false)
    }
  }

  printTrace(trace)
  const good = results.filter(Boolean).length
  return {
    label,
    verdict: results.length === 0 ? "没测到" : good ? `可用（${good}/${results.length} 个平台能放）` : "初始化通过，但拿不到能放的地址",
  }
}

// ── 主流程 ───────────────────────────────────────────────
/*
 * **每个脚本单独起一个子进程。**
 *
 * 音源脚本是重度混淆的第三方代码，它能干出什么事不由我们说了算 —— 六音就实测能把
 * 整个 Node 进程带崩（libuv 断言 `UV_HANDLE_CLOSING` 直接 abort，连异常都抛不出来）。
 * 全部跑在一个进程里的话，第一个脚本一崩，后面的根本没机会跑，
 * 而恰恰后面那个才是要测的。隔离到子进程之后，崩了也只是这一项报"把 Node 跑崩了"。
 *
 * 顺带也解决了另一件事：globalThis.lx 是单例，同进程跑第二个脚本本来就会互相污染。
 */
const VERDICT_MARK = "##结论##"

/** 把参数解析成 [显示名, 传给子进程的目标] */
function resolveJobs() {
  if (targets.length) {
    return targets.map((t) =>
      /^https?:\/\//.test(t) ? [t, t] : [basename(t), isAbsolute(t) || existsSync(t) ? t : join(DIR, t)],
    )
  }
  if (!existsSync(DIR) || !statSync(DIR).isDirectory()) {
    console.error(`没有这个目录：${DIR}\n用 --dir 指到你的音源目录，或直接把脚本路径当参数传进来。`)
    process.exit(1)
  }
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => [f, join(DIR, f)])
}

// ── 子进程：只测一个 ──────────────────────────────────────
const one = flag("one")
if (one) {
  const script = /^https?:\/\//.test(one) ? await (await fetch(one)).text() : readFileSync(one, "utf8")
  const r = await probe(basename(one), script)
  console.log(`${VERDICT_MARK}${r.verdict}`)
  realExit(0)
}

// ── 父进程：报网络、逐个起子进程 ───────────────────────────
const { spawn } = await import("node:child_process")
const SELF = fileURLToPath(import.meta.url)

/** 起一个子进程测一个脚本。输出照原样往外透，同时抓出最后那行结论。 */
function runChild(target) {
  const args = [SELF, "--one", target, "--keyword", KEYWORD, "--quality", QUALITY, "--env", LX_ENV, "--lxver", LX_VERSION]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] })
    let buf = ""
    let done = false
    const finish = (verdict) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(verdict)
    }
    // 脚本卡在自己服务端上时不能让整轮体检陪着一起挂
    const timer = setTimeout(() => {
      child.kill()
      finish("超时 90s，没跑完")
    }, 90000)

    child.stdout.on("data", (d) => {
      const s = String(d)
      buf += s
      process.stdout.write(s.split(VERDICT_MARK)[0])
    })
    child.stderr.on("data", (d) => process.stderr.write(d))
    child.on("close", (code, signal) => {
      const m = buf.match(new RegExp(`${VERDICT_MARK}(.*)`))
      if (m) return finish(m[1].trim())
      // 没留下结论就退出了 = 脚本把子进程带走了
      finish(`把 Node 跑崩了（${signal ?? `退出码 ${code}`}）—— 脚本自身的问题，不是本应用的`)
    })
  })
}

await reportNetwork()

const jobs = resolveJobs()
if (!jobs.length) {
  console.error(`${DIR} 下没有 .js 音源脚本`)
  realExit(1)
}

const summary = []
for (const [label, target] of jobs) {
  summary.push({ label, verdict: await runChild(target) })
}

console.log(`\n${"─".repeat(72)}\n结论`)
for (const s of summary) console.log(`  ${s.label.padEnd(28)} ${s.verdict}`)
console.log(
  `\n关键词「${KEYWORD}」音质 ${QUALITY}｜lx.env=${LX_ENV} lx.version=${LX_VERSION}` +
    `\n若这里全都不通，问题在音源服务端，改本应用的代码不会有任何帮助。` +
    `\n开着代理时先关掉代理再跑一次对比 —— 国外域名走代理节点出去，音源服务端普遍按地区判客。`,
)
process.exit(0)
