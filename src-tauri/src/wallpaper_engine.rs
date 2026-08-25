//! Wallpaper Engine 壁纸发现（Tier 1：只接 video / image 两类）。
//!
//! 策略照搬 Mineradio 的结论：**不重写 Wallpaper Engine，只读它的数据**。
//! scene/web/application 三类要么需要官方引擎渲染、要么是第三方 HTML，
//! 本项目一律不碰 —— 列表里给出来也没有意义，直接过滤。
//!
//! 发现链路与上游一致：
//!   注册表定位 Steam → libraryfolders.vdf 展开所有库 →
//!   `steamapps/workshop/content/431960`（WE 的 AppID）与
//!   `steamapps/common/wallpaper_engine/projects/myprojects` 两个容器里
//!   找 `project.json`，解析 type/title/file/preview。
//!
//! 读文件（媒体与预览）不走这条命令 —— 前端拿到路径后走既有的
//! allow_paths + readFile 通道，能力域管理与普通底图完全一致。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 一个可列出的 WE 壁纸。media 只有 video/image 才有。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeWallpaper {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub media: Option<String>,
    pub preview: Option<String>,
}

/// WE 的 AppID（Steam 创意工坊容器目录名）。
const WE_APPID: &str = "431960";
/// 防御性上限：正常用户订阅量在几百以内，这个数只挡异常目录。
const MAX_WALLPAPERS: usize = 2000;

/// 前端来列本机 Wallpaper Engine 的壁纸。没装 Steam/WE 时返回空列表。
///
/// **`(async)` 不是装饰**：Tauri 文档原话是「没有 async 关键字的命令在主线程执行」，
/// 而这里要遍历所有 Steam 库、逐个目录读 `project.json` —— 订阅量大或冷盘时是几百次
/// 同步 IO，摊在主线程上就是打开皮肤面板卡一下。函数体本身是阻塞的，用
/// `#[tauri::command(async)]` 把它挪到独立线程，签名不用改成 async fn。
///
/// 与 `scan_audio_files` 的区别值得说一句：那个也是同步的，但它由"我拖了个文件夹进来"
/// 触发，用户对卡顿有预期；这个是**开面板就跑**，没有任何用户动作对应得上。
#[tauri::command(async)]
pub fn list_we_wallpapers() -> Vec<WeWallpaper> {
    let mut out: Vec<WeWallpaper> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for lib in steam_libraries() {
        let containers = [
            lib.join("steamapps").join("workshop").join("content").join(WE_APPID),
            // 本地自建项目（WE 编辑器的"我的项目"），目录名任意，加前缀防止与工坊数字 id 撞车
            lib.join("steamapps")
                .join("common")
                .join("wallpaper_engine")
                .join("projects")
                .join("myprojects"),
        ];

        for (index, container) in containers.iter().enumerate() {
            let entries = match fs::read_dir(container) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.filter_map(|e| e.ok()) {
                if out.len() >= MAX_WALLPAPERS {
                    return sort_wallpapers(out);
                }
                let path = entry.path();
                if !path.is_dir() || !path.join("project.json").is_file() {
                    continue;
                }
                let raw_id = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                let id = if index == 0 { raw_id } else { format!("my:{raw_id}") };
                // 同一个库可能被多条 Steam 根重复展开，按 id 去重
                if seen.contains(&id) {
                    continue;
                }
                if let Some(w) = index_project(&path, id.clone()) {
                    seen.insert(id);
                    out.push(w);
                }
            }
        }
    }

    sort_wallpapers(out)
}

fn sort_wallpapers(mut list: Vec<WeWallpaper>) -> Vec<WeWallpaper> {
    // cached_key 而不是 sort_by：后者会在每次比较里各分配一个小写副本，
    // 两千条就是几万次多余分配（clippy 的 unnecessary_sort_by 也盯着这一条）
    list.sort_by_cached_key(|w| w.title.to_lowercase());
    list
}

/// 解析单个壁纸目录的 project.json。
fn index_project(dir: &Path, id: String) -> Option<WeWallpaper> {
    let raw = fs::read_to_string(dir.join("project.json")).ok()?;
    // WE 的 project.json 常见 UTF-8 BOM，serde_json 不认，先剥掉
    let raw = raw.trim_start_matches('\u{feff}');
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;

    let kind = v
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("unknown")
        .to_lowercase();
    let mut title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        title = id.trim_start_matches("my:").to_string();
    }

    // 只有 video/image 给出媒体路径；其余类型 media=None，前端直接过滤
    let media = if kind == "video" || kind == "image" {
        v.get("file")
            .and_then(|f| f.as_str())
            .and_then(|f| resolve_in_dir(dir, f))
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };

    let preview = resolve_preview(dir, &v);

    Some(WeWallpaper {
        id,
        title,
        kind,
        media,
        preview,
    })
}

/// 预览图：project.json 的 preview/cover/poster 字段优先，都不存在时退回约定文件名。
fn resolve_preview(dir: &Path, v: &serde_json::Value) -> Option<String> {
    for key in ["preview", "cover", "poster"] {
        if let Some(p) = v
            .get(key)
            .and_then(|p| p.as_str())
            .and_then(|p| resolve_in_dir(dir, p))
        {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    for name in ["preview.jpg", "preview.png"] {
        if let Some(p) = resolve_in_dir(dir, name) {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

/// 把 project.json 里的一个相对路径落到壁纸目录内，**并确认它没跑出去**。
///
/// `file` / `preview` 这些字段来自第三方（订阅来的工坊内容），而 `Path::join` 遇到
/// 绝对路径会整个替换 base、`..` 也不做归一化。少了这道检查，一条
/// `"file": "C:\\Users\\...\\某个文件"` 就能让前端把库外的任意文件放进 asset 能力域
/// 再喂给 `<video>` / canvas —— 等于让工坊内容替用户决定放行哪条路径。
///
/// 返回的是**原始拼法**而不是 canonicalize 的结果：Windows 上后者带 `\\?\` verbatim
/// 前缀，这种路径传到前端会一路出问题。规范化只用来做包含性判断（顺带把符号链接
/// 指到库外的情形也挡掉）。
fn resolve_in_dir(dir: &Path, entry: &str) -> Option<PathBuf> {
    if entry.is_empty() {
        return None;
    }
    let full = dir.join(entry);
    if !full.is_file() {
        return None;
    }
    let base = dir.canonicalize().ok()?;
    if !full.canonicalize().ok()?.starts_with(&base) {
        return None;
    }
    Some(full)
}

/// 所有 Steam 库根目录（去重）。Steam 根自身也是一个库。
fn steam_libraries() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for p in steam_install_paths() {
        push_unique(&mut roots, PathBuf::from(&p));
        let text = fs::read_to_string(PathBuf::from(&p).join("steamapps").join("libraryfolders.vdf"))
            .or_else(|_| {
                fs::read_to_string(PathBuf::from(&p).join("config").join("libraryfolders.vdf"))
            });
        if let Ok(text) = text {
            for path in vdf_paths(&text) {
                push_unique(&mut roots, PathBuf::from(path));
            }
        }
    }
    roots
}

fn push_unique(list: &mut Vec<PathBuf>, p: PathBuf) {
    let key = p.to_string_lossy().to_lowercase();
    if !list.iter().any(|x| x.to_string_lossy().to_lowercase() == key) {
        list.push(p);
    }
}

/// 注册表 + 兜底路径，拿到所有可能的 Steam 安装根。
#[cfg(target_os = "windows")]
fn steam_install_paths() -> Vec<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut out = vec!["C:\\Program Files (x86)\\Steam".to_string()];
    let mut push = |hive: RegKey, sub: &str, value: &str| {
        if let Ok(k) = hive.open_subkey(sub) {
            if let Ok(v) = k.get_value::<String, _>(value) {
                // SteamPath 用的是正斜杠，统一成 Windows 形态
                out.push(v.replace('/', "\\"));
            }
        }
    };
    push(
        RegKey::predef(HKEY_CURRENT_USER),
        "Software\\Valve\\Steam",
        "SteamPath",
    );
    push(
        RegKey::predef(HKEY_LOCAL_MACHINE),
        "SOFTWARE\\WOW6432Node\\Valve\\Steam",
        "InstallPath",
    );
    push(
        RegKey::predef(HKEY_LOCAL_MACHINE),
        "Software\\Valve\\Steam",
        "InstallPath",
    );
    out
}

#[cfg(not(target_os = "windows"))]
fn steam_install_paths() -> Vec<String> {
    vec![
        "C:\\Program Files (x86)\\Steam".to_string(),
        format!("{}/.steam/steam", std::env::var("HOME").unwrap_or_default()),
    ]
}

/// 从 libraryfolders.vdf 里抠出所有 `"path" "..."` 的值。
/// VDF 是 Valve 的私货格式，但库路径只需要这一种形态，正则级解析足够；
/// 反斜杠在 VDF 里转义成 `\\`，这里还原。
fn vdf_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if !t.starts_with("\"path\"") {
            continue;
        }
        // 形如 "path"    "D:\\SteamLibrary" —— 按引号切，第 4 段是值
        let parts: Vec<&str> = t.split('"').collect();
        if parts.len() >= 4 {
            let value = parts[3].replace("\\\\", "\\");
            if !value.is_empty() {
                out.push(value);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vdf_paths_extracts_all_libraries_and_unescapes() {
        let vdf = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
	"2"
	{
		"path"		"E:\\Games\\Steam"
		"label"		"games"
	}
}
"#;
        let got = vdf_paths(vdf);
        assert_eq!(
            got,
            vec![
                "C:\\Program Files (x86)\\Steam",
                "D:\\SteamLibrary",
                "E:\\Games\\Steam"
            ]
        );
    }

    #[test]
    fn vdf_paths_ignores_other_keys_and_empty_values() {
        assert!(vdf_paths("\"path\" \"\"").is_empty());
        assert!(vdf_paths("\"size\" \"123\"").is_empty());
    }

    fn write(p: &Path, bytes: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    #[test]
    fn index_project_reads_video_wallpaper_with_preview_fallback() {
        let dir = std::env::temp_dir().join("vinyl_we_test_video");
        let _ = fs::remove_dir_all(&dir);
        write(
            &dir.join("project.json"),
            "\u{feff}{\"type\":\"video\",\"title\":\"测试壁纸\",\"file\":\"主视频.mp4\",\"preview\":\"预览.jpg\"}".as_bytes(),
        );
        write(&dir.join("主视频.mp4"), b"x");
        write(&dir.join("预览.jpg"), b"x");

        let w = index_project(&dir, "123".into()).unwrap();
        assert_eq!(w.kind, "video");
        assert_eq!(w.title, "测试壁纸");
        assert_eq!(w.media, Some(dir.join("主视频.mp4").to_string_lossy().into_owned()));
        assert_eq!(w.preview, Some(dir.join("预览.jpg").to_string_lossy().into_owned()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_project_scene_gets_no_media_but_keeps_preview() {
        let dir = std::env::temp_dir().join("vinyl_we_test_scene");
        let _ = fs::remove_dir_all(&dir);
        write(
            &dir.join("project.json"),
            r#"{"type":"scene","title":"particles","file":"scene.json"}"#.as_bytes(),
        );
        write(&dir.join("scene.json"), b"{}");
        write(&dir.join("preview.jpg"), b"x");

        let w = index_project(&dir, "456".into()).unwrap();
        assert_eq!(w.kind, "scene");
        assert_eq!(w.media, None, "scene 不给 media，前端据此过滤");
        assert_eq!(w.preview, Some(dir.join("preview.jpg").to_string_lossy().into_owned()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_project_missing_media_file_yields_none() {
        let dir = std::env::temp_dir().join("vinyl_we_test_missing");
        let _ = fs::remove_dir_all(&dir);
        write(
            &dir.join("project.json"),
            br#"{"type":"video","title":"ghost","file":"gone.mp4"}"#,
        );

        let w = index_project(&dir, "789".into()).unwrap();
        assert_eq!(w.media, None, "file 字段指向不存在的文件时不能给出死路径");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_project_rejects_paths_outside_the_wallpaper_dir() {
        // 工坊内容是第三方数据。绝对路径（Path::join 会整个替换 base）和 ..（join 不
        // 归一化）都不能把 media/preview 指到目录外 —— 那等于让别人的 project.json
        // 决定前端把哪条路径放进 asset 能力域。
        let root = std::env::temp_dir().join("vinyl_we_test_escape");
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("wallpaper");
        let outside = root.join("库外文件.mp4");
        write(&outside, b"x");
        let abs = outside.to_string_lossy().replace('\\', "\\\\");
        write(
            &dir.join("project.json"),
            format!(
                r#"{{"type":"video","title":"t","file":"{abs}","preview":"../库外文件.mp4"}}"#
            )
            .as_bytes(),
        );

        let w = index_project(&dir, "999".into()).unwrap();
        assert_eq!(w.media, None, "绝对路径必须被挡下");
        assert_eq!(w.preview, None, ".. 逃逸必须被挡下");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_we_wallpapers_survives_machine_without_steam() {
        // 没装 Steam 的机器上必须返回空列表而不是 panic —— 这条路每次打开皮肤面板都会走
        let got = list_we_wallpapers();
        assert!(got.len() <= MAX_WALLPAPERS);
    }
}
