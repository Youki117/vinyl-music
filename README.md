# Vinyl Player

一个以视觉为第一卖点的 Windows 本地音乐播放器：整屏是一张可随意更换的人物底图，左侧压一层向右雾化弥散的白色蒙版，蒙版上放置黑胶唱片与全套播放控件；黑胶中心的贴纸跟随底图自动切换。

**当前状态：设计阶段，尚未开始编码。**

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 产品需求：功能清单、界面规格、验收标准、版本规划 |
| [docs/TECH-DESIGN.md](docs/TECH-DESIGN.md) | 技术设计：选型理由、架构、雾化蒙版着色器、音频引擎、落地顺序 |

## 参考资料

`design-ref/` 目录为只读参考，不参与构建。

| 文件 | 说明 |
| --- | --- |
| `target/ref-ui-dark.png` | UI 与蒙版的基准效果图 |
| `target/ref-ui-dark-with-extra-disc.png` | 同上；**右半部分那张大黑胶是多余元素，不实现** |
| `figma-make/figma-output-hard-edge.png` | Figma Make 版本的输出，蒙版右缘是一条硬边 —— 本项目要解决的首要问题 |
| `figma-make/{App.tsx,index.css}` | Figma Make 版本源码，仅供对照 |
| `figma-make/original-export.zip` | 原始导出包存档 |

## 技术栈

Tauri v2 + React 19 + TypeScript + Vite 8，蒙版用裸 WebGL2 着色器。

开发前需先安装 Rust 工具链与 VS C++ 生成工具，见 [TECH-DESIGN.md §1.3](docs/TECH-DESIGN.md)。
