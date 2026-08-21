import { formatTime } from "@/lib/format"
import { useLibrary } from "@/store/library"
import { SOURCES, useOnline, type SourceId } from "@/store/online"
import { usePlayer } from "@/store/player"

type ImportResult = {
  id: string
  name: string
  count: number
}

/**
 * 平台歌单导入视图。
 *
 * 解析状态仍由 online store 持有，视图只负责呈现，因此从在线页迁到曲库后不会出现
 * 两套请求与导入逻辑。导入完成由父面板决定是否切回新歌单。
 */
export default function PlaylistImport({ onImported }: { onImported: (result: ImportResult) => void }) {
  const listInput = useOnline((s) => s.listInput)
  const listSource = useOnline((s) => s.listSource)
  const listStatus = useOnline((s) => s.listStatus)
  const listError = useOnline((s) => s.listError)
  const preview = useOnline((s) => s.preview)
  const { setListInput, setListSource, fetchList, importList } = useOnline.getState()

  const libTracks = useLibrary((s) => s.tracks)
  const currentId = usePlayer((s) => s.current()?.id ?? null)
  const playFrom = usePlayer((s) => s.playFrom)

  const inLibrary = new Set(libTracks.map((track) => track.id))

  const playPreview = (index = 0) => {
    if (!preview || preview.tracks.length === 0) return
    void playFrom(preview.tracks, index)
  }

  const doImport = () => {
    if (!preview) return
    const id = importList()
    if (!id) return
    onImported({ id, name: preview.name || "导入的歌单", count: preview.tracks.length })
  }

  return (
    <div className="playlist-import-view">
      <section className="panel-section playlist-import-form">
        <div className="online-bar">
          <input
            value={listInput}
            autoFocus
            onChange={(event) => setListInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void fetchList()
            }}
            placeholder="贴歌单分享链接、分享文案或歌单 ID"
            aria-label="歌单链接、分享文案或歌单 ID"
          />
          <select
            value={listSource ?? ""}
            onChange={(event) => setListSource((event.target.value || null) as SourceId | null)}
            aria-label="歌单所属平台"
            title="粘贴分享链接时保留自动即可；输入纯 ID 时请选择平台"
          >
            <option value="">自动</option>
            {SOURCES.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
          <button onClick={() => void fetchList()} disabled={listStatus === "loading"}>
            {listStatus === "loading" ? "解析中…" : "解析"}
          </button>
        </div>

        <p className="online-tip">
          支持公开的 QQ 音乐、网易云音乐等平台歌单。输入纯 ID 时需要先选择所属平台。
        </p>
      </section>

      {listStatus === "error" && listError && <p className="lib-note online-error">{listError}</p>}

      {preview && (
        <div className="online-preview">
          <b>{preview.name || "（这个歌单没有名字）"}</b>
          <span>
            {preview.tracks.length} 首
            {preview.total > preview.tracks.length ? ` / 平台显示 ${preview.total} 首` : ""}
          </span>
          <span className="online-preview-actions">
            <button className="primary" onClick={() => playPreview()}>
              播放全部
            </button>
            <button onClick={doImport}>导入为歌单</button>
          </span>
        </div>
      )}

      <ol>
        {preview?.tracks.map((track, index) => (
          <li key={track.id} data-active={track.id === currentId}>
            <button
              className="row"
              onDoubleClick={() => playPreview(index)}
              data-tooltip="双击从这里播放整张歌单"
            >
              <span className="song-index">{String(index + 1).padStart(2, "0")}</span>
              <b>{track.title}</b>
              <span>{track.artist}</span>
              {inLibrary.has(track.id) && <i title="已在曲库">库</i>}
              <em>{track.duration > 0 ? formatTime(track.duration) : "--:--"}</em>
            </button>
          </li>
        ))}
        {listStatus === "loading" && <li className="drawer-empty">正在解析歌单…</li>}
        {!preview && listStatus !== "loading" && (
          <li className="drawer-empty">解析后可先预览，也可以直接播放整张歌单或导入曲库</li>
        )}
      </ol>
    </div>
  )
}
