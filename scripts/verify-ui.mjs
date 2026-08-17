/**
 * 逐个按键的交互测试。
 *
 * 之前的端到端脚本只验证"功能跑得通"，没验证"用着顺手"——面板能打开，
 * 但点外面关不掉；两个面板互斥是用 `open={a && !b}` 拼的，关掉上面那个，
 * 下面那个会自己冒出来。这类问题功能测试一个都照不出来。
 *
 * 这里做两件事：
 *   一、把界面上每个可点的控件都点一遍，确认没有点了就报错的。
 *   二、逐条验证现代软件该有的交互约定：点外部关闭、面板互斥、
 *       Esc 收起、常驻操控件不误触关闭、选中态跟随。
 *
 * 前置：npm run dev 已在 1420 端口运行；tests/real/ 下有素材。
 *
 *   node scripts/verify-ui.mjs
 */
import { chromium } from "playwright"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const OUT = "tests/__screenshots__"
const REAL = resolve("tests/real")

mkdirSync(OUT, { recursive: true })
if (!existsSync(REAL)) {
  console.error("tests/real/ 不存在，先跑 node scripts/fetch-real-assets.mjs")
  process.exit(1)
}
const audio = readdirSync(REAL)
  .filter((f) => /\.(mp3|ogg)$/i.test(f))
  .map((f) => resolve(REAL, f))
const lrc = readdirSync(REAL)
  .filter((f) => /\.lrc$/i.test(f))
  .map((f) => resolve(REAL, f))

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: 1243, height: 688 }, deviceScaleFactor: 1 })

const errors = []
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`)
})

/**
 * 扫按钮时会碰到打开文件对话框的按钮，不接住 Playwright 会一直挂着。
 * 但这个兜底不能一开始就挂 —— 它会把下面那次**故意**的导入也一起取消掉。
 * 等素材导完再打开。
 */
let autoCancelDialogs = false
page.on("filechooser", (fc) => {
  if (autoCancelDialogs) void fc.setFiles([]).catch(() => {})
})

const checks = []
const check = (name, ok, detail) => checks.push([name, !!ok, detail])

const panelOf = () =>
  page.evaluate(() => {
    if (document.querySelector(".library-drawer")) return "playlist"
    if (document.querySelector(".mix-panel")) return "mix"
    const d = document.querySelector(".skin-editor")
    if (!d) return null
    return d.getAttribute("aria-label") === "播放设置" ? "playback" : "skin"
  })

/** 点画面左上角的空白处——底图区域，既不是面板也不是常驻操控件 */
const clickBlank = async () => {
  await page.mouse.click(620, 210)
  await page.waitForTimeout(350)
}

await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForTimeout(600)

// 先把曲目导进来，否则大半控件是禁用或空的，点了等于没点
const chooser = page.waitForEvent("filechooser")
await page.click('button:has-text("添加音乐文件")')
await (await chooser).setFiles([...audio, ...lrc])
await page.waitForTimeout(3000)
autoCancelDialogs = true

const imported = await page.evaluate(() => document.querySelectorAll(".lib-main ol li").length)
await page.click(".disc")
await page.waitForTimeout(1800)

// ── 一、点外部关闭（用户明确点名的那条）─────────────────────────
await page.click('button[aria-label="播放列表"]')
await page.waitForTimeout(400)
const openedByButton = await panelOf()
const rowCount = await page.evaluate(() => document.querySelectorAll(".lib-main ol li .row").length)
check("测试素材已导入（后面的检查都靠它）", rowCount >= 2, `${rowCount} 首`)
await clickBlank()
const afterBlank = await panelOf()

check("点列表按钮能打开曲库", openedByButton === "playlist", String(openedByButton))
check("点画面空白处能自然关闭曲库", afterBlank === null, String(afterBlank))

// 关闭那一下不该顺手按到底下的东西
const playingBefore = await page.evaluate(() => document.querySelector(".disc")?.dataset.playing)
await page.click('button[aria-label="播放列表"]')
await page.waitForTimeout(300)
await page.mouse.click(360, 344) // 黑胶正中，底下是播放/暂停
await page.waitForTimeout(400)
const afterDiscClick = await panelOf()
const playingAfter = await page.evaluate(() => document.querySelector(".disc")?.dataset.playing)

check("点到黑胶上也能关闭面板", afterDiscClick === null)
check(
  "关闭的那一下不会顺手把底下的播放/暂停也按了",
  playingBefore === playingAfter,
  `${playingBefore} → ${playingAfter}`,
)

// ── 二、常驻操控件豁免 ───────────────────────────────────────────
// 混音面板开着时本来就要一边拖进度条一边看时间轴
await page.keyboard.press("x")
await page.waitForTimeout(400)
const mixOpen = await panelOf()
const bar = await (await page.$(".progress")).boundingBox()
await page.mouse.click(bar.x + bar.width * 0.4, bar.y + bar.height / 2)
await page.waitForTimeout(400)
const mixAfterSeek = await panelOf()

check("按 X 打开混音面板", mixOpen === "mix", String(mixOpen))
check("拖进度条不会把混音面板关掉（传输栏是常驻操控件）", mixAfterSeek === "mix", String(mixAfterSeek))

// 标题栏同理，而且要能直接切到另一个面板
await page.click('button[aria-label="播放设置"]')
await page.waitForTimeout(400)
const afterSwitch = await panelOf()
check("从混音面板直接切到播放设置", afterSwitch === "playback", String(afterSwitch))

// ── 三、面板互斥：关掉当前的，前一个不该"复活" ───────────────────
// 这是旧写法 open={a && !b && !c} 的老毛病
await page.keyboard.press("Escape")
await page.waitForTimeout(300)
const afterEsc = await panelOf()
check("Esc 能收起面板", afterEsc === null, String(afterEsc))
check("关掉之后前一个面板不会自己冒出来", afterEsc === null, String(afterEsc))

// 依次开四个，每次都应当只剩最后开的那个
const seq = [
  ["p", "playlist"],
  ["s", "skin"],
  ["e", "playback"],
  ["x", "mix"],
]
let exclusive = true
let trace = []
for (const [key, want] of seq) {
  await page.keyboard.press(key)
  await page.waitForTimeout(350)
  const got = await panelOf()
  trace.push(`${key}→${got}`)
  const count = await page.evaluate(
    () => document.querySelectorAll(".drawer").length,
  )
  if (got !== want || count !== 1) exclusive = false
}
check("四个面板严格互斥，同一时刻只有一个", exclusive, trace.join("  "))

// 同一个快捷键按第二次应当收起
await page.keyboard.press("x")
await page.waitForTimeout(350)
check("同一快捷键再按一次收起面板", (await panelOf()) === null)

// ── 四、右键菜单也要能点外面关掉 ────────────────────────────────
await page.keyboard.press("p")
await page.waitForTimeout(400)
await page.click(".lib-main ol li:nth-child(1) .row", { button: "right" })
await page.waitForTimeout(350)
const menuOpen = await page.evaluate(() => !!document.querySelector(".ctx-menu"))
// 点抽屉里别处（不是菜单），菜单该收但抽屉该留着
await page.mouse.click(1000, 120)
await page.waitForTimeout(350)
const menuAfter = await page.evaluate(() => !!document.querySelector(".ctx-menu"))
const drawerStill = await panelOf()

check("右键曲目弹出菜单", menuOpen)
check("点菜单外面菜单收起", !menuAfter)
check("收菜单不会连抽屉一起关掉", drawerStill === "playlist", String(drawerStill))

// ── 五、选中态跟随 ──────────────────────────────────────────────
const listBtnOn = await page.evaluate(
  () => document.querySelector('.controls button[aria-label="播放列表"]')?.dataset.on,
)
check("曲库开着时列表按钮点亮", listBtnOn === "true", String(listBtnOn))
await page.keyboard.press("Escape")
await page.waitForTimeout(300)
const listBtnOff = await page.evaluate(
  () => document.querySelector('.controls button[aria-label="播放列表"]')?.dataset.on,
)
check("关掉后按钮熄灭", listBtnOff !== "true", String(listBtnOff))

// ── 六、传输栏每个按钮 ──────────────────────────────────────────
const modes = []
for (let i = 0; i < 5; i++) {
  modes.push(await page.getAttribute('.controls button[aria-label^="播放模式"]', "aria-label"))
  await page.click('.controls button[aria-label^="播放模式"]')
  await page.waitForTimeout(200)
}
check(
  "播放模式循环四种后回到起点",
  new Set(modes).size === 4 && modes[0] === modes[4],
  modes.map((m) => m?.replace("播放模式：", "")).join(" → "),
)

const titleBefore = await page.textContent(".timing b")
await page.click('.controls button[aria-label="下一首"]')
await page.waitForTimeout(1800)
const titleNext = await page.textContent(".timing b")
await page.click('.controls button[aria-label="上一首"]')
await page.waitForTimeout(1800)
const titleBack = await page.textContent(".timing b")
check("下一首切歌", titleNext !== titleBefore, `${titleBefore} → ${titleNext}`)
check("上一首切回来", titleBack === titleBefore, `${titleNext} → ${titleBack}`)

const likeBefore = await page.getAttribute(".action.like", "aria-pressed")
await page.click(".action.like")
await page.waitForTimeout(250)
const likeAfter = await page.getAttribute(".action.like", "aria-pressed")
check("收藏按钮能切换", likeBefore !== likeAfter, `${likeBefore} → ${likeAfter}`)
await page.click(".action.like")
await page.waitForTimeout(200)

// ── 七、A-B 循环真的会跳回去 ────────────────────────────────────
await page.evaluate(() => {
  const el = document.querySelector('audio[data-role="host"]') ?? document.querySelector("audio")
  if (el) el.currentTime = 30
})
await page.waitForTimeout(400)
await page.keyboard.press("l") // 设 A
await page.waitForTimeout(300)
await page.evaluate(() => {
  const el = document.querySelector('audio[data-role="host"]') ?? document.querySelector("audio")
  if (el) el.currentTime = 33
})
await page.waitForTimeout(400)
await page.keyboard.press("l") // 设 B
await page.waitForTimeout(300)

const marks = await page.evaluate(() => document.querySelectorAll(".loop-mark").length)
// 跳到 B 之后一点，应当被拉回 A 附近
await page.evaluate(() => {
  const el = document.querySelector('audio[data-role="host"]') ?? document.querySelector("audio")
  if (el) el.currentTime = 33.4
})
await page.waitForTimeout(1400)
const afterLoop = await page.evaluate(() => {
  const el = document.querySelector('audio[data-role="host"]') ?? document.querySelector("audio")
  return el?.currentTime ?? -1
})
console.log(`A-B：标记 ${marks} 个，越过 B 点后落到 ${afterLoop.toFixed(2)}s（A 点是 30s）`)
check("进度条上画出了 A、B 两个标记", marks === 2, String(marks))
check("播到 B 点自动跳回 A 点", afterLoop >= 29.5 && afterLoop < 33, `${afterLoop.toFixed(2)}s`)

await page.keyboard.press("l") // 清除
await page.waitForTimeout(300)
check("再按一次清除区间", (await page.evaluate(() => document.querySelectorAll(".loop-mark").length)) === 0)

// ── 八、拖拽排序 ────────────────────────────────────────────────
await page.keyboard.press("p")
await page.waitForTimeout(400)
// 建一个歌单并把曲目放进去，才有"顺序"可言
await page.click('.lib-side-title button[aria-label="新建歌单"]')
await page.waitForTimeout(400)
await page.keyboard.press("Enter")
await page.waitForTimeout(400)
await page.click('button:has-text("加文件夹")').catch(() => {})
await page.waitForTimeout(300)

// 直接从曲库右键把四首都加进这个歌单
await page.click(".lib-side-group button:nth-child(1)") // 回到全部音乐
await page.waitForTimeout(300)
const total = await page.evaluate(() => document.querySelectorAll(".lib-main ol li").length)
for (let i = 1; i <= total; i++) {
  await page.click(`.lib-main ol li:nth-child(${i}) .row`, { button: "right" })
  await page.waitForTimeout(200)
  const add = await page.$('.ctx-menu button:has-text("加入「")')
  if (add) await add.click()
  await page.waitForTimeout(200)
}
const playlistBtn = await page.$$(".lib-side-group")
await page.click(".lib-side-group:nth-of-type(3) button")
await page.waitForTimeout(400)

const orderBefore = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".lib-main ol li .row b")).map((e) => e.textContent),
)
if (orderBefore.length >= 2) {
  const first = await (await page.$(".lib-main ol li:nth-child(1) .row")).boundingBox()
  const last = await (
    await page.$(`.lib-main ol li:nth-child(${orderBefore.length}) .row`)
  ).boundingBox()
  await page.mouse.move(first.x + 40, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + 40, first.y + first.height / 2 + 20, { steps: 4 })
  await page.mouse.move(last.x + 40, last.y + last.height, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(500)
}
const orderAfter = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".lib-main ol li .row b")).map((e) => e.textContent),
)
console.log(`拖拽排序：${orderBefore.join(",")} → ${orderAfter.join(",")}`)
check("歌单里有曲目可供排序", orderBefore.length >= 2, `${orderBefore.length} 条`)
check(
  "把第一首拖到末尾，顺序真的变了",
  orderBefore.length >= 2 && orderAfter[orderAfter.length - 1] === orderBefore[0],
  `${orderBefore.join(",")} → ${orderAfter.join(",")}`,
)
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

// ── 九、快速连按不能把状态搞拧 ──────────────────────────────────
// 暂停有 80ms 淡出，延迟停止的计时器要是不取消，会在下一次播放之后才触发：
// 界面显示在播放，实际没声音。
await page.keyboard.press("Escape")
await page.waitForTimeout(300)
await page.evaluate(() => {
  const el = document.querySelector('audio[data-role="host"]') ?? document.querySelector("audio")
  if (el?.paused) document.querySelector(".disc")?.click()
})
await page.waitForTimeout(1200)

for (let i = 0; i < 3; i++) {
  await page.keyboard.press(" ")
  await page.waitForTimeout(30) // 刻意小于 80ms 的淡变时长
  await page.keyboard.press(" ")
  await page.waitForTimeout(500)
}
const rapid = await page.evaluate(() => {
  const el = document.querySelector('audio[data-role="host"]') ?? document.querySelector("audio")
  return {
    uiSaysPlaying: document.querySelector(".disc")?.dataset.playing === "true",
    elementPaused: el?.paused ?? true,
  }
})
console.log(`\n快速连按空格：界面=${rapid.uiSaysPlaying ? "播放" : "暂停"}，元素=${rapid.elementPaused ? "已暂停" : "在播"}`)
check(
  "快速连按空格后，界面状态与实际发声一致",
  rapid.uiSaysPlaying !== rapid.elementPaused,
  `界面说${rapid.uiSaysPlaying ? "在播" : "暂停"}，元素${rapid.elementPaused ? "却是暂停的" : "在播"}`,
)

// 快速切歌时混音层的 sync 会交错，过期那轮不能把层塞回来
await page.keyboard.press("x")
await page.waitForTimeout(400)
const addBtn = await page.$('button:has-text("＋ 添加")')
if (addBtn) {
  await addBtn.click()
  await page.waitForTimeout(300)
  const pick = await page.$(".track-picker button")
  if (pick) await pick.click()
  await page.waitForTimeout(2500)
}
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

const elsBefore = await page.evaluate(() => document.querySelectorAll("audio").length)
// 连续快切，不给 sync 跑完的机会
for (let i = 0; i < 6; i++) {
  await page.click('.controls button[aria-label="下一首"]')
  await page.waitForTimeout(120)
}
await page.waitForTimeout(3500)
const elsAfter = await page.evaluate(() => ({
  count: document.querySelectorAll("audio").length,
  playing: Array.from(document.querySelectorAll("audio")).filter((e) => !e.paused && !e.ended).length,
}))
console.log(`快速切歌：音频元素 ${elsBefore} → ${elsAfter.count}，其中 ${elsAfter.playing} 个在播`)
check("快速切歌不会攒下孤儿音频元素", elsAfter.count <= elsBefore, `${elsBefore} → ${elsAfter.count}`)
check("快速切歌后同时发声的不超过两轨", elsAfter.playing <= 2, String(elsAfter.playing))

// ── 十、把每个面板里的按钮都点一遍 ──────────────────────────────
const SKIP = {
  // 关闭类的单独测，混在扫描里会让面板中途关掉，后面的控件就都扫不到了
  selectors: [".drawer-close", ".titlebar button.close"],
  // 不可逆后果
  texts: ["删歌单", "从曲库移除", "移除这一层"],
}

for (const [key, label, least] of [
  ["e", "播放设置", 25],
  ["s", "皮肤", 8],
  ["x", "混音", 3],
  ["p", "曲库", 10],
]) {
  await page.keyboard.press("Escape")
  await page.waitForTimeout(250)
  await page.keyboard.press(key)
  await page.waitForTimeout(450)

  const before = errors.length
  // 分页面板要逐页扫：标签按钮在 DOM 里排在内容前面，一轮扫下来会先把标签点完，
  // 每页的内容只在被选中的那一瞬间存在，扫描器根本轮不到它们
  const tabs = await page.$$(".drawer .tabs button")
  let clicked = 0
  if (tabs.length > 1) {
    for (let i = 0; i < tabs.length; i++) {
      const tab = (await page.$$(".drawer .tabs button"))[i]
      if (!tab) continue
      await tab.click().catch(() => {})
      await page.waitForTimeout(250)
      clicked += 1 + (await sweepButtons(page, ".skin-body", SKIP))
    }
  } else {
    clicked = await sweepButtons(page, ".drawer", SKIP)
  }
  await page.waitForTimeout(400)
  const stillOpen = (await page.evaluate(() => document.querySelectorAll(".drawer").length)) > 0

  console.log(`${label}面板：点了 ${clicked} 个控件，新增报错 ${errors.length - before}`)
  check(`${label}面板里的按钮全点一遍不报错`, errors.length === before, errors.slice(before, before + 2).join(" | "))
  check(`${label}面板确实扫到了控件（≥${least}）`, clicked >= least, `${clicked} 个`)
  check(`${label}面板点完仍然活着`, stillOpen)
  await page.screenshot({ path: `${OUT}/ui-${key}.png` })

  // 面板自带的 ✕ 单独验一次
  await page.click(".drawer-close")
  await page.waitForTimeout(350)
  check(`${label}面板的 ✕ 能关闭`, (await panelOf()) === null)
}

// 标题栏、右侧工具栏与传输栏（排除窗口关闭）
{
  const before = errors.length
  // .sidebar 是后来从标题栏拆出去的右侧工具栏；漏掉它这轮扫描的覆盖会悄悄缩水
  const n = await sweepButtons(page, ".titlebar, .sidebar, .playback, .actions", SKIP)
  console.log(`标题栏/侧栏/传输栏：点了 ${n} 个控件，新增报错 ${errors.length - before}`)
  check("这三处的按钮全点一遍不报错", errors.length === before, errors.slice(before, before + 2).join(" | "))
  check("确实扫到了控件（≥8）", n >= 8, `${n} 个`)
}
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

const alive = await page.evaluate(() => !!document.querySelector(".stage"))
check("全部点完界面仍然完好", alive)
await page.screenshot({ path: `${OUT}/ui-final.png` })

await browser.close()

check("全程无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "))

// ── 判定 ─────────────────────────────────────────────────────────
console.log("")
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  —— 实际：${detail}` : ""}`)
  if (!ok) failed++
}
if (errors.length) {
  console.log("\n页面报错：")
  for (const e of errors.slice(0, 10)) console.log("  " + e)
}
console.log(`\n截图 → ${OUT}/ui-*.png`)

if (failed > 0) {
  console.error(`\n✗ ${failed} / ${checks.length} 项未通过`)
  process.exit(1)
}
console.log(`\n✓ 交互检查全部通过（${checks.length} 项）`)

/**
 * 把选择器范围内所有可见、未禁用的控件点一遍。
 *
 * 每次都重新查询：点一下可能让界面重排（切换 tab、增删行），
 * 拿着旧的元素句柄接着点会拿到脱离文档的节点。
 */
async function sweepButtons(page, scope, skip) {
  const seen = []
  let clicked = 0

  for (let round = 0; round < 120; round++) {
    // 每轮都重新查询：点一下可能让界面重排（切 tab、增删行），
    // 拿着上一轮的元素句柄接着点会拿到已经脱离文档的节点
    const key = await page.evaluate(
      ({ scope, seen, skip }) => {
        document.querySelector("[data-sweep]")?.removeAttribute("data-sweep")
        const roots = Array.from(document.querySelectorAll(scope))
        const all = roots.flatMap((r) =>
          Array.from(r.querySelectorAll("button, input[type=checkbox], input[type=range], select")),
        )
        for (const el of all) {
          if (el.disabled) continue
          const box = el.getBoundingClientRect()
          if (box.width === 0 || box.height === 0) continue
          if (skip.selectors.some((s) => el.matches(s))) continue
          const text = (el.textContent ?? "").trim()
          if (skip.texts.some((t) => text.includes(t))) continue

          const id = `${el.tagName}|${el.className}|${el.getAttribute("aria-label") ?? ""}|${text.slice(0, 24)}`
          if (seen.includes(id)) continue
          el.setAttribute("data-sweep", "1")
          return id
        }
        return null
      },
      { scope, seen, skip },
    )
    if (!key) break
    seen.push(key)

    const el = await page.$("[data-sweep]")
    if (!el) break
    // 点不到（被遮挡、正好被移出）不算失败，记下继续
    await el.click({ timeout: 1500 }).catch(() => {})
    clicked++
    await page.waitForTimeout(110)
  }
  await page.evaluate(() => document.querySelector("[data-sweep]")?.removeAttribute("data-sweep"))
  return clicked
}
