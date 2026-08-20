/**
 * 在线音源的**惰性启动**。第一次真的要用（搜索、导歌单、播一首在线曲目）时才拉起来。
 *
 * 这个模块本身零依赖 —— 它只有一句动态 import，所以引它不会把 musicSdk 带进来。
 *
 * 为什么不能在启动时就拉：`@/source` 会加载整个 vendored musicSdk，连带
 * crypto-browserify / browserify-zlib / stream / buffer 一串 node 垫片；
 * `loadBuiltinSource()` 还会起一个 **Worker**，那是一个独立的 V8 isolate。
 * 只放本地文件的用户从头到尾用不上这些，却要一直替它们付内存 —— 这条原则
 * 本来就写在 source/index.ts 和 store/player.ts 的注释里，只是 App.tsx 那边
 * 一直在启动路径上无条件 import，等于把它自己的原则架空了。
 */

type SourceModule = typeof import("./index")

declare global {
  interface Window {
    __source?: SourceModule
    /** 端到端核查用：显式把音源拉起来，因为启动时不再自动加载了 */
    __initSource?: () => Promise<SourceModule>
  }
}

let booting: Promise<SourceModule> | null = null

/**
 * 拿到就绪的音源模块。**幂等**：并发调用共用同一次启动。
 *
 * 音源在这里自动拉起，优先用用户导入的那份，其次是随构建附带的内置脚本
 * （开源构建不带，见 source/builtin/README.md）。两份都没有时只是警告：
 * 搜索与歌词不依赖音源脚本，只有解析播放地址依赖它。
 */
export function ensureSource(): Promise<SourceModule> {
  if (!booting) {
    booting = import("./index").then(async (m) => {
      // 端到端核查要的入口（scripts/verify-source.mjs），只读，不含写权限
      window.__source = m
      try {
        const loaded = await m.loadConfiguredSource()
        console.info(
          `[source] 音源就绪：${loaded.info.name}｜${Object.keys(loaded.sources).join(",")}`,
        )
      } catch (err) {
        console.warn("[source] 没有可用音源，搜索仍可用，播放地址解析不可用", err)
      }
      return m
    })
    // 模块本身没加载起来（打包异常、磁盘读失败）时，别把这个失败永久钉住 ——
    // 下次再点搜索应该能重来一次，而不是从此再也不试
    booting.catch(() => {
      booting = null
    })
  }
  return booting
}
