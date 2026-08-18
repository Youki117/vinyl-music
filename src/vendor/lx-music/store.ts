/**
 * musicSdk/api-source.js 依赖的两个 store 字段。**垫片，不是上游代码。**
 *
 * 这是整套东西最关键的接缝，值得写清楚：
 *
 * 上游 api-source.js 里 `allApi` 是**空对象**（内置音源全部被注释掉），所以
 * `apis(source)` 只有在 `apiSource.value` 以 `user_api` 开头时才返回东西 ——
 * 也就是**必须由用户导入音源脚本，才能解析出播放地址**。洛雪本身就是这个行为，
 * 不是我们缺了什么。
 *
 * 于是 `userApi.apis` 就是音源脚本注册进来的地方，形状：
 *   { [平台id]: { getMusicUrl(songInfo, quality) → Promise<{url}> } }
 *
 * 搜索、歌词、歌单、排行榜**不走这条路**，是 musicSdk 自带的，没有音源脚本也能用。
 */
export interface SourceApi {
  getMusicUrl: (songInfo: unknown, quality: string) => Promise<{ url: string }> | { url: string }
}

/** 当前音源。`user_api` 前缀表示用用户导入的脚本；其它值会让 apis() 抛 'Api is not found' */
export const apiSource = { value: "user_api" }

export const userApi: { apis: Record<string, SourceApi | undefined> } = { apis: {} }

/** 音源脚本注册入口，由 src/source/ 的运行时调用 */
export const registerUserApi = (source: string, api: SourceApi): void => {
  userApi.apis[source] = api
}

export const clearUserApi = (): void => {
  for (const k of Object.keys(userApi.apis)) delete userApi.apis[k]
}

/** 有没有可用的音源脚本 —— 界面据此提示「导入音源后才能播放」 */
export const hasUserApi = (): boolean => Object.keys(userApi.apis).length > 0
