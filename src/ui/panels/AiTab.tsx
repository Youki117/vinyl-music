import { isConfigured } from "@/ai/config"
import { useAi } from "@/store/ai"
import { usePlayer } from "@/store/player"

const STAGE_TEXT: Record<string, string> = {
  text: "正在读歌词、构思画面…",
  image: "正在生成图片…（这一步通常 10–30 秒）",
  saving: "正在保存…",
}

/**
 * AI 配图设置。
 *
 * 默认关闭：不开这个开关，应用仍然全程离线、不发任何网络请求。
 */
export default function AiTab() {
  const ai = useAi()
  const track = usePlayer((s) => s.current())
  const ready = isConfigured(ai.config)
  const busy = ai.stage !== "idle"
  const hasArtwork = track ? Boolean(ai.artwork[track.id]) : false

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

        {ai.config.enabled && (
          <>
            <div className="setting-toggle-row compact">
              <div>
                <b>切歌时自动生成</b>
                <span>已有配图直接复用，不会重复产生费用</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={ai.config.auto}
                  onChange={(e) => ai.patch({ auto: e.target.checked })}
                />
                <span />
              </label>
            </div>
            <div className="ai-generate-actions">
              <button
                className="primary"
                disabled={!track || !ready || busy}
                onClick={() => track && void ai.generate(track)}
              >
                {hasArtwork ? "重新生成当前歌曲" : "为当前歌曲生成意境配图"}
              </button>
              {busy && (
                <button className="danger" onClick={() => ai.cancel()}>
                  取消
                </button>
              )}
            </div>
            {!ready && <p className="hint danger-text">接口地址、密钥和模型名填齐后才能生成。</p>}
            {!track && <p className="hint">先选一首歌。</p>}
            {busy && <p className="hint">{STAGE_TEXT[ai.stage]}</p>}
            {ai.error && <p className="hint danger-text">失败：{ai.error}</p>}
          </>
        )}
      </section>

      {ai.config.enabled && (
        <>
          <section className="panel-section">
            <div className="panel-title-row">
              <h3>风格后缀与画面提示词</h3>
            </div>
            <textarea
              className="style-suffix"
              value={ai.config.styleSuffix}
              onChange={(e) => ai.patch({ styleSuffix: e.target.value })}
              rows={6}
            />
            <p className="hint">
              追加到每次提示词末尾。其中“人物主体位于画面右侧、左侧留白”用于避开左侧蒙版。
            </p>
          </section>

          {ai.lastScene && (
            <section className="panel-section">
              <div className="panel-title-row">
                <h3>模型理解的画面意境</h3>
              </div>
              <p className="hint scene-text">{ai.lastScene}</p>
            </section>
          )}

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
