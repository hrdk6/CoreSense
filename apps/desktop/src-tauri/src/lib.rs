use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, System};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticWarning {
    code: String,
    severity: String,
    component: String,
    title: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiagnosticResult {
    id: String,
    tool_id: String,
    measurement_type: String,
    source: String,
    platform: String,
    os_version: String,
    collected_at: String,
    duration_ms: u64,
    summary: String,
    limitations: Vec<String>,
    warnings: Vec<DiagnosticWarning>,
    data: Value,
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Strictly validated read-only native diagnostic command registry.
/// ZERO arbitrary shell execution is permitted.
#[tauri::command]
fn run_native_diagnostic(tool_id: String) -> Result<NativeDiagnosticResult, String> {
    let allowed = [
        "cpu_diagnostics",
        "memory_diagnostics",
        "storage_diagnostics",
        "full_system_snapshot",
    ];
    if !allowed.contains(&tool_id.as_str()) {
        return Err(format!(
            "SECURITY_BLOCK: Native tool '{}' is not in the validated read-only registry.",
            tool_id
        ));
    }

    let started = Instant::now();
    let mut sys = System::new_all();
    sys.refresh_cpu_all();
    thread::sleep(Duration::from_millis(220));
    sys.refresh_cpu_all();
    sys.refresh_memory();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let os_version = format!(
        "{} {}",
        System::name().unwrap_or_else(|| "OS".into()),
        System::os_version().unwrap_or_else(|| "Unknown".into())
    );

    let mut warnings: Vec<DiagnosticWarning> = Vec::new();
    let mut limitations: Vec<String> = Vec::new();

    // CPU metrics
    let cpu_load = (sys.global_cpu_usage() * 10.0).round() / 10.0;
    let per_core: Vec<f32> = sys
        .cpus()
        .iter()
        .map(|c| (c.cpu_usage() * 10.0).round() / 10.0)
        .collect();
    let cpu_model = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown Processor".into());

    let mut procs: Vec<(String, u32, f32, u64)> = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            (
                p.name().to_string_lossy().to_string(),
                pid.as_u32(),
                (p.cpu_usage() * 10.0).round() / 10.0,
                p.memory() / (1024 * 1024),
            )
        })
        .collect();
    procs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let top_cpu_procs: Vec<Value> = procs
        .iter()
        .take(8)
        .map(|(name, pid, cpu, mem)| {
            json!({ "name": name, "pid": pid, "cpuSeconds": cpu, "workingSetMb": mem })
        })
        .collect();

    if cpu_load >= 85.0 {
        warnings.push(DiagnosticWarning {
            code: "HIGH_CPU_LOAD".into(),
            severity: "critical".into(),
            component: "cpu".into(),
            title: "Sustained High CPU Utilization".into(),
            detail: format!("Native Rust probe measured {:.1}% live CPU load.", cpu_load),
        });
    }

    // Memory metrics
    let total_mem_gb = (sys.total_memory() as f64 / 1024_f64.powi(3) * 100.0).round() / 100.0;
    let used_mem_gb = (sys.used_memory() as f64 / 1024_f64.powi(3) * 100.0).round() / 100.0;
    let avail_mem_gb = (sys.available_memory() as f64 / 1024_f64.powi(3) * 100.0).round() / 100.0;
    let mem_pct = if total_mem_gb > 0.0 {
        ((used_mem_gb / total_mem_gb) * 1000.0).round() / 10.0
    } else {
        0.0
    };
    let pressure = if mem_pct >= 90.0 {
        "critical"
    } else if mem_pct >= 80.0 {
        "high"
    } else if mem_pct >= 70.0 {
        "elevated"
    } else {
        "normal"
    };
    if mem_pct >= 88.0 {
        warnings.push(DiagnosticWarning {
            code: "CRITICAL_MEMORY_PRESSURE".into(),
            severity: "critical".into(),
            component: "memory".into(),
            title: "High Native RAM Pressure".into(),
            detail: format!("RAM utilization is {:.1}% ({:.2}/{:.2} GB).", mem_pct, used_mem_gb, total_mem_gb),
        });
    }

    procs.sort_by(|a, b| b.3.cmp(&a.3));
    let top_mem_procs: Vec<Value> = procs
        .iter()
        .take(8)
        .map(|(name, pid, _, mem)| json!({ "name": name, "pid": pid, "memoryMb": mem }))
        .collect();

    // Storage metrics
    let disks = Disks::new_with_refreshed_list();
    let mut volumes: Vec<Value> = Vec::new();
    for d in disks.list() {
        let total = d.total_space() as f64 / 1024_f64.powi(3);
        let free = d.available_space() as f64 / 1024_f64.powi(3);
        if total <= 0.0 {
            continue;
        }
        let used_pct = (((total - free) / total) * 1000.0).round() / 10.0;
        let mount = d.mount_point().to_string_lossy().to_string();
        if used_pct >= 92.0 || free < 10.0 {
            warnings.push(DiagnosticWarning {
                code: "LOW_DISK_SPACE".into(),
                severity: if used_pct >= 96.0 { "critical".into() } else { "warning".into() },
                component: "storage".into(),
                title: format!("Low Free Space on {}", mount),
                detail: format!("Volume {} is {:.1}% full ({:.1} GB free).", mount, used_pct, free),
            });
        }
        volumes.push(json!({
            "mount": mount,
            "label": d.name().to_string_lossy(),
            "fileSystem": d.file_system().to_string_lossy(),
            "totalGb": (total * 10.0).round() / 10.0,
            "freeGb": (free * 10.0).round() / 10.0,
            "usedPercent": used_pct,
        }));
    }

    let networks = Networks::new_with_refreshed_list();
    let iface_names: Vec<String> = networks.iter().map(|(name, _)| name.clone()).collect();

    limitations.push("Low-level NVMe SMART registers and ACPI die temperatures require elevated OS driver privileges where not exposed by standard user-mode APIs.".into());

    let (summary, data) = match tool_id.as_str() {
        "cpu_diagnostics" => (
            format!("{} — {:.1}% live CPU load across {} threads.", cpu_model, cpu_load, sys.cpus().len()),
            json!({
                "model": cpu_model,
                "logicalThreads": sys.cpus().len(),
                "utilizationPercent": cpu_load,
                "perCorePercent": per_core,
                "topProcesses": top_cpu_procs,
            }),
        ),
        "memory_diagnostics" => (
            format!("{:.2} GB / {:.2} GB RAM used ({:.1}%, pressure: {}).", used_mem_gb, total_mem_gb, mem_pct, pressure),
            json!({
                "totalGb": total_mem_gb,
                "usedGb": used_mem_gb,
                "availableGb": avail_mem_gb,
                "utilizationPercent": mem_pct,
                "pressure": pressure,
                "topProcesses": top_mem_procs,
            }),
        ),
        "storage_diagnostics" => (
            format!("Detected {} mounted volume(s) via native OS storage API.", volumes.len()),
            json!({ "volumes": volumes, "physicalDisks": [] }),
        ),
        _ => (
            format!("Native Rust Full Scan: CPU {:.1}%, RAM {:.1}%, {} volume(s), {} warning(s).", cpu_load, mem_pct, volumes.len(), warnings.len()),
            json!({
                "cpu": {
                    "model": cpu_model,
                    "logicalThreads": sys.cpus().len(),
                    "utilizationPercent": cpu_load,
                    "perCorePercent": per_core,
                    "topProcesses": top_cpu_procs,
                },
                "memory": {
                    "totalGb": total_mem_gb,
                    "usedGb": used_mem_gb,
                    "availableGb": avail_mem_gb,
                    "utilizationPercent": mem_pct,
                    "pressure": pressure,
                    "topProcesses": top_mem_procs,
                },
                "storage": { "volumes": volumes, "physicalDisks": [] },
                "network": { "interfaces": iface_names },
                "osHealth": {
                    "uptimeHours": ((System::uptime() as f64 / 3600.0) * 10.0).round() / 10.0,
                    "hardware": { "hostname": System::host_name(), "osCaption": os_version }
                }
            }),
        ),
    };

    Ok(NativeDiagnosticResult {
        id: Uuid::new_v4().to_string(),
        tool_id,
        measurement_type: "measured".into(),
        source: format!("CoreSense Native Rust Agent (sysinfo • {})", current_platform()),
        platform: current_platform().into(),
        os_version,
        collected_at: Utc::now().to_rfc3339(),
        duration_ms: started.elapsed().as_millis() as u64,
        summary,
        limitations,
        warnings,
        data,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_native_diagnostic])
        .run(tauri::generate_context!())
        .expect("error while running CoreSense Desktop");
}
