import { useEffect, useRef, useState, useCallback } from "react";
import { Cpu, MemoryStick, HardDrive, Wifi, Battery, Activity, Clock, Pause, Play, ArrowDown, ArrowUp } from "lucide-react";
import { Badge, Button, EmptyState, Spinner, ViewHeader } from "../ui";
import { useTokens } from "../lib/tokens";

const SPARK_TOKENS = ["--color-accent", "--color-info"] as const;
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
    return <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="monitor-sparkline" />;
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
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="monitor-sparkline">
      <polygon points={areaPoints} fill={color} opacity={0.12} />
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
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
        <div
          className={`monitor-progress-fill${pct > 90 ? " is-critical" : pct > 75 ? " is-high" : ""}`}
          style={{ width: `${pct}%` }}
        />
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

  const tokens = useTokens(SPARK_TOKENS);

  if (error && !metrics) {
    return (
      <div className="view monitor-container">
        <ViewHeader title="System Monitor" subtitle="Live CPU, memory, disk and network usage" />
        <div className="view-body">
          <EmptyState icon={Activity} title="Monitor unavailable" description={error} className="monitor-error" />
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="view monitor-container">
        <ViewHeader title="System Monitor" subtitle="Live CPU, memory, disk and network usage" />
        <div className="view-body">
          <div className="monitor-loading view-loading">
            <Spinner size={16} />
            <span>Collecting system metrics…</span>
          </div>
        </div>
      </div>
    );
  }

  const memPct = metrics.memory.total > 0 ? (metrics.memory.used / metrics.memory.total) * 100 : 0;

  return (
    <div className="view monitor-container">
      <ViewHeader
        title="System Monitor"
        subtitle="Live CPU, memory, disk and network usage"
        actions={
          <>
            <Badge size="md" icon={<Clock size={12} />} className="monitor-uptime" title="Uptime">
              {formatUptime(metrics.uptime)}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              className="monitor-toggle"
              iconLeft={running ? <Pause size={13} /> : <Play size={13} />}
              onClick={() => setRunning((r) => !r)}
            >
              {running ? "Pause" : "Resume"}
            </Button>
          </>
        }
      />
      <div className="view-body">
        {error && <div className="monitor-error-banner">{error}</div>}

        <div className="monitor-grid">
          <MetricCard
            icon={<Cpu size={15} />}
            label="CPU"
            value={`${metrics.overall_cpu.toFixed(1)}%`}
            subValue={`${metrics.cpus.length} cores`}
            sparklineData={cpuHistoryRef.current}
            sparklineMax={100}
            sparklineColor={tokens["--color-accent"]}
          />
          <MetricCard
            icon={<MemoryStick size={15} />}
            label="Memory"
            value={formatBytes(metrics.memory.used)}
            subValue={`of ${formatBytes(metrics.memory.total)} (${memPct.toFixed(1)}%)`}
            sparklineData={memHistoryRef.current}
            sparklineMax={metrics.memory.total}
            sparklineColor={tokens["--color-info"]}
          />
          {metrics.battery && (
            <MetricCard
              icon={<Battery size={15} />}
              label="Battery"
              value={`${metrics.battery.percent.toFixed(0)}%`}
              subValue={metrics.battery.charging ? "Charging" : "On battery"}
            />
          )}
        </div>

        <section className="monitor-section">
          <h3 className="monitor-section-title">
            <HardDrive size={14} />
            Disks
          </h3>
          <div className="monitor-panel monitor-disks">
            {metrics.disks.map((disk, i) => (
              <ProgressBar
                key={i}
                value={disk.used}
                max={disk.total}
                label={`${disk.name} (${disk.mount_point}) — ${formatBytes(disk.used)} / ${formatBytes(disk.total)}`}
              />
            ))}
          </div>
        </section>

        <section className="monitor-section">
          <h3 className="monitor-section-title">
            <Wifi size={14} />
            Network
          </h3>
          <div className="monitor-network-grid">
            {metrics.network.length === 0 && <span className="monitor-empty">No active network interfaces</span>}
            {metrics.network.map((net, i) => (
              <div key={i} className="monitor-network-item">
                <span className="monitor-network-name">{net.interface}</span>
                <span className="monitor-network-rate">
                  <ArrowDown size={11} /> {formatRate(net.rx_rate)}
                </span>
                <span className="monitor-network-rate">
                  <ArrowUp size={11} /> {formatRate(net.tx_rate)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="monitor-section">
          <h3 className="monitor-section-title">
            <Activity size={14} />
            Top processes
          </h3>
          <div className="monitor-processes">
            <table className="monitor-process-table">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Name</th>
                  <th className="is-num">CPU %</th>
                  <th className="is-num">Memory</th>
                </tr>
              </thead>
              <tbody>
                {metrics.processes.map((proc) => (
                  <tr key={proc.pid}>
                    <td className="monitor-pid">{proc.pid}</td>
                    <td className="monitor-proc-name">{proc.name}</td>
                    <td className="monitor-proc-cpu is-num">{proc.cpu_usage.toFixed(1)}</td>
                    <td className="monitor-proc-mem is-num">{formatBytes(proc.memory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
