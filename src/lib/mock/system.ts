/**
 * Mock handler for `commands/system_commands.rs`: smoothly varying CPU,
 * memory, disk, network, process and battery readings (mean-reverting
 * random walks, so charts look alive without jumping around).
 */
import type { ProcessInfo, SystemMetrics } from "../../types";
import { nowSeconds, registerReset, type MockHandlerMap } from "./runtime";

const GIB = 1024 ** 3;
const CORES = 8;
const MEMORY_TOTAL = 32 * GIB;
const DISK_TOTAL = 994 * 1000 ** 3;
const PROCESS_NAMES = [
  "WindowServer", "aether-os", "ollama", "Safari", "node", "rust-analyzer",
  "Code Helper (Renderer)", "kernel_task", "Spotify", "Finder", "mds_stores", "zsh",
];

/** A value that drifts towards a slowly moving target. */
class Walk {
  constructor(
    private value: number,
    private target: number,
    private readonly min: number,
    private readonly max: number,
    private readonly volatility: number
  ) {}

  next(): number {
    if (Math.random() < 0.08) {
      this.target = this.min + Math.random() * (this.max - this.min);
    }
    const noise = (Math.random() - 0.5) * this.volatility;
    this.value += (this.target - this.value) * 0.18 + noise;
    this.value = Math.min(this.max, Math.max(this.min, this.value));
    return this.value;
  }
}

interface MonitorState {
  bootedAt: number;
  cpus: Walk[];
  memory: Walk;
  diskUsed: number;
  rx: Walk;
  tx: Walk;
  processes: { pid: number; name: string; cpu: Walk; memory: Walk }[];
  battery: number;
  charging: boolean;
}

function seed(): MonitorState {
  return {
    bootedAt: nowSeconds() - 3 * 86_400 - 4 * 3600,
    cpus: Array.from({ length: CORES }, (_, i) => new Walk(12 + i * 2, 18, 2, i < 4 ? 92 : 60, 9)),
    memory: new Walk(17.5 * GIB, 18 * GIB, 11 * GIB, 27 * GIB, 0.35 * GIB),
    diskUsed: 612 * 1000 ** 3,
    rx: new Walk(420_000, 600_000, 8_000, 9_000_000, 350_000),
    tx: new Walk(90_000, 120_000, 2_000, 2_500_000, 80_000),
    processes: PROCESS_NAMES.map((name, i) => ({
      pid: 180 + i * 97,
      name,
      cpu: new Walk(Math.max(0.2, 24 - i * 2), 10, 0, i < 3 ? 85 : 35, 4),
      memory: new Walk((1400 - i * 90) * 1024 ** 2, 900 * 1024 ** 2, 40 * 1024 ** 2, 2400 * 1024 ** 2, 30 * 1024 ** 2),
    })),
    battery: 78,
    charging: false,
  };
}

let state = seed();
registerReset(() => {
  state = seed();
});

/** One metrics snapshot; every call advances the random walks. */
export function sampleMetrics(): SystemMetrics {
  const cpus = state.cpus.map((walk, i) => ({ name: String(i + 1), usage: round(walk.next(), 1) }));
  const overall = cpus.reduce((sum, c) => sum + c.usage, 0) / cpus.length;
  const used = Math.round(state.memory.next());
  state.diskUsed += Math.round((Math.random() - 0.35) * 40_000_000);
  state.charging = state.battery <= 20 ? true : state.battery >= 99 ? false : state.charging;
  state.battery = Math.min(100, Math.max(5, state.battery + (state.charging ? 0.08 : -0.03)));
  const processes: ProcessInfo[] = state.processes
    .map((p) => ({ pid: p.pid, name: p.name, cpu_usage: round(p.cpu.next(), 1), memory: Math.round(p.memory.next()) }))
    .sort((a, b) => b.cpu_usage - a.cpu_usage);
  return {
    timestamp: nowSeconds(),
    cpus,
    overall_cpu: round(overall, 1),
    memory: { total: MEMORY_TOTAL, used, available: MEMORY_TOTAL - used },
    disks: [
      { name: "Macintosh HD", mount_point: "/", total: DISK_TOTAL, used: state.diskUsed, available: DISK_TOTAL - state.diskUsed },
      { name: "Backup", mount_point: "/Volumes/Backup", total: 2_000 * 1000 ** 3, used: 1_210 * 1000 ** 3, available: 790 * 1000 ** 3 },
    ],
    network: [
      { interface: "en0", rx_rate: Math.round(state.rx.next()), tx_rate: Math.round(state.tx.next()) },
      { interface: "utun3", rx_rate: Math.round(Math.random() * 4_000), tx_rate: Math.round(Math.random() * 2_000) },
    ],
    processes,
    battery: { charging: state.charging, percent: round(state.battery, 0) },
    uptime: nowSeconds() - state.bootedAt,
  };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export const systemHandlers: MockHandlerMap = {
  cmd_get_system_metrics: () => sampleMetrics(),
};
