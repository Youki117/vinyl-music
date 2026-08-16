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
      <label className="row-field">
        <span>启用</span>
        <input
          type="checkbox"
          checked={ai.config.enabled}
          onChange={(e) => ai.patch({ enabled: e.target.checked })}
        />
      </label>
      <p className="hint">
        关闭时应用不发起任何网络请求。开启后仅在你点击生成（或勾了自动）时才联网。
      </p>

      {ai.config.enabled && (
        <>
          <p className="section-title">文本模型（把歌词总结成画面）</p>
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
              placeholder="留空则复用上面的地址"
            />
          </label>
          <label className="row-field">
            <span>密钥</span>
            <input
              type="password"
              value={ai.config.imageApiKey}
              onChange={(e) => ai.patch({ imageApiKey: e.target.value })}
              placeholder="留空则复用上面的密钥"
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
            两个接口都按 OpenAI 兼容格式调用（<code>/chat/completions</code> 与{" "}
            <code>/images/generations</code>），DeepSeek、智谱、月之暗面、通义、本地 Ollama
            都能填。密钥以明文存在本机配置文件里，请只填你愿意这样存放的密钥。
          </p>

          <p className="section-title">生成</p>
          <label className="row-field">
            <span>自动生成</span>
            <input
              type="checkbox"
              checked={ai.config.auto}
              onChange={(e) => ai.patch({ auto: e.target.checked })}
            />
          </label>
          <p className="hint">
            开启后，切到还没有配图的曲目时会在后台生成，不影响播放。已生成过的会直接复用，不重复花钱。
          </p>

          <div className="chip-row">
            <button
              disabled={!track || !ready || busy}
              onClick={() => track && void ai.generate(track)}
            >
              {hasArtwork ? "重新生成这首" : "为这首歌生成配图"}
            </button>
            {busy && (
              <button className="danger" onClick={() => ai.cancel()}>
                取消
              </button>
            )}
          </div>

          {!ready && <p className="hint danger-text">接口地址、密钥、模型名填齐后才能生成。</p>}
          {!track && <p className="hint">先选一首歌。</p>}
          {busy && <p className="hint">{STAGE_TEXT[ai.stage]}</p>}
          {ai.error && <p className="hint danger-text">失败：{ai.error}</p>}
          {ai.lastScene && (
            <>
              <p className="section-title">模型理解的画面</p>
              <p className="hint scene-text">{ai.lastScene}</p>
            </>
          )}

          <p className="section-title">风格后缀</p>
          <textarea
            className="style-suffix"
            value={ai.config.styleSuffix}
            onChange={(e) => ai.patch({ styleSuffix: e.target.value })}
            rows={4}
          />
          <p className="hint">
            追加到每次提示词末尾，保证生成的图看起来像同一套。
            其中「人物主体位于画面右侧、左侧留白」是硬要求：画面左边要压白色蒙版，主体画在左边会被盖住。
          </p>
        </>
      )}
    </>
  )
}
