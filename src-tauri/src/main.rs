use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------- telemetry

#[derive(Serialize)]
struct HostTelemetry {
    cpu_usage: f32,
    used_memory: u64,
    total_memory: u64,
}

#[tauri::command]
fn host_telemetry() -> HostTelemetry {
    let mut system = System::new_all();
    system.refresh_all();
    HostTelemetry {
        cpu_usage: system.global_cpu_info().cpu_usage(),
        used_memory: system.used_memory(),
        total_memory: system.total_memory(),
    }
}

// ------------------------------------------------------------- data folders

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "could not resolve the RedstonePanel data folder".to_string())
}

/// Creates the app data folder (plus `servers/` and `logs/`) on first launch
/// and returns its absolute path.
#[tauri::command]
fn ensure_data_dir(app: AppHandle) -> Result<String, String> {
    let root = data_root(&app)?;
    fs::create_dir_all(root.join("servers")).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join("logs")).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().to_string())
}

// ------------------------------------------------------------ server state

struct ServerProc {
    dir: PathBuf,
    child: Arc<Mutex<Child>>,
    stdin: Option<BufWriter<ChildStdin>>,
}

#[derive(Default)]
struct ServerState {
    running: Mutex<HashMap<String, ServerProc>>,
}

#[derive(Serialize, Clone)]
struct ServerInfo {
    id: String,
    name: String,
    running: bool,
}

#[derive(Serialize, Clone)]
struct ConsoleLine {
    id: String,
    line: String,
    source: &'static str,
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn list_servers(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
) -> Result<Vec<ServerInfo>, String> {
    let servers_root = data_root(&app)?.join("servers");
    let mut out = Vec::new();
    if !servers_root.is_dir() {
        return Ok(out);
    }
    let running = state.running.lock().map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&servers_root).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let is_running = running.contains_key(&id);
        out.push(ServerInfo {
            id: id.clone(),
            name: id,
            running: is_running,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn create_server(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
    name: String,
) -> Result<ServerInfo, String> {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ' '))
        .collect();
    let id = cleaned.to_lowercase().replace(' ', "-");
    if id.is_empty() {
        return Err("please give the server a name".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err("the name can only contain letters, numbers, dashes and underscores".into());
    }
    if state.running.lock().map_err(|e| e.to_string())?.contains_key(&id) {
        return Err("that server is currently running".into());
    }
    let dir = data_root(&app)?.join("servers").join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(ServerInfo {
        id,
        name: cleaned,
        running: false,
    })
}

fn pick_jar(dir: &Path) -> Option<PathBuf> {
    let mut jars = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_file() && path.extension().map(|e| e == "jar").unwrap_or(false) {
                Some(path)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    jars.sort_by_key(|path| {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let priority = if name.contains("paper") || name.contains("purpur") {
            0
        } else if name.contains("spigot") {
            1
        } else if name.contains("forge") || name.contains("fabric") || name.contains("quilt") {
            2
        } else {
            3
        };
        (priority, name)
    });
    jars.into_iter().next()
}

fn stream_lines(
    stream: Option<impl std::io::Read + Send>,
    app: &AppHandle,
    id: &str,
    source: &'static str,
    log: &Arc<Mutex<Option<File>>>,
) {
    let Some(stream) = stream else {
        return;
    };
    let reader = BufReader::new(stream);
    for result in reader.lines() {
        let Ok(line) = result else { break };
        let _ = app.emit(
            "server-console",
            ConsoleLine {
                id: id.to_string(),
                line: line.clone(),
                source,
            },
        );
        if let Ok(mut guard) = log.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}

#[tauri::command]
fn start_server(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    let root = data_root(&app)?;
    let dir = root.join("servers").join(&id);
    if !dir.is_dir() {
        return Err(format!("server folder not found: {id}"));
    }
    if state.running.lock().map_err(|e| e.to_string())?.contains_key(&id) {
        return Err("this server is already running".into());
    }
    let jar = pick_jar(&dir).ok_or_else(|| {
        "no server .jar found in the folder — drop a Paper/Forge jar into the server folder first"
            .to_string()
    })?;

    let mut command = Command::new("java");
    command
        .args(["-Xms1G", "-Xmx2G", "-jar"])
        .arg(&jar)
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to launch java: {e} — is a recent JDK installed?"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    fs::create_dir_all(root.join("logs")).map_err(|e| e.to_string())?;
    let log_file = File::options()
        .create(true)
        .append(true)
        .open(root.join("logs").join(format!("{id}.log")))
        .map_err(|e| e.to_string())?;
    let log = Arc::new(Mutex::new(Some(log_file)));

    let child_arc = Arc::new(Mutex::new(child));
    let child_for_map = Arc::clone(&child_arc);

    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id.clone(),
            ServerProc {
                dir,
                child: child_for_map,
                stdin: stdin.map(BufWriter::new),
            },
        );

    let (app_out, id_out, log_out, state_out) = (app.clone(), id.clone(), Arc::clone(&log), state.clone());
    std::thread::spawn(move || {
        stream_lines(stdout, &app_out, &id_out, "stdout", &log_out);
        let code = {
            let mut guard = child_arc.lock().unwrap();
            guard.wait().map(|status| status.code().unwrap_or(-1))
        }
        .unwrap_or(-1);
        state_out.running.lock().unwrap().remove(&id_out);
        let _ = app_out.emit("server-exit", serde_json::json!({ "id": id_out, "code": code }));
    });

    let (app_err, id_err, log_err) = (app.clone(), id.clone(), Arc::clone(&log));
    std::thread::spawn(move || {
        stream_lines(stderr, &app_err, &id_err, "stderr", &log_err);
    });

    Ok(format!("starting {id} from {}", jar.file_name().unwrap_or_default().to_string_lossy()))
}

#[tauri::command]
fn stop_server(
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
) -> Result<String, String> {
    let entry = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .ok_or_else(|| "this server is not running".to_string())?;
    entry
        .child
        .lock()
        .map_err(|e| e.to_string())?
        .kill()
        .map_err(|e| e.to_string())?;
    Ok(format!("stopping {id}"))
}

#[tauri::command]
fn send_console(
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
    line: String,
) -> Result<String, String> {
    let mut entry = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&id)
        .ok_or_else(|| "this server is not running".to_string())?;
    let stdin = entry
        .stdin
        .as_mut()
        .ok_or_else(|| "this server has no console input".to_string())?;
    writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
    Ok(line)
}

// ------------------------------------------------------------------- files

#[derive(Serialize)]
struct FileEntry {
    name: String,
    dir: bool,
}

fn server_dir_for(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("servers").join(id);
    if !dir.is_dir() {
        return Err("server folder not found".into());
    }
    Ok(dir)
}

fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return Err("empty file path".into());
    }
    let joined = base.join(rel);
    let canon_base = fs::canonicalize(base).map_err(|e| e.to_string())?;
    let canon = fs::canonicalize(&joined).map_err(|_| format!("file not found: {rel}"))?;
    if !canon.starts_with(&canon_base) {
        return Err("that path is outside the server folder".into());
    }
    Ok(canon)
}

#[tauri::command]
fn list_files(app: AppHandle, id: String) -> Result<Vec<FileEntry>, String> {
    let base = server_dir_for(&app, &id)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&base).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(FileEntry {
            name: if dir { format!("{name}/") } else { name },
            dir,
        });
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
fn read_file(app: AppHandle, id: String, path: String) -> Result<String, String> {
    let base = server_dir_for(&app, &id)?;
    let target = safe_join(&base, &path)?;
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "that file is not plain text".into())
}

#[tauri::command]
fn write_file(app: AppHandle, id: String, path: String, content: String) -> Result<String, String> {
    let base = server_dir_for(&app, &id)?;
    let target = safe_join(&base, &path)?;
    fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok("saved".into())
}

// ---------------------------------------------------------------------- app

fn main() {
    let state = Arc::new(ServerState::default());
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            host_telemetry,
            ensure_data_dir,
            list_servers,
            create_server,
            start_server,
            stop_server,
            send_console,
            list_files,
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RedstonePanel desktop app");
}
