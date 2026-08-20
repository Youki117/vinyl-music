use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use tauri_plugin_fs::FsExt;

/// 单次切片的上限。
///
/// 元数据解析只读文件头（ogg 另补读尾部），几百 KB 绰绰有余。设上限是为了防止
/// 前端一时传错长度，把整首无损又拉进内存 —— 那正是这条命令要消灭的事。
const MAX_SLICE: u64 = 8 * 1024 * 1024;

/// 读取文件的一段字节。
///
/// 为什么需要它：导入一千首歌时，为读几百字节的标签，plugin-fs 的 readFile 要把
/// 每个文件整个过一遍 IPC。无损单曲动辄几十 MB，实测导入峰值 701MB，绝大部分是
/// 这些读完就扔的字节。改成按需切片后，一首歌通常只过一次 256KB。
///
/// 返回裸字节而不是 JSON 数组：JSON 编码会把每个字节膨胀成几个字符，
/// 光编解码就能吃掉省下来的时间。
#[tauri::command]
pub fn read_file_slice(
    app: tauri::AppHandle,
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    if length > MAX_SLICE {
        return Err(format!("切片过大：{length} 字节，上限 {MAX_SLICE}"));
    }

    // 与 plugin-fs 走同一道能力域。绕过它就等于把 fs:scope 放成 `**`，
    // grant.rs 里那条「按用户实际动作逐个放行」的防线也就白设了。
    let p = std::path::PathBuf::from(&path);
    if !app.fs_scope().is_allowed(&p) {
        return Err(format!("路径不在能力域内：{path}"));
    }

    let mut file = File::open(&p).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if offset >= size {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }

    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;

    // 越过文件尾就给多少算多少，不报错：tokenizer 读尾部时并不知道确切还能读到
    // 多少字节，让它按实际拿到的长度自己判断，比在这里失败更好用。
    let want = length.min(size - offset);
    let mut buf = Vec::with_capacity(want as usize);
    file.take(want)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;

    Ok(tauri::ipc::Response::new(buf))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Read, Seek, SeekFrom};

    /// 把命令体里不依赖 AppHandle 的那段读取逻辑单独验一遍。
    /// 能力域检查需要一个真实的 Tauri 应用，留给集成测试。
    fn read_at(path: &std::path::Path, offset: u64, length: u64) -> Vec<u8> {
        let mut file = fs::File::open(path).unwrap();
        let size = file.metadata().unwrap().len();
        if offset >= size {
            return Vec::new();
        }
        file.seek(SeekFrom::Start(offset)).unwrap();
        let want = length.min(size - offset);
        let mut buf = Vec::with_capacity(want as usize);
        file.take(want).read_to_end(&mut buf).unwrap();
        buf
    }

    #[test]
    fn reads_head_middle_and_clamped_tail() {
        let dir = std::env::temp_dir().join("vinyl_slice_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.bin");
        fs::write(&f, b"0123456789").unwrap();

        assert_eq!(read_at(&f, 0, 4), b"0123", "头部");
        assert_eq!(read_at(&f, 4, 3), b"456", "中段");
        // 尾部越界应截断而不是报错
        assert_eq!(read_at(&f, 7, 100), b"789", "尾部越界应截断");
        // 起点越界给空，不报错
        assert_eq!(read_at(&f, 10, 4), b"", "起点越界给空");
        assert_eq!(read_at(&f, 99, 4), b"", "起点远越界给空");

        let _ = fs::remove_dir_all(&dir);
    }
}
