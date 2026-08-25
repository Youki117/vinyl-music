use std::path::Path;

use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// 把用户明确交给应用的路径加进 fs 运行时能力域。
///
/// 为什么需要这个：capabilities 里的 `fs:scope` 是一份静态白名单，只列了
/// `$AUDIO`、`$HOME/Music`、`$DOWNLOAD` 等几个标准目录。文件对话框选中的文件由
/// dialog 插件自动放行，但**拖放进来的文件不会** —— 实测把 `D:\Project\…` 下的
/// mp3 拖进打包后的应用，读取直接报 `forbidden path`。而拖放恰恰是 README 里
/// 推荐的首选导入方式，很多人的音乐库也确实不在这几个标准目录里。
///
/// 与其把 scope 放开成 `**`（等于取消这道防线），不如按用户的实际动作逐个放行：
/// 拖进来的、命令行传进来的、上次已经导入过的，才允许读。没被点过名的路径依旧读不了。
#[tauri::command]
pub fn allow_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let scope = app.fs_scope();
    Ok(grant_each(paths, |path, is_dir| {
        if is_dir {
            scope.allow_directory(path, true).map_err(|e| e.to_string())
        } else {
            scope.allow_file(path).map_err(|e| e.to_string())
        }
    }))
}

/// 把路径加进 **asset 协议**的运行时能力域。
///
/// asset 协议有**自己独立的一份 scope**，和上面那个 fs scope 是两套东西：
/// `allow_paths` 放行的路径，`asset://` 照样会 403（源码见 tauri 的
/// `protocol/asset.rs`，它查的是 `asset_protocol_scope`）。而 403 在 `<video>` 上
/// 表现为"没有可用的源"—— 不抛错，只是一片空白，最难查的那种。
///
/// 故意做成独立命令而不是并进 `allow_paths`：走 asset 协议的只有视频底图这一类，
/// 顺手把每一首导入的音频也放进 asset 域是没必要的扩权。谁用谁申请。
#[tauri::command]
pub fn allow_asset_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let scope = app.asset_protocol_scope();
    Ok(grant_each(paths, |path, is_dir| {
        if is_dir {
            scope.allow_directory(path, true).map_err(|e| e.to_string())
        } else {
            scope.allow_file(path).map_err(|e| e.to_string())
        }
    }))
}

/// 逐条放行，返回成功的条数。两个 scope 的类型不同（一个来自 fs 插件、一个来自
/// tauri 本体），共用不了同一个句柄，但"怎么放"这套规则必须一致，所以抽在这里。
fn grant_each(
    paths: Vec<String>,
    mut allow: impl FnMut(&Path, bool) -> Result<(), String>,
) -> usize {
    let mut granted = 0usize;

    for p in paths {
        let path = std::path::PathBuf::from(&p);
        // 不存在的路径不放行：曲库里可能留着早已删掉的条目，
        // 没必要为它们把不存在的位置加进白名单
        if !path.exists() {
            continue;
        }
        match allow(&path, path.is_dir()) {
            Ok(()) => granted += 1,
            // 单条失败不该中断整批 —— 一个坏路径不能拖累整个曲库
            Err(e) => eprintln!("放行失败 {p}：{e}"),
        }
    }

    granted
}
