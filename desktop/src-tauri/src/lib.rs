use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 31415;

/// Shell state: the spawned sidecar child (killed on exit), the dashboard
/// session token reported by the sidecar (auto-login), and a pending port
/// for when READY arrives before TOKEN (either order must work).
#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    token: Mutex<Option<String>>,
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
                        open_dashboard(&handle, &port);
                    }
                } else if let Some(idx) = text.find("READY port=") {
                    if let Some(port) = text[idx + "READY port=".len()..]
                        .split_whitespace()
                        .next()
                    {
                        let ready = handle
                            .state::<Sidecar>()
                            .token
                            .lock()
                            .unwrap()
                            .is_some();
                        if ready {
                            open_dashboard(&handle, port);
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

fn open_dashboard(app: &AppHandle, port: &str) {
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
        .build(app)?;
    Ok(())
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app.handle())?;

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
