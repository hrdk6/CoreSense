use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Components, Disks, Networks, System};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn run_fixed_cmd(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Some(stdout);
        }
    }
    None
}

fn describe_win_pnp_code(code: i64) -> String {
    match code {
        1 => "Code 1: Device is not configured correctly.".into(),
        10 => "Code 10: Device cannot start (driver/firmware/hardware fault).".into(),
        12 => "Code 12: Insufficient free system resources (PCIe/IRQ conflict).".into(),
        18 => "Code 18: Reinstall drivers for this device.".into(),
        22 => "Code 22: Device is manually disabled in Device Manager.".into(),
        28 => "Code 28: Drivers for this device are not installed.".into(),
        31 => "Code 31: Windows cannot load required drivers.".into(),
        43 => "Code 43: Windows stopped this device because it reported hardware/driver problems.".into(),
        56 => "Code 56: Windows is still configuring class settings for this device (often seen on VPN/WAN miniport drivers).".into(),
        other => format!("Code {}: OS Plug-and-Play device error.", other),
    }
}

fn collect_native_gpu(warnings: &mut Vec<DiagnosticWarning>, limitations: &mut Vec<String>) -> Value {
    let mut adapters: Vec<Value> = Vec::new();
    let mut has_nvidia_smi = false;
    let mut nv_rows: Vec<(String, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<String>)> = Vec::new();

    if let Some(out) = run_fixed_cmd(
        "nvidia-smi",
        &[
            "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.current.graphics,driver_version",
            "--format=csv,noheader,nounits",
        ],
    ) {
        has_nvidia_smi = true;
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            let p: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if p.len() >= 8 {
                let to_f = |s: &str| s.parse::<f64>().ok().map(|v| (v * 10.0).round() / 10.0);
                nv_rows.push((
                    p[0].to_string(),
                    to_f(p[1]),
                    to_f(p[2]),
                    to_f(p[3]),
                    to_f(p[4]),
                    to_f(p[5]),
                    to_f(p[6]),
                    Some(p[7].to_string()),
                ));
            }
        }
    }

    if cfg!(target_os = "windows") {
        let ps = "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterCompatibility, DriverVersion, AdapterRAM, Status, ConfigManagerErrorCode, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate | ConvertTo-Json -Depth 3";
        if let Some(raw) = run_fixed_cmd(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        ) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                let items: Vec<Value> = match parsed {
                    Value::Array(arr) => arr,
                    Value::Object(_) => vec![parsed],
                    _ => vec![],
                };
                for g in items {
                    let name = g.get("Name").and_then(|v| v.as_str()).unwrap_or("Graphics Adapter").to_string();
                    let nv = nv_rows.iter().find(|r| {
                        let a = name.to_lowercase();
                        let b = r.0.to_lowercase();
                        a.contains(&b) || b.contains(&a)
                    });
                    let err_code = g.get("ConfigManagerErrorCode").and_then(|v| v.as_i64()).unwrap_or(0);
                    let wmi_vram = g
                        .get("AdapterRAM")
                        .and_then(|v| v.as_u64())
                        .filter(|&x| x > 0)
                        .map(|x| (x / (1024 * 1024)) as f64);
                    let vram_mb = nv.and_then(|r| r.4).or(wmi_vram);
                    let res = match (
                        g.get("CurrentHorizontalResolution").and_then(|v| v.as_u64()),
                        g.get("CurrentVerticalResolution").and_then(|v| v.as_u64()),
                    ) {
                        (Some(w), Some(h)) if w > 0 && h > 0 => Some(format!("{}x{}", w, h)),
                        _ => None,
                    };
                    if err_code != 0 {
                        warnings.push(DiagnosticWarning {
                            code: if err_code == 43 { "GPU_CODE_43".into() } else { "GPU_DRIVER_ERROR".into() },
                            severity: if err_code == 43 || err_code == 10 { "critical".into() } else { "warning".into() },
                            component: "gpu".into(),
                            title: format!("GPU Device Fault ({})", name),
                            detail: describe_win_pnp_code(err_code),
                        });
                    }
                    if let Some(temp) = nv.and_then(|r| r.1) {
                        if temp >= 84.0 {
                            warnings.push(DiagnosticWarning {
                                code: "GPU_HIGH_TEMP".into(),
                                severity: if temp >= 92.0 { "critical".into() } else { "warning".into() },
                                component: "thermal".into(),
                                title: format!("Elevated GPU Temperature ({:.1}°C)", temp),
                                detail: format!("{} sensor reads {:.1}°C.", name, temp),
                            });
                        }
                    }
                    adapters.push(json!({
                        "name": name,
                        "vendor": g.get("AdapterCompatibility").and_then(|v| v.as_str()).unwrap_or("Unknown"),
                        "driverVersion": nv.and_then(|r| r.7.clone()).or_else(|| g.get("DriverVersion").and_then(|v| v.as_str()).map(|s| s.to_string())),
                        "driverDate": null,
                        "vramMb": vram_mb,
                        "vramUsedMb": nv.and_then(|r| r.3),
                        "utilizationPercent": nv.and_then(|r| r.2),
                        "temperatureCelsius": nv.and_then(|r| r.1),
                        "powerDrawWatts": nv.and_then(|r| r.5),
                        "clockMhz": nv.and_then(|r| r.6),
                        "resolution": res,
                        "refreshHz": g.get("CurrentRefreshRate").and_then(|v| v.as_u64()),
                        "status": if err_code == 0 { "OK" } else { "Error" },
                        "errorCode": if err_code != 0 { Some(err_code) } else { None },
                        "errorDescription": if err_code != 0 { Some(describe_win_pnp_code(err_code)) } else { None },
                        "telemetrySource": if nv.is_some() { "Win32_VideoController + nvidia-smi" } else { "Win32_VideoController" },
                    }));
                }
            }
        }
    } else if cfg!(target_os = "macos") {
        if let Some(raw) = run_fixed_cmd("system_profiler", &["SPDisplaysDataType", "-json"]) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(arr) = parsed.get("SPDisplaysDataType").and_then(|v| v.as_array()) {
                    for g in arr {
                        let name = g
                            .get("sppci_model")
                            .or_else(|| g.get("_name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Mac GPU");
                        adapters.push(json!({
                            "name": name,
                            "vendor": g.get("spdisplays_vendor").and_then(|v| v.as_str()).unwrap_or("Apple"),
                            "driverVersion": g.get("spdisplays_mtlgpufamilysupport").and_then(|v| v.as_str()),
                            "driverDate": null,
                            "vramMb": null,
                            "vramUsedMb": null,
                            "utilizationPercent": null,
                            "temperatureCelsius": null,
                            "powerDrawWatts": null,
                            "clockMhz": null,
                            "resolution": null,
                            "refreshHz": null,
                            "status": "OK",
                            "errorCode": null,
                            "errorDescription": null,
                            "telemetrySource": "system_profiler",
                        }));
                    }
                }
            }
        }
    } else if let Some(out) = run_fixed_cmd("lspci", &["-nn"]) {
        for line in out.lines() {
            let low = line.to_lowercase();
            if low.contains("vga compatible") || low.contains("3d controller") || low.contains("display controller") {
                let desc = line.split_once(':').map(|x| x.1.trim()).unwrap_or(line);
                let nv = nv_rows.first().filter(|_| low.contains("nvidia"));
                adapters.push(json!({
                    "name": nv.map(|r| r.0.as_str()).unwrap_or(desc),
                    "vendor": if low.contains("nvidia") { "NVIDIA" } else if low.contains("amd") || low.contains("radeon") { "AMD" } else if low.contains("intel") { "Intel" } else { "Unknown" },
                    "driverVersion": nv.and_then(|r| r.7.clone()),
                    "driverDate": null,
                    "vramMb": nv.and_then(|r| r.4),
                    "vramUsedMb": nv.and_then(|r| r.3),
                    "utilizationPercent": nv.and_then(|r| r.2),
                    "temperatureCelsius": nv.and_then(|r| r.1),
                    "powerDrawWatts": nv.and_then(|r| r.5),
                    "clockMhz": nv.and_then(|r| r.6),
                    "resolution": null,
                    "refreshHz": null,
                    "status": "OK",
                    "errorCode": null,
                    "errorDescription": null,
                    "telemetrySource": if nv.is_some() { "lspci + nvidia-smi" } else { "lspci" },
                }));
            }
        }
    }

    if adapters.is_empty() && !nv_rows.is_empty() {
        for r in &nv_rows {
            adapters.push(json!({
                "name": r.0,
                "vendor": "NVIDIA",
                "driverVersion": r.7,
                "vramMb": r.4,
                "vramUsedMb": r.3,
                "utilizationPercent": r.2,
                "temperatureCelsius": r.1,
                "powerDrawWatts": r.5,
                "clockMhz": r.6,
                "status": "OK",
                "errorCode": null,
                "errorDescription": null,
                "telemetrySource": "nvidia-smi",
            }));
        }
    }

    if adapters.is_empty() {
        limitations.push("No GPU adapter details were returned by user-mode OS graphics APIs.".into());
    }

    json!({
        "adapterCount": adapters.len(),
        "adapters": adapters,
        "hasLiveNvidiaSmi": has_nvidia_smi,
    })
}

fn collect_native_peripherals(warnings: &mut Vec<DiagnosticWarning>, limitations: &mut Vec<String>) -> Value {
    let mut usb: Vec<Value> = Vec::new();
    let mut bluetooth: Vec<Value> = Vec::new();
    let mut audio: Vec<Value> = Vec::new();
    let mut cameras: Vec<Value> = Vec::new();
    let mut monitors: Vec<Value> = Vec::new();
    let mut faults: Vec<Value> = Vec::new();

    if cfg!(target_os = "windows") {
        let ps = "$usb = Get-PnpDevice -Class USB, USBDevice -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 25 FriendlyName, Name, Status; $bt = Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 20 FriendlyName, Name, Status; $aud = Get-PnpDevice -Class AudioEndpoint, MEDIA -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 20 FriendlyName, Name, Status; $cam = Get-PnpDevice -Class Camera, Image -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 10 FriendlyName, Name, Status; $mon = Get-PnpDevice -Class Monitor -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 10 FriendlyName, Name, Status; $faults = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.ConfigManagerErrorCode -ne 0 -and $_.ConfigManagerErrorCode -ne $null } | Select-Object -First 20 Name, PNPClass, Status, ConfigManagerErrorCode, DeviceID; @{ usb=$usb; bluetooth=$bt; audio=$aud; camera=$cam; monitor=$mon; faults=$faults } | ConvertTo-Json -Depth 4";
        if let Some(raw) = run_fixed_cmd(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        ) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                let to_vec = |key: &str| -> Vec<Value> {
                    match parsed.get(key) {
                        Some(Value::Array(a)) => a.clone(),
                        Some(obj @ Value::Object(_)) => vec![obj.clone()],
                        _ => vec![],
                    }
                };
                for u in to_vec("usb") {
                    usb.push(json!({
                        "name": u.get("FriendlyName").or_else(|| u.get("Name")).and_then(|v| v.as_str()).unwrap_or("USB Device"),
                        "status": u.get("Status").and_then(|v| v.as_str()).unwrap_or("OK"),
                    }));
                }
                for b in to_vec("bluetooth") {
                    bluetooth.push(json!({
                        "name": b.get("FriendlyName").or_else(|| b.get("Name")).and_then(|v| v.as_str()).unwrap_or("Bluetooth Device"),
                        "status": b.get("Status").and_then(|v| v.as_str()).unwrap_or("OK"),
                    }));
                }
                for a in to_vec("audio") {
                    audio.push(json!({
                        "name": a.get("FriendlyName").or_else(|| a.get("Name")).and_then(|v| v.as_str()).unwrap_or("Audio Endpoint"),
                        "status": a.get("Status").and_then(|v| v.as_str()).unwrap_or("OK"),
                    }));
                }
                for c in to_vec("camera") {
                    cameras.push(json!({
                        "name": c.get("FriendlyName").or_else(|| c.get("Name")).and_then(|v| v.as_str()).unwrap_or("Camera"),
                        "status": c.get("Status").and_then(|v| v.as_str()).unwrap_or("OK"),
                    }));
                }
                for m in to_vec("monitor") {
                    monitors.push(json!({
                        "name": m.get("FriendlyName").or_else(|| m.get("Name")).and_then(|v| v.as_str()).unwrap_or("Monitor"),
                        "status": m.get("Status").and_then(|v| v.as_str()).unwrap_or("OK"),
                    }));
                }
                for f in to_vec("faults") {
                    let code = f.get("ConfigManagerErrorCode").and_then(|v| v.as_i64()).unwrap_or(0);
                    let name = f.get("Name").and_then(|v| v.as_str()).unwrap_or("Unknown Device");
                    let cls = f.get("PNPClass").and_then(|v| v.as_str()).unwrap_or("Hardware");
                    let desc = describe_win_pnp_code(code);
                    if code != 0 && code != 22 {
                        warnings.push(DiagnosticWarning {
                            code: format!("PNP_ERROR_CODE_{}", code),
                            severity: if code == 43 || code == 10 { "critical".into() } else { "warning".into() },
                            component: "peripherals".into(),
                            title: format!("Device Fault: {} (Code {})", name, code),
                            detail: desc.clone(),
                        });
                    }
                    faults.push(json!({
                        "name": name,
                        "deviceClass": cls,
                        "status": if code == 22 { "Disabled" } else { "Error" },
                        "errorCode": code,
                        "errorDescription": desc,
                        "instanceId": f.get("DeviceID").and_then(|v| v.as_str()).unwrap_or(""),
                    }));
                }
            }
        } else {
            limitations.push("Windows PnP peripheral query could not complete in user mode.".into());
        }
    } else if cfg!(target_os = "linux") {
        if let Some(out) = run_fixed_cmd("lsusb", &[]) {
            for line in out.lines().take(25) {
                usb.push(json!({ "name": line.trim(), "status": "OK" }));
            }
        }
    } else {
        limitations.push("macOS USB/Bluetooth peripheral inspection uses system_profiler when invoked via the Host Collector.".into());
    }

    let active_faults = faults
        .iter()
        .filter(|f| f.get("errorCode").and_then(|v| v.as_i64()).unwrap_or(0) != 22)
        .count();

    json!({
        "counts": {
            "usb": usb.len(),
            "bluetooth": bluetooth.len(),
            "audio": audio.len(),
            "cameras": cameras.len(),
            "monitors": monitors.len(),
            "faultedDevices": active_faults,
        },
        "usbDevices": usb,
        "bluetoothDevices": bluetooth,
        "audioEndpoints": audio,
        "cameras": cameras,
        "monitors": monitors,
        "faultedDevices": faults,
    })
}

fn run_native_stress_probe(cpu_model: &str, logical_threads: usize, warnings: &mut Vec<DiagnosticWarning>, limitations: &mut Vec<String>) -> Value {
    let mut windows: Vec<Value> = Vec::new();
    let mut scores: Vec<f64> = Vec::new();
    let mut sink: f64 = 0.0;

    for w in 0..4 {
        let t0 = Instant::now();
        let mut ops: u64 = 0;
        while t0.elapsed() < Duration::from_millis(650) {
            let mut acc: f64 = 0.0;
            for i in 1..=400 {
                let x = (i as f64 + ops as f64) * 0.00137;
                acc += x.sin() * x.cos() + (i as f64 + 1.5).sqrt();
            }
            sink += acc;
            ops += 1;
        }
        let elapsed_ms = t0.elapsed().as_millis().max(1) as f64;
        let k_ops = (((ops * 400) as f64 / elapsed_ms) * 10.0).round() / 10.0;
        scores.push(k_ops);
        windows.push(json!({
            "windowIndex": w + 1,
            "durationMs": elapsed_ms as u64,
            "kOpsPerSec": k_ops,
        }));
        thread::sleep(Duration::from_millis(30));
    }

    let peak = scores.iter().cloned().fold(0.0_f64, f64::max);
    let sustained = *scores.last().unwrap_or(&peak);
    let avg = ((scores.iter().sum::<f64>() / scores.len().max(1) as f64) * 10.0).round() / 10.0;
    let drop_pct = if peak > 0.0 {
        (((peak - sustained) / peak * 100.0).max(0.0) * 10.0).round() / 10.0
    } else {
        0.0
    };
    let stability = ((100.0 - drop_pct).clamp(0.0, 100.0) * 10.0).round() / 10.0;

    if drop_pct >= 22.0 {
        warnings.push(DiagnosticWarning {
            code: "CPU_THROTTLING_DETECTED".into(),
            severity: if drop_pct >= 32.0 { "critical".into() } else { "warning".into() },
            component: "thermal".into(),
            title: format!("Native CPU Throughput Dropped {:.1}%", drop_pct),
            detail: format!("Peak {:.1} kOps/s fell to {:.1} kOps/s across the 4-window compute stress test.", peak, sustained),
        });
    }

    // Safe 16 MB self-cleaning sequential temp file disk benchmark
    let mut write_mbps: Option<f64> = None;
    let mut read_mbps: Option<f64> = None;
    let tmp_path = std::env::temp_dir().join(format!("coresense-native-bench-{}.tmp", Uuid::new_v4()));
    let buf: Vec<u8> = (0..(16 * 1024 * 1024)).map(|i| ((i * 31 + 17) % 251) as u8).collect();
    let w0 = Instant::now();
    if let Ok(mut f) = File::create(&tmp_path) {
        if f.write_all(&buf).is_ok() && f.sync_all().is_ok() {
            let w_sec = w0.elapsed().as_secs_f64().max(0.001);
            write_mbps = Some(((16.0 / w_sec) * 10.0).round() / 10.0);
            let r0 = Instant::now();
            if let Ok(read_back) = fs::read(&tmp_path) {
                if read_back.len() == buf.len() {
                    let r_sec = r0.elapsed().as_secs_f64().max(0.001);
                    read_mbps = Some(((16.0 / r_sec) * 10.0).round() / 10.0);
                }
            }
        }
    } else {
        limitations.push("Unable to create temp file for disk throughput benchmark.".into());
    }
    let _ = fs::remove_file(&tmp_path);

    json!({
        "checksumGuard": sink.is_finite(),
        "cpuBenchmark": {
            "logicalThreads": logical_threads,
            "cpuModel": cpu_model,
            "peakKOpsPerSec": peak,
            "sustainedKOpsPerSec": sustained,
            "averageKOpsPerSec": avg,
            "throttleDropPercent": drop_pct,
            "stabilityPercent": stability,
            "windows": windows,
        },
        "diskBenchmark": {
            "sampleSizeMb": 16,
            "targetDir": std::env::temp_dir().to_string_lossy(),
            "sequentialWriteMBps": write_mbps,
            "sequentialReadMBps": read_mbps,
        }
    })
}

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
        "gpu_diagnostics",
        "network_diagnostics",
        "peripherals_diagnostics",
        "hardware_stress_probe",
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

    let gpu_json = if tool_id == "gpu_diagnostics" || tool_id == "full_system_snapshot" {
        collect_native_gpu(&mut warnings, &mut limitations)
    } else {
        json!({ "adapterCount": 0, "adapters": [], "hasLiveNvidiaSmi": false })
    };

    let peripherals_json = if tool_id == "peripherals_diagnostics" || tool_id == "full_system_snapshot" {
        collect_native_peripherals(&mut warnings, &mut limitations)
    } else {
        json!({ "counts": {}, "usbDevices": [], "bluetoothDevices": [], "audioEndpoints": [], "cameras": [], "monitors": [], "faultedDevices": [] })
    };

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
        "gpu_diagnostics" => {
            let count = gpu_json.get("adapterCount").and_then(|v| v.as_u64()).unwrap_or(0);
            (
                format!("Detected {} GPU adapter(s) via native OS graphics collector.", count),
                gpu_json,
            )
        }
        "peripherals_diagnostics" => {
            let usb_c = peripherals_json.pointer("/counts/usb").and_then(|v| v.as_u64()).unwrap_or(0);
            let bt_c = peripherals_json.pointer("/counts/bluetooth").and_then(|v| v.as_u64()).unwrap_or(0);
            let aud_c = peripherals_json.pointer("/counts/audio").and_then(|v| v.as_u64()).unwrap_or(0);
            let flt_c = peripherals_json.pointer("/counts/faultedDevices").and_then(|v| v.as_u64()).unwrap_or(0);
            (
                format!(
                    "Enumerated {} USB, {} Bluetooth, {} audio device(s); {} active PnP fault(s).",
                    usb_c, bt_c, aud_c, flt_c
                ),
                peripherals_json,
            )
        }
        "hardware_stress_probe" => {
            let stress_data = run_native_stress_probe(&cpu_model, sys.cpus().len(), &mut warnings, &mut limitations);
            let avg_k = stress_data.pointer("/cpuBenchmark/averageKOpsPerSec").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let stab = stress_data.pointer("/cpuBenchmark/stabilityPercent").and_then(|v| v.as_f64()).unwrap_or(100.0);
            let w_mb = stress_data.pointer("/diskBenchmark/sequentialWriteMBps").and_then(|v| v.as_f64());
            (
                format!(
                    "Native Stress Probe: CPU {:.1} kOps/s avg ({:.1}% stability), Disk write {}.",
                    avg_k,
                    stab,
                    w_mb.map(|v| format!("{:.1} MB/s", v)).unwrap_or_else(|| "N/A".into())
                ),
                stress_data,
            )
        }
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
                "Native Rust Full Scan: CPU {:.1}%, RAM {:.1}%, {} GPU(s), {} volume(s), DNS {}, {} warning(s).",
                cpu_load,
                mem_pct,
                gpu_json.get("adapterCount").and_then(|v| v.as_u64()).unwrap_or(0),
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
                "gpu": gpu_json,
                "network": net_json,
                "peripherals": peripherals_json,
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![run_native_diagnostic])
        .run(tauri::generate_context!())
        .expect("error while running CoreSense Desktop");
}
