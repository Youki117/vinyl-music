//! 窗口保持设计比例（1243:688，见前端 src/stage/useStageFit.ts 的 DESIGN_W/H）。
//!
//! 做法：用 SetWindowSubclass 挂到 WM_SIZING 上，在拖拽过程中直接修正拖动矩形，
//! 无闪烁、无回弹 —— 这是"窗口只能等比缩放"的标准做法。
//!
//! 最大化 / 全屏不经过 WM_SIZING，窗口会变成屏幕尺寸、比例必然失配；这种情况
//! 由前端在比例失配时切到 cover 铺满处理（见 useStageFit.ts），这里不管。

use tauri::Manager;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    WM_SIZING, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP,
    WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
};

/// 与前端 src/stage/useStageFit.ts 的 DESIGN_W/H 保持一致，改前端这里要一起改。
const DESIGN_W: f64 = 1243.0;
const DESIGN_H: f64 = 688.0;
const ASPECT: f64 = DESIGN_W / DESIGN_H;

/// 最小尺寸。与 tauri.conf.json 的 minWidth/minHeight 保持一致且满足比例。
const MIN_W: i32 = 780;
const MIN_H: i32 = 432;

/// 子类化 id，随便一个与其它子类不冲突的值。
const SUBCLASS_ID: usize = 0xA517;

/// 把宽度/高度钳到最小尺寸，且二者同时满足比例。
fn clamp(w: i32, h: i32) -> (i32, i32) {
    let (mut w, mut h) = (w, h);
    if w < MIN_W {
        w = MIN_W;
        h = (MIN_W as f64 / ASPECT).round() as i32;
    }
    if h < MIN_H {
        h = MIN_H;
        w = (MIN_H as f64 * ASPECT).round() as i32;
    }
    (w, h)
}

unsafe extern "system" fn sizing_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id_subclass: usize,
    _ref_data: usize,
) -> LRESULT {
    if msg == WM_SIZING {
        let rect = &mut *(lparam as *mut RECT);
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;

        // 以用户正在拖的那条轴为准，另一轴按比例推导；角落则看哪个方向偏得多就锁哪个。
        let edge = wparam as u32;
        let (w, h) = match edge {
            WMSZ_LEFT | WMSZ_RIGHT => (w, (w as f64 / ASPECT).round() as i32),
            WMSZ_TOP | WMSZ_BOTTOM => ((h as f64 * ASPECT).round() as i32, h),
            WMSZ_TOPLEFT | WMSZ_TOPRIGHT | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT => {
                let want_w = h as f64 * ASPECT;
                let want_h = w as f64 / ASPECT;
                if (w as f64 - want_w).abs() > (h as f64 - want_h).abs() {
                    (w, want_h.round() as i32)
                } else {
                    (want_w.round() as i32, h)
                }
            }
            _ => (w, h),
        };
        let (w, h) = clamp(w, h);

        let (left, top, right, bottom) = (rect.left, rect.top, rect.right, rect.bottom);
        match edge {
            WMSZ_LEFT => {
                rect.left = right - w;
                rect.top = bottom - h;
            }
            WMSZ_RIGHT => {
                rect.right = left + w;
                rect.bottom = top + h;
            }
            WMSZ_TOP => {
                rect.top = bottom - h;
                rect.right = left + w;
            }
            WMSZ_BOTTOM => {
                rect.bottom = top + h;
                rect.right = left + w;
            }
            WMSZ_TOPLEFT => {
                rect.left = right - w;
                rect.top = bottom - h;
            }
            WMSZ_TOPRIGHT => {
                rect.right = left + w;
                rect.top = bottom - h;
            }
            WMSZ_BOTTOMLEFT => {
                rect.left = right - w;
                rect.bottom = top + h;
            }
            WMSZ_BOTTOMRIGHT => {
                rect.right = left + w;
                rect.bottom = top + h;
            }
            _ => {}
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// 给主窗口装上比例锁定。窗口必须已创建。
///
/// 顺带把启动时恢复过来的尺寸（旧版本存过 1220×688 之类）归一化到设计比例，
/// 否则每次启动都会先以失配比例闪一帧。
pub fn install(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if let Ok(h) = window.hwnd() {
        let hwnd = h.0 as *mut core::ffi::c_void;
        unsafe {
            SetWindowSubclass(hwnd, Some(sizing_proc), SUBCLASS_ID, 0);
        }
    }

    // 归一化启动尺寸（旧版本可能存过 1220×688 这类失配尺寸）。窗口没有边框，outer == inner。
    if let Ok(size) = window.inner_size() {
        let (w, h) = (size.width as i32, size.height as i32);
        let (nw, nh) = if (w as f64 / h as f64 - ASPECT).abs() > 0.005 {
            // 比例失配：以更贴近目标比例的那条轴为基准，另一条按比例推导
            if (w as f64 - h as f64 * ASPECT).abs() < (h as f64 - w as f64 / ASPECT).abs() {
                (w, (w as f64 / ASPECT).round() as i32)
            } else {
                ((h as f64 * ASPECT).round() as i32, h)
            }
        } else {
            (w, h)
        };
        let (nw, nh) = clamp(nw, nh);
        if nw != w || nh != h {
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(nw as u32, nh as u32)));
        }
    }
}