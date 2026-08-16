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
    let mut granted = 0usize;

    for p in paths {
        let path = std::path::PathBuf::from(&p);
        // 不存在的路径不放行：曲库里可能留着早已删掉的条目，
        // 没必要为它们把不存在的位置加进白名单
        if !path.exists() {
            continue;
        }
        let result = if path.is_dir() {
            scope.allow_directory(&path, true)
        } else {
            scope.allow_file(&path)
        };
        match result {
            Ok(()) => granted += 1,
            // 单条失败不该中断整批 —— 一个坏路径不能拖累整个曲库
            Err(e) => eprintln!("放行失败 {p}：{e}"),
        }
    }
    Ok(granted)
}
