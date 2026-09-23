import { Suspense, useEffect, useState } from "react";
import { VIEWS, type ViewDefinition } from "../views/registry";
import type { ViewMode } from "../views/modes";
import { Spinner, cx } from "../ui";
import { ShellErrorBoundary } from "./ErrorBoundary";

function ViewFallback({ label }: { label: string }) {
  return (
    <div className="view-loading" role="status">
      <Spinner size={16} />
      <span>Loading {label}…</span>
    </div>
  );
}

function RenderView({ def }: { def: ViewDefinition }) {
  const C = def.component;
  return (
    <ShellErrorBoundary label={def.label} resetKey={def.mode}>
      <Suspense fallback={<ViewFallback label={def.label} />}>
        <C />
      </Suspense>
    </ShellErrorBoundary>
  );
}

/**
 * Renders the active view. Views marked `keepAlive` stay mounted (hidden)
 * after their first visit so long-lived state — PTY sessions, scrollback —
 * survives view switches.
 */
export function ViewHost({ view }: { view: ViewMode }) {
  const [visited, setVisited] = useState<Set<ViewMode>>(() => new Set([view]));

  useEffect(() => {
    setVisited((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  }, [view]);

  const active = VIEWS.find((v) => v.mode === view);

  return (
    <>
      {active && !active.keepAlive && (
        <div key={active.mode} className="view-frame" data-view={active.mode}>
          <RenderView def={active} />
        </div>
      )}
      {VIEWS.filter((v) => v.keepAlive && (visited.has(v.mode) || v.mode === view)).map((v) => (
        <div
          key={v.mode}
          className={cx("view-frame", "view-keepalive", v.mode !== view && "is-hidden")}
          data-view={v.mode}
          aria-hidden={v.mode !== view || undefined}
        >
          <RenderView def={v} />
        </div>
      ))}
    </>
  );
}
