mod grant;
mod scan;
#[cfg(target_os = "windows")]
mod smtc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// 前端约定的事件名。媒体键、托盘菜单、系统媒体面板都转成同一套事件，
/// 前端只认事件不认来源。
pub(crate) const EVT_COMMAND: &str = "player://command";
/// 命令行/拖拽带进来的文件
const EVT_OPEN_FILES: &str = "player://open-files";

/// Rust 侧保持极薄：只做 WebView 做不了或做不快的事。
/// 播放、渲染、状态管理全部在前端。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // 单实例：重复启动时激活已有窗口，并把命令行里的文件交给前端
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let files = playable_args(argv.into_iter().skip(1));
            if !files.is_empty() {
                let _ = app.emit(EVT_OPEN_FILES, files);
            }
        }));
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(desktop)]
            setup_media_keys(app.handle())?;
            setup_tray(app.handle())?;
            // 首次启动的命令行参数（"打开方式"、拖到 exe 上、命令行直接带文件）。
            // 之前只在单实例重复启动时处理了 argv，首次启动整个漏掉，
            // 而前端也没人监听这个事件 —— 等于这条路从来没通过。
            #[cfg(desktop)]
            emit_startup_files(app.handle());
            #[cfg(target_os = "windows")]
            smtc::init(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan::scan_audio_files,
            grant::allow_paths,
            #[cfg(target_os = "windows")]
            smtc::smtc_update
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

/// 从命令行参数里挑出真正存在的文件。
///
/// 只认存在于磁盘上的路径：命令行里可能混着开关、也可能是别的什么东西，
/// 拿去当曲目会在前端产生一串莫名其妙的导入失败。
fn playable_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).is_file())
        .collect()
}

/// 首次启动时把命令行里带的文件发给前端。
#[cfg(desktop)]
fn emit_startup_files(app: &tauri::AppHandle) {
    let files = playable_args(std::env::args().skip(1));
    if files.is_empty() {
        return;
    }
    // 前端此刻还没挂上监听，延后一拍再发
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let _ = handle.emit(EVT_OPEN_FILES, files);
    });
}

/// 键盘媒体键。注册失败不该让应用起不来 —— 别的播放器可能已经占用了。
#[cfg(desktop)]
fn setup_media_keys(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

    let handle = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let cmd = match shortcut.key {
                    Code::MediaPlayPause => "toggle",
                    Code::MediaTrackNext => "next",
                    Code::MediaTrackPrevious => "prev",
                    Code::MediaStop => "pause",
                    _ => return,
                };
                let _ = handle.emit(EVT_COMMAND, cmd);
            })
            .build(),
    )?;

    for code in [
        Code::MediaPlayPause,
        Code::MediaTrackNext,
        Code::MediaTrackPrevious,
        Code::MediaStop,
    ] {
        if let Err(e) = app.global_shortcut().register(Shortcut::new(None, code)) {
            eprintln!("媒体键 {code:?} 注册失败（可能被其他程序占用）：{e}");
        }
    }
    Ok(())
}

fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let toggle = MenuItem::with_id(app, "toggle", "播放 / 暂停", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "上一首", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &prev, &next, &show, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Vinyl Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            other => {
                let _ = app.emit(EVT_COMMAND, other);
            }
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}
