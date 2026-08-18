/**
 * dns 的空实现。**垫片，不是上游代码。**
 *
 * musicSdk/utils.js 里的 getHostIp / dnsLookup 用它把域名预解析成 IP，再交给请求库
 * 做 IP 直连（上游用 needle，能指定 lookup）。我们的请求走 Rust 侧的 plugin-http，
 * 域名解析在 Rust 那边做，这层没有意义；浏览器环境也根本没有 dns 模块。
 *
 * 回调里返回错误而不是假地址：上游的 getHostIp 拿到 err 只会 console.log 然后跳过，
 * 走正常的域名请求路径 —— 这正是我们想要的行为。
 */
type LookupCallback = (err: Error | null, address?: string, family?: number) => void

const lookup = (
  _hostname: string,
  optionsOrCallback: unknown,
  maybeCallback?: LookupCallback,
): void => {
  const cb = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as
    | LookupCallback
    | undefined
  cb?.(new Error("dns lookup 在本环境不可用（走 Rust 侧解析）"))
}

export default { lookup }
export { lookup }
