# 实测素材来源

这些文件**不入库**（约 24MB 的第三方作品），用 `node scripts/fetch-real-assets.mjs` 重新下载。
`scripts/verify-real.mjs` 依赖它们。

存在的理由：此前的测试音频全是 ffmpeg 生成的正弦波，标签是我自己写的、时长规整、没有内嵌封面、没有歌词。
真实文件的元数据千奇百怪，只有拿真东西跑才照得出问题——第一次跑就照出了三个：
OGG 时长读不出、内嵌封面提取了却从没显示、英文歌词把版面撑破。

## 音频

来自 [archive.org](https://archive.org) 的 netlabel 发行，带真实 ID3 / Vorbis 标签。

| 文件 | 出处 | 许可 |
| --- | --- | --- |
| `ProleteR - April Showers.mp3` | [DWK123](https://archive.org/details/DWK123) · Dusted Wax Kingdom | CC BY-NC-ND 3.0 |
| `ProleteR - Downtown Irony.ogg` | 同上 | CC BY-NC-ND 3.0 |
| `Riding Alone - Lullaby.ogg` | [badpanda018](https://archive.org/details/badpanda018) | CC BY-NC-SA 3.0 |
| `Multi Panel - Christmas With Mr Rice.mp3` | [NS050](https://archive.org/details/NS050) · No-Source Netlabel | CC BY-NC-SA 4.0 |

选它们的原因：四个文件覆盖 MP3 与 OGG 两种容器；只有 `Christmas With Mr Rice` 带内嵌封面
（mjpeg 250×250），正好用来验证"有封面用封面、没封面留空盘"两条分支。

## 歌词

| 文件 | 出处 | 说明 |
| --- | --- | --- |
| `ProleteR - April Showers.lrc` | [lrclib.net](https://lrclib.net) | **真实的行级同步歌词**。数据库里这首标注时长 269s，音频实测 269.06s，对得上。里头带一条 `[01:21.72] ` 空标记（间奏起点），是现实中很常见、之前会被我们丢掉的写法 |
| `ProleteR - Downtown Irony.lrc` | 由上面那份派生 | **词级时间戳是插值出来的，不是人工打轴**。用 `scripts/make-word-lrc.mjs` 按各词字符数等比分配行内时长 |

为什么逐字歌词要自己造：公开渠道（LRCLIB 等）提供的都是行级歌词，
主流平台的逐字格式（QRC / KRC）是加密私有的，拿不到合法样本。
真实的逐字歌词节奏并不均匀，所以这份派生数据只能验证**解析与渲染管线**，
验证不了打轴质量。

## 图片

来自 [Wikimedia Commons](https://commons.wikimedia.org)，按 1500px 宽的缩略图下载。

| 文件 | 原作 | 许可 |
| --- | --- | --- |
| `backdrop-1.jpg` | A Tibetan Pilgrim Lighting Ghee Lamps | CC BY-SA 4.0 |
| `backdrop-2.jpg` | A smoky day at the Sugar Bowl—Hupa（Edward S. Curtis, 1923） | 公有领域 |

## 歌单

`测试歌单.m3u` 是手写的，**入库**。故意写得不干净：混用正反斜杠、含一条指向不存在盘符的失效路径、
顺序与曲库添加顺序不同——用来验证导入时的容错、按文件名兜底匹配、以及顺序保持。
