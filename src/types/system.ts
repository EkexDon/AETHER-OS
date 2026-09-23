/** System monitor types — mirror `engine/system_monitor.rs`. */

/** Per-core CPU usage (0–100). */
export interface CpuInfo {
  name: string;
  usage: number;
}

/** Memory in bytes. */
export interface MemoryInfo {
  total: number;
  used: number;
  available: number;
}

/** One mounted disk, sizes in bytes. */
export interface DiskInfo {
  name: string;
  mount_point: string;
  total: number;
  used: number;
  available: number;
}

/** Network interface throughput in bytes per second. */
export interface NetworkInfo {
  interface: string;
  rx_rate: number;
  tx_rate: number;
}

/** A running process (memory in bytes). */
export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_usage: number;
  memory: number;
}

/** Battery state, when the machine has one. */
export interface BatteryInfo {
  charging: boolean;
  percent: number;
}

/** Full snapshot returned by `cmd_get_system_metrics`. */
export interface SystemMetrics {
  /** Seconds since the Unix epoch. */
  timestamp: number;
  cpus: CpuInfo[];
  overall_cpu: number;
  memory: MemoryInfo;
  disks: DiskInfo[];
  network: NetworkInfo[];
  processes: ProcessInfo[];
  battery: BatteryInfo | null;
  /** Seconds since boot. */
  uptime: number;
}
