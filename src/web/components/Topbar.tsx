import { Loader2, RefreshCcw } from "lucide-react";
import type { HealthStatus } from "../types.js";

export function SealedCube() {
  return (
    <svg viewBox="0 0 100 100" stroke="currentColor" strokeWidth={6} strokeLinejoin="round">
      <polygon points="50 16 82 35 50 54 18 35" fill="currentColor" fillOpacity={1} />
      <polygon points="18 35 50 54 50 88 18 69" fill="currentColor" fillOpacity={0.45} />
      <polygon points="82 35 50 54 50 88 82 69" fill="currentColor" fillOpacity={0.72} />
    </svg>
  );
}

export function Topbar({
  health,
  subtitle,
  busy,
  onRefresh
}: {
  health: HealthStatus | null;
  subtitle: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  const state = health?.runner.state ?? "unknown";
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <SealedCube />
        </div>
        <div>
          <div className="brand-title">Experiments on an unpublished model</div>
          <div className="brand-sub">{subtitle}</div>
        </div>
      </div>
      <div className="topbar-actions">
        <span className="runner-pill" data-state={state}>
          <span className="tab-dot" />
          runner {state}
          {health?.busy ? ` · running ${health.busy.experimentId}` : ""}
        </span>
        <button className="btn-ghost" type="button" onClick={onRefresh} disabled={busy}>
          {busy ? <Loader2 className="spin" /> : <RefreshCcw />}
          <span>Refresh</span>
        </button>
      </div>
    </header>
  );
}
