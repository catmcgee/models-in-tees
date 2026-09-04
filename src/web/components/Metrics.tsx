import { formatMetric, labelize, pctMilli } from "../format.js";
import type { ExperimentKind } from "../types.js";

type Metrics = Record<string, unknown>;

export function MetricsView({
  kind,
  metrics,
  descriptive
}: {
  kind: ExperimentKind;
  metrics: Metrics;
  descriptive: Record<string, unknown>;
}) {
  switch (kind) {
    case "linear-probe":
      return <ProbeMetrics metrics={metrics} />;
    case "activation-patching":
      return <PatchMetrics metrics={metrics} />;
    case "sae-features":
      return <FeatureMetrics metrics={metrics} descriptive={descriptive} />;
    default:
      return <EvalMetrics metrics={metrics} kind={kind} />;
  }
}

const EXPLAIN: Partial<Record<ExperimentKind, string>> = {
  "expected-token":
    "Top-1 accuracy is how often the expected token was the model's first prediction; top-5 means it was within the first five. Median rank says how far down the right answer usually sits. Every value is an integer function of the committed per-item leaves.",
  memorization:
    "Verbatim rate is the fraction of passages the model completed token-for-token under greedy decoding, which is evidence those passages were in its training data.",
  "paired-bias":
    "The signed gap is mean P(target | prompt A) minus P(target | prompt B), in basis points. A positive gap with target ' he' means prompt A's subjects pull the model toward a male pronoun more than prompt B's."
};

function scalarEntries(metrics: Metrics): Array<[string, unknown]> {
  return Object.entries(metrics).filter(
    ([key, value]) => key !== "kind" && (typeof value === "number" || typeof value === "string")
  );
}

export function EvalMetrics({ metrics, kind }: { metrics: Metrics; kind: ExperimentKind }) {
  return (
    <div>
      <div className="metric-tiles">
        {scalarEntries(metrics).map(([key, value]) => (
          <Tile key={key} k={labelize(key)} v={formatMetric(key, value)} />
        ))}
      </div>
      <p className="metric-note">{EXPLAIN[kind]}</p>
    </div>
  );
}

export function ProbeMetrics({ metrics }: { metrics: Metrics }) {
  const layers = (metrics.layers as Array<{ layer: number; label: string; testAccuracyMilli: number }>) || [];
  const baseline = Number(metrics.majorityClassBaselineMilli ?? 500);
  const counts = (metrics.counts as { train: number; test: number }) || { train: 0, test: 0 };
  return (
    <div>
      <div className="metric-tiles">
        <Tile k="Best layer" v={String(metrics.bestLayer)} />
        <Tile k="Best held-out accuracy" v={pctMilli(Number(metrics.bestTestAccuracyMilli))} />
        <Tile k="Baseline to beat" v={pctMilli(baseline)} />
        <Tile k="Train / test" v={`${counts.train} / ${counts.test}`} />
      </div>
      <div className="patch-bars">
        {layers.map((layer) => (
          <div className="patch-row" key={layer.layer}>
            <span>{layer.label === "embedding" ? "emb" : layer.label === "final-norm" ? "norm" : `L${layer.layer - 1}`}</span>
            <div className="patch-track">
              <div className="patch-fill" style={{ width: `${Math.round(layer.testAccuracyMilli / 10)}%` }} />
              <div className="baseline-mark" style={{ left: `${Math.round(baseline / 10)}%` }} />
            </div>
            <strong>{pctMilli(layer.testAccuracyMilli)}</strong>
          </div>
        ))}
      </div>
      <p className="metric-note">
        Each bar is held-out probe accuracy on one hidden state; the tick is the majority-class baseline. The probe's
        weight vector never leaves the runner. Only each example's predicted label per layer is committed, so the
        accuracies are recomputable from the leaves.
      </p>
    </div>
  );
}

export function PatchMetrics({ metrics }: { metrics: Metrics }) {
  const layers =
    (metrics.layers as Array<{ layer: number; meanClippedRecoveryMilli: number; stdClippedRecoveryMilli: number }>) || [];
  return (
    <div>
      <div className="metric-tiles">
        <Tile k="Best layer" v={`L${metrics.bestLayer}`} />
        <Tile k="Best mean recovery" v={pctMilli(Number(metrics.bestMeanClippedRecoveryMilli))} />
        <Tile k="Pairs scored" v={`${metrics.scored} (unscorable ${metrics.unscorable})`} />
        <Tile
          k="Mean clean / corrupted log-prob"
          v={`${formatMetric("meanCleanLogProbMilli", metrics.meanCleanLogProbMilli)} / ${formatMetric("meanCorruptedLogProbMilli", metrics.meanCorruptedLogProbMilli)}`}
        />
      </div>
      <div className="patch-bars">
        {layers.map((layer) => (
          <div className="patch-row" key={layer.layer}>
            <span>L{layer.layer}</span>
            <div className="patch-track">
              <div className="patch-fill" style={{ width: `${Math.round(layer.meanClippedRecoveryMilli / 10)}%` }} />
            </div>
            <strong>{pctMilli(layer.meanClippedRecoveryMilli)}</strong>
            <em>± {pctMilli(layer.stdClippedRecoveryMilli)}</em>
          </div>
        ))}
      </div>
      <p className="metric-note">
        Mean recovery of the correct answer's log-probability when the clean prompt's residual stream is patched into
        the corrupted prompt at that layer, averaged across pairs. A sharp rise over a few consecutive layers with a
        small spread is the robust finding: that layer band causally carries the country-to-capital information.
      </p>
    </div>
  );
}

export function FeatureMetrics({ metrics, descriptive }: { metrics: Metrics; descriptive: Record<string, unknown> }) {
  const features =
    (metrics.features as Array<{
      feature: number;
      firedTokenCount: number;
      firingRateMilli: number;
      maxActivationCenti: number;
      promptCount: number;
    }>) || [];
  const labels = (descriptive.saeFeatureLabels as Record<string, { label: string; topTokens: string[] }>) || {};
  return (
    <div>
      <div className="metric-tiles">
        <Tile k="Tokens scanned" v={String(metrics.tokenCount)} />
        <Tile k="Active features / token" v={formatMetric("meanActiveFeaturesPerTokenMilli", metrics.meanActiveFeaturesPerTokenMilli)} />
        <Tile k="Prompts" v={String(metrics.promptCount)} />
        <Tile k="Features reported" v={String(features.length)} />
      </div>
      <div className="patch-bars">
        {features.map((feature) => (
          <div className="patch-row feature-row" key={feature.feature}>
            <span>#{feature.feature}</span>
            <div className="patch-track">
              <div className="patch-fill" style={{ width: `${Math.round(feature.firingRateMilli / 10)}%` }} />
            </div>
            <strong>{pctMilli(feature.firingRateMilli)}</strong>
            <em className="feature-label">
              {labels[String(feature.feature)]?.label ?? "no label"} · {feature.promptCount} prompt{feature.promptCount === 1 ? "" : "s"}
            </em>
          </div>
        ))}
      </div>
      <p className="metric-note">
        Firing rate is the fraction of scanned tokens on which a Gemma Scope 2 dictionary feature activated. Labels are
        the top activating tokens observed in this run; they are descriptive context and are not part of the signed
        material.
      </p>
    </div>
  );
}

export function PolicyChips({ policy }: { policy: Record<string, unknown> }) {
  const entries: Array<[string, string]> = [
    ["Strategy", String(policy.strategy)],
    ["Disclosed items", `${policy.disclosedItemPercent}% (min ${policy.minDisclosedItems}, max ${policy.maxDisclosedItems})`],
    ["Merkle scheme", String(policy.merkleScheme)],
    ["Per-item results", policy.perItemResultsSealed ? "sealed, committed" : "returned"],
    ["Probe weights", policy.probeWeightsReturned ? "returned" : "sealed"],
    ["Raw activations", policy.rawActivationsReturned ? "returned" : "sealed"]
  ];
  return (
    <div className="policy-block">
      <div className="ev-col-title">Leakage policy enforced inside the runner</div>
      <div className="policy-tags">
        {entries.map(([key, value]) => (
          <span key={key}>
            {key}: {value}
          </span>
        ))}
      </div>
      <p className="metric-note">
        Numbers are fixed-point integers at declared scales, top-k is capped, and only a seeded sample of per-item
        results is opened. The policy's hash is inside the signed receipt, so an auditor can prove which caps governed
        this run.
      </p>
    </div>
  );
}

export function Tile({ k, v }: { k: string; v: string }) {
  return (
    <div className="metric-tile">
      <div className="metric-k">{k}</div>
      <div className="metric-v">{v}</div>
    </div>
  );
}
