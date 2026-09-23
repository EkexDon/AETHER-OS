import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, EmptyState } from "../ui";
import { reportFrontendError } from "../lib/diagnostics";

interface Props {
  /** Resets the boundary when this value changes (e.g. the view mode). */
  resetKey?: string;
  /** Rendered instead of the default fallback; `null` renders nothing. */
  fallback?: ReactNode | null;
  /** Label used in the default fallback ("Notes could not be displayed"). */
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Contains render errors to one view or status item so the rest of the
 * shell keeps working.
 */
export class ShellErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[shell] ${this.props.label ?? "component"} crashed:`, error, info.componentStack);
    reportFrontendError({
      error,
      componentStack: info.componentStack ?? null,
      view: this.props.label ?? null,
      source: "boundary",
      // A crashed view is fatal for that view; a crashed status item is not.
      fatal: this.props.fallback === undefined,
    });
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="view view-error">
        <EmptyState
          icon={TriangleAlert}
          title={`${this.props.label ?? "This view"} could not be displayed`}
          description={this.state.error.message || "An unexpected error occurred."}
          action={
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
}
