/**
 * 文本文件判码。
 *
 * .lrc 和 .m3u 是野生格式，编码全凭当年写它的软件心情：中文环境下大量文件是 GBK，
 * 从网上抓的多半是 UTF-8，还有少数带 BOM 的 UTF-16。一律当 UTF-8 解会得到满屏
 * 乱码，而 TextDecoder 非 fatal 模式又会把坏字节悄悄替换成 U+FFFD 而不报错 ——
 * 所以必须显式开 fatal，让它失败，再退到 GB18030。
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    // GB18030 是 GBK 的超集，向下兼容，用它比用 gbk 覆盖面更广
    return new TextDecoder("gb18030").decode(bytes)
  }
}

/** 去掉扩展名 */
export function stripExt(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(0, i) : name
}

/** 取路径里的文件名部分，兼容两种分隔符 */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * 歌名里的【】降级成连字符：`【Free】Lucky` → `Free-Lucky`。
 *
 * 平台上带【】的歌名很多（【Free】、【伴奏】、【高音质】），那对括号在中文排版里是
 * 用来抢注意力的，进了播放器的标题行只剩噪音，还会把本来就窄的一行挤掉小半。
 *
 * **只动【】这一对。** 其它括号在歌名里是有信息的 ——「晴天 (Live)」「夜曲 (伴奏版)」
 * 「海阔天空 (粤语)」—— 一起洗掉就分不清版本了。
 *
 * 原始歌名不会丢：在线曲目留在 `origin.raw` 里（音源脚本拿的是那一份），
 * 本地文件留在标签里，重新扫一遍就能拿回来。
 */
export function cleanTitle(title: string): string {
  if (!title.includes("【") && !title.includes("】")) return title
  const parts = title
    .split(/[【】]/)
    .map((s) => s.trim())
    .filter(Boolean)
  // 整个歌名就是一对空括号这种，洗完什么都不剩 —— 那就别洗，空标题比难看的标题糟得多
  return parts.length > 0 ? parts.join("-") : title
}
