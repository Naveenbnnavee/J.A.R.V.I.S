use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static GHOST_MODE: AtomicBool = AtomicBool::new(false);
static SPAWNED_CHILDREN: Mutex<Vec<Child>> = Mutex::new(Vec::new());

fn is_port_listening(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn resolve_project_root() -> PathBuf {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            if parent.join("backend").join("server.js").exists() {
                return parent.to_path_buf();
            }
            let ancestor = parent.join("..").join("..").join("..");
            if let Ok(canon) = ancestor.canonicalize() {
                if canon.join("backend").join("server.js").exists() {
                    return canon;
                }
            }
        }
    }
    PathBuf::from(r"D:\1\jaros")
}

fn start_services() {
    let root = resolve_project_root();
    let backend_dir = root.join("backend");
    let memory_db_dir = root.join("jarvis_memory_db");

    // 1. Ensure ChromaDB is running on port 8000
    if !is_port_listening(8000) {
        println!("[Jarvis OS] Starting ChromaDB service on port 8000...");
        let chroma_candidates = vec![
            PathBuf::from(r"C:\Users\navee\AppData\Local\Programs\Python\Python311\Scripts\chroma.exe"),
            root.join("chroma-server.exe"),
            root.join("chroma-server-x86_64-pc-windows-msvc.exe"),
            root.join("binaries").join("chroma-server-x86_64-pc-windows-msvc.exe"),
        ];

        let mut chroma_spawned = false;
        for candidate in chroma_candidates {
            if candidate.exists() {
                let mut cmd = Command::new(&candidate);
                cmd.args(&["run", "--path", memory_db_dir.to_str().unwrap_or("./jarvis_memory_db")]);
                cmd.current_dir(&root);
                #[cfg(windows)]
                cmd.creation_flags(CREATE_NO_WINDOW);

                match cmd.spawn() {
                    Ok(child) => {
                        println!("[Jarvis OS] ChromaDB spawned via {:?}", candidate);
                        if let Ok(mut lock) = SPAWNED_CHILDREN.lock() {
                            lock.push(child);
                        }
                        chroma_spawned = true;
                        break;
                    }
                    Err(e) => {
                        eprintln!("[Jarvis OS] Failed to spawn ChromaDB candidate {:?}: {}", candidate, e);
                    }
                }
            }
        }

        if !chroma_spawned {
            let mut cmd = Command::new("chroma");
            cmd.args(&["run", "--path", memory_db_dir.to_str().unwrap_or("./jarvis_memory_db")]);
            cmd.current_dir(&root);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Ok(child) = cmd.spawn() {
                println!("[Jarvis OS] ChromaDB spawned via PATH chroma command");
                if let Ok(mut lock) = SPAWNED_CHILDREN.lock() {
                    lock.push(child);
                }
            }
        }
    } else {
        println!("[Jarvis OS] ChromaDB is already running on port 8000.");
    }

    // 2. Ensure Backend (Node server) is running on port 3000
    if !is_port_listening(3000) {
        println!("[Jarvis OS] Starting Jarvis Backend service on port 3000...");
        let node_candidates = vec![
            PathBuf::from("node"),
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            PathBuf::from(r"C:\Users\navee\AppData\Roaming\nvm\v18.5.0\node.exe"),
        ];

        let mut backend_spawned = false;
        for candidate in node_candidates {
            let mut cmd = Command::new(&candidate);
            cmd.arg("server.js");
            cmd.current_dir(&backend_dir);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            match cmd.spawn() {
                Ok(child) => {
                    println!("[Jarvis OS] Jarvis Backend spawned via {:?}", candidate);
                    if let Ok(mut lock) = SPAWNED_CHILDREN.lock() {
                        lock.push(child);
                    }
                    backend_spawned = true;
                    break;
                }
                Err(e) => {
                    eprintln!("[Jarvis OS] Failed to spawn backend candidate {:?}: {}", candidate, e);
                }
            }
        }
    } else {
        println!("[Jarvis OS] Jarvis Backend is already running on port 3000.");
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn toggle_ghost_mode(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    GHOST_MODE.store(ignore, Ordering::SeqCst);
    let _ = window.emit("ghost_mode_toggled", ignore);
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ensure_services_running() -> Result<String, String> {
    std::thread::spawn(|| {
        start_services();
    });
    Ok("Services check initiated".into())
}

#[tauri::command]
fn get_services_status() -> (bool, bool) {
    (is_port_listening(3000), is_port_listening(8000))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if shortcut.matches(Modifiers::ALT, Code::Space) || shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::Space) {
                            if let Some(window) = app.get_webview_window("main") {
                                let is_visible = window.is_visible().unwrap_or(false);
                                if is_visible {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyG)
                        {
                            if let Some(window) = app.get_webview_window("main") {
                                let current = GHOST_MODE.load(Ordering::SeqCst);
                                let next = !current;
                                GHOST_MODE.store(next, Ordering::SeqCst);
                                let _ = window.set_ignore_cursor_events(next);
                                let _ = window.emit("ghost_mode_toggled", next);
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Ensure autostart on boot is enabled
            use tauri_plugin_autostart::ManagerExt;
            let _ = app.autolaunch().enable();

            // Launch Backend & ChromaDB background services automatically
            std::thread::spawn(|| {
                start_services();
            });

            let alt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            let ctrl_alt_space =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
            let ctrl_alt_g = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG);
            let _ = app.global_shortcut().register(alt_space);
            let _ = app.global_shortcut().register(ctrl_alt_space);
            let _ = app.global_shortcut().register(ctrl_alt_g);

            if let Some(icon) = app.default_window_icon() {
                let _tray = TrayIconBuilder::new()
                    .tooltip("Jarvis OS")
                    .icon(icon.clone())
                    .on_tray_icon_event(|tray, event| match event {
                        TrayIconEvent::Click { .. } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, toggle_ghost_mode, ensure_services_running, get_services_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
