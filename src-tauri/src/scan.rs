use std::time::UNIX_EPOCH;

use serde::Serialize;
use walkdir::WalkDir;

/// 受支持的音频扩展名，与前端 platform/types.ts 的 AUDIO_EXTENSIONS 保持一致。
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"];

#[derive(Serialize)]
pub struct ScannedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// 毫秒时间戳
    pub mtime: u64,
}

/// 递归扫描目录下的音频文件。
///
/// 放在 Rust 侧而不是前端逐层 readDir：1000 首歌意味着上千次 IPC 往返，
/// 达不到 PRD F2.6 要求的 15 秒。
#[tauri::command]
pub fn scan_audio_files(dir: String) -> Result<Vec<ScannedFile>, String> {
    let mut out = Vec::new();

    for entry in WalkDir::new(&dir)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        // 跳过无权限的目录而不是整个扫描失败
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let is_audio = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_audio {
            continue;
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        out.push(ScannedFile {
            path: path.to_string_lossy().into_owned(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size: meta.len(),
            mtime,
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn collects_only_audio_files_case_insensitively() {
        let dir = std::env::temp_dir().join("vinyl_scan_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("b.mp3"), b"x").unwrap();
        fs::write(dir.join("a.txt"), b"x").unwrap();
        fs::write(dir.join("sub/c.FLAC"), b"x").unwrap();

        let found = scan_audio_files(dir.to_string_lossy().into_owned()).unwrap();
        let names: Vec<_> = found.iter().map(|f| f.name.clone()).collect();

        assert_eq!(names.len(), 2, "只应收到 2 个音频文件，实际 {names:?}");
        assert!(names.contains(&"b.mp3".to_string()));
        assert!(names.contains(&"c.FLAC".to_string()), "扩展名大小写应不敏感");

        let _ = fs::remove_dir_all(&dir);
    }
}
