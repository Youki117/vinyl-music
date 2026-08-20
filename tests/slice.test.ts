import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"
import { EndOfStreamError } from "strtok3"

import { parseWavInfo, readMetadata, readMetadataSliced, readWavInfoSliced } from "@/audio/metadata"
import {
  SLICE_BUDGET,
  SLICE_CHUNK,
  SliceBudgetExceeded,
  SliceTokenizer,
  type SliceReader,
} from "@/audio/sliceTokenizer"
import type { FileRef } from "@/platform"

/**
 * 按需切片读元数据。
 *
 * 盯的是这条路最容易出事的地方：tokenizer 报告的必须是**文件真实大小**而不是
 * 手上有多少字节 —— CBR mp3 的时长就是靠它算出来的；以及跨片读取的拼接。
 */

/** 一个内存里的假文件，顺便记下取了多少次、多少字节 */
function memoryFile(size: number) {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  const calls: Array<[number, number]> = []
  const read: SliceReader = async (offset, length) => {
    calls.push([offset, length])
    return bytes.subarray(offset, Math.min(offset + length, size))
  }
  return { bytes, read, calls }
}

describe("SliceTokenizer", () => {
  it("报告的是文件真实大小，不是已取到的字节数", async () => {
    const f = memoryFile(10 * SLICE_CHUNK)
    const t = new SliceTokenizer(f.bytes.length, f.read)

    expect(t.fileInfo.size).toBe(10 * SLICE_CHUNK)
    // 还一个字节都没取
    expect(t.bytesFetched).toBe(0)
  })

  it("跨片读取拼得对，且同一片只取一次", async () => {
    const f = memoryFile(3 * SLICE_CHUNK)
    const t = new SliceTokenizer(f.bytes.length, f.read)

    // 故意跨越片边界
    const start = SLICE_CHUNK - 100
    const len = 300
    const buf = new Uint8Array(len)
    t.setPosition(start)
    const n = await t.readBuffer(buf)

    expect(n).toBe(len)
    expect(buf).toEqual(f.bytes.subarray(start, start + len))
    expect(f.calls.length).toBe(2) // 只该碰到两片

    // 再读同一段，不该产生新的取片
    const before = f.calls.length
    t.setPosition(start)
    await t.readBuffer(new Uint8Array(len))
    expect(f.calls.length).toBe(before)
  })

  it("position 为 0 也生效（BlobTokenizer 用真值判断，这里会漏）", async () => {
    const f = memoryFile(SLICE_CHUNK)
    const t = new SliceTokenizer(f.bytes.length, f.read)

    t.setPosition(500)
    const buf = new Uint8Array(4)
    await t.readBuffer(buf, { position: 0, length: 4 })

    expect(buf).toEqual(f.bytes.subarray(0, 4))
    expect(t.position).toBe(4)
  })

  it("读过文件尾：默认抛 EOF，mayBeLess 时给多少算多少", async () => {
    const f = memoryFile(100)
    const t = new SliceTokenizer(f.bytes.length, f.read)

    t.setPosition(90)
    await expect(t.readBuffer(new Uint8Array(20))).rejects.toBeInstanceOf(EndOfStreamError)

    t.setPosition(90)
    const buf = new Uint8Array(20)
    const n = await t.readBuffer(buf, { length: 20, mayBeLess: true })
    expect(n).toBe(10)
    expect(buf.subarray(0, 10)).toEqual(f.bytes.subarray(90, 100))
  })

  it("取满预算就抛 SliceBudgetExceeded，交给上层退回整读", async () => {
    const size = SLICE_BUDGET * 4
    const f = memoryFile(size)
    const t = new SliceTokenizer(size, f.read)

    // 一片片往后读，直到预算用尽
    const read = async () => {
      for (let p = 0; p < size; p += SLICE_CHUNK) {
        t.setPosition(p)
        await t.readBuffer(new Uint8Array(16), { length: 16 })
      }
    }
    await expect(read()).rejects.toBeInstanceOf(SliceBudgetExceeded)
    expect(t.bytesFetched).toBeGreaterThanOrEqual(SLICE_BUDGET)
  })
})

/** 拼一个带 fmt / data / LIST-INFO 的最小 WAV，可指定 INFO 放在 data 之前还是之后 */
function makeWav(tags: Record<string, string>, infoAfterData: boolean): Uint8Array {
  const chunk = (id: string, body: Uint8Array) => {
    const pad = body.length % 2
    const out = new Uint8Array(8 + body.length + pad)
    out.set([...id].map((c) => c.charCodeAt(0)), 0)
    new DataView(out.buffer).setUint32(4, body.length, true)
    out.set(body, 8)
    return out
  }

  const fmt = new Uint8Array(16)
  const fv = new DataView(fmt.buffer)
  fv.setUint16(0, 1, true) // PCM
  fv.setUint16(2, 1, true) // 单声道
  fv.setUint32(4, 8000, true) // 采样率
  fv.setUint32(8, 8000, true) // 字节率
  fv.setUint16(12, 1, true) // 块对齐
  fv.setUint16(14, 8, true) // 位深

  const infoSubs: Uint8Array[] = []
  for (const [id, value] of Object.entries(tags)) {
    const body = new TextEncoder().encode(value)
    const withNul = new Uint8Array(body.length + 1)
    withNul.set(body)
    infoSubs.push(chunk(id, withNul))
  }
  const infoLen = infoSubs.reduce((n, c) => n + c.length, 0)
  const infoBody = new Uint8Array(4 + infoLen)
  infoBody.set([..."INFO"].map((c) => c.charCodeAt(0)), 0)
  let o = 4
  for (const c of infoSubs) {
    infoBody.set(c, o)
    o += c.length
  }

  const parts = [chunk("fmt ", fmt)]
  const data = chunk("data", new Uint8Array(8000))
  const list = chunk("LIST", infoBody)
  parts.push(...(infoAfterData ? [data, list] : [list, data]))

  const bodyLen = parts.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(12 + bodyLen)
  out.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  out.set([..."WAVE"].map((c) => c.charCodeAt(0)), 8)
  let p = 12
  for (const c of parts) {
    out.set(c, p)
    p += c.length
  }
  return out
}

describe("WAV 的 LIST/INFO：切片走法与整读走法结果一致", () => {
  const tags = { INAM: "测试曲目一", IART: "演唱者", IPRD: "专辑名" }

  for (const after of [false, true]) {
    it(`INFO 在 data ${after ? "之后" : "之前"}`, async () => {
      const wav = makeWav(tags, after)
      const read: SliceReader = async (offset, length) =>
        wav.subarray(offset, Math.min(offset + length, wav.length))

      const contiguous = parseWavInfo(wav)
      const sliced = await readWavInfoSliced(wav.length, read)

      expect(contiguous).toEqual({ title: "测试曲目一", artist: "演唱者", album: "专辑名" })
      expect(sliced).toEqual(contiguous)
    })
  }
})

/*
 * 下面这组要真实音频。tests/fixtures 是 gitignore 掉的（用 ffmpeg 现生成），
 * 没有就跳过 —— 单测不该因为素材缺失而红。
 */
const FIXTURES = ["test-mp3.mp3", "test-flac.flac", "test-wav.wav", "test-ogg.ogg", "test-m4a.m4a"]
const fixtureDir = resolve("tests/fixtures")
const hasFixtures = FIXTURES.every((f) => existsSync(resolve(fixtureDir, f)))

/** tests/real 下那几首是真正的大文件，常数上限要靠它们才看得出来。缺了就只跑 fixtures。 */
const REAL = [
  "ProleteR - April Showers.mp3",
  "Multi Panel - Christmas With Mr Rice.mp3",
  "Riding Alone - Lullaby.ogg",
  "ProleteR - Downtown Irony.ogg",
]
const realDir = resolve("tests/real")

function assets(): Array<{ path: string; name: string }> {
  const out = FIXTURES.map((name) => ({ path: resolve(fixtureDir, name), name }))
  for (const name of REAL) {
    const path = resolve(realDir, name)
    if (existsSync(path)) out.push({ path, name })
  }
  return out
}

function fileReader(path: string): SliceReader {
  return async (offset, length) => {
    const fd = openSync(path, "r")
    try {
      const buf = Buffer.alloc(length)
      const n = readSync(fd, buf, 0, length, offset)
      return new Uint8Array(buf.buffer, buf.byteOffset, n)
    } finally {
      closeSync(fd)
    }
  }
}

describe.skipIf(!hasFixtures)("真实文件：切片解出来的元数据与整读一致", () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      const path = resolve(fixtureDir, name)
      const size = statSync(path).size
      const ref: FileRef = { id: path, name, size, mtime: 0 }

      const full = await readMetadata(ref, new Uint8Array(readFileSync(path)))
      const sliced = await readMetadataSliced(ref, fileReader(path))

      // 时长是浮点，其余必须逐字相同
      expect(sliced.duration).toBeCloseTo(full.duration, 2)
      expect({ ...sliced, duration: 0 }).toEqual({ ...full, duration: 0 })
      // 时长本身不能丢：ogg 要靠 seek 到尾部才拿得到，是这条路最容易退化的一项
      expect(sliced.duration).toBeGreaterThan(0)
    })
  }

  it("取的字节数与文件大小无关，只跟格式有关", async () => {
    /*
     * 关键断言不是"比整读少"—— 小于一片的文件（比如 88KB 的 test-ogg）本来就
     * 一片装得下，读满它并不算退化。真正要钉住的是**上限是个常数**：无论文件
     * 多大，都只取头部那一片，ogg 再加尾部一片。
     */
    // 上限＝头部页 + 尾页各自最多跨两片。ogg 是这里的大头：解析器要读满 12 页
    // 才收手，尾部那 64KB 又可能骑在片边界上。
    const LIMIT = SLICE_CHUNK * 4
    const table: string[] = []

    for (const { path, name } of assets()) {
      const size = statSync(path).size
      const reader = fileReader(path)
      let fetched = 0
      const counting: SliceReader = async (offset, length) => {
        const b = await reader(offset, length)
        fetched += b.length
        return b
      }

      const ref: FileRef = { id: path, name, size, mtime: 0 }
      await readMetadataSliced(ref, counting)

      table.push(
        `  ${name.padEnd(42)} ${String(fetched).padStart(9)} / ${String(size).padStart(9)}` +
          `  ${(size / Math.max(fetched, 1)).toFixed(1)}x`,
      )
      expect(fetched, `${name} 取了 ${fetched} / ${size}`).toBeLessThanOrEqual(
        Math.min(size, LIMIT),
      )
    }
    console.log(["", "  取字节 / 文件大小：", ...table].join(String.fromCharCode(10)))
  })
})
