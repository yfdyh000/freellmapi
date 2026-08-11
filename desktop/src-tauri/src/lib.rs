use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 31415;

/// Shell state: the spawned sidecar child (killed on exit), the dashboard
/// session token (auto-login), the unified API key (copy-key), the resolved
/// server port, and a pending port for when READY arrives before TOKEN
/// (either order must work).
#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    token: Mutex<Option<String>>,
    api_key: Mutex<Option<String>>,
    port: Mutex<Option<u16>>,
    strings: Mutex<Option<serde_json::Value>>,
    pending_port: Mutex<Option<String>>,
}

/// Independent data dir (<appData>/FreeLLMAPI_Tauri) — mirrors the bun branch's
/// FreeLLMAPI_Bun: the Tauri build must not touch the Electron app's real data
/// while it is being debugged/developed.
fn data_dir(app: &AppHandle) -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_data_dir().expect("app data dir"))
        .join("FreeLLMAPI_Tauri")
}

/// Spawns the Node SEA sidecar and, when it reports `READY port=N` on stdout,
/// opens the dashboard window pointing at the embedded server.
fn spawn_sidecar(app: &AppHandle) -> Result<CommandChild, Box<dyn std::error::Error>> {
    let dir = data_dir(app);
    std::fs::create_dir_all(&dir).expect("create data dir");
    let db = dir.join("freeapi.db");
    let client_dist = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("client-dist");

    let (mut rx, child) = app
        .shell()
        .sidecar("freellmapi-sidecar")?
        .args([
            "--db",
            db.to_str().unwrap(),
            "--client-dist",
            client_dist.to_str().unwrap(),
            "--host",
            "127.0.0.1",
            "--port",
            &DEFAULT_PORT.to_string(),
        ])
        .spawn()?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) = event {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim();
                // Contains-match (not strip_prefix): tolerate any logging
                // prefix on the sidecar's contract lines. Opening the
                // dashboard needs BOTH the port and the token; whichever
                // arrives first is remembered (event order is line-based
                // but must not be relied upon).
                if let Some(idx) = text.find("TOKEN=") {
                    let token = text[idx + "TOKEN=".len()..].trim().to_string();
                    *handle.state::<Sidecar>().token.lock().unwrap() = Some(token);
                    if let Some(port) = handle
                        .state::<Sidecar>()
                        .pending_port
                        .lock()
                        .unwrap()
                        .take()
                    {
                        open_dashboard_window(&handle, &port);
                    }
                } else if let Some(idx) = text.find("API_KEY=") {
                    let key = text[idx + "API_KEY=".len()..].trim().to_string();
                    *handle.state::<Sidecar>().api_key.lock().unwrap() = Some(key);
                } else if let Some(idx) = text.find("STRINGS=") {
                    let raw = text[idx + "STRINGS=".len()..].trim();
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
                        *handle.state::<Sidecar>().strings.lock().unwrap() = Some(v);
                    }
                } else if let Some(idx) = text.find("READY port=") {
                    if let Some(port) = text[idx + "READY port=".len()..]
                        .split_whitespace()
                        .next()
                    {
                        if let Ok(port) = port.parse::<u16>() {
                            *handle.state::<Sidecar>().port.lock().unwrap() = Some(port);
                        }
                        let ready = handle
                            .state::<Sidecar>()
                            .token
                            .lock()
                            .unwrap()
                            .is_some();
                        if ready {
                            open_dashboard_window(&handle, port);
                        } else {
                            *handle
                                .state::<Sidecar>()
                                .pending_port
                                .lock()
                                .unwrap() = Some(port.to_string());
                        }
                    }
                }
            }
        }
    });

    Ok(child)
}

fn open_dashboard_window(app: &AppHandle, port: &str) {
    if let Some(win) = app.get_webview_window("dashboard") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    // Auto-login + desktop-mode flags, injected before any page script runs —
    // mirrors the Electron preload / Electrobun injected-preload behaviour.
    let token = app.state::<Sidecar>().token.lock().unwrap().clone().unwrap_or_default();
    let version = app.package_info().version.to_string();
    let script = format!(
        r#"try {{
  localStorage.setItem('freellmapi_dashboard_token', {token:?});
}} catch (e) {{}}
window.__FREEAPI_DESKTOP__ = true;
window.__FREEAPI_VERSION__ = {version:?};
var __d = document.documentElement;
if (__d) __d.classList.add('desktop');
else document.addEventListener('DOMContentLoaded', function () {{ document.documentElement.classList.add('desktop'); }});
"#,
        token = token,
        version = version,
    );

    let url = WebviewUrl::External(
        url::Url::parse(&format!("http://127.0.0.1:{port}")).expect("valid url"),
    );
    if let Err(err) = WebviewWindowBuilder::new(app, "dashboard", url)
        .title("FreeLLMAPI")
        .inner_size(1200.0, 800.0)
        .initialization_script(&script)
        .build()
    {
        eprintln!("[tauri] failed to open dashboard: {err}");
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("bundle icon").clone())
        .tooltip("FreeLLMAPI")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles the popover (Windows/macOS; Linux has no
            // tray click events — its menu would carry a popover entry).
            #[cfg(not(target_os = "linux"))]
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popover(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ── popover window ──────────────────────────────────────────────────────────

const POPOVER_W: f64 = 316.0;
const POPOVER_H: f64 = 348.0;

fn popover_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let win = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::App("popover.html".into()),
    )
    .title("FreeLLMAPI")
    .inner_size(POPOVER_W, POPOVER_H)
    .resizable(false)
    .decorations(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .build()?;
    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            // Blur hides the popover (Electron hides on blur; the 120ms
            // debounce was an Electrobun workaround for its activation quirk).
            let _ = handle.hide();
        }
    });
    Ok(win)
}

fn toggle_popover(app: &AppHandle) {
    let Some(win) = app.get_webview_window("popover") else {
        let Ok(win) = popover_window(app) else { return };
        let _ = win.show();
        position_popover(app, &win);
        let _ = win.set_focus();
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = win.show();
        position_popover(app, &win);
        let _ = win.emit("freeapi:refresh", ());
        let _ = win.set_focus();
    }
}

/// Anchors the popover above the tray click point (Electrobun-verified
/// approach): horizontally centered on the cursor, 6px above the work-area
/// bottom of the monitor the cursor is on. All physical pixels.
fn position_popover(app: &AppHandle, win: &tauri::WebviewWindow) {
    use tauri::PhysicalPosition;
    let Ok(cursor) = win.cursor_position() else { return };
    let Ok(Some(mon)) = app.monitor_from_point(cursor.x, cursor.y) else { return };
    let work = mon.work_area();
    let sf = mon.scale_factor();
    let bottom = work.position.y + work.size.height as i32;
    let w_phys = (POPOVER_W * sf) as i32;
    let h_phys = (POPOVER_H * sf) as i32;
    let x = (cursor.x - w_phys as f64 / 2.0).max(0.0) as i32;
    let y = bottom - h_phys - 6;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

// ── IPC commands (popover ↔ shell) ─────────────────────────────────────────

#[derive(Serialize)]
struct Snapshot {
    port: Option<u16>,
    version: String,
    api_key: String,
    // camelCase to match the popover's JS (s.loginItem), mirroring the
    // Electron main-process snapshot shape.
    #[serde(rename = "loginItem")]
    login_item: bool,
    theme: &'static str,
    // Stats are placeholders in the slim P2 (the shell has no direct SQLite
    // access); wired in a later pass via sidecar/HTTP.
    requests: u32,
    tokens: u64,
    last_model: String,
    success_rate: Option<u8>,
    hourly: Vec<u32>,
    strings: serde_json::Value,
}

/// Windows autostart state straight from the registry. The autostart plugin's
/// is_enabled() compares its expected quoted command against the stored value,
/// which mismatches dev exe paths and reports false; winreg reads the actual
/// registry value instead of spawning external tools.
#[cfg(target_os = "windows")]
fn autostart_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .and_then(|k| k.get_value::<String, _>("FreeLLMAPI_Tauri"))
        .is_ok()
}

#[cfg(not(target_os = "windows"))]
fn autostart_enabled() -> bool {
    false
}

#[tauri::command]
fn get_snapshot(app: AppHandle, state: State<Sidecar>) -> Snapshot {
    // Real autostart state from the registry so a fresh app start reflects
    // whatever was set before this session.
    let login_item = autostart_enabled();
    Snapshot {
        port: *state.port.lock().unwrap(),
        version: app.package_info().version.to_string(),
        api_key: state.api_key.lock().unwrap().clone().unwrap_or_default(),
        login_item,
        theme: "dark",
        requests: 0,
        tokens: 0,
        last_model: String::new(),
        success_rate: None,
        hourly: Vec::new(),
        strings: state
            .strings
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| serde_json::json!({})),
    }
}

#[tauri::command]
fn open_dashboard(app: AppHandle, state: State<Sidecar>) {
    if let Some(port) = *state.port.lock().unwrap() {
        open_dashboard_window(&app, &port.to_string());
    }
}

#[tauri::command]
fn copy_base_url(app: AppHandle, state: State<Sidecar>) {
    if let Some(port) = *state.port.lock().unwrap() {
        let _ = app
            .clipboard()
            .write_text(format!("http://127.0.0.1:{port}/v1"));
    }
}

#[tauri::command]
fn copy_api_key(app: AppHandle, state: State<Sidecar>) {
    if let Some(key) = state.api_key.lock().unwrap().clone() {
        let _ = app.clipboard().write_text(key);
    }
}

#[tauri::command]
fn set_login_item(app: AppHandle, on: bool) {
    // Use try_state (not autolaunch()): the plugin's AutoLaunchManager state
    // is only registered once its setup ran — calling into it when absent
    // panics inside the command and the popover never sees the error.
    let Some(auto) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() else {
        eprintln!("[tauri] autostart plugin state missing (plugins not registered?)");
        return;
    };
    let result = if on { auto.enable() } else { auto.disable() };
    if let Err(err) = result {
        eprintln!("[tauri] autostart toggle failed: {err}");
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    if let Some(child) = app.state::<Sidecar>().child.lock().unwrap().take() {
        let _ = child.kill();
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance: focus the existing dashboard (popover lands in P2).
            let _ = app.get_webview_window("dashboard").map(|win| {
                let _ = win.show();
                let _ = win.set_focus();
            });
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            open_dashboard,
            copy_base_url,
            copy_api_key,
            set_login_item,
            quit_app,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app.handle())?;
            popover_window(app.handle())?;

            let child = spawn_sidecar(app.handle())?;
            app.state::<Sidecar>().child.lock().unwrap().replace(child);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(child) = app.state::<Sidecar>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
