/**
 * AI 配图的配置。
 *
 * 默认关闭。不开这个开关，应用仍然全程离线、不发任何网络请求——这是 PRD §7
 * 的承诺，不能因为多了个可选功能就悄悄作废。
 *
 * API Key 以明文存在本机的应用数据目录里（和其他配置一样）。这不是安全存储，
 * 面板上会明示；请只填你愿意以明文放在自己电脑上的 Key。
 */
export type AiConfig = {
  enabled: boolean

  /** OpenAI 兼容的文本接口，例如 https://api.deepseek.com/v1 */
  textBaseUrl: string
  textApiKey: string
  textModel: string

  /** OpenAI 兼容的图像接口。多数服务与文本同域，留空则复用上面的 */
  imageBaseUrl: string
  imageApiKey: string
  imageModel: string
  imageSize: string

  /**
   * 追加到提示词末尾的固定风格描述。
   *
   * 自定义提示词那条路也会拼上它 —— 「主体偏右、左侧留白」是硬要求，不是审美偏好。
   */
  styleSuffix: string
}

/**
 * 风格后缀里「主体偏右、左侧留白」这条是硬要求，不是审美偏好：
 * 画面左侧要压一层白色蒙版，主体画在左边会被盖掉。
 */
export const DEFAULT_STYLE_SUFFIX =
  "电影感人像摄影，柔和自然光，浅景深，故事感，胶片质感；" +
  "人物主体位于画面右侧三分之一处，左侧留出大面积简洁背景；" +
  "16:9 横构图，不要文字，不要水印，不要边框"

export const DEFAULT_AI: AiConfig = {
  enabled: false,
  textBaseUrl: "https://api.deepseek.com/v1",
  textApiKey: "",
  textModel: "deepseek-chat",
  imageBaseUrl: "",
  imageApiKey: "",
  imageModel: "",
  imageSize: "1792x1024",
  styleSuffix: DEFAULT_STYLE_SUFFIX,
}

/** 图像接口没单独填时，复用文本那套配置。 */
export function resolveImageEndpoint(cfg: AiConfig): { baseUrl: string; apiKey: string } {
  return {
    baseUrl: (cfg.imageBaseUrl || cfg.textBaseUrl).replace(/\/+$/, ""),
    apiKey: cfg.imageApiKey || cfg.textApiKey,
  }
}

export function resolveTextEndpoint(cfg: AiConfig): { baseUrl: string; apiKey: string } {
  return { baseUrl: cfg.textBaseUrl.replace(/\/+$/, ""), apiKey: cfg.textApiKey }
}

/** 配置是否足以发起一次生成。 */
export function isConfigured(cfg: AiConfig): boolean {
  const t = resolveTextEndpoint(cfg)
  const i = resolveImageEndpoint(cfg)
  return Boolean(cfg.enabled && t.baseUrl && t.apiKey && cfg.textModel && i.baseUrl && cfg.imageModel)
}

/** 只提供对话接口、没有 /images/generations 的服务商 */
const TEXT_ONLY_HOSTS = [/(^|\.)deepseek\.com$/i, /(^|\.)moonshot\.cn$/i, /(^|\.)anthropic\.com$/i]

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

/**
 * 配置填得通、但注定跑不完的组合。
 *
 * 最常撞的一种：只填了文本接口，而图像接口留空会回落到文本那套
 * （见 resolveImageEndpoint）—— 于是把 /images/generations 发给一个根本没有
 * 生图能力的服务商，必然 404。这事等生成到第二步才报错太晚了：第一步的文本
 * 调用已经花掉了钱。
 */
export function configWarning(cfg: AiConfig): string | null {
  if (!cfg.enabled) return null

  const imageHost = hostOf(resolveImageEndpoint(cfg).baseUrl)
  if (imageHost && TEXT_ONLY_HOSTS.some((re) => re.test(imageHost))) {
    return `${imageHost} 只提供对话接口，没有生图接口。请在下面单独填一个支持 /images/generations 的图像接口地址，否则生成会在第二步失败`
  }
  return null
}
