import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  CircleMinus,
  CirclePlus,
  CornerUpLeft,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { BranchInfo, CommitInfo, GitChangeKind, GitStatusEntry, RepoStatus } from "../types";
import { gitBranches, gitCommit, gitCreateBranch, gitDiscard, gitLog, gitStage, gitStatus, gitSwitchBranch, gitUnstage } from "../lib/ipc";
import { CHANGE_COLORS, changeLabel, describeSyncState, fileNameOf, formatRelativeTime, groupChanges } from "../lib/gitView";

interface IdeSourceControlProps {
  rootPath: string;
  onOpenDiff: (file: string, staged: boolean) => void;
  /** Called after any mutation so the editor can reload changed files. */
  onChanged?: () => void;
}

export function IdeSourceControl({ rootPath, onOpenDiff, onChanged }: IdeSourceControlProps) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [log, setLog] = useState<CommitInfo[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBranches, setShowBranches] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [s, b, l] = await Promise.all([
        gitStatus(rootPath),
        gitBranches(rootPath),
        gitLog(rootPath, 20),
      ]);
      setStatus(s);
      setBranches(b);
      setLog(l);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rootPath]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        await refresh();
        onChanged?.();
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh, onChanged]
  );

  const handleCommit = () => {
    const msg = message.trim();
    if (!msg) return;
    setMessage("");
    void run(() => gitCommit(rootPath, msg));
  };

  if (error && !status) {
    return (
      <div className="scm-panel">
        <div className="ide-error">
          <GitBranch size={14} /> {error}
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="scm-panel">
        <div className="scm-loading"><Loader2 size={14} className="spin" /> Loading…</div>
      </div>
    );
  }

  const { staged, unstaged } = groupChanges(status.entries);

  return (
    <div className="scm-panel">
      <div className="scm-toolbar">
        <span className="scm-branch" title="Current branch">
          <GitBranch size={12} /> {status.branch}
          {describeSyncState(status.ahead, status.behind) && (
            <span className="scm-sync">{describeSyncState(status.ahead, status.behind)}</span>
          )}
          <button
            className="btn btn-icon btn-sm"
            onClick={() => setShowBranches((v) => !v)}
            title={showBranches ? "Hide branches" : "Show branches"}
          >
            <ChevronDown size={12} style={{ transform: showBranches ? "none" : "rotate(-90deg)" }} />
          </button>
        </span>
        <button className="btn btn-icon btn-sm" onClick={() => void refresh()} title="Refresh status">
          <RefreshCw size={12} />
        </button>
      </div>

      {showBranches && (
        <div className="scm-branches">
          {branches.map((b) => (
            <div key={b.name} className={`scm-branch-row${b.is_current ? " scm-branch-current" : ""}`}>
              <button
                className="scm-branch-name"
                disabled={b.is_current || busy}
                onClick={() => void run(() => gitSwitchBranch(rootPath, b.name))}
                title={b.is_current ? "Current branch" : `Switch to ${b.name}`}
              >
                {b.name}
              </button>
              {b.is_current && <span className="scm-badge">current</span>}
            </div>
          ))}
          <form
            className="scm-new-branch"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newBranchName.trim();
              if (!name) return;
              setNewBranchName("");
              setShowBranches(false);
              void run(() => gitCreateBranch(rootPath, name));
            }}
          >
            <input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="new branch name…"
              spellCheck={false}
            />
            <button type="submit" className="btn btn-icon btn-sm" disabled={!newBranchName.trim() || busy}>
              <Plus size={12} />
            </button>
          </form>
        </div>
      )}

      {error && <div className="ide-error">{error}</div>}

      <div className="scm-section">
        <h4>Staged Changes ({staged.length})</h4>
        {staged.length === 0 && <p className="scm-empty">No staged changes.</p>}
        {staged.map((entry) => (
          <ScmRow
            key={`s:${entry.path}`}
            entry={entry}
            kind={entry.staged!}
            side="staged"
            busy={busy}
            onOpen={() => onOpenDiff(entry.path, true)}
            onAction={() => void run(() => gitUnstage(rootPath, [entry.path]))}
          />
        ))}
      </div>

      <div className="scm-section">
        <h4>Changes ({unstaged.length})</h4>
        {unstaged.length === 0 && <p className="scm-empty">Working tree clean.</p>}
        {unstaged.map((entry) => (
          <ScmRow
            key={`u:${entry.path}`}
            entry={entry}
            kind={entry.unstaged!}
            side="unstaged"
            busy={busy}
            onOpen={() => onOpenDiff(entry.path, false)}
            onStage={() => void run(() => gitStage(rootPath, [entry.path]))}
            onDiscard={() => {
              if (window.confirm(`Discard all changes in ${entry.path}? This cannot be undone.`)) {
                void run(() => gitDiscard(rootPath, [entry.path]));
              }
            }}
          />
        ))}
      </div>

      <div className="scm-commit">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleCommit();
          }}
          placeholder={staged.length === 0 ? "Stage changes first…" : "Commit message… (Cmd+Enter)"}
          rows={3}
          spellCheck={false}
        />
        <button
          className="btn btn-primary"
          disabled={staged.length === 0 || !message.trim() || busy}
          onClick={handleCommit}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <GitCommitHorizontal size={13} />}
          Commit ({staged.length})
        </button>
      </div>

      <div className="scm-section">
        <h4>Recent Commits</h4>
        {log.map((c) => (
          <div key={c.id} className="scm-commit-row" title={`${c.id} — ${c.author}`}>
            <CornerUpLeft size={11} className="scm-commit-icon" />
            <span className="scm-commit-summary">{c.summary}</span>
            <span className="scm-commit-meta">
              {formatRelativeTime(c.time, Math.floor(Date.now() / 1000))} · {c.id}
            </span>
          </div>
        ))}
        {log.length === 0 && <p className="scm-empty">No commits yet.</p>}
      </div>
    </div>
  );
}

interface ScmRowProps {
  entry: GitStatusEntry;
  kind: GitChangeKind;
  side: "staged" | "unstaged";
  busy: boolean;
  onOpen: () => void;
  /** Unstage for staged rows; unused for unstaged rows. */
  onAction?: () => void;
  onStage?: () => void;
  onDiscard?: () => void;
}

function ScmRow({ entry, kind, side, busy, onOpen, onAction, onStage, onDiscard }: ScmRowProps) {
  return (
    <div className="scm-row">
      <button
        className="scm-row-open"
        onClick={onOpen}
        title={`${side === "staged" ? "Staged" : "Unstaged"} ${kind}: open diff`}
      >
        <span className="scm-file-name">{fileNameOf(entry.path)}</span>
        <span className="scm-file-dir">{fileNameOf(entry.path) !== entry.path ? entry.path.slice(0, -fileNameOf(entry.path).length - 1) : ""}</span>
      </button>
      <span
        className="scm-kind"
        style={{ color: CHANGE_COLORS[kind] }}
        title={kind}
      >
        {changeLabel(kind)}
      </span>
      <span className="scm-actions">
        {side === "unstaged" && onStage && (
          <button className="btn btn-icon btn-sm" onClick={onStage} disabled={busy} title="Stage (+)">
            <CirclePlus size={13} />
          </button>
        )}
        {side === "staged" && onAction && (
          <button className="btn btn-icon btn-sm" onClick={onAction} disabled={busy} title="Unstage (−)">
            <CircleMinus size={13} />
          </button>
        )}
        {side === "unstaged" && onDiscard && (
          <button className="btn btn-icon btn-sm" onClick={onDiscard} disabled={busy} title="Discard changes">
            <CornerUpLeft size={13} />
          </button>
        )}
      </span>
    </div>
  );
}
