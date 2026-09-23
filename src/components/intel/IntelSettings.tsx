import { useCallback, useEffect, useState } from "react";
import { Activity, Ban, Check, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, Kbd, Select, Spinner, Switch, useToast } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../../settings/layout";
import { clearAgentAudit, listAgentAudit } from "../../lib/ipc";
import { useIntelStore } from "../../lib/intelStore";
import { describeRule } from "../../lib/intel/risk";
import type { AuditEntry, IntelSettings as Settings } from "../../types";

const THRESHOLDS = [3_000, 4_000, 6_000, 8_000, 12_000, 16_000, 32_000];
const KEEP = [2, 4, 6, 8, 12];
const TIMEOUTS = [15, 30, 60, 120, 300];

/** "just now", "5 min ago", "3 h ago", or a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3_600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3_600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function StatusBadge({ entry }: { entry: AuditEntry }) {
  if (entry.status === "ok") {
    return (
      <Badge variant="success" icon={<Check size={14} />}>
        done
      </Badge>
    );
  }
  if (entry.status === "denied") {
    return (
      <Badge variant="neutral" icon={<Ban size={14} />}>
        denied
      </Badge>
    );
  }
  return (
    <Badge variant="danger" icon={<X size={14} />}>
      failed
    </Badge>
  );
}

/** Settings → AI Intelligence: compaction, suggestions, approvals, agent activity. */
export function IntelSettings() {
  const toast = useToast();
  const settings = useIntelStore((s) => s.settings);
  const loaded = useIntelStore((s) => s.settingsLoaded);
  const loadSettings = useIntelStore((s) => s.loadSettings);
  const updateSettings = useIntelStore((s) => s.updateSettings);
  const rules = useIntelStore((s) => s.allowRules);
  const removeRule = useIntelStore((s) => s.removeAllowRule);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!loaded) {
      void loadSettings().catch((e) =>
        toast.error("Could not load AI settings", { description: e instanceof Error ? e.message : String(e) })
      );
    }
  }, [loaded, loadSettings, toast]);

  const refreshLog = useCallback(async () => {
    setLoadingLog(true);
    try {
      setEntries(await listAgentAudit(50));
    } catch (e) {
      toast.error("Could not load agent activity", { description: e instanceof Error ? e.message : String(e) });
      setEntries([]);
    } finally {
      setLoadingLog(false);
    }
  }, [toast]);

  useEffect(() => {
    void refreshLog();
  }, [refreshLog]);

  const save = async (patch: Partial<Settings>) => {
    try {
      await updateSettings(patch);
    } catch (e) {
      toast.error("Could not save the setting", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const clearLog = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    try {
      await clearAgentAudit();
      setEntries([]);
      toast.success("Agent activity cleared");
    } catch (e) {
      toast.error("Could not clear the log", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <SettingsPage
      title="AI Intelligence"
      description="Conversation memory, writing suggestions and what the agent may do on its own."
    >
      <SettingsGroup
        title="Conversation memory"
        description="Long chats are summarised so the model keeps the thread without running out of context. The full transcript stays saved."
      >
        <SettingsRow
          label="Compact automatically"
          hint="Summarise older messages once the chat grows past the threshold."
          control={
            <Switch
              aria-label="Compact automatically"
              checked={settings.auto_compact}
              onChange={(v) => void save({ auto_compact: v })}
            />
          }
        />
        <SettingsRow
          label="Threshold"
          hint="Estimated tokens (≈ 4 characters each) in the chat window before compaction."
          htmlFor="intel-threshold"
          control={
            <Select
              id="intel-threshold"
              size="sm"
              value={String(settings.compact_threshold_tokens)}
              onChange={(e) => void save({ compact_threshold_tokens: Number(e.target.value) })}
              options={[...new Set([...THRESHOLDS, settings.compact_threshold_tokens])]
                .sort((a, b) => a - b)
                .map((t) => ({ value: String(t), label: `${t.toLocaleString()} tokens` }))}
            />
          }
        />
        <SettingsRow
          label="Keep recent messages"
          hint="The newest messages always stay verbatim."
          htmlFor="intel-keep"
          control={
            <Select
              id="intel-keep"
              size="sm"
              value={String(settings.keep_recent_messages)}
              onChange={(e) => void save({ keep_recent_messages: Number(e.target.value) })}
              options={[...new Set([...KEEP, settings.keep_recent_messages])]
                .sort((a, b) => a - b)
                .map((k) => ({ value: String(k), label: `${k} messages` }))}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Writing suggestions">
        <SettingsRow
          label="Related notes while writing"
          hint={
            <>
              Shows “N related” in the editor’s status bar and the Related drawer (<Kbd shortcut="mod+shift+r" />).
            </>
          }
          control={
            <Switch
              aria-label="Related notes while writing"
              checked={settings.related_suggestions}
              onChange={(v) => void save({ related_suggestions: v })}
            />
          }
        />
        <SettingsRow
          label="Let the model rank tags"
          hint="Asks the current chat model to order the tag suggestions. It can only pick existing vault tags."
          control={
            <Switch
              aria-label="Let the model rank tags"
              checked={settings.llm_tag_suggestions}
              onChange={(v) => void save({ llm_tag_suggestions: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Agent approvals"
        description="Commands, deletions, moves and commits always ask first. Deleted notes go to .trash in your vault."
      >
        <SettingsRow
          label="Command timeout"
          hint="Shell commands run by the agent are stopped after this time."
          htmlFor="intel-timeout"
          control={
            <Select
              id="intel-timeout"
              size="sm"
              value={String(settings.command_timeout_secs)}
              onChange={(e) => void save({ command_timeout_secs: Number(e.target.value) })}
              options={[...new Set([...TIMEOUTS, settings.command_timeout_secs])]
                .sort((a, b) => a - b)
                .map((t) => ({ value: String(t), label: t < 60 ? `${t} s` : `${t / 60} min` }))}
            />
          }
        />
        <SettingsRow
          label="Always allowed"
          hint="Rules you created in the approval dialog. Rules for dangerous actions end when AETHER-OS quits."
          stacked
        >
          {rules.length === 0 ? (
            <p className="ui-field-hint">No rules — every gated action asks for approval.</p>
          ) : (
            <div className="intel-rules">
              {rules.map((rule) => (
                <div key={rule.id} className="intel-suggestion">
                  <ShieldCheck size={14} aria-hidden="true" />
                  <span className="intel-suggestion-main">
                    <span className="intel-suggestion-name">{describeRule(rule)}</span>
                    <span className="intel-suggestion-reason">
                      <Badge variant={rule.risk === "dangerous" ? "danger" : "warning"}>
                        {rule.risk === "dangerous" ? "this session" : "this device"}
                      </Badge>
                    </span>
                  </span>
                  <IconButton size="sm" label="Revoke rule" icon={<X size={14} />} onClick={() => removeRule(rule.id)} />
                </div>
              ))}
            </div>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Agent activity"
        description="Every action the agent executed or you denied, newest first. Stored locally in intel/audit.jsonl."
      >
        <div className="intel-settings-actions">
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<RefreshCw size={14} />}
            onClick={() => void refreshLog()}
            loading={loadingLog}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="danger"
            iconLeft={<Trash2 size={14} />}
            onClick={() => void clearLog()}
            onBlur={() => setConfirmClear(false)}
            disabled={!entries || entries.length === 0}
          >
            {confirmClear ? "Click again to clear" : "Clear log"}
          </Button>
        </div>
        {entries === null ? (
          <div className="intel-drawer-state intel-activity-state">
            <Spinner size={14} /> Loading activity…
          </div>
        ) : entries.length === 0 ? (
          <div className="intel-activity-state">
            <EmptyState size="sm" icon={Activity} title="No agent activity yet" description="Actions the agent takes show up here." />
          </div>
        ) : (
          <div className="intel-activity" role="list">
            {entries.map((entry) => (
              <div key={entry.id} className="intel-activity-row" role="listitem">
                <StatusBadge entry={entry} />
                <div className="intel-activity-main">
                  <span className="intel-activity-summary" title={entry.summary}>
                    {entry.summary}
                  </span>
                  {entry.detail && (
                    <span className="intel-activity-detail" title={entry.detail}>
                      {entry.detail}
                    </span>
                  )}
                </div>
                <span className="intel-activity-time" title={entry.timestamp}>
                  {relativeTime(entry.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
