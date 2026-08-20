/**
 * 音源端到端：**发真实网络请求**搜索一首歌，验证 musicSdk 在我们的环境里跑得通。
 *
 * 为什么必须打真实接口：这套代码的全部价值就在于它跟得上平台接口的变化，
 * 用 mock 测等于什么都没测 —— 签名算错、字段改名、加密参数过期，mock 一个都照不出来。
 * 代价是这个脚本依赖网络，平台抽风时会红。所以它不进 CI 的必过项，是手动核查用的。
 *
 * 前置：npm run dev 已在 1420 端口运行。
 *
 *   node scripts/verify-source.mjs            # 全部平台
 *   node scripts/verify-source.mjs kw kg      # 只测指定平台
 */
import { chromium } from "playwright"
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const KEYWORD = process.env.KEYWORD ?? "后来"
const ONLY = process.argv.slice(2)
const ALL = ["kw", "kg", "tx", "wy", "mg"]
const TARGETS = ONLY.length ? ONLY : ALL

const NAMES = { kw: "酷我", kg: "酷狗", tx: "QQ", wy: "网易云", mg: "咪咕" }

const checks = []
const check = (name, ok, detail) => checks.push([name, !!ok, detail])

/**
 * 必须跑在**打包应用里**，不能用普通浏览器。
 *
 * musicSdk 的请求走 `@tauri-apps/plugin-http`，那是 Tauri 注入的 `__TAURI_INTERNALS__.invoke`，
 * 普通 Chromium 里没有（实测报 "Cannot read properties of undefined (reading 'invoke')"）。
 * 而这恰恰是这套东西的要害：请求必须从 Rust 侧发，否则音乐平台的接口全被 CORS 挡死。
 * 所以：起打包应用 → CDP 连进去 → 导航到 dev server（拿得到源码路径，也仍在 Tauri 运行时里）。
 */
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const PORT = 9224
const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
})

let browser = null
for (let i = 0; i < 40 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) {
  console.error("连不上打包应用的 CDP，先确认 src-tauri/target/release/vinyl-player.exe 存在")
  app.kill()
  process.exit(1)
}
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"))
const errors = []
page.on("pageerror", (e) => errors.push(e.message))

/*
 * 音源不在启动路径上了（内存：整个 musicSdk 加一个 Worker，见 src/source/boot.ts），
 * 所以这里要显式把它拉起来 —— 这正是用户第一次点开搜索时发生的事。
 * window.__source 由 boot.ts 在拉起后挂上。
 */
await page.waitForFunction(() => !!window.__initSource, null, { timeout: 30000 })
await page.evaluate(() => window.__initSource())
await page.waitForFunction(() => !!window.__source, null, { timeout: 30000 })

console.log(`关键词「${KEYWORD}」，平台：${TARGETS.map((t) => NAMES[t] ?? t).join(" ")}\n`)

for (const source of TARGETS) {
  const got = await page.evaluate(
    async ({ source, keyword }) => {
      try {
        const res = await window.__source.searchMusic(source, keyword, 1, 10)
        return {
          total: res.total,
          count: res.list.length,
          first: res.list[0] ?? null,
        }
      } catch (e) {
        return { err: String(e?.message ?? e) }
      }
    },
    { source, keyword: KEYWORD },
  )

  const label = NAMES[source] ?? source
  if (got.err) {
    check(`${label} 搜索`, false, got.err)
    continue
  }
  check(`${label} 搜索返回结果`, got.count > 0, `${got.count} 条（总计 ${got.total}）`)
  if (got.first) {
    const t = got.first
    check(`${label} 字段归一化正确`, !!t.title && !!t.artist && !!t.id,
      `${t.title} — ${t.artist}｜${t.album || "?"}｜${t.duration || "?"}｜id=${t.id.slice(0, 14)}`)
    check(`${label} 带音质档位`, t.qualities.length > 0, t.qualities.join(",") || "无")
  }
}

/*
 * 内置音源（src/source/builtin/qdy.js）。**这一段是硬性判据。**
 *
 * 它敢当判据，是因为 qdy 的 inited 握手完全在本地完成 —— 脚本顶层直接 send(inited)，
 * 不打任何第三方服务器。所以这里验的全是我们自己的东西：应用启动时有没有自动载入、
 * Worker 起没起来、上游那套能力收敛规则有没有照做。真正会挂的取址部分放在后面，只作参考。
 */
{
  const got = await page.evaluate(async () => {
    try {
      // App.tsx 启动时就会载入它，这里只等握手完成
      for (let i = 0; i < 60 && !window.__source.hasUserApi(); i++) {
        await new Promise((r) => setTimeout(r, 500))
      }
      return { has: window.__source.hasUserApi() }
    } catch (e) {
      return { err: String(e?.message ?? e) }
    }
  })
  check("内置音源随应用自动启用（用户不必先导入音源）", !got.err && got.has, got.err ?? "")
}

/*
 * 音源运行时。用**自带的测试音源**（tests/real/fake-source.js），不打第三方服务器。
 *
 * 理由写在那个脚本的注释里：真实音源全挂在别人的服务器上，实测四份全部失效，
 * 而且是在用户成功测试之后十几个小时内挂的。拿它们当验收依据，等于把回归测试
 * 挂在别人的运维上。这里验证的是我们这一侧：Worker 隔离、globalThis.lx 的形状、
 * 请求代发、inited 握手、musicUrl 往返。
 *
 * 想拿真实音源试，用 LX_SCRIPT_DIR 指到脚本目录（结果仅供参考，不计入通过与否）。
 */
{
  const script = readFileSync(join("tests", "real", "fake-source.js"), "utf8")
  const loaded = await page.evaluate(async (src) => {
    try {
      const r = await window.__source.loadUserApi(src, 15000)
      return { name: r.info.name, version: r.info.version, sources: Object.keys(r.sources) }
    } catch (e) {
      return { err: String(e?.message ?? e) }
    }
  }, script)

  check("音源脚本能载入并完成 inited 握手", !loaded.err && loaded.sources?.length > 0,
    loaded.err ?? `${loaded.name} ${loaded.version}｜声明支持 ${loaded.sources.join(",")}`)

  if (!loaded.err) {
    // 脚本声明 kw 支持 128k/320k、tx 只支持 128k；宿主要按上游规则取交集
    check("按上游规则收敛脚本声明的能力", loaded.sources.join(",") === "kw,tx", loaded.sources.join(","))

    const got = await page.evaluate(async () => {
      try {
        const res = await window.__source.searchMusic("kw", "后来", 1, 2)
        const t = res.list[0]
        const url = await window.__source.getMusicUrl(t, "128k")
        return { id: t.id, url }
      } catch (e) {
        return { err: String(e?.message ?? e) }
      }
    })

    check("走完 搜索 → 音源解析 → 拿到播放地址 的整条链路", !got.err && /^https:/.test(got.url ?? ""),
      got.err ?? got.url)
    // 传给脚本的必须是**原始对象**，不是我们裁剪过的字段 —— 真实音源要用里面的平台专有字段
    check("原始曲目对象正确传给了音源脚本", (got.url ?? "").includes(`/${got.id}/`),
      `期望地址里含 id=${got.id}`)
  }
}

/*
 * 歌词与封面。**这一段是硬性判据。**
 *
 * 它们不经过音源脚本（只有 getMusicUrl 走 apis()），所以只依赖 musicSdk 与我们的垫片。
 * 这里守的是三条曾经真的错过、而且**错了不报错**的契约：
 *
 *   1. musicSdk 一半的接口返回 `{ promise }` 请求对象而不是 Promise，
 *      直接 await 拿到的是对象本身，歌词永远是空字符串。
 *   2. `resp.raw` 必须是原始字节（Buffer）。给字符串的话酷我歌词那次
 *      `raw.toString('base64')` 会静默变成空操作。
 *   3. 拿不到就得换源。QQ 的逐字歌词要上游不公开的原生解码器，本平台永远解不出，
 *      只能换到网易云/酷狗 —— 这条路断了等于 QQ 的歌全没词。
 */
{
  const rows = await page.evaluate(async () => {
    const out = []
    for (const source of ["kw", "kg", "tx", "wy", "mg"]) {
      const row = { source }
      try {
        const res = await window.__source.searchMusic(source, "后来", 1, 5)
        const t = res.list[0]
        const r = await window.__source.resolveLyric(t)
        row.from = r.source
        row.lines = r.lrc.split("\n").filter(Boolean).length
        row.word = /<\d{1,3}:\d{1,2}[.:]\d{1,3}>/.test(r.lrc)
        row.pic = await window.__source.resolveCover(t)
      } catch (e) {
        row.err = String(e?.message ?? e).slice(0, 70)
      }
      out.push(row)
    }
    return out
  })

  const bad = rows.filter((r) => r.err || !r.lines)
  check(
    "五个平台都能拿到歌词（本平台拿不到就换源）",
    bad.length === 0,
    bad.length
      ? bad.map((r) => `${NAMES[r.source]}: ${r.err ?? "空"}`).join("；")
      : rows.map((r) => `${NAMES[r.source]}${r.from === r.source ? "" : `←${NAMES[r.from]}`} ${r.lines}行`).join("｜"),
  )
  check(
    "歌词是逐字的（洛雪 lxlyric 已转成增强型 LRC）",
    rows.every((r) => r.word),
    rows.filter((r) => !r.word).map((r) => NAMES[r.source]).join(",") || "全部逐字",
  )
  // 咪咕的封面接口在上游就是坏的（见 src/source/index.ts 的 NO_LYRIC_PIC），靠换源补上
  const pics = rows.filter((r) => /^https?:/.test(r.pic ?? ""))
  check("五个平台都能拿到封面（拿不到就换源）", pics.length === 5, `${pics.length}/5`)
}

/*
 * 内置音源打真实接口取地址。**只做参考，不计入通过与否** —— 它挂在别人的服务器上。
 * 想知道音源本身死没死，用 `npm run probe:source`，那个不经过本应用。
 */
{
  const rows = await page.evaluate(async () => {
    await window.__source.loadBuiltinSource()
    const out = []
    for (const source of ["kw", "kg", "tx", "wy", "mg"]) {
      try {
        const res = await window.__source.searchMusic(source, "后来", 1, 5)
        const t = res.list[0]
        const r = await window.__source.resolvePlayUrl(t, "128k")
        out.push({ source, ok: true, via: r.source, url: r.url.slice(0, 46) })
      } catch (e) {
        out.push({ source, ok: false, err: String(e?.message ?? e).slice(0, 60) })
      }
    }
    return out
  })
  console.log("\n内置音源取址（参考，不计入通过与否）")
  for (const r of rows) {
    const name = NAMES[r.source] ?? r.source
    if (!r.ok) console.log(`  ✗ ${name}：${r.err}`)
    else console.log(`  ✓ ${name}${r.via === r.source ? "" : `（换源自 ${NAMES[r.via] ?? r.via}）`}：${r.url}…`)
  }
}

// 用户自己的音源脚本：只做参考，不影响通过与否（它们的后端随时会挂）
const SCRIPT_DIR = process.env.LX_SCRIPT_DIR
if (SCRIPT_DIR && existsSync(SCRIPT_DIR)) {
  for (const f of readdirSync(SCRIPT_DIR).filter((x) => x.endsWith(".js"))) {
    const script = readFileSync(join(SCRIPT_DIR, f), "utf8")
    const r = await page.evaluate(async (src) => {
      try {
        const l = await window.__source.loadUserApi(src, 20000)
        const s = Object.keys(l.sources).find((x) => x !== "local")
        if (!s) return "载入成功但没有可用平台"
        const res = await window.__source.searchMusic(s, "后来", 1, 2)
        const u = await window.__source.getMusicUrl(res.list[0], "128k")
        return `可用 → ${String(u).slice(0, 60)}`
      } catch (e) {
        return `不可用：${String(e?.message ?? e).slice(0, 70)}`
      }
    }, script)
    console.log(`  [参考] ${f}：${r}`)
  }
}

/*
 * 在线曲目在曲库里的行为。**硬性判据。**
 *
 * 这一层最容易出回归又最没法从界面上断言：曲库迁移、在线曲目 id 的稳定性、
 * 收藏/歌单/播放统计对在线曲目是否一视同仁，点按钮验不出来。
 *
 * **必须自己收尾。** 它跑在用户真实的曲库上，加进去的曲目和歌单要原样删掉；
 * 落盘是 1 秒防抖的，删完还得等它写出去，否则下次启动测试数据又回来了。
 */
{
  const got = await page.evaluate(async () => {
    const lib = window.__lib
    const player = window.__player
    if (!lib || !player) return { err: "没有 __lib / __player 入口" }
    const before = lib.getState().tracks.length
    const r = {}
    try {
      r.migrated = lib.getState().tracks.every((t) => t.origin?.kind === "local" || t.origin?.kind === "online")

      const res = await window.__source.searchMusic("kw", "后来", 1, 3)
      const added = lib.getState().addOnlineTracks(res.list.slice(0, 2))
      r.ids = added.map((t) => t.id)
      // 再加一次不该翻倍
      lib.getState().addOnlineTracks(res.list.slice(0, 2))
      r.dedup = lib.getState().tracks.length === before + added.length

      const t = added[0]
      lib.getState().toggleLike(t.id)
      const pid = lib.getState().createPlaylist("__verify__")
      lib.getState().addToPlaylist(pid, [t.id])
      lib.getState().recordPlay(t.id)
      const after = lib.getState().byId(t.id)
      r.liked = after.liked
      r.inPlaylist = lib.getState().playlists.find((p) => p.id === pid)?.trackIds.includes(t.id)
      r.counted = after.playCount === 1

      await player.getState().playFrom([t], 0)
      await new Promise((x) => setTimeout(x, 2500))
      r.status = player.getState().status
      r.duration = player.getState().duration
      r.title = `${t.title} — ${t.artist}`

      await new Promise((x) => setTimeout(x, 4000))
      const meta = lib.getState().byId(t.id)
      r.lyricLines = meta.lyrics ? meta.lyrics.split("\n").filter(Boolean).length : 0
      r.hasCover = !!meta.cover

      lib.getState().deletePlaylist(pid)
      lib.getState().removeTracks(added.map((x) => x.id))
      player.getState().clearQueue()
    } catch (e) {
      r.err = String(e?.message ?? e).slice(0, 90)
    }
    // 收尾必须落盘之后才算完，否则测试数据留在用户曲库里
    await new Promise((x) => setTimeout(x, 1500))
    r.restored = lib.getState().tracks.length === before
    return r
  })

  if (got.err) {
    check("在线曲目能进曲库并播放", false, got.err)
  } else {
    check("老曲库迁移到 origin 判别联合", got.migrated, "")
    check("在线曲目入库且 id 稳定", got.ids?.length === 2 && got.ids.every((x) => /^[a-z]{2}:/.test(x)), got.ids?.join(" , "))
    check("重复入库不产生副本", got.dedup, "")
    check("收藏 / 歌单 / 播放统计对在线曲目一视同仁", got.liked && got.inPlaylist && got.counted,
      `收藏=${got.liked} 歌单=${got.inPlaylist} 计数=${got.counted}`)
    check("在线曲目真的播起来了", got.status === "playing" && got.duration > 60,
      `${got.title}｜${got.status}｜${got.duration?.toFixed(1)}s`)
    check("在线曲目的歌词与封面异步补齐", got.lyricLines > 0 && got.hasCover,
      `歌词 ${got.lyricLines} 行｜封面 ${got.hasCover ? "有" : "无"}`)
    check("测试数据已清理干净（不污染用户曲库）", got.restored, "")
  }
}

/*
 * 歌单导入。**硬性判据。**
 *
 * 用网易云的《热歌榜》(3778678)：官方榜单，不会哪天被人删掉，而且够长，
 * 能顺带验到翻页把整份取全。裸 id 和分享链接两种写法都要试 —— 用户手上的
 * 十有八九是链接，而链接解析是完全另一条代码路径（上游 songList 的正则）。
 *
 * 同样**必须自己收尾**：它跑在用户真实的曲库上。
 */
{
  const got = await page.evaluate(async () => {
    const src = window.__source
    const lib = window.__lib
    // 打包应用里没有 dev server，取不到源码路径，只能走 App.tsx 挂出来的入口
    const useOnline = window.__online
    const r = {}
    try {
      // 一、认平台（纯函数，但顺手在真环境里再确认一次）
      r.link = {
        wy: src.sourceOfLink("https://music.163.com/playlist?id=3778678"),
        tx: src.sourceOfLink("分享歌单：https://y.qq.com/n/ryqq/playlist/8888"),
        kw: src.sourceOfLink("http://www.kuwo.cn/playlist_detail/123"),
        kg: src.sourceOfLink("https://t1.kugou.com/song.html?id=x"),
        mg: src.sourceOfLink("https://music.migu.cn/v3/music/playlist/1"),
        none: src.sourceOfLink("2829883282"),
      }

      // 二、裸 id
      const byId = await src.getPlaylist("wy", "3778678", 1)
      r.name = byId.name
      r.count = byId.list.length
      r.total = byId.total
      r.first = byId.list[0]

      // 三、分享链接（另一条解析路径）
      const byLink = await src.getPlaylist("wy", "https://music.163.com/playlist?id=3778678", 1)
      r.linkCount = byLink.list.length
      r.sameList = byLink.list[0]?.id === byId.list[0]?.id

      // 四、真的导进曲库：顺序要和平台给的一致
      if (useOnline) {
        const before = lib.getState().tracks.length
        useOnline.setState({ listInput: "3778678", listSource: "wy" })
        await useOnline.getState().fetchList()
        const preview = useOnline.getState().preview
        r.previewCount = preview?.tracks.length ?? 0
        const pid = useOnline.getState().importList()
        const pl = lib.getState().playlists.find((p) => p.id === pid)
        r.playlistName = pl?.name
        r.orderKept =
          !!pl &&
          pl.trackIds.length === preview.tracks.length &&
          pl.trackIds.every((id, i) => id === preview.tracks[i].id)

        // 收尾
        lib.getState().deletePlaylist(pid)
        lib.getState().removeTracks(preview.tracks.map((t) => t.id))
        useOnline.setState({ preview: null, listInput: "" })
        await new Promise((x) => setTimeout(x, 1500))
        r.restored = lib.getState().tracks.length === before
      }
    } catch (e) {
      r.err = String(e?.message ?? e).slice(0, 120)
    }
    return r
  })

  if (got.err) {
    check("歌单导入", false, got.err)
  } else {
    check(
      "分享链接能认出平台，认不出的不瞎猜",
      got.link.wy === "wy" && got.link.tx === "tx" && got.link.kw === "kw" &&
        got.link.kg === "kg" && got.link.mg === "mg" && got.link.none === null,
      JSON.stringify(got.link),
    )
    check("裸歌单 id 能取到曲目", got.count > 0, `《${got.name}》${got.count} 首 / 平台声称 ${got.total}`)
    check(
      "歌单里的曲目字段归一化正确",
      !!got.first?.id && !!got.first?.title && Array.isArray(got.first?.qualities),
      `${got.first?.title} — ${got.first?.artist}｜${got.first?.duration}｜id=${got.first?.id}`,
    )
    check("分享链接与裸 id 拿到的是同一个歌单", got.linkCount > 0 && got.sameList, `链接 ${got.linkCount} 首`)
    check("导入后歌单名与曲目顺序都和平台一致", got.orderKept, `「${got.playlistName}」${got.previewCount} 首`)
    check("测试数据已清理干净（不污染用户曲库）", got.restored, "")
  }
}

check("全程无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "))

await browser.close().catch(() => {})
app.kill()

let bad = 0
for (const [n, ok, d] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${n}${d ? `  —— ${d}` : ""}`)
  if (!ok) bad++
}
console.log(bad ? `\n✗ ${bad} / ${checks.length} 项未通过` : `\n✓ 音源检查全部通过（${checks.length} 项）`)
process.exit(bad ? 1 : 0)
