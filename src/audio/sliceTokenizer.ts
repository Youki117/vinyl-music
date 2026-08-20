import {
  AbstractTokenizer,
  EndOfStreamError,
  type IRandomAccessFileInfo,
  type IRandomAccessTokenizer,
  type IReadChunkOptions,
  type ITokenizerOptions,
} from "strtok3"

/**
 * 一次取多少字节。
 *
 * 太小则 IPC 往返次数上去了，太大则白读。256KB 一片，绝大多数格式的标签
 * （含内嵌封面）一片就装得下 —— 也就是一首歌一次往返。
 */
export const SLICE_CHUNK = 256 * 1024

/**
 * 单个文件最多取多少。超了就放弃切片、退回整读。
 *
 * 兜的是「VBR 且没有 Xing 头」的 mp3：music-metadata 拿不到帧数，只能一帧帧
 * 数到文件尾（MpegParser 的 calculateEofDuration）。这种文件极少 —— Xing 头
 * 存在的意义就是让人不必这么数 —— 但真碰上了，一片片切着读会比整读更慢。
 * 与其赌，不如超预算就认输回退：最坏情况等于今天的行为，多花一次头部读取。
 */
export const SLICE_BUDGET = 2 * 1024 * 1024

/** 取字节的实际动作。越过文件尾时返回实际能读到的部分。 */
export type SliceReader = (offset: number, length: number) => Promise<Uint8Array>

/** 预算用尽。调用方应改走整读。 */
export class SliceBudgetExceeded extends Error {
  constructor(fetched: number) {
    super(`切片预算用尽（已取 ${fetched} 字节）`)
    this.name = "SliceBudgetExceeded"
  }
}

/**
 * 按需取片的随机访问 tokenizer。
 *
 * 关键在于 `fileInfo.size` 报告的是**文件真实大小**，而不是手上有多少字节 ——
 * 这正是不能拿截断的 buffer 喂 parseBuffer 的原因（BufferTokenizer 会用
 * buffer.length 覆盖掉 size）。有了真实大小：
 *
 * - CBR mp3 在第 4 帧就能用文件大小算出时长并停止解析，只读几 KB；
 * - flac / wav / m4a 的时长都在头部结构里，一片即可。
 *
 * ogg 是例外：music-metadata 找最后一页靠的是从头顺序读到文件尾，帮不上忙，
 * 时长由 metadata.ts 的 readOggDuration 自己取尾部算（走 readRange 共用缓存）。
 */
export class SliceTokenizer extends AbstractTokenizer implements IRandomAccessTokenizer {
  fileInfo: IRandomAccessFileInfo

  private readonly chunks = new Map<number, Uint8Array>()
  private fetched = 0

  constructor(
    size: number,
    private readonly reader: SliceReader,
    options?: ITokenizerOptions,
  ) {
    super(options)
    this.fileInfo = { ...(options?.fileInfo ?? {}), size }
  }

  /** 实际过了多少字节 IPC。用于验证与埋点。 */
  get bytesFetched(): number {
    return this.fetched
  }

  supportsRandomAccess(): boolean {
    return true
  }

  setPosition(position: number): void {
    this.position = position
  }

  async readBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    // 与 BlobTokenizer 的差别：那边写的是 `if (options?.position)`，position 为 0
    // 时不生效。这里按 undefined 判，position=0 也能正确回到文件头。
    if (options?.position !== undefined) this.position = options.position
    const read = await this.peekBuffer(buffer, options)
    this.position += read
    return read
  }

  async peekBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const opts = this.normalizeOptions(buffer, options)
    const available = Math.max(0, this.fileInfo.size - opts.position)
    const want = Math.min(available, opts.length)
    if (!opts.mayBeLess && want < opts.length) throw new EndOfStreamError()
    if (want === 0) return 0

    let written = 0
    while (written < want) {
      const at = opts.position + written
      const index = Math.floor(at / SLICE_CHUNK)
      const chunk = await this.chunk(index)
      const inChunk = at - index * SLICE_CHUNK
      const n = Math.min(want - written, chunk.length - inChunk)
      // 文件在解析途中被改短了。已经拿到的照常交出去，剩下的交给上层判断
      if (n <= 0) break
      buffer.set(chunk.subarray(inChunk, inChunk + n), written)
      written += n
    }
    return written
  }

  /**
   * 取任意一段，与解析共用同一份分片缓存。
   *
   * ogg 求时长要读尾部，走这条而不是直接调 reader：小文件的头部那一片往往已经
   * 把整个文件都覆盖了，再单独取一次尾部就是白读一遍。
   */
  async readRange(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(offset + length, this.fileInfo.size)
    if (end <= offset) return new Uint8Array(0)

    const out = new Uint8Array(end - offset)
    let written = 0
    while (written < out.length) {
      const at = offset + written
      const index = Math.floor(at / SLICE_CHUNK)
      const chunk = await this.chunk(index)
      const inChunk = at - index * SLICE_CHUNK
      const n = Math.min(out.length - written, chunk.length - inChunk)
      if (n <= 0) break
      out.set(chunk.subarray(inChunk, inChunk + n), written)
      written += n
    }
    return written === out.length ? out : out.subarray(0, written)
  }

  private async chunk(index: number): Promise<Uint8Array> {
    const hit = this.chunks.get(index)
    if (hit) return hit

    if (this.fetched >= SLICE_BUDGET) throw new SliceBudgetExceeded(this.fetched)

    const start = index * SLICE_CHUNK
    const bytes = await this.reader(start, Math.min(SLICE_CHUNK, this.fileInfo.size - start))
    this.fetched += bytes.length
    this.chunks.set(index, bytes)
    return bytes
  }
}
