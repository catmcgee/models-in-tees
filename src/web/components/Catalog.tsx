import { kindLabel, shortHash } from "../format.js";
import type { ExperimentSummary, PublicExperimentRecord } from "../types.js";

export function Catalog({
  experiments,
  registryHash,
  selectedId,
  lastRuns,
  onSelect
}: {
  experiments: ExperimentSummary[];
  registryHash: string | null;
  selectedId: string | null;
  lastRuns: Record<string, PublicExperimentRecord | undefined>;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel catalog">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Committed registry</span>
          <div className="panel-title">Experiments</div>
        </div>
        <span className="pill-count" title="sha256 over every experiment file in src/experiments/">
          registry {shortHash(registryHash, 6)}
        </span>
      </div>
      <div className="catalog-grid">
        {experiments.map((experiment) => {
          const last = lastRuns[experiment.id];
          return (
            <button
              key={experiment.id}
              type="button"
              className="exp-card"
              data-active={selectedId === experiment.id}
              onClick={() => onSelect(experiment.id)}
            >
              <div className="exp-card-head">
                <span className="kind-badge" data-kind={experiment.kind}>
                  {kindLabel(experiment.kind)}
                </span>
                <span className="exp-count">{experiment.itemCount} items</span>
              </div>
              <div className="exp-title">{experiment.title}</div>
              <div className="exp-desc">{experiment.description}</div>
              <div className="exp-meta">
                <span>dataset {shortHash(experiment.datasetHash, 6)}</span>
                <span>{last ? `last run ${new Date(last.createdAt).toLocaleDateString()}` : "not run yet"}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
