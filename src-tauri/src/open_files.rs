//! 启动文件的托管队列。
//!
//! setup 那一刻 WebView 还没起来，前端听不了事件；早先靠睡 1200ms 赌监听就位，
//! 慢机器上会静默丢文件。现在改成**存着等前端来取**：前端挂好 onOpenFiles 监听后
//! invoke [`take_open_files`]，把这份队列一次性拿走。之后来的文件（单实例二次启动）
//! 仍走 `player://open-files` 事件。

use std::sync::Mutex;

/// 启动参数里带来的、还没交付给前端的文件。
pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

/// 前端来取启动文件。原子取出（取完即空），同一批不会被交付两次。
#[tauri::command]
pub fn take_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("PendingOpenFiles 锁中毒"))
}
