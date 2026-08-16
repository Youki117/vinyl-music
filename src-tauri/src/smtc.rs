//! Windows 系统媒体传输控件（SMTC）—— 任务栏缩略图与锁屏上的那个音乐控件。
//!
//! 与媒体键的区别：媒体键是全局快捷键，只管收指令；SMTC 还要**往外报**当前在放
//! 什么，系统才会显示曲名、艺术家、封面，以及那一排上一首/播放/下一首。
//!
//! 事件回来后仍旧走已有的 `player://command` 通道，前端不区分来源。

use std::sync::Mutex;

use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
use tauri::{Emitter, Manager};

use crate::EVT_COMMAND;

/// SMTC 句柄。
///
/// 包一层 Mutex 是因为它要挂进 Tauri 的托管状态，而托管状态要求 Send + Sync。
/// 里面是 COM 对象，只允许一个线程碰，Mutex 正好也保证了这点。
pub struct Smtc(pub Mutex<Option<MediaControls>>);

/// 前端传过来的"正在播放什么"
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    /// 秒
    pub duration: f64,
    pub position: f64,
    /// 封面文件的绝对路径；没有就不设
    pub cover_path: Option<String>,
}

pub fn init(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("找不到主窗口")?;

    // SMTC 要挂在一个真实窗口上，拿不到句柄就没法注册
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as *mut std::ffi::c_void,
        Err(e) => {
            eprintln!("SMTC：取窗口句柄失败，跳过（{e}）");
            app.manage(Smtc(Mutex::new(None)));
            return Ok(());
        }
    };

    let config = PlatformConfig {
        dbus_name: "vinyl_player",
        display_name: "Vinyl Player",
        hwnd: Some(hwnd),
    };

    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            // 注册失败不该让应用起不来 —— 媒体键与托盘仍然可用
            eprintln!("SMTC：注册失败，跳过（{e:?}）");
            app.manage(Smtc(Mutex::new(None)));
            return Ok(());
        }
    };

    let handle = app.clone();
    if let Err(e) = controls.attach(move |event: MediaControlEvent| {
        let cmd = match event {
            MediaControlEvent::Play | MediaControlEvent::Pause | MediaControlEvent::Toggle => "toggle",
            MediaControlEvent::Next => "next",
            MediaControlEvent::Previous => "prev",
            MediaControlEvent::Stop => "pause",
            _ => return,
        };
        let _ = handle.emit(EVT_COMMAND, cmd);
    }) {
        eprintln!("SMTC：挂接事件失败，跳过（{e:?}）");
        app.manage(Smtc(Mutex::new(None)));
        return Ok(());
    }

    app.manage(Smtc(Mutex::new(Some(controls))));
    Ok(())
}

/// 把当前曲目报给系统。前端在切歌、播放/暂停、跳转时调用。
#[tauri::command]
pub fn smtc_update(state: tauri::State<'_, Smtc>, info: NowPlaying) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let Some(controls) = guard.as_mut() else {
        // 没注册成功，静默忽略：这只是锦上添花，不该把调用方拖down
        return Ok(());
    };

    // souvlaki 对 file:// 的处理是 `url.trim_start_matches("file://")`，
    // 剩下的直接喂给 StorageFile::GetFileFromPathAsync。所以这里**不能**写成
    // 规范的 `file:///C:/...` —— 那样剪完会剩个前导斜杠（`/C:/...`），
    // 不是合法的 Windows 路径，缩略图会静默地设不上。
    // 正确写法是 file:// 后面直接跟原生路径。
    let cover = info
        .cover_path
        .as_ref()
        .map(|p| format!("file://{}", p.replace('/', "\\")));

    let _ = controls.set_metadata(MediaMetadata {
        title: Some(&info.title),
        artist: if info.artist.is_empty() { None } else { Some(&info.artist) },
        album: if info.album.is_empty() { None } else { Some(&info.album) },
        duration: if info.duration > 0.0 {
            Some(std::time::Duration::from_secs_f64(info.duration))
        } else {
            None
        },
        cover_url: cover.as_deref(),
    });

    let progress = Some(MediaPosition(std::time::Duration::from_secs_f64(
        info.position.max(0.0),
    )));
    let _ = controls.set_playback(if info.playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    });

    Ok(())
}
