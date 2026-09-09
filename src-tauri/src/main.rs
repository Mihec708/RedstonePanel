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

fn server_pid(state: &ServerState, id: &str) -> Result<u32, String> {
    let running = state.running.lock().map_err(|e| e.to_string())?;
    let entry = running
        .get(id)
        .ok_or_else(|| "this server is not running".to_string())?;
    let child = entry.child.lock().map_err(|e| e.to_string())?;
    Ok(child.id())
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
    let pid = server_pid(&state, &id)?;
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

#[derive(Serialize)]
struct ServerStats {
    cpu: f32,
    ram_used: u64,
    ram_alloc: u64,
    uptime_secs: u64,
}

/// CPU, RAM, uptime and thread count of the server process only.
#[tauri::command]
fn server_stats(
    app: AppHandle,
    host: tauri::State<'_, Arc<Mutex<HostStats>>>,
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
) -> Result<ServerStats, String> {
    let pid = server_pid(&state, &id)?;
    let dir = data_root(&app)?.join("servers").join(&id);
    let allocated = load_meta(&dir).map(|m| gb_bytes(m.ram_gb)).unwrap_or(gb_bytes(2));
    let mut guard = host.lock().map_err(|e| e.to_string())?;
    guard.sys.refresh_all();
    let proc = guard.sys.processes().values().find(|p| p.pid().as_u32() == pid);
    Ok(ServerStats {
        cpu: proc.map(|p| p.cpu_usage()).unwrap_or(0.0),
        ram_used: proc.map(|p| p.memory()).unwrap_or(0),
        ram_alloc: allocated,
        uptime_secs: proc.map(|p| p.run_time()).unwrap_or(0),
    })
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

fn do_start(app: &AppHandle, state: &Arc<ServerState>, id: &str) -> Result<String, String> {
    let root = data_root(app)?;
    let dir = root.join("servers").join(&id);
    if !dir.is_dir() {
        return Err(format!("server folder not found: {id}"));
    }
    if state.running.lock().map_err(|e| e.to_string())?.contains_key(id) {
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
            id.to_string(),
            ServerProc {
                dir,
                child: child_for_map,
                stdin: stdin.map(BufWriter::new),
            },
        );

    let (app_out, id_out, log_out, state_out) = (app.clone(), id.to_string(), Arc::clone(&log), Arc::clone(state));
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

    let (app_err, id_err, log_err) = (app.clone(), id.to_string(), Arc::clone(&log));
    std::thread::spawn(move || {
        stream_lines(stderr, &app_err, &id_err, "stderr", &log_err);
    });

    Ok(format!("starting {id} from {}", jar.file_name().unwrap_or_default().to_string_lossy()))
}

/// Start wrapper for the UI.
#[tauri::command]
fn start_server(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
) -> Result<String, String> {
    do_start(&app, &state, &id)
}

fn do_stop(state: &Arc<ServerState>, id: &str) -> Result<String, String> {
    let entry = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or_else(|| "this server is not running".to_string())?;
    entry
        .child
        .lock()
        .map_err(|e| e.to_string())?
        .kill()
        .map_err(|e| e.to_string())?;
    Ok(format!("stopping {id}"))
}

/// Stop wrapper for the UI.
#[tauri::command]
fn stop_server(
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
) -> Result<String, String> {
    do_stop(&state, &id)
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

/// Send a console line to a running server (used by the scheduler thread).
fn send_line(state: &Arc<ServerState>, id: &str, line: &str) -> Result<(), String> {
    let mut map = state.running.lock().map_err(|e| e.to_string())?;
    let entry = map.get_mut(id).ok_or_else(|| "this server is not running".to_string())?;
    let stdin = entry.stdin.as_mut().ok_or_else(|| "no console input".to_string())?;
    writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
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

// ------------------------------------------------------------- backups

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn utc_stamp(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let h = rem / 3600;
    let m = (rem % 3600) / 60;
    let s = rem % 60;
    // civil-from-days (Howard Hinnant)
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = if mo <= 2 { y + 1 } else { y };
    format!("{yy:04}{mo:02}{d:02}-{h:02}{m:02}{s:02}")
}

fn copy_tree(src: &Path, dst: &Path) -> Result<u64, String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut total = 0;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() {
            total += copy_tree(&path, &dst.join(name))?;
        } else if name.to_string_lossy() != "download.tmp" {
            let to = dst.join(&name);
            fs::copy(&path, &to).map_err(|e| e.to_string())?;
            total += fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(total)
}

fn tree_size(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total += tree_size(&path);
            } else {
                total += fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

fn backup_dir_for(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("backups").join(id))
}

fn validate_part(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains("\\")
        || name.contains('\0')
    {
        return Err("invalid backup name".into());
    }
    Ok(())
}

fn do_backup(app: &AppHandle, id: &str) -> Result<String, String> {
    let dir = server_dir_for(app, id)?;
    let dest = backup_dir_for(app, id)?
        .join(format!("backup-{}-utc", utc_stamp(unix_now())));
    copy_tree(&dir, &dest)?;
    Ok(dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default())
}

#[tauri::command]
fn create_backup(app: AppHandle, id: String) -> Result<String, String> {
    do_backup(&app, &id)
}

#[derive(Serialize, Clone)]
struct BackupInfo {
    name: String,
    size: u64,
    mtime: u64,
}

#[tauri::command]
fn list_backups(app: AppHandle, id: String) -> Result<Vec<BackupInfo>, String> {
    let root = backup_dir_for(&app, &id)?;
    let mut out = Vec::new();
    if root.is_dir() {
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.push(BackupInfo {
                    name: entry.file_name().to_string_lossy().to_string(),
                    size: tree_size(&path),
                    mtime: entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                });
            }
        }
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

#[tauri::command]
fn restore_backup(
    app: AppHandle,
    state: tauri::State<'_, Arc<ServerState>>,
    id: String,
    name: String,
) -> Result<String, String> {
    validate_part(&name)?;
    if state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&id)
    {
        return Err("stop the server before restoring a backup".into());
    }
    let src = backup_dir_for(&app, &id)?.join(&name);
    if !src.is_dir() {
        return Err("that backup does not exist".into());
    }
    let dir = server_dir_for(&app, &id)?;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    copy_tree(&src, &dir)?;
    Ok("backup restored — start the server to use it".into())
}

#[tauri::command]
fn delete_backup(app: AppHandle, id: String, name: String) -> Result<String, String> {
    validate_part(&name)?;
    let path = backup_dir_for(&app, &id)?.join(&name);
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok("backup deleted".into())
}

// ------------------------------------------------------------ scheduler

fn sched_path(dir: &Path) -> PathBuf {
    dir.join(".scheduler.json")
}

fn load_schedules(dir: &Path) -> Option<Vec<serde_json::Value>> {
    let text = fs::read_to_string(sched_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_schedules(dir: &Path, list: &[serde_json::Value]) -> Result<(), String> {
    fs::write(
        sched_path(dir),
        serde_json::to_string_pretty(list).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn sched_value(
    sid: u64,
    action: &str,
    next_run: u64,
    repeat: &str,
    command: &Option<String>,
) -> serde_json::Value {
    serde_json::json!({
        "sid": sid,
        "action": action,
        "next_run": next_run,
        "repeat": repeat,
        "command": command,
    })
}

#[tauri::command]
fn list_schedules(app: AppHandle, id: String) -> Result<Vec<serde_json::Value>, String> {
    let dir = server_dir_for(&app, &id)?;
    Ok(load_schedules(&dir).unwrap_or_default())
}

#[tauri::command]
fn add_schedule(
    app: AppHandle,
    id: String,
    action: String,
    delay_secs: u64,
    repeat: String,
    command: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let dir = server_dir_for(&app, &id)?;
    let mut list = load_schedules(&dir).unwrap_or_default();
    let sid = list
        .iter()
        .filter_map(|v| v.get("sid").and_then(|s| s.as_u64()))
        .max()
        .unwrap_or(0)
        + 1;
    let repeat = match repeat.as_str() {
        "hourly" | "daily" | "weekly" => repeat,
        _ => "none".to_string(),
    };
    let action = match action.as_str() {
        "start" | "stop" | "restart" | "backup" | "command" => action,
        _ => return Err("unknown schedule action".into()),
    };
    if action == "command" && command.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err("give the command schedule a console command".into());
    }
    let delay = delay_secs.clamp(10, 31_536_000);
    list.push(sched_value(sid, &action, unix_now() + delay, &repeat, &command));
    save_schedules(&dir, &list)?;
    Ok(list)
}

#[tauri::command]
fn remove_schedule(app: AppHandle, id: String, sid: u64) -> Result<Vec<serde_json::Value>, String> {
    let dir = server_dir_for(&app, &id)?;
    let mut list = load_schedules(&dir).unwrap_or_default();
    list.retain(|v| v.get("sid").and_then(|s| s.as_u64()) != Some(sid));
    save_schedules(&dir, &list)?;
    Ok(list)
}

/// Background loop that runs due schedules for every server.
fn spawn_scheduler(app: AppHandle, state: Arc<ServerState>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(15));
            let Ok(servers_root) = app.path().app_data_dir() else {
                continue;
            };
            let servers_root = servers_root.join("servers");
            if !servers_root.is_dir() {
                continue;
            }
            let now = unix_now();
            let Ok(entries) = fs::read_dir(&servers_root) else {
                continue;
            };
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let id = entry.file_name().to_string_lossy().to_string();
                let mut list = match load_schedules(&dir) {
                    Some(l) if l.iter().any(|v| {
                        v.get("next_run").and_then(|n| n.as_u64()).unwrap_or(u64::MAX) <= now
                    }) => l,
                    _ => continue,
                };
                let mut changed = false;
                for s in list.iter_mut() {
                    if s.get("next_run").and_then(|n| n.as_u64()).unwrap_or(u64::MAX) > now {
                        continue;
                    }
                    let action = s.get("action").and_then(|a| a.as_str()).unwrap_or("");
                    let repeat = s.get("repeat").and_then(|r| r.as_str()).unwrap_or("none");
                    let command = s.get("command").and_then(|c| c.as_str()).map(str::to_string);
                    match action {
                        "start" => {
                            let _ = do_start(&app, &state, &id);
                        }
                        "stop" => {
                            let _ = do_stop(&state, &id);
                        }
                        "restart" => {
                            let _ = do_stop(&state, &id);
                            std::thread::sleep(Duration::from_secs(2));
                            let _ = do_start(&app, &state, &id);
                        }
                        "backup" => {
                            let _ = do_backup(&app, &id);
                        }
                        "command" => {
                            if let Some(line) = command.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
                                let _ = send_line(&state, &id, line);
                            }
                        }
                        _ => {}
                    }
                    let interval: u64 = match repeat {
                        "hourly" => 3600,
                        "daily" => 86_400,
                        "weekly" => 604_800,
                        _ => 0,
                    };
                    if let Some(next) = s.get_mut("next_run") {
                        *next = serde_json::json!(now.saturating_add(interval));
                    }
                    changed = true;
                }
                if changed {
                    if let Ok(_) = save_schedules(&dir, &list) {}
                }
            }
        }
    });
}

// -------------------------------------------------------------- players

#[derive(Serialize, Clone)]
struct PlayerInfo {
    name: String,
    uuid: String,
}

fn read_level_name(dir: &Path) -> String {
    if let Ok(text) = fs::read_to_string(dir.join("server.properties")) {
        for line in text.lines() {
            let Some(eq) = line.find('=') else {
                continue;
            };
            if line[..eq].trim() == "level-name" {
                return line[eq + 1..].trim().to_string();
            }
        }
    }
    "world".into()
}

/// Past players: parsed from the `<level>/players/*.dat` uuid files.
#[tauri::command]
fn list_players(app: AppHandle, id: String) -> Result<Vec<PlayerInfo>, String> {
    let dir = server_dir_for(&app, &id)?;
    let players_dir = dir.join(read_level_name(&dir)).join("players");
    let mut out = Vec::new();
    if players_dir.is_dir() {
        for entry in fs::read_dir(&players_dir).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "dat").unwrap_or(false) {
                let raw = entry.file_name().to_string_lossy().to_string();
                let uuid = raw.strip_suffix(".dat").unwrap_or(&raw).to_string();
                let name = uuid.split('-').next().unwrap_or("").to_string();
                out.push(PlayerInfo { name, uuid });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Whitelisted players from `whitelist.json`.
#[tauri::command]
fn list_whitelist(app: AppHandle, id: String) -> Result<Vec<PlayerInfo>, String> {
    let dir = server_dir_for(&app, &id)?;
    let text = match fs::read_to_string(dir.join("whitelist.json")) {
        Ok(t) => t,
        Err(_) => return Ok(Vec::new()),
    };
    let Ok(value) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else {
        return Ok(Vec::new());
    };
    Ok(value
        .iter()
        .filter_map(|v| {
            let name = v.get("name").and_then(|n| n.as_str()).map(str::to_string)?;
            let uuid = v
                .get("uuid")
                .and_then(|u| u.as_str())
                .map(str::to_string)
                .unwrap_or_default();
            Some(PlayerInfo { name, uuid })
        })
        .collect())
}

// ------------------------------------------------------------- plugins

/// Downloads a plugin jar into the server folder (Modrinth file url).
#[tauri::command]
fn install_plugin(app: AppHandle, id: String, url: String, filename: String) -> Result<String, String> {
    let dir = server_dir_for(&app, &id)?;
    let safe_name: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
        .collect();
    let name = if safe_name.is_empty() { "plugin.jar".to_string() } else { safe_name };
    let tmp = dir.join(format!(".plugin-download-{name}.tmp"));
    let out = Command::new("curl")
        .args(["-sSL", "--fail", "--max-time", "600", "-o", tmp.to_str().ok_or("bad path")?, &url])
        .output()
        .map_err(|e| format!("curl is not available on this machine: {e}"))?;
    if !out.status.success() {
        let _ = fs::remove_file(&tmp);
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "plugin download failed (exit {}){}",
            out.status.code().unwrap_or(-1),
            if detail.is_empty() { String::new() } else { format!(": {detail}") }
        ));
    }
    fs::rename(&tmp, dir.join(&name)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(format!("{name} added to the server — restart it to load the plugin"))
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
    let scheduler_state = Arc::clone(&state);
    tauri::Builder::default()
        .manage(state)
        .manage(host)
        .invoke_handler(tauri::generate_handler![
            host_telemetry,
            server_ram,
            server_stats,
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
            write_file,
            list_players,
            list_whitelist,
            create_backup,
            list_backups,
            restore_backup,
            delete_backup,
            list_schedules,
            add_schedule,
            remove_schedule,
            install_plugin
        ])
        .setup(|app| {
            spawn_scheduler(app.handle().clone(), scheduler_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run RedstonePanel desktop app");
}
