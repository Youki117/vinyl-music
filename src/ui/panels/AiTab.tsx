import { useEffect, useState } from "react"

import { configWarning, isConfigured } from "@/ai/config"
import {
  MAX_ARTWORK_BUDGET,
  MIN_ARTWORK_BUDGET,
  artworkForTrack,
  formatBytes,
  totalBytes,
} from "@/ai/artworkStore"
import { useAi } from "@/store/ai"
import { usePlayer } from "@/store/player"
import { useSkin } from "@/store/skin"

const STAGE_TEXT: Record<string, string> = {
  text: "正在读歌词、构思画面…",
  image: "正在生成图片…（这一步通常 10–30 秒）",
  saving: "正在保存…",
}

/**
 * AI 配图设置。
 *
 * 功能模型（见 artworkStore 顶部）：底图只有一个"基础"槽，歌曲专属图只在那首歌
 * 播放时临时盖上去。所以这一页分三块 —— 定基础的、给当前这首歌配的、以及回头
 * 翻查全部生成过的图库。
 *
 * 默认关闭：不开这个开关，应用仍然全程离线、不发起任何网络请求。
 */
export default function AiTab() {
  const ai = useAi()
  const track = usePlayer((s) => s.current())
  const baseBackdrop = useSkin((s) => s.skin.backdrop)
  const [prompt, setPrompt] = useState("")

  const ready = isConfigured(ai.config)
  const busy = ai.stage !== "idle"
  const warning = configWarning(ai.config)
  const used = totalBytes(ai.artwork)
  // 大小未知的那些（旧版本迁移来的）不计入已用。如实说明，免得用户拿这个数字
  // 去对文件夹属性时对不上
  const unsized = ai.artwork.filter((item) => item.bytes === 0).length
  const forTrack = track ? artworkForTrack(ai.artwork, ai.pinned, track.id) : null

  // 迁移来的旧条目没有缩略图，第一次打开这一页时按原图补上
  useEffect(() => {
    if (ai.config.enabled) void useAi.getState().ensureThumbnails()
  }, [ai.config.enabled])

  return (
    <>
      <section className="panel-section">
        <div className="setting-toggle-row">
          <div>
            <b>启用 AI 意境配图</b>
            <span>关闭时全程离线，不发起任何网络请求</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={ai.config.enabled}
              onChange={(e) => ai.patch({ enabled: e.target.checked })}
            />
            <span />
          </label>
        </div>
        {!ready && ai.config.enabled && (
          <p className="hint danger-text">接口地址、密钥和模型名填齐后才能生成。</p>
        )}
        {warning && <p className="hint danger-text">{warning}</p>}
        {busy && <p className="hint">{STAGE_TEXT[ai.stage]}</p>}
        {ai.error && <p className="hint danger-text">失败：{ai.error}</p>}
      </section>

      {ai.config.enabled && (
        <>
          {/*
            基础底图：整个应用平时用的那张。自己写一句想要的画面，跳过文本模型
            直接出图 —— 少一次调用就少一笔钱，用户自己写本来也不需要"歌词转画面"。
          */}
          <section className="panel-section">
            <div className="panel-title-row">
              <h3>基础底图</h3>
              <span>平时显示的那张</span>
            </div>
            <textarea
              className="style-suffix"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="写一句你想要的画面，例如：黄昏的海边公路，一辆旧车停在路肩"
              rows={3}
            />
            <div className="ai-generate-actions">
              <button
                className="primary"
                disabled={!ready || busy || !prompt.trim()}
                onClick={() => void ai.generateGlobal(prompt)}
                title="按这句话生成，并设为基础底图"
              >
                {ai.generatingFor === "custom" ? "生成中…" : "生成并设为基础底图"}
              </button>
              {busy && (
                <button className="danger" onClick={() => ai.cancel()}>
                  取消
                </button>
              )}
            </div>
            <p className="hint">
              不读歌词，直接按这句话出图，比走歌词那条少一次模型调用。
              在「底图」页手动选图同样会成为基础底图。
            </p>
          </section>

          {/*
            歌曲专属图：只在这首歌播放时临时盖住基础底图，切走就回来。
          */}
          <section className="panel-section">
            <div className="panel-title-row">
              <h3>当前歌曲专属图</h3>
              <span>{track ? track.title : "没有在放的歌"}</span>
            </div>
            {forTrack ? (
              <div className="artwork-current">
                {forTrack.thumbnail ? (
                  <img src={forTrack.thumbnail} alt="当前歌曲的专属配图" />
                ) : (
                  <div className="artwork-thumb-empty" aria-hidden="true" />
                )}
                <div>
                  <b>已有专属图</b>
                  <span>
                    这首歌名下共 {ai.artwork.filter(
                      (a) => a.origin.kind === "song" && a.origin.trackId === track?.id,
                    ).length} 张，正在用的是
                    {ai.pinned[track?.id ?? ""] ? "你指定的那张" : "最新的一张"}
                  </span>
                </div>
              </div>
            ) : (
              <p className="hint">这首歌还没有专属图，现在显示的是基础底图。</p>
            )}
            <div className="ai-generate-actions">
              <button
                disabled={!track || !ready || busy}
                onClick={() => track && void ai.generateForTrack(track)}
                title="读这首歌的歌词构思画面，生成一张只属于它的图"
              >
                {forTrack ? "再生成一张" : "为这首歌生成"}
              </button>
            </div>
            {ai.lastScene && <p className="hint scene-text">{ai.lastScene}</p>}
          </section>

          {/* 图库：回头翻查、用回旧图、删掉不要的 */}
          <section className="panel-section">
            <div className="panel-title-row">
              <h3>AI 图库</h3>
              <span>
                {ai.artwork.length} 张 · {formatBytes(used)} / {formatBytes(ai.budgetBytes)}
              </span>
            </div>
            <div className="artwork-meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (used / ai.budgetBytes) * 100)}%` }} />
            </div>

            {ai.artwork.length === 0 ? (
              <p className="hint">还没有生成过图片。</p>
            ) : (
              <ul className="artwork-gallery">
                {ai.artwork.map((item) => {
                  const isBase = item.path === baseBackdrop
                  const isPinned = track ? ai.pinned[track.id] === item.id : false
                  return (
                    <li key={item.id} data-on={isBase}>
                      {item.thumbnail ? (
                        <img src={item.thumbnail} alt="" />
                      ) : (
                        <div className="artwork-thumb-empty" aria-hidden="true" />
                      )}
                      <div className="artwork-meta">
                        <b>
                          {item.origin.kind === "custom"
                            ? "自定义提示词"
                            : item.origin.title || "（曲目已不在库中）"}
                        </b>
                        <span title={item.prompt || undefined}>
                          {item.scene || item.prompt || "（这张没有留下提示词）"}
                        </span>
                        <em>
                          {new Date(item.createdAt).toLocaleString("zh-CN", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {item.bytes > 0 ? ` · ${formatBytes(item.bytes)}` : ""}
                          {isBase ? " · 基础底图" : ""}
                        </em>
                      </div>
                      <div className="artwork-actions">
                        <button
                          disabled={isBase}
                          onClick={() => void ai.useAsBase(item.id)}
                          title="设为平时显示的基础底图"
                        >
                          设为底图
                        </button>
                        <button
                          disabled={!track}
                          data-on={isPinned}
                          onClick={() =>
                            track && ai.pinToTrack(track.id, isPinned ? null : item.id)
                          }
                          title={
                            isPinned
                              ? "取消指定，回到用最新的一张"
                              : "让当前这首歌固定用这张，而不是最新的那张"
                          }
                        >
                          {isPinned ? "已指定" : "指定给本曲"}
                        </button>
                        <button
                          className="danger"
                          onClick={() => void ai.removeArtwork(item.id)}
                          title="删除这张图片文件"
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <label className="row-field">
              <span>磁盘上限</span>
              <input
                type="range"
                min={MIN_ARTWORK_BUDGET}
                max={MAX_ARTWORK_BUDGET}
                step={100 * 1024 * 1024}
                value={ai.budgetBytes}
                onChange={(e) => ai.setBudget(Number(e.target.value))}
                aria-label={`磁盘上限 ${formatBytes(ai.budgetBytes)}`}
              />
            </label>
            <p className="hint">
              超过上限时从最久没用到的开始删；正在用的那张和基础底图永远保留。
              {unsized > 0 && ` 另有 ${unsized} 张是旧版本留下的，没记大小，重新生成后才会计入。`}
            </p>
            <div className="ai-generate-actions">
              <button
                className="danger"
                disabled={ai.artwork.length === 0}
                onClick={() => void ai.clearArtwork()}
                title="删掉全部已生成的配图文件"
              >
                清空全部（{ai.artwork.length}）
              </button>
            </div>
          </section>

          <section className="panel-section">
            <div className="panel-title-row">
              <h3>风格后缀</h3>
            </div>
            <textarea
              className="style-suffix"
              value={ai.config.styleSuffix}
              onChange={(e) => ai.patch({ styleSuffix: e.target.value })}
              rows={6}
            />
            <p className="hint">
              追加到每次提示词末尾，自定义提示词那条也会拼上。
              其中“人物主体位于画面右侧、左侧留白”用于避开左侧蒙版，不是审美偏好。
            </p>
          </section>

          <section className="panel-section ai-config-section">
            <div className="panel-title-row">
              <h3>API 接口与模型配置</h3>
              <span>OpenAI 兼容格式</span>
            </div>
            <p className="section-title">文本模型（读取歌词构思画面）</p>
            <label className="row-field">
              <span>接口地址</span>
              <input
                value={ai.config.textBaseUrl}
                onChange={(e) => ai.patch({ textBaseUrl: e.target.value })}
                placeholder="https://api.deepseek.com/v1"
              />
            </label>
            <label className="row-field">
              <span>密钥</span>
              <input
                type="password"
                value={ai.config.textApiKey}
                onChange={(e) => ai.patch({ textApiKey: e.target.value })}
                placeholder="sk-…"
              />
            </label>
            <label className="row-field">
              <span>模型名</span>
              <input
                value={ai.config.textModel}
                onChange={(e) => ai.patch({ textModel: e.target.value })}
                placeholder="deepseek-chat"
              />
            </label>

            <p className="section-title">生图模型</p>
            <label className="row-field">
              <span>接口地址</span>
              <input
                value={ai.config.imageBaseUrl}
                onChange={(e) => ai.patch({ imageBaseUrl: e.target.value })}
                placeholder="留空则复用文本模型地址"
              />
            </label>
            <label className="row-field">
              <span>密钥</span>
              <input
                type="password"
                value={ai.config.imageApiKey}
                onChange={(e) => ai.patch({ imageApiKey: e.target.value })}
                placeholder="留空则复用文本模型密钥"
              />
            </label>
            <label className="row-field">
              <span>模型名</span>
              <input
                value={ai.config.imageModel}
                onChange={(e) => ai.patch({ imageModel: e.target.value })}
                placeholder="例如 cogview-3 / dall-e-3"
              />
            </label>
            <label className="row-field">
              <span>尺寸</span>
              <input
                value={ai.config.imageSize}
                onChange={(e) => ai.patch({ imageSize: e.target.value })}
                placeholder="1792x1024"
              />
            </label>
            <p className="hint">
              密钥会以明文保存在本机配置文件中，请只填写你愿意这样存放的密钥。
            </p>
          </section>
        </>
      )}
    </>
  )
}
