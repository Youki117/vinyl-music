/**
 * Windows 路径归一化与目录围栏。
 *
 * 单独成模块是为了能测：`platform/tauri.ts` 在模块顶层就 import 了一堆 Tauri API，
 * 在测试环境里根本加载不起来，围栏这种安全语义不能因此没有覆盖。
 */

/**
 * 归一化 Windows 路径：统一分隔符、压平重复分隔符、消掉 `.` 与 `..`。
 *
 * 纯字符串运算，不碰磁盘 —— 因此不解析符号链接。用于围栏时这是可接受的：
 * 我们要挡的是调用方传错路径，不是本机上蓄意布置的链接攻击。
 */
export function normalizeWin(path: string): string {
  const win = path.replace(/\//g, "\\")
  // UNC 前缀 \\server\share 要原样留住，其余重复分隔符压平
  const unc = win.startsWith("\\\\")
  const out: string[] = []
  for (const seg of win.split("\\")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return (unc ? "\\\\" : "") + out.join("\\")
}

/**
 * target 是否严格位于 root 目录之内。
 *
 * 两个必要条件，缺一个围栏就是纸糊的：
 *
 * 1. **先归一化再比**。裸 `startsWith` 不解析 `..`，
 *    `…\com.vinylplayer.desktop\..\..\Music\x.mp3` 能前缀匹配通过，实际指向音乐库。
 * 2. **root 末尾补分隔符**。不补的话兄弟目录也算通过 ——
 *    `…\com.vinylplayer.desktop-backup\x.jpg` 的前缀恰好也是 `…\com.vinylplayer.desktop`。
 *
 * root 自身返回 false（"之内"不含它本身），Windows 路径按不区分大小写比较。
 */
export function isUnderDir(root: string, target: string): boolean {
  const r = normalizeWin(root).toLowerCase()
  const t = normalizeWin(target).toLowerCase()
  if (!r) return false
  return t.length > r.length && t.startsWith(r.endsWith("\\") ? r : `${r}\\`)
}
