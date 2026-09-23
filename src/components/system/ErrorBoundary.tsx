import { Component, Fragment, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { buildErrorReport, reportFrontendError } from "../../lib/diagnostics";
import { isDesktopRuntime, openAppDataDir } from "../../lib/ipc";
import "./ErrorBoundary.css";

/** Props of {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  /** View or area name shown in the panel and recorded in the report. */
  name?: string;
  /** Full-window layout for the app root. */
  root?: boolean;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  /** Bumped by "Reload view" to remount the children from scratch. */
  generation: number;
  status: string | null;
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Clipboard is not available");
}

/**
 * Catches render errors below it, reports them to the local crash log
 * (`cmd_log_frontend_error`, fatal) and shows a recovery panel with
 * "Copy report", "Reload view" and "Open data folder".
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, generation: 0, status: null };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)), status: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null;
    this.setState({ componentStack });
    reportFrontendError({
      error,
      componentStack,
      view: this.props.name ?? null,
      source: "boundary",
      fatal: true,
    });
  }

  private reload = () => {
    this.setState((s) => ({ error: null, componentStack: null, status: null, generation: s.generation + 1 }));
  };

  private copyReport = async () => {
    const { error, componentStack } = this.state;
    if (!error) return;
    const report = buildErrorReport({
      error,
      componentStack,
      view: this.props.name ?? null,
      source: "boundary",
      fatal: true,
    });
    try {
      await copyText(report);
      this.setState({ status: "Report copied to the clipboard." });
    } catch (e) {
      this.setState({ status: `Could not copy the report: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  private openDataFolder = async () => {
    try {
      await openAppDataDir();
      this.setState({ status: "Opened the data folder (logs/ and crash-reports/)." });
    } catch (e) {
      this.setState({ status: `Could not open the data folder: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  render(): ReactNode {
    const { error, componentStack, generation, status } = this.state;
    if (!error) return <Fragment key={generation}>{this.props.children}</Fragment>;

    const name = this.props.name;
    const details = [error.stack, componentStack && `Component stack:${componentStack}`]
      .filter(Boolean)
      .join("\n\n");
    return (
      <div className={`aether-crash${this.props.root ? " aether-crash--root" : ""}`} role="alert">
        <section className="aether-crash__panel" aria-labelledby="aether-crash-title">
          <p className="aether-crash__eyebrow">Crash report saved locally</p>
          <h2 className="aether-crash__title" id="aether-crash-title">
            {name ? `${name} ran into a problem` : "Something went wrong"}
          </h2>
          <p className="aether-crash__message">{error.message || "An unexpected error occurred."}</p>
          {details && (
            <details className="aether-crash__details">
              <summary>Technical details</summary>
              <pre className="aether-crash__stack">{details}</pre>
            </details>
          )}
          <div className="aether-crash__actions">
            <button type="button" className="aether-crash__button aether-crash__button--primary" onClick={this.reload}>
              Reload view
            </button>
            <button type="button" className="aether-crash__button" onClick={() => void this.copyReport()}>
              Copy report
            </button>
            <button
              type="button"
              className="aether-crash__button"
              onClick={() => void this.openDataFolder()}
              disabled={!isDesktopRuntime()}
              title={isDesktopRuntime() ? undefined : "Available in the desktop app"}
            >
              Open data folder
            </button>
          </div>
          {status && (
            <p className="aether-crash__status" role="status">
              {status}
            </p>
          )}
        </section>
      </div>
    );
  }
}

/**
 * Wrap a view component in an {@link ErrorBoundary} named `name`, so a
 * crash takes down only that view.
 */
export function withViewBoundary<P extends object>(Wrapped: ComponentType<P>, name: string): ComponentType<P> {
  function WithViewBoundary(props: P) {
    return (
      <ErrorBoundary name={name}>
        <Wrapped {...props} />
      </ErrorBoundary>
    );
  }
  WithViewBoundary.displayName = `withViewBoundary(${Wrapped.displayName || Wrapped.name || name})`;
  return WithViewBoundary;
}
