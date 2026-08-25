import { platform } from "@/platform"

/**
 * 各 store 共用的防抖落盘器。
 *
 * 六个 store 原本各自手写同一段「clearTimeout → setTimeout → writeConfig」，
 * 连延时长短都各自漂移过。现在每个 store 只声明存什么（build）与多久后存
 * （delay），写盘时机由这一处统一持有。
 */
export function createConfigSaver<T>(name: string, build: () => T, delay = 1000): () => void {
  let timer = 0
  return () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      void platform.writeConfig(name, build())
    }, delay)
  }
}
