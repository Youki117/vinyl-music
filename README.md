# Vinyl Player

一个以视觉为第一卖点的 Windows 本地音乐播放器：整屏是一张可随意更换的人物底图，左侧压一层向右雾化弥散的白色蒙版，蒙版上放置黑胶唱片与全套播放控件；黑胶中心的贴纸跟随底图自动切换。

## 使用

安装包在 `src-tauri/target/release/bundle/nsis/` 下，装完直接运行。

**加音乐**：把文件或文件夹直接拖进窗口；或按 `P` 打开播放列表，点「添加文件 / 添加文件夹」。文件夹会递归扫描。

**换底图**（本产品的核心）：把图片直接拖进窗口，或右键黑胶唱片，或点右下角的星标。选完图皮肤面板会自动弹出，左边拖底图焦点，右边拖唱片取景、滚轮缩放。唱片中间的图默认跟着底图走，也可以单独指定另一张。

**调蒙版**：皮肤面板的「蒙版」页可以调边缘位置、羽化宽度、不透明度、边缘蜿蜒、呼吸强度。**「随音乐波动」拉到 0 以上，白雾边缘就会跟着音乐做竖向 S 型起伏。**

**改文案**：「文案」页可以改标题、副标题、年份、署名。

### 快捷键

| 键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `←` `→` | 快退 / 快进 5 秒 |
| `↑` `↓` | 音量 |
| `M` | 静音 |
| `P` | 播放列表 |
| `S` | 皮肤面板 |

键盘上的媒体键（播放/暂停、上一首、下一首）也可用，托盘图标右键同样能控制播放。窗口位置和尺寸会记住，音量、播放模式、曲库、当前曲目也会在下次启动时恢复。

## 开发

```bash
npm install
```

前端可以脱离 Tauri 单独跑，调视觉与播放逻辑都不必等 Rust 编译：

```bash
npm run dev
```

完整应用（需要 Rust 工具链，见 [TECH-DESIGN.md §1.3](docs/TECH-DESIGN.md)）：

```bash
npm run tauri dev
```

## 校验

```bash
npm test
```

```bash
node scripts/compare-visual.mjs --diag
```

```bash
node scripts/verify-skin.mjs
```

| 脚本 | 作用 |
| --- | --- |
| `npm test` | 47 个单元测试，覆盖 LRC 解析、洗牌、取景换算、配色对比度、格式化 |
| `compare-visual.mjs` | 与参考图对拍。核对黑胶坐标（精确判据），断言蒙版确由 WebGL 画出，SSIM 作回归绊线 |
| `verify-skin.mjs` | 端到端走一遍换底图路径，验证贴纸联动与配色更新 |
| `analyze-ref.mjs` | 从参考图实测蒙版边缘剖面，产出着色器参数 |
| `reference-ceiling.mjs` | 测定参考素材自身的 SSIM 上限，用于判定对拍阈值该定在哪 |

> `compare-visual.mjs` 与 `verify-skin.mjs` 需要 `npm run dev` 已在 1420 端口运行。

## 结构

```
src/
├─ platform/    唯一允许 import @tauri-apps/* 的地方；Tauri 与浏览器双实现
├─ stage/       渲染层：舞台缩放、底图、蒙版着色器、颗粒
├─ ui/          内容层组件与浮层面板
├─ audio/       播放引擎、频谱分析、波形峰值、元数据
├─ skin/        皮肤模型、取景换算、自动配色
├─ lyrics/      LRC 解析
└─ store/       Zustand：player / skin
src-tauri/      Rust 外壳，只做目录递归扫描与窗口
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 产品需求：功能清单、界面规格、验收标准、版本规划 |
| [docs/TECH-DESIGN.md](docs/TECH-DESIGN.md) | 技术设计：选型理由、架构、雾化蒙版着色器、音频引擎 |

## 参考资料

`design-ref/` 为只读参考，不参与构建。

| 文件 | 说明 |
| --- | --- |
| `target/ref-veil-primary.png` | 主参考图，白色蒙版与 UI 的基准。**右半部分那张大黑胶是多余元素，不实现** |
| `target/ref-dark-variant.png` | 全暗变体，没有白色蒙版 |
| `figma-make/figma-input.png` | 用户喂给 Figma 的原始参考 |
| `figma-make/figma-output-hard-edge.png` | Figma Make 的输出，蒙版右缘是一条硬边——本项目要解决的首要问题 |
| `figma-make/original-export.zip` | 原始导出包存档 |

## 许可

标题字体 Cormorant Garamond 采用 SIL OFL 1.1，许可证见 `src/assets/fonts/OFL.txt`。
