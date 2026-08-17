# Vinyl Player 技术设计文档

| 项 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 日期 | 2026-08-15 |
| 对应 PRD | [PRD.md](./PRD.md) v1.0 |
| 目标平台 | Windows 10 1809+ / Windows 11，x64 |

本文档只回答"怎么做"。功能"做什么"以 PRD 为准，冲突时以 PRD 为准。

---

## 1. 技术选型

### 1.1 结论

| 层 | 选型 | 版本（2026-08 实测） |
| --- | --- | --- |
| 桌面外壳 | **Tauri v2** | `tauri 2.11.5` |
| 渲染引擎 | 系统 WebView2 | 本机已装 `151.0.4129.78` |
| 前端框架 | React 19 + TypeScript | `react 19.2.8` |
| 构建 | Vite 8 | `vite 8.2.1` |
| 状态管理 | Zustand | `zustand 5.0.15` |
| 样式 | 原生 CSS + CSS 变量 | 无框架 |
| 音频播放 | `HTMLAudioElement` + Web Audio API | 浏览器内置 |
| 蒙版渲染 | 裸 WebGL2 全屏着色器 | 无库 |
| 元数据 | music-metadata | `11.14.0`（MIT） |
| 单元测试 | Vitest | 最新 |

### 1.2 为什么是 Tauri 而不是 Electron

| | Tauri v2 | Electron 43 |
| --- | --- | --- |
| 安装包 | **2.44MB 实测** | 90–150MB |
| 常驻内存 | 空闲 279MB 实测 | 同量级，见下 |
| 渲染内核 | 系统 WebView2（本机已装） | 自带 Chromium |
| 一次性环境成本 | **需装 Rust + VS C++ 生成工具（约 3–5GB）** | 无 |

PRD §7 定的安装包 < 20MB 用 Electron 直接出局，这一条成立。环境成本是一次性的，已确认接受。

**但内存这一行原来写的 "~60MB vs ~150MB+" 是错的，别再拿它说事。** 两边跑的是同一个
Chromium 多进程模型，内存量级本来就一样 —— Tauri 只是不把 Chromium 打进安装包，
不是不运行 Chromium。实测这台机器上一个空白页整棵进程树就要 323MB
（`scripts/perf/dbg-floor.mjs`）；洛雪音乐作者自报他机器上常态 360MB、峰值四五百
（[lx-music-desktop#598](https://github.com/lyswhut/lx-music-desktop/issues/598)），
和我们同一个区间。选 Tauri 换来的是**安装包**和**不用维护自带 Chromium**，
换不来更低的运行内存。

由于 Tauri 在 Windows 上用的就是 Chromium 内核的 WebView2，**渲染能力与 Electron 完全一致**——WebGL2、Web Audio、CSS 滤镜全部可用，视觉方案不受外壳选择影响。

#### WebView2 启动参数

`tauri.conf.json` 的 `additionalBrowserArgs` 是纯 JSON，塞不进注释，所以记在这里。
当前值：

```
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService
```

| 参数 | 为什么 |
| --- | --- |
| `msWebOOUI,msPdfOOUI,msSmartScreenProtection` | wry 的默认值。**这个字段是整体替换而不是追加**，不带上就等于把默认值删了 |
| `MediaSessionService` | 不关的话 Chromium 会为 `<audio>` 自己注册一个媒体会话，Windows 媒体面板上出现两个"正在播放" |

> 关于 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量：它会**整体覆盖**上面这一串，
> 不是合并。调试脚本用它开远程调试端口时必须把需要的参数一起写全，否则测的就不是
> 装机版的真实配置。

#### 实测过但**没有采用**的两个省内存参数

留档，免得以后有人重新试一遍。实测数据来自 `scripts/perf/dbg-flags.mjs`（空闲 → 连播 9 首）：

| 参数 | 效果 | 为什么不用 |
| --- | --- | --- |
| `--in-process-gpu` | 空闲 392 → **281MB** | 显卡驱动一崩就带着整个应用退出，而不是只崩 GPU 进程再自动重启；GPU 沙箱也没了。省下的内存换不来这个稳定性风险 |
| `--js-flags=--max-old-space-size=192` | 峰值 810 → **647MB** | 上限压在观测到的堆峰值（269MB）之下，靠的是"那些几乎全是垃圾"这个前提。曲库更大、live 数据更多时会不会 OOM 崩渲染器，没有把握 |
| 两个一起 | **279 → 463MB**（降 29% / 43%） | |

结论：**这两个都是拿稳定性换内存，不是白捡的优化。** 真要用，先补一轮长跑
（大曲库 + 连播数小时）证明不会崩，再开。

V8 那条还有个反直觉的观察值得记住：**在正常分配速率下，峰值由 GC 的回收阈值决定，
不由分配量决定。** 把波形解码从 90MB 降到 16MB（`src/audio/peaks.ts` 的 `DECODE_RATE`），
观测到的峰值一点没动 —— 32GB 机器上 V8 根本还没到想回收的时候。

> **这条后来被自己的数据修正过，别当成无条件成立。** 原文写的是"峰值由回收阈值决定，
> 不由分配量决定"，没有前半句限定。后来把导入并发从 1 提到 4，峰值从 868MB 冲到
> **4253MB** —— 分配**速率**足够高时回收器就是跟不上，这时候分配量直接决定峰值。
> 详见下面 1.2.1。

#### 1.2.1 资源分布，以及蒙版到底占多少

`scripts/perf/dbg-breakdown.mjs` 冷启动装机版，按进程类型拆开量（窗口 1052×710，空闲态）。
第三档用 `--disable-webgl` 让 `VeilRenderer.create` 拿不到上下文，应用自己走 CSS 降级路径，
② 与 ③ 的差就是"选用 WebGL 画蒙版"的真实代价：

| | 合计 | GPU 进程 | 渲染器 | 空闲 CPU |
| --- | --- | --- | --- | --- |
| ① 空白页（Chromium 地板） | 200MB | 89MB | 36MB | 2.0% |
| ② 装机版·WebGL 蒙版 | 338MB | 181MB | 68MB | **10.5%** |
| ③ 装机版·CSS 降级蒙版 | 344MB | 181MB | 73MB | **1.4%** |

**结论和直觉完全相反：蒙版的内存成本是 0（②③ 差 −6MB，在噪声里；GPU 进程两边都是
181MB，一分不差）。它的代价全在 CPU —— 空闲态就吃掉 9.2 个百分点。**

孤立基准曾经给出"全屏 WebGL 画布比空白页多 215MB"，那个数把整套 GPU/ANGLE 基础设施
都算到了画布头上；真实应用里底图、颗粒、内容本来就要合成，那套设施早就在了，蒙版
只是往已有的纹理池里再放一张。**这是同一个教训第三次出现：孤立基准会把"第一个用户
承担的公共成本"错记成"这个功能的成本"。**

由此也说明优化方向定错过：之前花力气压蒙版的分辨率（省下 11MB），而真正该盯的是
它的重绘频率。空闲 9.2% CPU 是在 12fps 档测的（`Veil.tsx` 按播放状态降档），
播放时 60fps 只会更高。要再省，往帧率和着色器复杂度上使劲，不要再动分辨率。

#### 1.2.2 导入大曲库：实测与取舍

基准脚本：`scripts/perf/gen-library.mjs` 造合成曲库（真 MP3、真 ID3v2、真 PNG 内嵌封面，
每首约 0.6MB），`scripts/perf/dbg-library.mjs` 在**装机版**里通过应用自己的
`player://open-files` 通道触发导入，量整棵进程树的 Private Bytes。

导入 1000 首的并发上限对比：

| 并发 | 耗时 | 峰值内存 |
| --- | --- | --- |
| 1（原实现） | 72.4s | 868MB |
| **2（当前）** | **50.2s** | **701MB** |
| 4 | 38.3s | 4253MB |

取 2 不是折中，是它**两项都优于串行**。4 那档快 24% 却让峰值涨六倍：事后强制回收能
回落到 844MB，说明是垃圾不是泄漏，但内存小的机器上峰值就是会当场把人崩掉。

根因不在并发，在**为了解标签把整个文件读进来**：一首 0.6MB 的歌产生的临时垃圾远大于
0.6MB（过一次 IPC、再 `parseBlob` 一次）。治本是 `platform.readSlice(ref, start, end)`，
元数据只读头部数 MB（OGG/Opus 的时长在尾部，补读 256KB），失败再回退全量。
**没做是因为有正确性风险**：music-metadata 靠 blob 大小算 CBR 时长，喂截断的字节会
直接算错时长，必须把真实文件大小另行传进去并对每种容器验证。这是个该独立做、独立
验的改动，不适合塞在一批优化里顺手带过。

顺带两条实测结论：

- **导入时物化封面是最大的一笔常驻内存。** 旧实现给每首歌的内嵌封面建 object URL，
  但全项目只有 Disc 显示封面、且只显示当前播放那一首。在真实应用进程里量同等数量的
  blob，1000 首约 **+280 ~ +520MB**（四次运行波动很大，但都是几百 MB 量级）。现已改为
  首播时由 `library.ensureCover` 懒解 —— 这条路径本来就存在：曲库落盘不存封面，
  所以**重启之后一直是这个行为**。
- **"面板开着导入会 O(n²)"没有复现。** 面板开着 76.9s vs 关着 72.4s，只慢 6%。原因是
  `addFiles` 在整批结束后才一次性替换 `tracks`，导入过程中列表并不增长，所以每文件一次的
  重渲染跑的是空列表。切片订阅 + `useMemo` 仍然保留：往**已有的大曲库**里再导入时，
  列表是满的，那才是真正会 O(n·m) 的场景。

### 1.3 需要装的东西（M0 之前）

**① Rust 工具链** — 普通权限即可，无需管理员：

```bash
winget install --id Rustlang.Rustup --exact --silent --accept-source-agreements --accept-package-agreements
```

**② MSVC C++ 生成工具** — Rust 的 `*-pc-windows-msvc` 目标需要 MSVC 链接器，**必须在管理员终端里执行**：

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --accept-source-agreements --accept-package-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

下载约 3–5GB，耗时 15–40 分钟。装完用 `vswhere` 验证：

```bash
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -products * -property displayName
```

WebView2 运行时本机已存在（`151.0.4129.78`），不需要额外安装。

> **PATH 不会刷新到已打开的终端。** winget 装完 rustup 后，当前终端里 `cargo` 仍然是 "not found"，这不代表安装失败。重开终端，或在当前会话里手动拼一次：
> ```bash
> $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
> ```

> 首次 `cargo build` 会编译整个 Tauri 依赖树，约 3–8 分钟且吃满 CPU，属正常现象；之后增量编译 10–30 秒。

**本机实测记录（2026-08-15，环境已就绪）**

| 项 | 结果 |
| --- | --- |
| rustup | 1.29.0 |
| rustc / cargo | 1.97.1 |
| toolchain | `stable-x86_64-pc-windows-msvc` |
| VS 生成工具 | 2022 v17.14.37 |
| MSVC 工具集 | 14.44.35207 |
| Windows SDK | 10.0.26100.0 |
| 链接验证 | `cargo new` + `cargo build --release` + 运行，全程通过 |

两条命令**都在非管理员会话中直接装成功了**——VS 生成工具的引导程序自行完成了提权，没有卡在权限上。M0 的环境依赖已全部解除。

### 1.4 依赖清单

**Rust 侧（`src-tauri/Cargo.toml`）**

| crate | 版本 | 用途 |
| --- | --- | --- |
| `tauri` | 2.11.5 | 外壳 |
| `tauri-plugin-dialog` | 2.7.2 | 文件/文件夹选择对话框（F2.1、F5.1） |
| `tauri-plugin-fs` | 2.5.1 | 读文件字节、读写配置（F2、F5） |
| `tauri-plugin-window-state` | 2.4.1 | 窗口位置尺寸记忆（F8.2） |
| `tauri-plugin-single-instance` | 2.4.3 | 单实例（F8.3） |
| `tauri-plugin-global-shortcut` | 2.3.2 | 媒体键与全局快捷键（F8.4、F8.7） |
| `souvlaki` | 0.8.3 | Windows SMTC 系统媒体控件（F8.5） |
| `walkdir` | 2.x | 目录递归扫描（F2.1） |

> 发布前用 `cargo license` 核对全部传递依赖的许可证。`souvlaki` 的许可证在集成时确认，若不合适则改用 `windows` crate 直接调 `SystemMediaTransportControls`（工作量约多半天）。

**前端（`package.json`）**

| 包 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| `react` / `react-dom` | 19.2.8 | MIT | UI |
| `zustand` | 5.0.15 | MIT | 状态 |
| `music-metadata` | 11.14.0 | MIT | 读 ID3/Vorbis/MP4 标签与内嵌封面（F2.3） |
| `@tauri-apps/api` | 2.11.1 | MIT/Apache-2.0 | 外壳 API |
| `@tauri-apps/plugin-fs` | 2.5.1 | 同上 | 文件读写 |
| `@tauri-apps/plugin-dialog` | 2.7.2 | 同上 | 对话框 |
| `fast-average-color` | 9.5.2 | MIT | 底图取色算文字配色（F5.6） |

开发依赖：`vite`、`@vitejs/plugin-react`、`typescript`、`vitest`、`@tauri-apps/cli 2.11.4`、`playwright` + `pixelmatch`（仅对拍脚本用）。

### 1.5 明确不引入，以及为什么

用户要求"能复用就复用，不重复造轮子"。下面这些是**调研过后决定不用**的轮子，附理由，避免以后有人重新捡起来：

| 轮子 | 不用的原因 |
| --- | --- |
| **three.js** `0.185.1` | 蒙版只是一个全屏四边形 + 一个片元着色器，不需要场景图/相机/材质系统。裸 WebGL2 约 120 行搞定，three 压缩后仍有 600KB+，与"小巧"直接冲突 |
| **ogl** `1.0.11` / **regl** `2.1.1` | 同上，省下的那 80 行不值得多一个依赖 |
| **Tailwind CSS** | 本项目是像素级还原的定制版式，几乎每个元素都是绝对定位的一次性样式，原子类没有复用收益，反而多一层构建和一份心智负担。Figma 导出的版本引了 Tailwind 但实际一个类都没用上（见 `design-ref/figma-make/index.css`） |
| **wavesurfer.js** `7.12.11`（BSD-3, 10.4k★） | 它要接管 `<audio>` 元素与播放控制，会和我们自己的播放引擎打架；我们只需要"波形峰值数组"这一个产物。**借鉴其峰值降采样思路，不引依赖** |
| **howler.js** `2.2.4` | 最后发版 2023-09，且它把 Web Audio 节点图封装死了，我们需要在中间插 `AnalyserNode`（F10 的数据源）和 `BiquadFilter`（F7.3 均衡器） |
| **lrc-kit** `1.2.1`（MIT） | LRC 解析本体约 60 行。我们还需要 `[offset:]`、同行多时间戳、双语预留（PRD Q3），自己写更好控制。**已阅读其解析思路** |
| 任何组件库（MUI / Ant / shadcn） | 全部控件都是定制外观，组件库只会带来覆写成本 |
| SQLite / Dexie | 曲库量级在万条以内，一个 JSON 文件 + 内存索引足够，见 §9 |
| Redux / MobX | 状态规模小，Zustand 的 3KB 足够 |

### 1.6 已调研的参考项目

**仅作架构参考，不复制代码**——许可证不兼容或缺失：

| 项目 | ★ | 栈 | 许可证 | 可借鉴之处 |
| --- | --- | --- | --- | --- |
| [basharovV/musicat](https://github.com/basharovV/musicat) | 934 | Tauri + Svelte | **GPL-3.0** | Tauri 下本地曲库扫描与播放的整体架构；⚠️ GPL 传染，**严禁复制任何代码片段** |
| [dupitydumb/Audion](https://github.com/dupitydumb/Audion) | 492 | Svelte | **无许可证** | 同步歌词与主题系统的交互设计；⚠️ 无许可证 = 默认保留全部权利，**只能看不能抄** |
| [katspaugh/wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) | 10.4k | TS | BSD-3-Clause | 峰值降采样算法思路；许可证友好，必要时可直接依赖 |
| [kelvinau/circular-audio-wave](https://github.com/kelvinau/circular-audio-wave) | 280 | JS | — | 环形音频可视化的频段映射思路 |

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ WebView2 (Chromium) — 绝大部分逻辑在这里                     │
│                                                             │
│  React 19 UI ──▶ Zustand stores ──▶ audio/engine.ts         │
│       │                                  │                  │
│       │                          Web Audio 节点图            │
│       │                          └─▶ AnalyserNode           │
│       ▼                                  │                  │
│  stage/ 渲染层 ◀── audioBus (16 段包络) ◀─┘                  │
│  (WebGL2 蒙版 + Canvas 波形 + DOM 控件)                      │
│                                                             │
│       ▲                                                     │
│       │  src/platform/*.ts  ← 唯一允许 import @tauri-apps 的层│
└───────┼─────────────────────────────────────────────────────┘
        │ IPC
┌───────▼─────────────────────────────────────────────────────┐
│ Rust 侧 — 保持极薄，只做 WebView 做不了的事                   │
│  · 无边框窗口 / 窗口状态 / 单实例                             │
│  · 目录递归扫描（walkdir，比 JS 逐层 IPC 快一个量级）          │
│  · 媒体键监听 + SMTC 系统媒体面板                             │
│  · 文件读写（走 plugin-fs，无需自写命令）                     │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 两条关键边界

**边界一：`src/platform/` 是唯一的外壳出口。**
除 `src/platform/*.ts` 外，任何文件都不得 `import` `@tauri-apps/*`。这样做的收益是**整个 UI 与音频层可以在普通浏览器里跑**——`pnpm dev` 打开 Chrome 就能调蒙版着色器和版式，不用等 Rust 编译。`platform/` 提供浏览器 fallback 实现（用 `<input type=file>` 和 `localStorage`）。M1 的全部工作因此可以完全在浏览器里完成。

**边界二：渲染层不认识"播放器"。**
`stage/veil/renderer.ts` 只接受一个数值数组（16 段能量包络）和若干参数，不知道音频、不知道 React。它是一个纯函数式的渲染器，可以单独用假数据驱动测试。

---

## 3. 目录结构

```
vinyl-player/
├─ docs/                       PRD、本文档、与主流播放器的功能对照
├─ design-ref/                 目标效果图与 Figma 版本存档（只读参考）
├─ src-tauri/
│  ├─ src/{lib.rs, main.rs, scan.rs, grant.rs, smtc.rs}
│  ├─ capabilities/default.json    权限清单
│  ├─ tauri.conf.json
│  └─ Cargo.toml
├─ src/
│  ├─ main.tsx  App.tsx
│  ├─ stage/                   渲染层
│  │  ├─ Stage.tsx             舞台盒子与等比缩放
│  │  ├─ Backdrop.tsx          L0 底图
│  │  ├─ Veil.tsx              L1 蒙版（React 壳）
│  │  ├─ veil/{renderer.ts, veil.vert, veil.frag}
│  │  ├─ clock.ts              全应用唯一的 rAF 循环
│  │  └─ useStageFit.ts
│  ├─ ui/                      L3 内容层
│  │  ├─ Masthead.tsx Lyrics.tsx Disc.tsx
│  │  ├─ Progress.tsx Controls.tsx Actions.tsx TitleBar.tsx VolumeControl.tsx
│  │  ├─ useDismiss.ts         点浮层外部关闭
│  │  └─ panels/{Playlist.tsx, Playback.tsx, SkinEditor.tsx, Mix.tsx, Timeline.tsx, AiTab.tsx}
│  ├─ audio/{engine.ts, analyser.ts, eq.ts, peaks.ts, metadata.ts, clips.ts, layer.ts, useProgress.ts}
│  ├─ lyrics/parse.ts          LRC 解析（含词级时间戳）
│  ├─ skin/{model.ts, resolve.ts, palette.ts}
│  ├─ lib/{format.ts, m3u.ts, text.ts}         无依赖小工具
│  ├─ ai/{config.ts, prompt.ts, generate.ts}
│  ├─ store/{player.ts, library.ts, skin.ts, mix.ts, ai.ts, shuffle.ts}
│  ├─ platform/{types.ts, index.ts, tauri.ts, browser.ts}  ← 唯一 import @tauri-apps 的地方
│  └─ styles/{tokens.css, stage.css, ui.css}
├─ tests/                      Vitest 单测 + 实测素材
└─ scripts/                    对拍与端到端验证脚本，见 README §校验
```

---

## 4. 渲染层：还原目标效果

### 4.1 舞台与坐标系

界面按**固定 1220 × 688 的设计坐标系**布局，整体等比缩放居中，窗口内其余部分填黑。所有元素坐标直接写设计稿数值，不做响应式重排——这是保证"任何窗口尺寸下都和效果图一致"最省事也最可靠的做法。

```ts
// stage/Stage.tsx
const DESIGN_W = 1220, DESIGN_H = 688
const fit = Math.min(winW / DESIGN_W, winH / DESIGN_H)
// 内容层：<div style={{ width: DESIGN_W, height: DESIGN_H, transform: `scale(${fit})` }}>
```

**WebGL 画布必须单独处理**：CSS 的 `transform: scale()` 会把画布当图片拉伸，导致模糊。画布的 CSS 尺寸仍是 1220×688（跟着一起缩放），但**后备缓冲区按真实物理像素分配**：

```ts
canvas.width  = Math.round(DESIGN_W * fit * devicePixelRatio)
canvas.height = Math.round(DESIGN_H * fit * devicePixelRatio)
gl.viewport(0, 0, canvas.width, canvas.height)
```

`fit` 或 `devicePixelRatio` 变化时才重新分配（用 `ResizeObserver` + 100ms 防抖，避免拖拽窗口时反复重建缓冲区）。

### 4.2 图层栈

| 层 | 实现 | 说明 |
| --- | --- | --- |
| L0 底图 | `<img>` + `object-fit: cover` | 双缓冲两个 img 做交叉淡入（F5.5） |
| L1 蒙版 | `<canvas>` WebGL2 | 见 §4.3，`pointer-events: none` |
| L2 颗粒 | `<div>` + 重复渐变 + `mix-blend-mode: overlay` | 直接沿用 Figma 版本的写法（`design-ref/figma-make/index.css:19`），那部分是对的 |
| L3 内容 | DOM | 缩放容器内 |
| L4 浮层 | DOM | 抽屉与面板 |

### 4.3 雾化边缘（PRD D1 / A1–A5，本项目的技术命门）

#### 4.3.1 三个方案的比较

| 方案 | 静态效果 | 能否做 F10 的波动 | 成本 | 结论 |
| --- | --- | --- | --- | --- |
| **A. CSS 多层渐变 + `filter: blur()`** | 边缘柔和但**过于规则**，一眼看出是渐变；无云絮质感 | 不能。`blur()` 每帧重算代价极高，动起来必掉帧 | 极低 | ❌ 这正是 Figma 版本的做法，达不到 A1/A3 |
| **B. 预渲染一张蒙版 PNG 做 `mask-image`** | 可以做到完美，因为可以在 PS 里手工画 | 不能。图片是死的 | 低 | ⚠️ 作为无 WebGL 时的降级方案 |
| **C. WebGL2 片元着色器实时生成** | 噪声可控，云絮质感与不等宽过渡带天然成立 | **能**，加两个 uniform 即可 | 中（约 120 行） | ✅ **选它** |

选 C 的决定性理由：**F10 的波动效果必须由同一套渲染管线产出**。如果 M1 用 A 或 B 做完，到 M5 要加波动时整个蒙版层得推倒重来。C 方案在 M1 阶段把 `uTime` 和 `uWaveAmp` 固定为 0 即可得到静态效果，M5 只需把它们接上音频总线——**零重写**。

#### 4.3.2 着色器

顶点着色器是一个全屏三角形（比四边形少一次插值，且没有对角线接缝），略。片元着色器：

```glsl
#version 300 es
precision highp float;

in  vec2 vUv;              // 舞台内归一化坐标，(0,0) = 左下
out vec4 fragColor;

uniform float uTime;       // 秒；只画一次，恒为 0
uniform float uEdgeX;      // 静止边缘位置，默认 0.52
uniform float uSoftness;   // 过渡带半宽，默认 0.10（对应 PRD A2 的 ≥12% 全宽）
uniform float uOpacity;    // 蒙版最大不透明度，默认 0.88（PRD A4 上限 0.92）
uniform vec3  uTint;       // 蒙版色，默认 #f4f2ec；自动取色时由 6.6 决定
uniform float uRipple;     // 边缘起伏幅度 0..1（静态形状，不随时间变）

// 整数哈希，不用 fract(sin(dot(...)))。后者的结果依赖 GPU 的 sin 精度：
// 在 Intel Arc 的 ANGLE→D3D11 上，单独调没问题，但 fbm 叠到多个八度后会塌成
// 少数几个值。噪声格点是 floor(p)，塌了就表现为一片轴对齐的矩形色块。
uint hashU(uvec2 x){
  uint h = x.x * 374761393u + x.y * 668265263u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}
float hash(vec2 p){ return float(hashU(uvec2(ivec2(p) + 4096))) / 4294967295.0; }

float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i),           hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}

float fbm(vec2 p){                       // 4 个八度，掉帧时可降到 2
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main(){
  float y = vUv.y;

  // ① S 型行波：两个不可通约的波数叠加，肉眼看不出周期重复
  //    1.5 个波长跨越画面高度 —— 这正是"S 形"的来源
  float slow = sin(6.2831 * (y * 1.5) + uTime * 0.55);
  float fast = sin(6.2831 * (y * 3.7) - uTime * 0.90 + 1.7);

  // ② 音频驱动：按高度采样频谱包络（F10.2 / F10.3）
  float band = texture(uBands, vec2(y, 0.5)).r;
  float wave = (slow * 0.60 + fast * 0.25) * (0.35 + 0.65 * band);

  // ③ 云絮质感：让过渡带的宽度和位置本身沿 y 起伏（满足 A2 不等宽、A3 有絮状）
  float grain = fbm(vec2(vUv.x * 3.0, y * 6.0) + uTime * 0.03);
  float edge  = uEdgeX + wave * 0.06 * uWaveAmp + (grain - 0.5) * uSoftness * 0.9;
  float soft  = uSoftness * (0.7 + 0.6 * grain);

  // ④ 合成
  float a = (1.0 - smoothstep(edge - soft, edge + soft, vUv.x)) * uOpacity;
  fragColor = vec4(uTint * a, a);        // 预乘 alpha
}
```

要点：

- 画布用默认的 `premultipliedAlpha: true`，所以输出 `vec4(uTint * a, a)`。写成 `vec4(uTint, a)` 会在过渡带出现白边。
- ③ 里 `grain` 同时扰动 `edge` 和 `soft` 两个量，这是"过渡带宽度沿竖直方向变化"（A2）的直接来源，也是与纯 CSS 渐变拉开差距的关键。
- `uOpacity` 上限 0.92：底图必须能透出来（A4）。
- M1 阶段 `uTime = 0`、`uWaveAmp = 0`、`uBands` 全零，得到的就是一张静止的雾化蒙版。此时**每帧都在渲染同样的东西，所以要停掉渲染循环**，参数变化时才画一帧（见 §11）。

#### 4.3.3 参数标定流程

着色器的默认参数不是拍脑袋定的，用 §14 的对拍脚本标：`compare-visual.mjs` 在参数网格上扫 `uEdgeX × uSoftness × uOpacity`，输出与 `design-ref/target/ref-ui-dark.png` 的 SSIM 最高的一组，写回 `src/skin/model.ts` 作为默认皮肤的初值。这一步在 M1 结束时做一次。

#### 4.3.3.1 晶格伪随机不能用 `fract(sin(...))`

fbm 的 hash 最初写的是最常见的那句 `fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)`。
**这是个 GPU 相关的坑，实机上会直接毁掉画面。**

现象：暗部渐变里出现轴对齐、硬边的矩形色块，大小不一、层层嵌套。

原因：那句 hash 要求 `sin` 在幅角变大后仍有足够精度。fbm 每叠一个八度坐标就乘 2.03，
到第三四个八度时幅角已经不小；ANGLE → D3D11 路径上（实测 Intel Arc）相邻晶格点被映射
到同一个值，整块晶格塌成平的。而晶格是 `floor(p)` 的整数网格 —— 塌陷出来的形状就是
**轴对齐的矩形**。`uTime` 一直在往坐标上加，所以跑得越久越糟。

实测对比（`scripts/perf/dbg-hash.mjs`，同一块卡，`fbm(x*3, y*6)` 渲染到 256×256，
统计相邻像素的跳变 —— 平滑的 fbm 在这个尺度下最多差 1~2 级）：

| hash 写法 | 最大跳变 | 硬边像素（差 ≥6 级） |
| --- | --- | --- |
| `fract(sin(dot(...)))` | **52 级** | 2804 |
| 整数位运算 | 10 级 | 1705（正常高频噪声） |

改用纯整数位运算（GLSL ES 3.00 有整数类型），不碰任何超越函数，与 GPU 的 `sin` 实现无关。
换完之后视觉对拍的 SSIM 从 0.7074 升到 **0.7256**。

> **顺带暴露了测试体系的一个盲区：视觉回归跑在 headless Chromium 上，那是 SwiftShader
> 软件光栅，`sin` 算得准，图完美，SSIM 一路绿灯。这类"只在真实 GPU 上出现"的问题，
> 对拍脚本一个也拦不住。** 排查时第一版复现脚本就是用 headless 跑的，五种图层组合全是
> 完美渐变，差点得出"复现不了"的错误结论。涉及着色器的问题必须在装机版里看
> （`scripts/perf/dbg-banding.mjs` 默认就是装机版模式）。

#### 4.3.4 降级

启动时探测 `canvas.getContext('webgl2')`。返回 `null`（老显卡、远程桌面、显卡驱动异常）时切到方案 B：加载预渲染的 `veil-fallback.png` 做 `mask-image`，同时把 F10 的开关置灰并提示原因。这张 PNG 由 §4.3.3 标定后的着色器离线渲染导出，视觉与实时版一致，只是不会动。

### 4.4 黑胶旋转（F4.1）

```css
.disc { animation: spin 20s linear infinite; animation-play-state: paused; will-change: transform; }
.disc[data-playing="true"] { animation-play-state: running; }
@keyframes spin { to { transform: rotate(360deg); } }
```

**必须用 `animation-play-state` 切换，不能用 `animation: none` 或改 class 移除动画**——后者会让唱片瞬间弹回 0°，违反 F4.1"就地停住"。用 `animation-play-state` 时浏览器保留动画时间轴，恢复即从原角度继续，且整个动画跑在合成器线程，主线程卡顿也不影响转速。

唱片贴纸是 `.disc` 的子元素，自然跟着转（F4.2），无需额外处理。

---

## 5. 音频引擎

### 5.1 节点图

```
<audio> ──▶ MediaElementSource ──▶ [BiquadFilter ×10] ──▶ GainNode ──▶ destination
                                            │
                                            └──▶ AnalyserNode（旁路，不影响输出）
```

用 `HTMLAudioElement` 而不是 `AudioBufferSourceNode` 作为音源：前者自带流式解码、`currentTime` 跳转、缓冲管理，一首 FLAC 不需要全部解码进内存。均衡器（F7.3）关闭时把 10 个滤波器整体旁路而不是设成 0 增益，省 CPU。

### 5.2 本地文件怎么喂给 Web Audio（**最大的坑**）

Tauri 里有两条路，选错会导致**频谱分析永远返回全 0**，而且极难排查：

| 路径 | 做法 | 问题 |
| --- | --- | --- |
| `convertFileSrc(path)` | 拿到 `http://asset.localhost/...` 直接给 `<audio src>` | 该 URL 是**跨源**的。`createMediaElementSource` 会把音频图标记为 tainted，`getByteFrequencyData()` **恒返回全 0**，且不报任何错。需要同时正确配置 `assetProtocol` 的 scope、CSP 与 CORS 响应头，还要给 `<audio>` 加 `crossOrigin="anonymous"`，任何一环漏了就静默失败 |
| **Blob URL（选它）** | `readFile(path)` 拿字节 → `new Blob([bytes])` → `URL.createObjectURL(blob)` | 同源，分析器一定能工作。代价是整首曲子驻留内存 |

**决定：走 Blob URL。**

内存代价可接受：一首 10MB 的 MP3 就是 10MB，一首 60MB 的无损 FLAC 就是 60MB，PRD 的 200MB 内存预算装得下。规则：

- 同一时刻只保留**当前曲目**和**预加载的下一首**共两个 Blob。
- 切歌时对旧的 Blob URL 调 `URL.revokeObjectURL()`——**不调就是稳定的内存泄漏**，PRD 要求连续播放 8 小时内存增长 < 50MB，这一条不做直接不达标。
- 单文件超过 200MB 时拒绝加载并提示（避免用户误拖入超长录音）。

```ts
// audio/engine.ts 片段
async function load(path: string) {
  const bytes = await platform.readFile(path)          // Uint8Array
  revokeCurrent()
  const blob = new Blob([bytes], { type: mimeOf(path) })
  currentUrl = URL.createObjectURL(blob)
  audioEl.src = currentUrl
  // bytes 同时交给 metadata 与 peaks 复用，避免二次读盘
  return bytes
}
```

### 5.3 元数据（F2.3）

`music-metadata@11` 在浏览器环境用 `parseBlob(blob)`，直接复用 §5.2 已经读到的字节，不重复读盘。内嵌封面拿到的是 `Uint8Array`，同样转 Blob URL 使用，**用完同样要 revoke**。

批量扫描时不要对每个文件都做完整解析：先只解析头部（`parseBlob(blob, { duration: false })`），需要精确时长时再补。扫描在 Web Worker 里做，避免 F2.6 要求的"过程中界面不卡顿"落空。

### 5.4 波形峰值（F3.2）

```ts
// audio/peaks.ts
const buf = await ctx.decodeAudioData(bytes.buffer.slice(0))   // ⚠️ 必须 slice
const ch  = buf.getChannelData(0)
const N   = 500                                    // 进度条宽 320px，500 个桶足够
const peaks = new Float32Array(N)
const step = Math.floor(ch.length / N)
for (let i = 0; i < N; i++) {
  let sum = 0
  for (let j = 0; j < step; j += 16) sum += ch[i * step + j] ** 2   // 每 16 个采样取一个，够用且快 16 倍
  peaks[i] = Math.sqrt(sum / (step / 16))          // RMS，比取绝对值峰值更接近人耳感受
}
```

**`decodeAudioData` 会把传入的 `ArrayBuffer` 转移（detach）**，之后原 buffer 长度变 0。§5.2 里那份字节还要给 Blob 和元数据用，所以必须传 `.slice(0)` 的副本。这个坑的表现是"播放正常但元数据全空"或反过来，且不报错。

峰值算完写入缓存目录（§9），键 = 文件路径 + 大小 + mtime 的哈希。500 个 `Float32` = 2KB，一万首歌也才 20MB。算峰值放在 `requestIdleCallback` 里，不阻塞播放（F3.4）。

### 5.5 频谱包络（F10 的数据源）

```ts
// audio/analyser.ts
analyser.fftSize = 2048          // 1024 个频点 @48kHz ≈ 23.4Hz/点
analyser.smoothingTimeConstant = 0  // 平滑自己做，浏览器那套不满足"快起慢落"

const N = 16, env = new Float32Array(N)
const ATTACK = 0.35, RELEASE = 0.06   // 快起慢落（F10.4）

// 对数分箱：40Hz → 14kHz。线性分箱会让 16 段里 14 段都落在高频，视觉上全在抖同一个东西
const edges = Array.from({ length: N + 1 }, (_, i) =>
  Math.round(40 * Math.pow(14000 / 40, i / N) / (sampleRate / analyser.fftSize)))

function tick(freq: Uint8Array) {
  for (let i = 0; i < N; i++) {
    let sum = 0
    for (let b = edges[i]; b < edges[i + 1]; b++) sum += freq[b]
    const v = sum / Math.max(1, edges[i + 1] - edges[i]) / 255
    env[i] += (v - env[i]) * (v > env[i] ? ATTACK : RELEASE)
  }
  smooth3(env)     // [0.25, 0.5, 0.25] 卷积一次，消掉 16 段的台阶感
}
```

产物 `env` 每帧上传成一张 16×1 的 `R8` 纹理喂给着色器的 `uBands`。低频在 `y=0`（画面下部），高频在 `y=1`（上部），设置里可反转（F10.3）。

暂停时 `env` 自然按 RELEASE 衰减到 0，画面平滑回到静止的呼吸态，不需要额外处理。

---

## 6. 皮肤系统（F5）

### 6.1 数据模型

```ts
// skin/model.ts
export type Skin = {
  id: string
  name: string
  backdrop: string                                   // 图片相对路径（相对 skins/）
  backdropFocus: { x: number; y: number }            // 0..1，cover 裁切的焦点
  label: { source: 'backdrop' | string               // 'backdrop' = 跟随底图（F5.3）
           focus: { x: number; y: number; zoom: number } }  // 取景框
  veil: { edgeX: number; softness: number; opacity: number; tint: string; ripple: number }
  tintAuto: boolean                                  // 蒙版色自动取自底图（见 6.6），默认 true
  ink:  { auto: boolean; primary: string; secondary: string; accent: string }
  text: { title: string; subtitle: string; year: string; byline: string }
}
```

`tintAuto` 放在 `Skin` 而不是 `veil` 里：`veil` 是直接喂给渲染器的参数包，渲染器不该看见一个它永远用不上的开关。

`label.source === 'backdrop'` 是默认值，正是用户要的"黑胶上的图跟着底图切换"。设成具体路径就脱离联动（F5.4）。

### 6.2 贴纸取景

贴纸不是另存一张图，而是**同一张底图用不同的 `background-size` / `background-position` 呈现**——省一份存储，也保证永远同步：

```ts
// skin/resolve.ts
export function labelStyle(skin: Skin, imgW: number, imgH: number) {
  const { x, y, zoom } = skin.label.focus
  const side = Math.min(imgW, imgH) / zoom        // 取景框边长（原图像素）
  return {
    backgroundImage: `url(${src})`,
    backgroundSize: `${(imgW / side) * 100}% ${(imgH / side) * 100}%`,
    backgroundPosition: `${x * 100}% ${y * 100}%`,
  }
}
```

默认取景框：`{ x: 0.5, y: 0.32, zoom: 2.2 }`——中心偏上。人物照片的头部绝大多数落在画面上三分之一，这个默认值在参考图的几张图上都能直接取到人脸，满足 F5.3"默认值即已可用"。

### 6.3 文字自动配色（F5.6）

用 `fast-average-color` 取**底图左侧 40% 区域**（蒙版覆盖区）的平均色，算相对亮度：

```ts
const L = relativeLuminance(avgColor)
// 蒙版把底图压向 uTint，实际背景亮度 ≈ 混合后的值
const bgL = mix(L, luminance(veil.tint), veil.opacity)
ink.primary = bgL > 0.5 ? '#3a3a37' : '#e8e6e0'
```

算完校验与背景的对比度是否 ≥ 4.5:1，不足则继续往两端推，直到达标或触到纯黑/纯白。铜金色的标题色（`#b2845f`）是品牌色，只在对比度不足时才自动调整明度，保持色相。

### 6.4 切换转场（F5.5）

双 `<img>` 交叉淡入 600ms；同一时刻蒙版的 `uTint` 与文字色用 CSS 自定义属性过渡；贴纸走 F4.3 的短转场（400ms 淡出换图淡入）。三者时长不同是有意的——同时开始、错落结束，比整齐划一更有质感。

### 6.6 蒙版三色自动取色

从底图取 3 个主色当蒙版色，按播放进度每色占 1/3 时长依次切换（不做渐变）。默认开启、直接应用。

**取样**：底图缩到 96px 宽再统计——主色调不需要全分辨率，4K 图逐像素是几千万次循环，缩图后结果几乎一样。取**整张图**：人是看着整张图判断"这图什么颜色"的，而这类图主体常在右侧。（曾经只取左 40%，理由是"取的区域要和盖的区域一致"——那个理由对 6.3 的文字配色成立，对取色不成立。实测一张暗调人物图，左 40% 全是黑烟，三个主色的原始距离只有 9。）

**挑色**（`dominantColors`）三步：

1. **直方图**：RGB 各压到 16 级做 4096 桶，桶内取平均（不取桶心，量化后桶心最多偏 8）。
2. **聚类**：把相距 < 60 的桶并进同一簇，代表色取簇内最常见的那个桶（不取全簇平均——平均会把强调色朝背景色拉回去）。量化会把一片渐变打散成几十个小桶，不合并的话它们各自都够不着门槛；而一片背景的明暗过渡若分成三簇，会各自带着不低的分数把三个名额全占掉。
3. **按显眼程度挑**，不是按面积挑。

第 3 步是关键。按面积排必然选中背景：实测那张暗调人物图，近黑的 `#0b0809` 占 85.51%，于是它必然第一名，后两个也只能在剩下的面积顺序里挑。而人说"这张图最明显的三个颜色"，指的是最跳眼的，不是铺得最满的。所以：

```
score = 0.6 × 饱和度 + 0.4 × √占比          // 面积开根号压一下，别让背景一家独大
资格线 = max(0.25%, 0.8% × (1 − 0.75×饱和度))  // 越鲜艳，允许占的面积越小
挑选   = score × min(1, 色距/90) × min(1, 亮度差/0.10)
```

后两个乘子是**去重护栏，不是目标**：够分得开就不再加分，剩下交给显眼程度。两道都必需——

- 只按色距挑（纯最远点采样）：血红 `#551718` 离黑底只有 88，一块浅灰粉离黑底有 266，纯比距离就把浅灰粉挑走，一张满屏血红的图取不到红。
- 不加亮度护栏：两个深色天生挨得近，暗调图会把三个名额全给暗色，画面上那块亮的（人物衣服、高光）永远选不上——而那恰恰是人一眼看到的第三个色。

凑不满三个是可接受结果：色调很窄的图聚类后本来就只有两簇，硬塞第三个看不出差别的更糟，三色轮换会自动退化成两段。

**调色**（`veilTintsFrom` / `veilTintFrom`）：**基本原样放行，只挡纯黑、纯白和霓虹。**

这里前后错了三版，根子是同一个想当然：认定蒙版必须是浅色，于是把亮度硬压进一条窄而浅的带子（曾经是 `[0.55, 0.86]`、饱和上限 0.32）。后果是取色再准也没用——实测四张真实底图十二个色没有一个不是淡的，`#a65927` 这种饱满的铁锈橙直接变成近白的 `#f4ede9`，"黑 + 血红"的一组变成三个几乎一样的淡粉。而用户手调的蒙版色是 `#5e0d0d`，亮度 0.028，想要的方向和那条带子正相反。

现在只留三个护栏，见 `VEIL_TINT_MIN_LUM / MAX_LUM / MAX_SAT`。注意 MIN_LUM 只要抬离纯黑、不能抬到看得出变亮：这个数从 0.004 放大到 0.015 就足以把 `#0b0808` 顶到 `#2c2224` 身上，两个原本差 50 的色挤成差 7。

**文字配色跟着走**：蒙版色一放开就可能很深，`deriveInk` 必须用**当前生效的** tint 而不是皮肤里存的那个，否则会出现深底深字。所以配色改成在 `Stage` 里现算（输入 `backdropAvg` + `useActiveTint()`），不再在换图时算一次存进皮肤。`useActiveTint` 是蒙版和 Stage 共用的唯一出口，避免两边各算一遍走岔。

**优先级**：用户手调蒙版色即关闭自动取色。这条规则落在 store 的 `patchVeil` 里而不是面板里——任何改 `tint` 的路径都自动遵守，不会漏掉某个入口。面板上留一个开关重新打开。预设套用时 `tintAuto` 跟着预设一起搬（预设携带它自己的意图）。

**取到的色不落盘**：`tintColors` 是运行时派生态。存下来只会和底图对不上。自动色也**不写回 `skin.veil.tint`**——写回去一首歌要落三次盘，还会把用户存在预设里的颜色悄悄改掉。

**开销**：`useTintPhase` 订阅播放进度但只在跨 1/3 边界时 `setState`，一首歌重渲染 3 次，不是每个进度事件一次。

---

## 7. 歌词（F6）

LRC 解析约 60 行，自己写：

```ts
// lyrics/parse.ts
const TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
// 一行可能有多个时间戳：[00:12.00][01:30.00] 副歌
// [offset:+500] 表示整体提前 500ms
```

产物是按时间排序的 `{ t: number; text: string }[]`。定位当前行用**二分查找**而非线性扫描——歌词更新跑在每帧的渲染循环里，一首歌 200 行的线性扫描每秒 60 次是纯浪费。

滚动用 `transform: translateY()` + `cubic-bezier` 缓动，不用 `scrollTop`（会触发布局）。当前行前后各 3 行，透明度按距离衰减，与效果图一致。

---

## 8. 系统集成（F8）

| 功能 | 实现 |
| --- | --- |
| 无边框窗口 | `tauri.conf.json` 设 `decorations: false`；标题栏区域加 `data-tauri-drag-region` 属性即可拖拽 |
| 窗口状态 | `tauri-plugin-window-state`，零代码 |
| 单实例 | `tauri-plugin-single-instance`，回调里把 `argv` 的文件路径通过事件发给前端 |
| 媒体键 | `tauri-plugin-global-shortcut` 注册 `MediaPlayPause` / `MediaTrackNext` / `MediaTrackPrevious` |
| SMTC | `souvlaki` 在 Rust 侧建 `MediaControls`，前端每次切歌/暂停通过 `invoke` 同步曲目信息与封面；SMTC 的按钮事件反向 `emit` 给前端 |
| 托盘 | Tauri 内置 `TrayIconBuilder` |

**目录扫描放在 Rust 侧**：`walkdir` 递归 + 扩展名过滤，一次性把路径列表返回给前端。若用前端逐层调 `readDir`，1000 首歌意味着上千次 IPC 往返，达不到 F2.6 的 15 秒要求。

权限在 `src-tauri/capabilities/default.json` 里显式声明，`fs` 的 scope 限制到用户音乐目录、应用数据目录与用户显式选择的路径，不开全盘读权限。

---

## 9. 数据持久化

放在 `%APPDATA%\vinyl-player\`：

```
vinyl-player/
├─ library.json      曲库：路径、元数据、播放次数、喜欢标记、歌单
├─ skins.json        全部皮肤配置
├─ settings.json     音量、播放模式、倍速、均衡器、输出设备、上次曲目
├─ mix.json          每首歌的叠加轨与片段编排
├─ ai.json           AI 配图配置与已生成图的索引
├─ skins/            用户导入的底图、AI 生成图、提取出的内嵌封面副本
└─ cache/
   └─ peaks-*.bin    波形峰值，文件名 = 内容哈希（平铺，无子目录）
```

全部是 JSON，读时一次性载入内存，写时**防抖 1 秒 + 写临时文件再原子 rename**——直接覆写原文件遇到断电会得到一个半截的 JSON，曲库就没了。

`library.json` 里存**绝对路径**。启动时不做存在性校验（1000 次 `stat` 会拖慢冷启动），改为播放失败时才标灰（F2.5）。

版本迁移：每个 JSON 带 `schemaVersion` 字段，加载时按版本跑迁移函数链。第一版就加上，后面改结构不至于把用户数据洗掉。

### 9.1 fs 权限：两个只在打包后才暴露的坑

开发时跑 `npm run dev`，走的是 `platform/browser.ts`——配置进 localStorage，文件靠 `File` 对象，**完全不碰 Tauri 的权限系统**。下面两件事因此在开发期一次都没暴露过，是装机实测（`scripts/verify-packaged.mjs`）才照出来的。

**一、文本读写是独立命令。** `capabilities/default.json` 里给了 `fs:allow-read-file` 与 `fs:allow-write-file`，但 `readTextFile` / `writeTextFile` 走的是 `plugin:fs|read_text_file` / `write_text_file`，是**另外两条命令**，不被前者覆盖。少了它们，所有 JSON 配置在打包后一律 `not allowed by ACL`——曲库、设置、皮肤、混音编排全都存不进也读不出，而界面上看不出任何异常，因为异常被 `void init()` 吞了。

顺带把 `readConfig` 改成读失败降级返回 `null` 并打日志：原先异常会一路抛穿 `init()`，让整个启动流程停在半路。

**二、fs scope 是静态白名单，拖放不在其中。** scope 只列了 `$AUDIO`、`$HOME/Music`、`$DOWNLOAD` 等标准目录。对话框选中的文件由 dialog 插件自动放行，**拖放进来的不会**——实测把 `D:\Project\…` 下的 mp3 拖进打包应用，读取直接报 `forbidden path`。而拖放恰恰是 README 推荐的首选导入方式。

更隐蔽的是**重启**：能力域每次启动重建，`library.json` 里那些绝对路径不会自动重新放行。音乐库不在标准目录下的用户，重启后整个曲库都会变成"无法播放"。

解法不是把 scope 放开成 `**`（等于取消这道防线），而是按用户的实际动作逐个放行——`allow_paths` 命令（`src-tauri/src/grant.rs`）在三个时机被调用：

| 时机 | 放行什么 |
| --- | --- |
| 拖放 | 拖进来的路径，目录则递归 |
| 载入曲库 | `library.json` 里所有曲目的路径 |
| 找外挂歌词 / 解析 m3u | 那个具体的 `.lrc` 或被引用的音频路径 |

放行音频文件**不等于**放行它旁边的 `.lrc`，得单独补一刀，否则域外的外挂歌词会静默地"找不到"。

---

## 10. 状态管理

五个 Zustand store。**依赖是单向的，无环**——不是"互不 import"，那个说法在加了混音与 AI 之后就不成立了：

| store | 内容 | 依赖 |
| --- | --- | --- |
| `library` | 全部曲目、歌单、扫描进度、搜索过滤排序 | 叶子 |
| `skin` | 当前皮肤、皮肤列表、取景与配色 | 叶子 |
| `player` | 当前曲目、播放状态、音量、播放模式、队列与洗牌顺序 | → `library` |
| `mix` | 叠加轨配置与片段编排 | → `library` |
| `ai` | AI 配图配置与生成状态 | → `skin` |

播放设置（均衡器、倍速、输出设备、睡眠定时器）没有单独的 store：它们是**引擎的状态**，由 `audio/engine.ts` 自己持有，`player` 只在落盘时读一遍。多一个 store 只会让同一份状态有两个真相。

**进度（`currentTime`）不进 store**。它每秒变化几十次，进 store 会让整棵组件树每秒重渲染几十次。改为：`audio/engine.ts` 暴露一个订阅接口，只有进度条与歌词两个组件直接订阅并用 ref 更新 DOM。这是本项目最重要的一条性能约定。

`mix` 的 `sync()` 中间有 `await layer.load()`，而 `setHost` / `addLayer` / `removeLayer` 都会调它。快速切歌时两次 sync 会交错，必须用代际号把过期那轮丢掉，否则会留下一个不会 tick、也没人回收的 `<audio>`。

**进度（`currentTime`）不进 store**。它每秒变化几十次，进 store 会让整棵组件树每秒重渲染几十次。改为：`audio/engine.ts` 暴露一个订阅接口，只有进度条与歌词两个组件直接订阅并用 ref 更新 DOM。这是本项目最重要的一条性能约定。

随机播放（F1.5）用**Fisher-Yates 洗牌出一个顺序数组**，而不是每次随机取一首。后者会重复播放同一首，用户体感很差。一轮播完重新洗牌，且保证新一轮的第一首不等于上一轮的最后一首。

---

## 11. 渲染循环与性能

单一 `requestAnimationFrame` 循环，统一驱动蒙版、波形高亮、歌词、进度。多个组件各开一个 rAF 是常见的性能事故来源。

**分级降频**，直接对应 PRD §7 的"空闲 CPU < 3%"：

| 状态 | 循环行为 |
| --- | --- |
| 播放中 + F10 开启 | 60fps 全量 |
| 播放中 + F10 关闭 | 蒙版不重绘（参数没变），只更新进度/歌词，约 10fps |
| 暂停 | 蒙版按呼吸底噪 30fps；无底噪时完全停止 |
| 窗口不可见（`document.hidden`） | **完全停止**，音频继续播 |
| 窗口最小化 | 同上 |

掉帧自动降级（F10.6）：连续 30 帧超过 20ms，依次执行 ① fbm 八度 4 → 2；② 蒙版画布按 0.6 倍分辨率渲染再由 CSS 拉伸（蒙版本身是模糊的，降分辨率几乎看不出来）；③ 关闭 F10 回落静态。每级降级记一条日志，方便定位是哪台机器的问题。

---

## 12. 错误处理

| 场景 | 处理 |
| --- | --- |
| 音频文件不存在/损坏 | 曲名位置显示原因，2s 后跳下一首；连续 3 首失败则停止（PRD §6.3） |
| 图片解码失败 | 保留上一张底图，提示"图片无法识别" |
| WebGL2 不可用 | 降级到静态蒙版 PNG（§4.3.4） |
| 配置文件损坏 | 备份为 `.corrupt.json`，用默认值重建，提示用户 |
| 磁盘写入失败 | 提示并保持内存状态，不静默丢数据 |

原则：**任何错误都不弹系统级对话框**，一律在画面内以最低干扰的方式呈现，不破坏视觉。

---

## 13. 构建与发布

```bash
npm run tauri dev
```

```bash
npm run tauri build
```

产物：`src-tauri/target/release/bundle/nsis/*.exe`。配置 `"windows": { "webviewInstallMode": { "type": "downloadBootstrapper" } }`——不把 WebView2 运行时打进包里，能省几十 MB，Win11 本身已内置。

不做代码签名（PRD Q5），首次运行会有 SmartScreen 提示，个人自用可接受。

---

## 14. 测试策略

**不允许跳过测试。** 分三层：

**① 单元测试（Vitest）** — 覆盖全部纯逻辑，这些是最容易出静默 bug 的地方：

- `lyrics/parse.ts`：多时间戳、offset、异常格式、空文件、BOM
- `store/player.ts`：四种播放模式的状态转移；洗牌不重复；边界（列表空、单曲、末尾）
- `audio/peaks.ts`：降采样长度、RMS 正确性、静音输入
- `audio/analyser.ts`：对数分箱边界、attack/release 包络行为
- `skin/resolve.ts`：取景框换算、极端 zoom、非方形图
- `skin/palette.ts`：对比度校验一定输出 ≥ 4.5:1
- 时间格式化、路径哈希、JSON 迁移链

**② 视觉对拍（`scripts/compare-visual.mjs`）** — PRD A5 的执行者：

Playwright 打开 `npm run dev` 的页面（浏览器路径，不需要 Tauri），截图后与 `design-ref/target/ref-veil-primary.png` 比对，输出上下对照图。两层判定：

- **坐标核对（精确）**：从参考图上检测黑胶圆心与半径，与 `tokens.css` 的常量比对，偏差 > 6px 即告警。这是真正有意义的保真度检查，当前实测偏差 0/1/0px。
- **SSIM（回归绊线）**：阈值 0.66，当前 0.70。**不是保真度指标**，只用来发现布局塌陷、图层丢失、字体未加载这类硬故障。

原稿把 SSIM ≥ 0.92 当作 M1 的硬关口，实测证明那个数字不可达也不该追，理由记在 PRD §4.3 的修订说明里，判据由 `scripts/reference-ceiling.mjs` 给出。

设计坐标系定为 **1243×688**，正是参考图剥掉录屏黑边后的尺寸——这样元素坐标可以 1:1 照抄参考图，对拍全程不做缩放，消除了一整类方法误差。

**③ 手工冒烟清单** — PRD §10 的验收清单，每个里程碑结束跑一遍，结果记进 `docs/smoke-log.md`。

音频播放与系统集成这类涉及真实设备的部分不做自动化——桩件的维护成本超过收益，靠 ③ 覆盖。

---

## 15. 风险登记

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 着色器调不出效果图那种雾感 | **致命**，产品失去唯一卖点 | M1 就做，最早暴露；已备好方案 B（预渲染 PNG）保底；参数用对拍脚本自动标定而非手调 |
| R2 | Rust 工具链安装失败或编译环境出问题 | 阻塞 M0 | `platform/` 边界保证 M1–M3 全部可在纯浏览器中开发，外壳问题不阻塞视觉与播放功能 |
| R3 | Blob 方案在超大无损文件上吃内存 | 中 | 200MB 单文件上限 + 只保留 2 个 Blob + 严格 revoke |
| R4 | SMTC 集成（souvlaki）在 Win11 上行为异常 | 低，F8.5 是 P1 | 属可降级功能；失败则只保留媒体键（F8.4），不阻塞发布 |
| R5 | 集显上 F10 掉帧 | 中 | §11 的三级自动降级；F10 本身可关 |
| R6 | 误用 GPL 参考项目的代码 | **法务** | musicat 是 GPL-3.0、Audion 无许可证，已在 §1.6 标注；只读架构不复制代码，评审时抽查 |

---

## 16. 落地顺序

与 PRD §8 的里程碑对应，每个里程碑独立提交、独立验收：

| 里程碑 | 具体交付 |
| --- | --- |
| **M0** | Rust 工具链就位；`npm create tauri-app`；无边框窗口；`platform/` 双实现（Tauri + 浏览器 fallback）跑通 |
| **M1** | Stage 缩放；L0–L3 图层；**veil 着色器 + 对拍脚本 + 参数标定**；全部 UI 元素静态版；SSIM ≥ 0.92 |
| **M2** | engine/graph/metadata/peaks；播放列表抽屉；Rust 侧目录扫描；黑胶旋转接上播放状态 |
| **M3** | Skin 模型与持久化；底图导入；取景框编辑器；自动配色；切换转场 |
| **M4** | LRC 解析与滚动；均衡器；输出设备；媒体键；SMTC；托盘；全部快捷键；收藏与播放次数统计（F9） |
| **M5** | analyser → uBands 接线；`uTime` / `uWaveAmp` 通电；强度调节；三级降级 |
| **M6** | 图标；NSIS 打包；README；跑完 PRD §10 全部验收项 |

M1 是整个项目的分水岭：**如果 M1 的 SSIM 达不到 0.92，不要继续往下做，回到 §4.3 重新评估方案。**
