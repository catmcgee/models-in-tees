import { Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDate, formatMs, kindLabel, shortHash } from "../format.js";
import type { ExperimentDetail, PublicExperimentRecord } from "../types.js";

export function ExperimentPanel({
  experiment,
  runs,
  activeRecord,
  running,
  busyElsewhere,
  onRun,
  onSelectRun
}: {
  experiment: ExperimentDetail | null;
  runs: PublicExperimentRecord[];
  activeRecord: PublicExperimentRecord | null;
  running: boolean;
  busyElsewhere: string | null;
  onRun: () => void;
  onSelectRun: (record: PublicExperimentRecord) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(timer);
  }, [running]);

  if (!experiment) {
    return (
      <section className="panel experiment">
        <div className="empty">
          <div className="empty-t">Loading the committed registry from the runner…</div>
        </div>
      </section>
    );
  }

  const params = Object.entries(experiment.params).filter(([, value]) => typeof value !== "object");
  return (
    <section className="panel experiment">
      <div className="panel-head">
        <div>
          <span className="eyebrow">{kindLabel(experiment.kind)}</span>
          <div className="panel-title">{experiment.title}</div>
        </div>
        <button className="btn btn-dark" type="button" onClick={onRun} disabled={running || !!busyElsewhere}>
          {running ? <Loader2 className="spin" /> : <Play />}
          <span>{running ? `Running… ${formatMs(elapsed)}` : busyElsewhere ? `Busy: ${busyElsewhere}` : "Run inside the TEE"}</span>
        </button>
      </div>
      <p className="lede exp-lede">{experiment.description}</p>
      <div className="kv exp-kv">
        <div className="kv-row">
          <div className="kv-k">Dataset hash ({experiment.itemCount} committed items)</div>
          <div className="kv-v">{experiment.datasetHash}</div>
        </div>
        <div className="kv-row">
          <div className="kv-k">Experiment hash · registry hash</div>
          <div className="kv-v">
            {shortHash(experiment.experimentHash, 12)} · {shortHash(experiment.registryHash, 12)}
          </div>
        </div>
        <div className="kv-row">
          <div className="kv-k">Fixed parameters</div>
          <div className="policy-tags">
            {params.map(([key, value]) => (
              <span key={key}>
                {key}: {String(value)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <details className="items-list">
        <summary>Show the {experiment.itemCount} committed items</summary>
        <ol>
          {experiment.items.map((item, index) => (
            <li key={index}>
              <code>{JSON.stringify(item)}</code>
            </li>
          ))}
        </ol>
      </details>
      {runs.length > 0 && (
        <div className="runs">
          <div className="ev-col-title">Recent runs</div>
          <div className="runs-list">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className="run-chip"
                data-active={activeRecord?.id === run.id}
                onClick={() => onSelectRun(run)}
              >
                <span>{formatDate(run.createdAt)}</span>
                <span className="kv-v">root {shortHash(run.receipt.payload.results.resultsRoot, 6)}</span>
                <span className="run-chain">{run.solanaCommitment?.status === "confirmed" ? "on-chain" : "off-chain"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
