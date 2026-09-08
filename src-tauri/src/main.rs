use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------- telemetry

#[derive(Serialize)]
struct HostTelemetry {
    cpu_usage: f32,
    used_memory: u64,
    total_memory: u64,
}

/// One persistent `System` instance for the whole app lifetime.
/// CPU usage is a delta between two refreshes, so a fresh `System` (the old
/// approach) always reported ~0 / garbage. Keeping one instance and refreshing
/// it on every poll gives real CPU numbers.
struct HostStats {
    sys: System,
    ready: bool,
}

#[tauri::command]
fn host_telemetry(host: tauri::State<'_, Arc<Mutex<HostStats>>>) -> HostTelemetry {
    let mut guard = host.lock().expect("host stats lock poisoned");
    if !guard.ready {
        guard.sys.refresh_all();
        drop(guard);
        std::thread::sleep(Duration::from_millis(250));
        guard = host.lock().expect("host stats lock poisoned");
        guard.sys.refresh_all();
        guard.ready = true;
    } else {
        guard.sys.refresh_all();
    }
    HostTelemetry {
        cpu_usage: guard.sys.global_cpu_info().cpu_usage(),
        used_memory: guard.sys.used_memory(),
        total_memory: guard.sys.total_memory(),
    }
}

#[derive(Serialize)]
struct ServerRam {
    used: u64,
    allocated: u64,
}

fn gb_bytes(gb: u32) -> u64 {
    (gb as u64).saturating_mul(1024 * 1024 * 1024)
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
    #[allow(dead_code)]
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
    kind: String,
    version: String,
    ram_gb: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct ServerMeta {
    name: String,
    kind: String,
    version: String,
    ram_gb: u32,
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join(".redstone.json")
}

fn load_meta(dir: &Path) -> Option<ServerMeta> {
    let text = fs::read_to_string(meta_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_meta(dir: &Path, meta: &ServerMeta) -> Result<(), String> {
    fs::write(meta_path(dir), serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Used / allocated RAM for a running server (JVM RSS vs. the RAM the user
/// dedicated to it when the server was created).
#[tauri::command]
fn server_ram(
    app: AppHandle,
    host: tauri::State<'_, Arc<Mutex<HostStats>>>,
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
) -> Result<ServerRam, String> {
    let pid = {
        let running = state.running.lock().map_err(|e| e.to_string())?;
        let entry = running
            .get(&id)
            .ok_or_else(|| "this server is not running".to_string())?;
        let child = entry.child.lock().map_err(|e| e.to_string())?;
        child.id()
    };
    let dir = data_root(&app)?.join("servers").join(&id);
    let allocated = load_meta(&dir).map(|m| gb_bytes(m.ram_gb)).unwrap_or(gb_bytes(2));
    let mut guard = host.lock().map_err(|e| e.to_string())?;
    guard.sys.refresh_all();
    let used = guard
        .sys
        .processes()
        .values()
        .find(|p| p.pid().as_u32() == pid)
        .map(|p| p.memory())
        .unwrap_or(0);
    Ok(ServerRam { used, allocated })
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
        let meta = load_meta(&path);
        out.push(ServerInfo {
            name: meta.as_ref().map(|m| m.name.clone()).unwrap_or_else(|| id.clone()),
            kind: meta.as_ref().map(|m| m.kind.clone()).unwrap_or_else(|| "custom".to_string()),
            version: meta.as_ref().map(|m| m.version.clone()).unwrap_or_default(),
            ram_gb: meta.as_ref().map(|m| m.ram_gb).unwrap_or(2),
            id: id.clone(),
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
    kind: String,
    version: String,
    ram_gb: u32,
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
    let ram = ram_gb.clamp(1, 32);
    let dir = data_root(&app)?.join("servers").join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let meta = ServerMeta {
        name: cleaned.clone(),
        kind: kind.clone(),
        version: version.clone(),
        ram_gb: ram,
    };
    save_meta(&dir, &meta)?;
    Ok(ServerInfo {
        id,
        name: cleaned,
        running: false,
        kind,
        version,
        ram_gb: ram,
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
        "no server .jar found in the folder — create the server from the Add-server dialog and it downloads the jar automatically"
            .to_string()
    })?;
    let meta = load_meta(&dir);
    let ram = meta.as_ref().map(|m| m.ram_gb).unwrap_or(2).clamp(1, 32);

    let mut command = Command::new("java");
    command
        .args(["-Xms", &format!("{ram}G"), "-Xmx", &format!("{ram}G"), "-jar"])
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
    let mut map = state
        .running
        .lock()
        .map_err(|e| e.to_string())?;
    let entry = map
        .get_mut(&id)
        .ok_or_else(|| "this server is not running".to_string())?;
    let stdin = entry
        .stdin
        .as_mut()
        .ok_or_else(|| "this server has no console input".to_string())?;
    writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
    // BufWriter buffers; flush so the command reaches the server immediately.
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(line)
}

// -------------------------------------------------------- versions + downloads

fn curl_get(url: &str) -> Result<String, String> {
    let out = Command::new("curl")
        .args(["-sS", "--fail", "--max-time", "60", url])
        .output()
        .map_err(|e| format!("curl is not available on this machine: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "request failed (HTTP exit {}){}",
            out.status.code().unwrap_or(-1),
            if detail.is_empty() { String::new() } else { format!(": {detail}") }
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Version list for the add-server dialog.
///
/// Vanilla exposes a full release list (Mojang manifest). Paper and BungeeCord
/// only offer "latest" through their official download channels (the old
/// PaperMC v2 build API is retired), so they report a single "latest" entry;
/// the actual version number is resolved at download time and stored on the
/// server so the UI can show e.g. "Paper 26.2".
#[tauri::command]
fn list_versions(kind: String) -> Result<Vec<String>, String> {
    match kind.as_str() {
        "vanilla" => {
            let json: serde_json::Value = serde_json::from_str(&curl_get(
                "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
            )?)
            .map_err(|e| format!("could not parse the vanilla version list: {e}"))?;
            Ok(json["versions"]
                .as_array()
                .ok_or("unexpected vanilla manifest shape")?
                .iter()
                .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("release"))
                .filter_map(|v| v["id"].as_str().map(str::to_string))
                .filter(|v| !v.is_empty())
                .take(20)
                .collect())
        }
        "paper" | "bungeecord" => Ok(vec!["latest".to_string()]),
        other => Err(format!("unknown server type: {other}")),
    }
}

/// Parses the official Paper download page (server-rendered) for the latest
/// stable jar URL, e.g. https://fill-data.papermc.io/v1/objects/<sha>/paper-26.2-121.jar
fn paper_latest() -> Result<(String, String, String), String> {
    let html = curl_get("https://papermc.io/downloads/paper")
        .map_err(|e| format!("could not reach the Paper download page: {e}"))?;
    let start = html
        .find("https://fill-data.papermc.io/v1/objects/")
        .ok_or("no Paper jar found on the download page (page layout changed?)")?;
    let tail = &html[start..];
    let end = tail.find(".jar").ok_or("truncated Paper jar url")? + ".jar".len();
    let url = tail[..end].to_string();
    let name = url.rsplit('/').next().unwrap_or("paper.jar").to_string();
    // name looks like paper-26.2-121.jar -> version 26.2
    let version = name
        .strip_prefix("paper-")
        .and_then(|rest| rest.rsplit_once('-'))
        .map(|(v, _)| v.to_string())
        .unwrap_or_else(|| "latest".to_string());
    Ok((url, name, version))
}

fn resolve_download(kind: &str, version: &str) -> Result<(String, String, String), String> {
    // Returns (url, final file name, resolved version for the label).
    match kind {
        "vanilla" => {
            let json: serde_json::Value = serde_json::from_str(&curl_get(
                "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
            )?)
            .map_err(|e| e.to_string())?;
            let entry = json["versions"]
                .as_array()
                .ok_or("unexpected vanilla manifest shape")?
                .iter()
                .find(|v| v["id"] == version)
                .ok_or_else(|| format!("vanilla version '{version}' was not found"))?;
            let url = entry["downloads"]["server"]
                .as_str()
                .ok_or("no server jar url in the manifest")?
                .to_string();
            Ok((url, format!("server-{version}.jar"), version.to_string()))
        }
        "paper" => {
            let (url, name, version) = paper_latest()?;
            Ok((url, name, version))
        }
        "bungeecord" => Ok((
            "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar"
                .to_string(),
            "BungeeCord.jar".to_string(),
            "latest".to_string(),
        )),
        other => Err(format!(
            "unknown server type: {other} (supported: vanilla, paper, bungeecord)"
        )),
    }
}

/// Downloads the server jar for an existing server folder. Emits
/// `download-progress` events ({id, bytes}) while the file grows.
#[tauri::command]
fn download_server(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
    kind: String,
    version: String,
) -> Result<String, String> {
    let dir = server_dir_for(&app, &id)?;
    if state.running.lock().map_err(|e| e.to_string())?.contains_key(&id) {
        return Err("stop the server before downloading a new jar".into());
    }
    let (url, final_name, resolved_version) = resolve_download(&kind, &version)?;
    let tmp = dir.join("download.tmp");
    let _ = fs::remove_file(&tmp);
    let app_prog = app.clone();
    let id_prog = id.clone();
    let tmp_prog = tmp.clone();
    std::thread::spawn(move || {
        let mut last: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            if !tmp_prog.exists() {
                break;
            }
            let size = fs::metadata(&tmp_prog).map(|m| m.len()).unwrap_or(0);
            if size != last {
                last = size;
                let _ = app_prog.emit(
                    "download-progress",
                    serde_json::json!({ "id": id_prog, "bytes": size }),
                );
            }
        }
    });
    let out = Command::new("curl")
        .args([
            "-sSL", "--fail", "--max-time", "600", "-o",
            tmp.to_str().ok_or("bad temp file path")?,
            &url,
        ])
        .output()
        .map_err(|e| format!("curl is not available on this machine: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "download failed (exit {}){}",
            out.status.code().unwrap_or(-1),
            if detail.is_empty() { String::new() } else { format!(": {detail}") }
        ));
    }
    let final_path = dir.join(&final_name);
    fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    if !resolved_version.is_empty() && resolved_version != "latest" {
        if let Some(mut meta) = load_meta(&dir) {
            meta.version = resolved_version;
            let _ = save_meta(&dir, &meta);
        }
    }
    Ok(format!("{final_name} downloaded — press Start"))
}

/// Opens the server folder in the system file manager.
#[tauri::command]
fn open_server_dir(app: AppHandle, id: String) -> Result<String, String> {
    let dir = server_dir_for(&app, &id)?;
    let mut opener;
    #[cfg(target_os = "macos")]
    { opener = Command::new("open"); }
    #[cfg(target_os = "windows")]
    { opener = Command::new("explorer"); }
    #[cfg(all(unix, not(target_os = "macos")))]
    { opener = Command::new("xdg-open"); }
    opener
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("could not open the folder in a file manager: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
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
    let host = Arc::new(Mutex::new(HostStats {
        sys: System::new_all(),
        ready: false,
    }));
    tauri::Builder::default()
        .manage(state)
        .manage(host)
        .invoke_handler(tauri::generate_handler![
            host_telemetry,
            server_ram,
            ensure_data_dir,
            list_servers,
            create_server,
            list_versions,
            download_server,
            open_server_dir,
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
