import { useEffect, useRef, useState } from "react"

import { IS_TAURI, isBackdropFile, platform, type FileRef, type WeWallpaper } from "@/platform"
import { useRailWheel } from "../useRailWheel"

/**
 * Wallpaper Engine 壁纸栏（Tier 1：只接 video / image 两类）。
 *
 * 策略与 Mineradio 一致：只读 WE 的数据，不执行它的 scene/web 内容 ——
 * 那些类型在 Rust 侧就没有给 media，这里自然被过滤掉。
 * 选中后走与手选图片完全相同的 setBackdrop 通道：视频底图、焦点、取色、
 * 贴纸联动全部复用，这里不引入任何新状态。
 */
export default function WeRail({
  activeId,
  onPick,
}: {
  activeId: string | null
  onPick: (ref: FileRef) => void
}) {
  const [items, setItems] = useState<WeWallpaper[] | null>(null)
  const [failed, setFailed] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  /*
   * 两道过滤挡的是两件不同的事：
   *
   * - `media` 为空 = Rust 侧判定这是 scene/web/application，本项目不碰。
   * - 扩展名不认 = WE 用自己的解码器，吃的容器比 WebView2 多（mkv/avi/wmv）。这类
   *   壁纸摆出来只会在点下去时报「底图无法识别」—— `loadMedia` 见 `isVideoFile` 为
   *   false 就当图片走，拿 `<img>` 去加载一个视频 blob，必然失败，而且错得让人
   *   完全摸不着头脑。放不了的干脆不出现。
   */
  const usable = (items ?? []).filter((w) => w.media !== null && isBackdropFile(w.media))

  /*
   * 激活条件必须是"轨道真的渲染出来了"，而不是常 true：列表是异步加载的，
   * 组件挂载那一刻轨道还不存在（ref 为 null），effect 跑一次就再也不会重跑 ——
   * 常 true 的写法会让监听器永远挂不上，滚轮整个失效。
   */
  useRailWheel(railRef, usable.length > 0)

  useEffect(() => {
    if (!IS_TAURI) return
    let alive = true

    void (async () => {
      let list: WeWallpaper[]
      try {
        list = await platform.listWallpaperEngine()
      } catch {
        if (alive) setFailed(true)
        return
      }

      /*
       * 预览图**一次性批量放行**，而且必须在 setItems 之前 await 完。
       *
       * 一次 ensureReadable 就是一次 IPC，不管里面装几百条路径（platform/tauri.ts
       * 的 grantPaths），所以这里省掉的是 N-1 次往返。但更要紧的是**时序**：卡片
       * 一挂载就会自己去读，放行要是只"并行发出去"，一部分卡片会赶在放行到达前读到
       * `forbidden path` —— 而 WeThumb 那边是 `.catch(() => {})`，报错被吞掉，只留下
       * 几个空格子。这种 bug 在开发机上基本不复现（路径早被别的动作放过、盘也热），
       * 到用户机器上才随机冒出来。让列表晚一个 tick 出现，换掉这整类问题。
       *
       * **只放预览，不放 media**：media 要到用户点了那张卡才需要，而点击路径上的
       * setBackdrop 本来就会放行它，那是一次调用，可以忽略。为省这一次就把几百个
       * 用户从没点过的文件提前塞进能力域，等于废掉 grant.rs 立的那条规矩
       * （"没被点过名的路径依旧读不了"）。
       */
      const previews = list.map((w) => w.preview).filter((p): p is string => p !== null)
      // 放行失败不该把列表一起赔进去：缩略图空着，选壁纸这件事照样成立
      await platform.ensureReadable(previews).catch(() => {})

      if (alive) setItems(list)
    })()

    return () => {
      alive = false
    }
  }, [])

  if (!IS_TAURI) return null

  return (
    <section className="panel-section">
      <p className="hint">Wallpaper Engine 壁纸（视频与图片）</p>
      {items === null && !failed && <p className="hint we-empty">正在扫描 Wallpaper Engine…</p>}
      {failed && <p className="hint we-empty">扫描 Wallpaper Engine 失败</p>}
      {items !== null && !failed && usable.length === 0 && (
        <p className="hint we-empty">
          没有找到可用的视频/图片壁纸。需要已安装 Wallpaper Engine 并订阅过壁纸；scene
          与网页类壁纸不支持当底图。
        </p>
      )}
      {usable.length > 0 && (
        <div ref={railRef} className="builtin-backdrops" aria-label="Wallpaper Engine 壁纸">
          {usable.map((w) => (
            <button
              key={w.id}
              className="builtin-backdrop"
              data-on={activeId === w.media}
              onClick={() =>
                onPick({
                  id: w.media!,
                  name: w.media!.split(/[\\/]/).pop() ?? w.title,
                  size: 0,
                  mtime: 0,
                })
              }
              aria-label={`使用壁纸 ${w.title}`}
              aria-pressed={activeId === w.media}
              title={`${w.title}（${w.type === "video" ? "视频" : "图片"}）`}
            >
              <WeThumb path={w.preview} />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * 预览缩略图。**进了视口才读，滚出视口就撤**——与封面缓存同一套卫生习惯。
 * 预览缺失就留空格子，不挡选择。放行已由 WeRail 批量做过，这里只管读。
 *
 * 为什么要懒加载：轨道一次只露 4.5 张卡，而订阅几百张壁纸的人不少见。挂载就全读的话，
 * 每张都要把整个预览文件搬过 IPC，几百张就是几十兆的搬运，而且这些 blob 在面板关掉
 * 之前**全部同时挂着** —— skin 那边费劲设 `URL_CACHE_MAX = 6` 防的正是这种情况。
 *
 * 只"进了视口才读"是不够的：那样滚过一遍全轨道，读过的每一张都还留着，跟挂载就全读
 * 的终局是一样的，只是晚一点到。必须**出视口就撤**，同时在场的才压得到个位数。
 * 滚回来要重读一次，但 rootMargin 留了 200px 提前量 —— 卡片还在视口外就已经读完了。
 */
function WeThumb({ path }: { path: string | null }) {
  const [url, setUrl] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    /*
     * root 用默认的视口，不用轨道自己。IntersectionObserver 会把祖先的 overflow 裁剪
     * 算进去，所以横向滚出轨道的卡同样判为不可见 —— 而用视口还顺带覆盖了"面板整体
     * 纵向滚动、这一栏根本没露出来"，拿轨道当 root 就管不到那一层。
     * rootMargin 提前 200px 起读，滚起来不至于看着格子一个个往上补。
     *
     * **进出都要报**，不能见到第一次相交就 disconnect：那样 visible 是个单向锁存，
     * 下面那个 effect 的清理只在卸载时跑，于是"滚过一遍全轨道"= 几百个 blob 同时挂着
     * 直到面板关闭，正是这里想避免的那件事。
     */
    const io = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: "200px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !path) return
    let own: string | null = null
    let alive = true
    void platform
      .readFile({ id: path, name: path, size: 0, mtime: 0 })
      .then((bytes) => {
        // MIME 按扩展名给：WE 的预览以 jpg 为主但 png 也存在，认 MIME 的下游不吃嗅探
        const mime = /\.png$/i.test(path) ? "image/png" : "image/jpeg"
        own = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
        if (alive) setUrl(own)
        else URL.revokeObjectURL(own)
      })
      .catch(() => {})
    return () => {
      alive = false
      if (own) URL.revokeObjectURL(own)
      // 连 state 一起清掉：留着的话下次滚回来会先闪一帧指向死 blob 的旧 URL
      setUrl(null)
    }
  }, [visible, path])

  return (
    <span
      ref={ref}
      className="we-thumb"
      data-pending={url === null}
      style={url ? { backgroundImage: `url(${url})` } : undefined}
    />
  )
}
