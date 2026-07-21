use serde::Serialize;
use sysinfo::System;

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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![host_telemetry])
        .run(tauri::generate_context!())
        .expect("failed to run RedstonePanel desktop app");
}
