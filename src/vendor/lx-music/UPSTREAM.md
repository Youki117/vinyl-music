# 上游来源

本目录是 **lx-music-desktop 的 `src/renderer/utils/musicSdk`**，原样引入，未改动业务逻辑。

| | |
| --- | --- |
| 上游仓库 | https://github.com/lyswhut/lx-music-desktop |
| 许可证 | Apache-2.0（见同目录 LICENSE） |
| 同步自 commit | `9c364b482e5621a1d38b50e8610d2fb974457e6e` |
| 提交时间 | 2026-05-01T05:12:19Z |
| 引入时间 | 2026-08-18T06:54:38Z |

## 为什么整个搬而不是自己写

平台接口会变（签名算法、加密参数、字段名），上游一直在跟。原样引入之后，
上游更新时只要重新拉一份对 diff 就能同步，不用自己维护一套逆向实现。
**所以这个目录的原则是：不要改。** 需要适配的地方一律放在 `src/source/` 的垫片层。

## 同步方法

```
node scripts/sync-lx-sdk.mjs        # 拉上游最新，与本目录对 diff
```

## 已知的改动点

引入时**没有**修改任何文件。垫片层需要提供以下模块（原代码 import 的外部依赖）：

- `../../request` → `httpFetch`
- `../../index` → `formatPlayTime` / `sizeFormate` / `decodeName`
- `@common/ipcNames` / `@common/rendererIpc` → 仅 tx/lyric.js 用到
- `@renderer/store` → 仅 api-source.js 用到（`apiSource` / `userApi`）

## 重要：这里**没有**播放地址解析

上游的 `api-source.js` 里 `allApi` 是空对象，内置音源全部被注释掉了。
`getMusicUrl` 依赖用户自行导入的音源脚本（`user_api`）。搜索、歌词、歌单、
排行榜是自带的，能直接用；**播放地址必须由用户提供的音源脚本解析**，与洛雪本身的行为一致。
