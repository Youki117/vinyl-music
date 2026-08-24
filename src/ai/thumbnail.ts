/**
 * 图库列表用的小缩略图。
 *
 * 和 skin.ts 里给「背景图片」历史栏做缩略图是同一个理由：图库可能有上百张
 * 1792×1024 的 PNG，列表直接渲染原图等于打开面板就解码几百 MB。存成几 KB 的
 * JPEG data URL，列表只认它。
 *
 * 单独一个文件是因为它要碰 DOM（canvas / Image），而 artworkStore 是纯函数、
 * 要能在 node 环境下单测 —— 两者不能混在一起。
 */

/** 和背景图片历史栏保持一致的尺寸，两处列表看起来才是一套东西 */
const THUMB_W = 160
const THUMB_H = 100

/** JPEG 质量。0.74 是历史栏用了很久的值，肉眼看不出差别而体积只有几 KB */
const THUMB_QUALITY = 0.74

/**
 * 图片字节 → 缩略图 data URL。
 *
 * 走 Blob URL 而不是 base64 data URL 喂给 `<img>`：一张 3MB 的 PNG 转成 base64
 * 是 4MB 的字符串，白白多一次编解码。用完立刻 revoke。
 */
export async function thumbnailFromBytes(bytes: Uint8Array): Promise<string> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
  try {
    return await thumbnailFromUrl(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function thumbnailFromUrl(url: string): Promise<string> {
  const source = new Image()
  await new Promise<void>((resolve, reject) => {
    source.onload = () => resolve()
    source.onerror = () => reject(new Error("无法读取图片"))
    source.src = url
  })

  const canvas = document.createElement("canvas")
  canvas.width = THUMB_W
  canvas.height = THUMB_H
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("无法创建缩略图画布")

  // 等比铺满后居中裁切（cover），列表里每格大小一致才不会参差不齐
  const scale = Math.max(THUMB_W / source.naturalWidth, THUMB_H / source.naturalHeight)
  const w = source.naturalWidth * scale
  const h = source.naturalHeight * scale
  ctx.drawImage(source, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h)
  return canvas.toDataURL("image/jpeg", THUMB_QUALITY)
}
