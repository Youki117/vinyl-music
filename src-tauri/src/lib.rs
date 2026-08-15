mod scan;

/// Rust 侧保持极薄：只做 WebView 做不了或做不快的事。
/// 播放、渲染、状态管理全部在前端。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![scan::scan_audio_files])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
