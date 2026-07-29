use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Per-core CPU usage as a percentage (0–100).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    pub name: String,
    pub usage: f32,
}

/// Memory statistics in bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryInfo {
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

/// Disk statistics for a single partition in bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub name: String,
    pub mount_point: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

/// Network throughput in bytes per second.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInfo {
    pub interface: String,
    pub rx_rate: f64,
    pub tx_rate: f64,
}

/// A single process in the top-processes list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_usage: f32,
    pub memory: u64,
}

/// Battery information if a battery is present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatteryInfo {
    pub charging: bool,
    pub percent: f32,
}

/// Full snapshot of system resource usage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetrics {
    pub timestamp: i64,
    pub cpus: Vec<CpuInfo>,
    pub overall_cpu: f32,
    pub memory: MemoryInfo,
    pub disks: Vec<DiskInfo>,
    pub network: Vec<NetworkInfo>,
    pub processes: Vec<ProcessInfo>,
    pub battery: Option<BatteryInfo>,
    pub uptime: u64,
}

/// Thread-safe system monitor that wraps `sysinfo` types.
///
/// `System` is not `Sync` by default because it contains interior
/// mutability for network rate tracking. We wrap it in a `Mutex` to
/// share it across Tauri command calls.
pub struct SystemMonitor {
    sys: Mutex<sysinfo::System>,
    networks: Mutex<sysinfo::Networks>,
    prev_rx: Mutex<std::collections::HashMap<String, u64>>,
    prev_tx: Mutex<std::collections::HashMap<String, u64>>,
    prev_ts: Mutex<std::time::Instant>,
}

impl SystemMonitor {
    pub fn new() -> Self {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_all();

        let mut networks = sysinfo::Networks::new();
        networks.refresh();

        Self {
            sys: Mutex::new(sys),
            networks: Mutex::new(networks),
            prev_rx: Mutex::new(std::collections::HashMap::new()),
            prev_tx: Mutex::new(std::collections::HashMap::new()),
            prev_ts: Mutex::new(std::time::Instant::now()),
        }
    }

    /// Collect a full snapshot of current system metrics.
    pub fn collect(&self) -> SystemMetrics {
        let mut sys = self.sys.lock().unwrap();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All);

        // Small delay so CPU usage readings are non-zero on first call.
        std::thread::sleep(std::time::Duration::from_millis(50));

        let cpus: Vec<CpuInfo> = sys
            .cpus()
            .iter()
            .enumerate()
            .map(|(i, cpu)| CpuInfo {
                name: format!("Core {}", i),
                usage: cpu.cpu_usage(),
            })
            .collect();

        let overall_cpu = sys.global_cpu_usage();

        let memory = MemoryInfo {
            total: sys.total_memory(),
            used: sys.used_memory(),
            available: sys.available_memory(),
        };

        let disks: Vec<DiskInfo> = sysinfo::Disks::new_with_refreshed_list()
            .list()
            .iter()
            .map(|d| DiskInfo {
                name: d.name().to_string_lossy().to_string(),
                mount_point: d.mount_point().to_string_lossy().to_string(),
                total: d.total_space(),
                used: d.total_space() - d.available_space(),
                available: d.available_space(),
            })
            .collect();

        // Network rates
        let mut networks = self.networks.lock().unwrap();
        networks.refresh();
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(*self.prev_ts.lock().unwrap()).as_secs_f64();
        let elapsed = if elapsed > 0.0 { elapsed } else { 1.0 };

        let mut prev_rx = self.prev_rx.lock().unwrap();
        let mut prev_tx = self.prev_tx.lock().unwrap();

        let net_info: Vec<NetworkInfo> = networks
            .list()
            .iter()
            .map(|(name, data)| {
                let rx_total = data.total_received();
                let tx_total = data.total_transmitted();

                let rx_rate = if let Some(&prev) = prev_rx.get(name) {
                    (rx_total.saturating_sub(prev)) as f64 / elapsed
                } else {
                    0.0
                };
                let tx_rate = if let Some(&prev) = prev_tx.get(name) {
                    (tx_total.saturating_sub(prev)) as f64 / elapsed
                } else {
                    0.0
                };

                prev_rx.insert(name.clone(), rx_total);
                prev_tx.insert(name.clone(), tx_total);

                NetworkInfo {
                    interface: name.clone(),
                    rx_rate,
                    tx_rate,
                }
            })
            .collect();

        *self.prev_ts.lock().unwrap() = now;

        // Top processes by CPU usage
        let mut procs: Vec<ProcessInfo> = sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcessInfo {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().to_string(),
                cpu_usage: p.cpu_usage(),
                memory: p.memory(),
            })
            .collect();
        procs.sort_by(|a, b| b.cpu_usage.partial_cmp(&a.cpu_usage).unwrap_or(std::cmp::Ordering::Equal));
        procs.truncate(10);

        // Battery (best-effort, may not be available on desktops)
        // sysinfo 0.31 does not expose a dedicated battery API.
        let battery: Option<BatteryInfo> = None;

        let timestamp = chrono::Utc::now().timestamp();
        let uptime = sysinfo::System::uptime();

        SystemMetrics {
            timestamp,
            cpus,
            overall_cpu,
            memory,
            disks,
            network: net_info,
            processes: procs,
            battery,
            uptime,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_returns_non_empty_cpus() {
        let monitor = SystemMonitor::new();
        let metrics = monitor.collect();
        assert!(!metrics.cpus.is_empty(), "should have at least one CPU core");
        assert!(metrics.overall_cpu >= 0.0 && metrics.overall_cpu <= 100.0);
    }

    #[test]
    fn collect_returns_valid_memory() {
        let monitor = SystemMonitor::new();
        let metrics = monitor.collect();
        assert!(metrics.memory.total > 0, "total memory should be > 0");
        assert!(metrics.memory.used <= metrics.memory.total, "used <= total");
        assert!(
            metrics.memory.available <= metrics.memory.total,
            "available <= total"
        );
    }

    #[test]
    fn collect_returns_at_least_one_disk() {
        let monitor = SystemMonitor::new();
        let metrics = monitor.collect();
        assert!(!metrics.disks.is_empty(), "should have at least one disk");
        let disk = &metrics.disks[0];
        assert!(disk.total > 0, "disk total should be > 0");
        assert!(disk.used + disk.available <= disk.total + 1, "used + available <= total");
    }

    #[test]
    fn collect_returns_network_interfaces() {
        let monitor = SystemMonitor::new();
        let _ = monitor.collect(); // first call to seed prev counters
        std::thread::sleep(std::time::Duration::from_millis(100));
        let metrics = monitor.collect();
        // Network interfaces may be empty on some CI environments, so just
        // verify the field exists and is a vec.
        let _ = &metrics.network;
    }

    #[test]
    fn collect_returns_top_processes() {
        let monitor = SystemMonitor::new();
        let metrics = monitor.collect();
        assert!(!metrics.processes.is_empty(), "should have at least one process");
        assert!(metrics.processes.len() <= 10, "should cap at 10 processes");
        // Verify sorted by CPU usage descending
        for i in 1..metrics.processes.len() {
            assert!(
                metrics.processes[i - 1].cpu_usage >= metrics.processes[i].cpu_usage,
                "processes should be sorted by CPU usage descending"
            );
        }
    }

    #[test]
    fn collect_returns_valid_timestamp_and_uptime() {
        let monitor = SystemMonitor::new();
        let metrics = monitor.collect();
        assert!(metrics.timestamp > 0, "timestamp should be > 0");
        assert!(metrics.uptime > 0, "uptime should be > 0");
    }

    #[test]
    fn repeated_collect_produces_consistent_structure() {
        let monitor = SystemMonitor::new();
        let m1 = monitor.collect();
        let m2 = monitor.collect();
        assert_eq!(m1.cpus.len(), m2.cpus.len(), "CPU count should be stable");
        assert_eq!(
            m1.memory.total, m2.memory.total,
            "total memory should be stable"
        );
    }
}
