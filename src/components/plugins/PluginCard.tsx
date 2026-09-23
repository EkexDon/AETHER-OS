import { useState } from "react";
import {
  Blocks,
  Check,
  FolderOpen,
  Minus,
  PanelRight,
  Play,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { PluginInfo } from "../../types";
import { openPluginsFolder } from "../../lib/ipc";
import { usePluginsStore, type PluginRuntimeState } from "../../lib/pluginsStore";
import { getPluginHost } from "../../lib/plugins/host";
import { describePermission } from "../../lib/plugins/permissions";
import { Badge, Button, Card, IconButton, Kbd, Modal, Switch, Tooltip, cx, useToast } from "../../ui";
import { PluginSettingsForm } from "./PluginSettingsForm";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Relative time for log lines ("just now", "4 min ago"). */
export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function StatusBadge({ plugin, runtime }: { plugin: PluginInfo; runtime: PluginRuntimeState | undefined }) {
  if (plugin.error) return <Badge variant="danger">Broken</Badge>;
  if (!plugin.enabled) return <Badge variant="neutral">Disabled</Badge>;
  switch (runtime?.status) {
    case "running":
      return (
        <Badge variant="success" dot>
          Running
        </Badge>
      );
    case "starting":
      return <Badge variant="info">Starting…</Badge>;
    case "error":
      return <Badge variant="danger">Failed</Badge>;
    default:
      return <Badge variant="neutral">Stopped</Badge>;
  }
}

/** One installed plugin: status, permissions, commands, settings and actions. */
export function PluginCard({ plugin }: { plugin: PluginInfo }) {
  const id = plugin.manifest.id;
  const { manifest } = plugin;
  const runtime = usePluginsStore((s) => s.runtime[id]);
  const commands = usePluginsStore((s) => s.commands[id]);
  const logs = usePluginsStore((s) => s.logs[id]);
  const hasPanel = usePluginsStore((s) => !!s.panels[id]);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const openReview = usePluginsStore((s) => s.openReview);
  const setActivePanel = usePluginsStore((s) => s.setActivePanel);
  const uninstall = usePluginsStore((s) => s.uninstall);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const granted = new Set(plugin.granted_permissions);
  const pending = manifest.permissions.filter((p) => !granted.has(p)).length;
  const lastProblem = [...(logs ?? [])].reverse().find((l) => l.level !== "info");

  const toggle = async (next: boolean) => {
    if (next && manifest.permissions.length > 0 && plugin.granted_permissions.length === 0) {
      openReview(id, "enable");
      return;
    }
    setBusy(true);
    try {
      await setEnabled(id, next);
    } catch (error) {
      toast.error(next ? `${manifest.name} could not be enabled` : `${manifest.name} could not be disabled`, {
        description: message(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const runCommand = async (commandId: string, title: string) => {
    try {
      await getPluginHost().runCommand(id, commandId);
    } catch (error) {
      toast.error(`${title} failed`, { description: message(error) });
    }
  };

  const doUninstall = async () => {
    setBusy(true);
    try {
      await uninstall(id);
      toast.success(`${manifest.name} was uninstalled`);
    } catch (error) {
      toast.error("Uninstall failed", { description: message(error) });
      setBusy(false);
    }
  };

  const openFolder = () => {
    openPluginsFolder(id).catch((error) => toast.error("Could not open the folder", { description: message(error) }));
  };

  return (
    <Card padding="none" className={cx("plugin-card", plugin.enabled && !plugin.error && "is-enabled")}>
      <div className="plugin-card-head">
        <span className="plugin-card-icon" aria-hidden="true">
          <Blocks size={16} />
        </span>
        <div className="plugin-card-title">
          <h3 className="plugin-card-name">{manifest.name}</h3>
          <span className="plugin-card-meta">
            <span className="tabular">v{manifest.version}</span>
            {manifest.author && <span> · {manifest.author}</span>}
            {plugin.bundled && <span> · Bundled example</span>}
          </span>
        </div>
        <StatusBadge plugin={plugin} runtime={runtime} />
        <Switch
          checked={plugin.enabled}
          onChange={(next) => void toggle(next)}
          disabled={busy || (!!plugin.error && !plugin.enabled)}
          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${manifest.name}`}
        />
      </div>

      {manifest.description && <p className="plugin-card-description">{manifest.description}</p>}

      {plugin.error && (
        <div className="ui-notice ui-notice-danger plugin-card-notice" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>This plugin cannot be loaded: {plugin.error}</span>
        </div>
      )}
      {!plugin.error && runtime?.status === "error" && runtime.error && (
        <div className="ui-notice ui-notice-danger plugin-card-notice" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{runtime.error}</span>
          <Button size="sm" variant="ghost" iconLeft={<RotateCw size={14} />} onClick={() => void getPluginHost().restart(id)}>
            Retry
          </Button>
        </div>
      )}

      {manifest.permissions.length > 0 && (
        <ul className="plugin-permission-chips" aria-label="Permissions">
          {manifest.permissions.map((permission) => {
            const described = describePermission(permission);
            const isGranted = granted.has(permission);
            return (
              <li key={permission}>
                <Tooltip content={`${described.description}${isGranted ? "" : " — not granted"}`} placement="top">
                  <span
                    tabIndex={0}
                    className={cx("plugin-permission-chip", isGranted ? "is-granted" : "is-pending", `is-risk-${described.risk}`)}
                  >
                    {isGranted ? <Check size={14} aria-hidden="true" /> : <Minus size={14} aria-hidden="true" />}
                    {described.label}
                    <span className="sr-only">{isGranted ? " (granted)" : " (not granted)"}</span>
                  </span>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}

      {commands && commands.length > 0 && (
        <div className="plugin-card-commands">
          <span className="ui-section-label">Commands</span>
          <ul>
            {commands.map((command) => (
              <li key={command.id} className="plugin-command-row">
                <span className="plugin-command-title">{command.title}</span>
                {command.shortcut && <Kbd shortcut={command.shortcut} />}
                <IconButton
                  size="sm"
                  label={`Run “${command.title}”`}
                  icon={<Play size={14} />}
                  onClick={() => void runCommand(command.id, command.title)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {lastProblem && (
        <p className={cx("plugin-card-log", lastProblem.level === "error" && "is-error")}>
          {lastProblem.level === "error" ? "Last error" : "Warning"} · {timeAgo(lastProblem.at)}: {lastProblem.message}
        </p>
      )}

      <div className="plugin-card-actions">
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<ShieldCheck size={14} />}
          onClick={() => openReview(id)}
          disabled={!!plugin.error}
        >
          Permissions{pending > 0 && plugin.enabled ? ` · ${pending} off` : ""}
        </Button>
        {manifest.settings.length > 0 && !plugin.error && (
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<SlidersHorizontal size={14} />}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            Settings
          </Button>
        )}
        {hasPanel && (
          <Button size="sm" variant="ghost" iconLeft={<PanelRight size={14} />} onClick={() => setActivePanel(id)}>
            Show panel
          </Button>
        )}
        <span className="plugin-card-actions-spacer" />
        <IconButton size="sm" label="Open plugin folder" icon={<FolderOpen size={14} />} onClick={openFolder} />
        <IconButton
          size="sm"
          variant="danger"
          label={`Uninstall ${manifest.name}`}
          icon={<Trash2 size={14} />}
          onClick={() => setConfirmUninstall(true)}
          disabled={busy}
        />
      </div>

      {settingsOpen && (
        <div className="plugin-card-settings">
          <PluginSettingsForm plugin={plugin} />
        </div>
      )}

      <Modal
        open={confirmUninstall}
        onClose={() => setConfirmUninstall(false)}
        size="sm"
        icon={Trash2}
        title={`Uninstall ${manifest.name}?`}
        description="The plugin, its settings and everything it stored are deleted. Your notes are not touched."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmUninstall(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                setConfirmUninstall(false);
                void doUninstall();
              }}
            >
              Uninstall
            </Button>
          </>
        }
      />
    </Card>
  );
}
