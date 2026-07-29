import { useEffect, useRef, useState, useCallback } from "react";
import { Cpu, MemoryStick, HardDrive, Wifi, Battery, Activity, Clock } from "lucide-react";
import { getSystemMetrics, isDesktopRuntime } from "../lib/ipc";
import type { SystemMetrics } from "../types";

const POLL_INTERVAL_MS = 2000;
const MAX_HISTORY = 60;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function MiniSparkline({ data, max, color }: { data: number[]; max: number; color: string }) {
  const width = 200;
  const height = 40;
  if (data.length < 2) {
    return <svg width={width} height={height} className="monitor-sparkline" />;
  }
  const safeMax = max > 0 ? max : 1;
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * step;
      const y = height - (Math.min(v, safeMax) / safeMax) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width={width} height={height} className="monitor-sparkline">
      <polygon points={areaPoints} fill={color} opacity={0.1} />
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

function MetricCard({
  icon,
  label,
  value,
  subValue,
  sparklineData,
  sparklineMax,
  sparklineColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  sparklineData?: number[];
  sparklineMax?: number;
  sparklineColor?: string;
}) {
  return (
    <div className="monitor-card">
      <div className="monitor-card-header">
        <span className="monitor-card-icon">{icon}</span>
        <span className="monitor-card-label">{label}</span>
      </div>
      <div className="monitor-card-value">{value}</div>
      {subValue && <div className="monitor-card-subvalue">{subValue}</div>}
      {sparklineData && sparklineMax !== undefined && sparklineColor && (
        <MiniSparkline data={sparklineData} max={sparklineMax} color={sparklineColor} />
      )}
    </div>
  );
}

function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="monitor-progress">
      <div className="monitor-progress-header">
        <span>{label}</span>
        <span>{pct.toFixed(1)}%</span>
      </div>
      <div className="monitor-progress-bar">
        <div className="monitor-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SystemMonitor() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const cpuHistoryRef = useRef<number[]>([]);
  const memHistoryRef = useRef<number[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!isDesktopRuntime()) {
      setError("System Monitor requires the desktop runtime. Start with: npm run app");
      setRunning(false);
      return;
    }
    try {
      const m = await getSystemMetrics();
      setMetrics(m);
      setError(null);
      cpuHistoryRef.current = [...cpuHistoryRef.current, m.overall_cpu].slice(-MAX_HISTORY);
      memHistoryRef.current = [...memHistoryRef.current, m.memory.used].slice(-MAX_HISTORY);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!running) return;
    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running, poll]);

  if (error && !metrics) {
    return (
      <div className="monitor-container">
        <div className="monitor-error">
          <Activity size={48} />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="monitor-container">
        <div className="monitor-loading">
          <Activity size={48} className="monitor-loading-icon" />
          <p>Collecting system metrics…</p>
        </div>
      </div>
    );
  }

  const memPct = metrics.memory.total > 0 ? (metrics.memory.used / metrics.memory.total) * 100 : 0;

  return (
    <div className="monitor-container">
      <div className="monitor-header">
        <h2 className="monitor-title">System Monitor</h2>
        <div className="monitor-controls">
          <span className="monitor-uptime">
            <Clock size={14} />
            {formatUptime(metrics.uptime)}
          </span>
          <button
            className="btn btn-secondary monitor-toggle"
            onClick={() => setRunning((r) => !r)}
          >
            {running ? "Pause" : "Resume"}
          </button>
        </div>
      </div>

      {error && <div className="monitor-error-banner">{error}</div>}

      <div className="monitor-grid">
        <MetricCard
          icon={<Cpu size={18} />}
          label="CPU Usage"
          value={`${metrics.overall_cpu.toFixed(1)}%`}
          subValue={`${metrics.cpus.length} cores`}
          sparklineData={cpuHistoryRef.current}
          sparklineMax={100}
          sparklineColor="#6b6bf5"
        />
        <MetricCard
          icon={<MemoryStick size={18} />}
          label="Memory"
          value={formatBytes(metrics.memory.used)}
          subValue={`of ${formatBytes(metrics.memory.total)} (${memPct.toFixed(1)}%)`}
          sparklineData={memHistoryRef.current}
          sparklineMax={metrics.memory.total}
          sparklineColor="#4ade80"
        />
        {metrics.battery && (
          <MetricCard
            icon={<Battery size={18} />}
            label="Battery"
            value={`${metrics.battery.percent.toFixed(0)}%`}
            subValue={metrics.battery.charging ? "Charging" : "On battery"}
          />
        )}
      </div>

      <div className="monitor-section">
        <h3 className="monitor-section-title">
          <HardDrive size={16} />
          Disk Usage
        </h3>
        <div className="monitor-disks">
          {metrics.disks.map((disk, i) => (
            <ProgressBar
              key={i}
              value={disk.used}
              max={disk.total}
              label={`${disk.name} (${disk.mount_point}) — ${formatBytes(disk.used)} / ${formatBytes(disk.total)}`}
            />
          ))}
        </div>
      </div>

      <div className="monitor-section">
        <h3 className="monitor-section-title">
          <Wifi size={16} />
          Network
        </h3>
        <div className="monitor-network-grid">
          {metrics.network.length === 0 && (
            <span className="monitor-empty">No active network interfaces</span>
          )}
          {metrics.network.map((net, i) => (
            <div key={i} className="monitor-network-item">
              <span className="monitor-network-name">{net.interface}</span>
              <span className="monitor-network-rate">↓ {formatRate(net.rx_rate)}</span>
              <span className="monitor-network-rate">↑ {formatRate(net.tx_rate)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="monitor-section">
        <h3 className="monitor-section-title">
          <Activity size={16} />
          Top Processes
        </h3>
        <div className="monitor-processes">
          <table className="monitor-process-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>Name</th>
                <th>CPU %</th>
                <th>Memory</th>
              </tr>
            </thead>
            <tbody>
              {metrics.processes.map((proc) => (
                <tr key={proc.pid}>
                  <td className="monitor-pid">{proc.pid}</td>
                  <td className="monitor-proc-name">{proc.name}</td>
                  <td className="monitor-proc-cpu">{proc.cpu_usage.toFixed(1)}</td>
                  <td className="monitor-proc-mem">{formatBytes(proc.memory)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
