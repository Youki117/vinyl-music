import { describe, expect, it } from "vitest"

import { isBackdropFile, isImageFile, isVideoFile, videoMime } from "@/platform/types"

describe("isVideoFile", () => {
  it("认 WebView2 解得了的容器，扩展名大小写不敏感", () => {
    for (const ext of ["mp4", "m4v", "webm", "mov"]) {
      expect(isVideoFile(`壁纸.${ext}`)).toBe(true)
      expect(isVideoFile(`壁纸.${ext.toUpperCase()}`)).toBe(true)
    }
  })

  it("不认解不了的容器与无扩展名", () => {
    // mkv/avi 选进来也只会黑屏，必须挡在选择器外（VIDEO_EXTENSIONS 的注释）
    expect(isVideoFile("壁纸.mkv")).toBe(false)
    expect(isVideoFile("壁纸.avi")).toBe(false)
    expect(isVideoFile("builtin:a")).toBe(false)
    expect(isVideoFile("song.mp3")).toBe(false)
  })
})

describe("isImageFile / isBackdropFile", () => {
  it("图片与视频都算底图", () => {
    expect(isBackdropFile("a.png")).toBe(true)
    expect(isBackdropFile("b.webp")).toBe(true)
    expect(isBackdropFile("c.mp4")).toBe(true)
    expect(isBackdropFile("d.mov")).toBe(true)
  })

  it("歌词、歌单、音频不是底图", () => {
    for (const name of ["e.lrc", "f.m3u8", "g.mp3", "h"]) {
      expect(isBackdropFile(name)).toBe(false)
    }
  })

  it("isImageFile 不把视频当图片", () => {
    expect(isImageFile("a.mp4")).toBe(false)
  })

  it("认 gif —— WE 有一批 gif 壁纸，走图片那条路本来就能放", () => {
    // 这条容易被当成"图片格式列表里的冗余项"顺手删掉：删了之后 WeRail 会把
    // gif 壁纸过滤掉，而它其实显示得好好的。
    expect(isImageFile("a.gif")).toBe(true)
    expect(isBackdropFile("a.gif")).toBe(true)
  })

  it("WebView2 解不了的容器不算底图 —— WeRail 据此不把它们摆出来", () => {
    // WE 用自己的解码器，吃的容器比 WebView2 多。这些要是列进壁纸栏，
    // 点下去只会报「底图无法识别」：isVideoFile 为 false → 当图片走 → <img> 加载视频
    for (const name of ["壁纸.mkv", "壁纸.avi", "壁纸.wmv"]) {
      expect(isBackdropFile(name)).toBe(false)
    }
  })
})

describe("videoMime", () => {
  it("逐容器给出 Chromium 要求的显式 MIME", () => {
    // Blob 没有 type 的话 <video> 判定"没有可用的源"，且不报错——静默空白
    expect(videoMime("a.mp4")).toBe("video/mp4")
    expect(videoMime("a.m4v")).toBe("video/mp4")
    expect(videoMime("a.webm")).toBe("video/webm")
    expect(videoMime("a.mov")).toBe("video/quicktime")
  })

  it("未知扩展名按最通用的 mp4 处理", () => {
    expect(videoMime("a")).toBe("video/mp4")
  })
})
