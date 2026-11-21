use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Components, Disks, Networks, System};
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

fn probe_tcp_ms(addr: &str, timeout_ms: u64) -> Option<u64> {
    let parsed: SocketAddr = addr.parse().ok()?;
    let t0 = Instant::now();
    TcpStream::connect_timeout(&parsed, Duration::from_millis(timeout_ms))
        .ok()
        .map(|_| t0.elapsed().as_millis() as u64)
}

fn probe_dns_ms(host: &str) -> (bool, Vec<String>, Option<u64>, Option<String>) {
    let t0 = Instant::now();
    match (host, 443).to_socket_addrs() {
        Ok(iter) => {
            let ips: Vec<String> = iter.map(|sa| sa.ip().to_string()).take(4).collect();
            (true, ips, Some(t0.elapsed().as_millis() as u64), None)
        }
        Err(e) => (false, vec![], None, Some(e.to_string())),
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
        "network_diagnostics",
        "os_health_diagnostics",
        "power_and_peripherals",
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

    // CPU & Thermal sensors
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

    let components = Components::new_with_refreshed_list();
    let mut cpu_temp_c: Option<f32> = None;
    for comp in components.list() {
        if let Some(t) = comp.temperature() {
            let lbl = comp.label().to_lowercase();
            if (lbl.contains("cpu") || lbl.contains("package") || lbl.contains("core") || cpu_temp_c.is_none())
                && t > 5.0
                && t < 130.0
            {
                cpu_temp_c = Some((t * 10.0).round() / 10.0);
            }
        }
    }

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
    if let Some(temp) = cpu_temp_c {
        if temp >= 88.0 {
            warnings.push(DiagnosticWarning {
                code: "HIGH_CPU_TEMP".into(),
                severity: "critical".into(),
                component: "thermal".into(),
                title: "Elevated Thermal Sensor Reading".into(),
                detail: format!("Native hardware sensor reported {:.1}°C.", temp),
            });
        }
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
            detail: format!(
                "RAM utilization is {:.1}% ({:.2}/{:.2} GB).",
                mem_pct, used_mem_gb, total_mem_gb
            ),
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
                severity: if used_pct >= 96.0 {
                    "critical".into()
                } else {
                    "warning".into()
                },
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

    // Network interfaces + live DNS & direct TCP reachability
    let networks = Networks::new_with_refreshed_list();
    let iface_list: Vec<Value> = networks
        .iter()
        .map(|(name, data)| {
            json!({
                "name": name,
                "rxKb": data.total_received() / 1024,
                "txKb": data.total_transmitted() / 1024,
                "internal": false,
            })
        })
        .collect();

    let (dns_ok, dns_ips, dns_ms, dns_err) = if tool_id == "network_diagnostics" || tool_id == "full_system_snapshot" {
        probe_dns_ms("cloudflare.com")
    } else {
        (true, vec![], None, None)
    };
    let direct_ip_ms = if tool_id == "network_diagnostics" || tool_id == "full_system_snapshot" {
        probe_tcp_ms("1.1.1.1:443", 2200)
    } else {
        None
    };

    if tool_id == "network_diagnostics" || tool_id == "full_system_snapshot" {
        if direct_ip_ms.is_some() && !dns_ok {
            warnings.push(DiagnosticWarning {
                code: "DNS_RESOLUTION_FAILURE".into(),
                severity: "critical".into(),
                component: "network".into(),
                title: "DNS Resolution Failed While Direct IP Works".into(),
                detail: format!(
                    "Direct TCP to 1.1.1.1:443 succeeded ({}ms), but DNS lookup failed ({}).",
                    direct_ip_ms.unwrap_or(0),
                    dns_err.clone().unwrap_or_else(|| "unknown".into())
                ),
            });
        } else if direct_ip_ms.is_none() && !dns_ok {
            warnings.push(DiagnosticWarning {
                code: "INTERNET_UNREACHABLE".into(),
                severity: "critical".into(),
                component: "network".into(),
                title: "External Network Unreachable".into(),
                detail: "Neither 1.1.1.1:443 nor DNS lookup for cloudflare.com succeeded.".into(),
            });
        }
    }

    let uptime_hours = ((System::uptime() as f64 / 3600.0) * 10.0).round() / 10.0;
    let kernel_ver = System::kernel_version().unwrap_or_else(|| "Unknown".into());
    let hostname = System::host_name().unwrap_or_else(|| "Local Host".into());

    limitations.push("Low-level NVMe SMART registers, Windows Event Logs, and ACPI battery wear counters use OS-specific APIs when executed via the CoreSense Host Collector; user-mode Rust probes remain strictly read-only.".into());

    let net_json = json!({
        "interfaces": iface_list,
        "connectivity": {
            "testHost": "cloudflare.com",
            "dnsResolved": dns_ok,
            "dnsResolvedIps": dns_ips,
            "dnsLatencyMs": dns_ms,
            "dnsError": dns_err,
            "directIpReachable": direct_ip_ms.is_some(),
            "directIpLatencyMs": direct_ip_ms,
        }
    });

    let os_json = json!({
        "uptimeHours": uptime_hours,
        "recentErrors": [],
        "hardware": {
            "hostname": hostname,
            "osCaption": os_version,
            "kernelVersion": kernel_ver,
        }
    });

    let sensor_list: Vec<Value> = components
        .list()
        .iter()
        .filter_map(|c| c.temperature().map(|t| json!({ "label": c.label(), "tempC": (t * 10.0).round() / 10.0 })))
        .take(10)
        .collect();

    let power_json = json!({
        "battery": {
            "present": false,
            "status": "Use Host Collector for ACPI battery wear",
            "chargePercent": null,
            "wearPercent": null
        },
        "displays": [],
        "thermalSensors": sensor_list
    });

    let (summary, data) = match tool_id.as_str() {
        "cpu_diagnostics" => (
            format!(
                "{} — {:.1}% live CPU load across {} threads{}.",
                cpu_model,
                cpu_load,
                sys.cpus().len(),
                cpu_temp_c.map(|t| format!(", {:.1}°C", t)).unwrap_or_default()
            ),
            json!({
                "model": cpu_model,
                "logicalThreads": sys.cpus().len(),
                "utilizationPercent": cpu_load,
                "perCorePercent": per_core,
                "temperatureCelsius": cpu_temp_c,
                "topProcesses": top_cpu_procs,
            }),
        ),
        "memory_diagnostics" => (
            format!(
                "{:.2} GB / {:.2} GB RAM used ({:.1}%, pressure: {}).",
                used_mem_gb, total_mem_gb, mem_pct, pressure
            ),
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
        "network_diagnostics" => (
            format!(
                "{} interface(s); DNS: {}; Direct IP 1.1.1.1: {}.",
                iface_list.len(),
                if dns_ok { format!("{}ms", dns_ms.unwrap_or(0)) } else { "FAILED".into() },
                direct_ip_ms.map(|m| format!("{}ms", m)).unwrap_or_else(|| "UNREACHABLE".into())
            ),
            net_json,
        ),
        "os_health_diagnostics" => (
            format!("{} (Kernel {}) — Uptime {:.1}h on {}.", os_version, kernel_ver, uptime_hours, hostname),
            os_json,
        ),
        "power_and_peripherals" => (
            format!("Detected {} hardware thermal sensor(s) via native Rust probe.", sensor_list.len()),
            power_json,
        ),
        _ => (
            format!(
                "Native Rust Full Scan: CPU {:.1}%, RAM {:.1}%, {} volume(s), DNS {}, {} warning(s).",
                cpu_load,
                mem_pct,
                volumes.len(),
                if dns_ok { "OK" } else { "FAIL" },
                warnings.len()
            ),
            json!({
                "cpu": {
                    "model": cpu_model,
                    "logicalThreads": sys.cpus().len(),
                    "utilizationPercent": cpu_load,
                    "perCorePercent": per_core,
                    "temperatureCelsius": cpu_temp_c,
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
                "network": net_json,
                "osHealth": os_json,
                "power": power_json,
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
