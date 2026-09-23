import { Laptop, Monitor, MonitorSmartphone } from "lucide-react";
import type { SyncDeviceInfo } from "../../types";
import { useSyncStore } from "../../lib/syncStore";
import { absoluteTime, relativeTime } from "../../lib/sync/format";
import { Badge, EmptyState, ListRow, Tooltip } from "../../ui";

const PLATFORM_LABEL: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

function DeviceIcon({ device }: { device: SyncDeviceInfo }) {
  if (device.platform === "macos" && /book|laptop/i.test(device.device_name)) return <Laptop size={14} />;
  return <Monitor size={14} />;
}

/** Devices syncing through the folder. */
export function DevicesCard() {
  const status = useSyncStore((s) => s.status);
  const devices = useSyncStore((s) => s.devices);

  return (
    <section className="sync-card" aria-labelledby="sync-devices-title">
      <header className="sync-card-header">
        <div>
          <h2 className="sync-card-title" id="sync-devices-title">
            Devices
          </h2>
          <p className="sync-card-subtitle">Everything that shares this sync folder.</p>
        </div>
      </header>
      {!status?.configured ? (
        <EmptyState size="sm" icon={MonitorSmartphone} title="No sync folder" description="Set up sync to connect devices." />
      ) : !status.unlocked ? (
        <EmptyState size="sm" icon={MonitorSmartphone} title="Locked" description="Unlock to see the other devices." />
      ) : devices.length <= 1 ? (
        <>
          {devices.map((d) => (
            <DeviceRow key={d.device_id} device={d} />
          ))}
          <p className="ui-field-hint sync-devices-hint">
            Install AETHER-OS on another device, choose the same folder and enter the same passphrase.
          </p>
        </>
      ) : (
        <div role="list" aria-label="Devices">
          {devices.map((d) => (
            <DeviceRow key={d.device_id} device={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function DeviceRow({ device }: { device: SyncDeviceInfo }) {
  return (
    <ListRow
      role="listitem"
      icon={<DeviceIcon device={device} />}
      title={device.device_name}
      description={
        <Tooltip content={absoluteTime(device.last_seen)} placement="top">
          <span tabIndex={0}>
            {PLATFORM_LABEL[device.platform] ?? device.platform} · seen {relativeTime(device.last_seen)} ·{" "}
            {device.file_count.toLocaleString("en-US")} files
          </span>
        </Tooltip>
      }
      meta={
        device.is_current ? (
          <Badge size="sm" variant="accent">
            This device
          </Badge>
        ) : undefined
      }
    />
  );
}
