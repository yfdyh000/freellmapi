use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 31415;

/// Holds the spawned sidecar child so it can be killed on exit.
#[derive(Default)]
struct Sidecar(Mutex<Option<CommandChild>>);

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
                // Contains-match (not strip_prefix): tolerate any logging
                // prefix on the sidecar's "READY port=N" contract line.
                if let Some(idx) = text.find("READY port=") {
                    let rest = text[idx + "READY port=".len()..].trim();
                    if let Some(port) = rest.split_whitespace().next() {
                        open_dashboard(&handle, port);
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
    let url = WebviewUrl::External(
        url::Url::parse(&format!("http://127.0.0.1:{port}")).expect("valid url"),
    );
    if let Err(err) = WebviewWindowBuilder::new(app, "dashboard", url)
        .title("FreeLLMAPI")
        .inner_size(1200.0, 800.0)
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
            app.state::<Sidecar>().0.lock().unwrap().replace(child);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
