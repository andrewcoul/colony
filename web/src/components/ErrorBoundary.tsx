import { Component, type ReactNode } from "react";

/** Last-resort screen for render errors and failed Convex subscriptions. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="m-0 text-xl font-semibold">Something went wrong</h1>
        <p className="m-0 max-w-sm text-label leading-relaxed text-muted">Colony hit an unexpected error. Your conversations are saved; reloading usually fixes it.</p>
        <button type="button" onClick={() => location.reload()} className="h-10 rounded-full bg-ink px-4 text-sm font-medium text-on-ink">Reload</button>
      </main>
    );
  }
}
