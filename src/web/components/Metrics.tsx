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
    "Top-1 accuracy: fraction of items where the expected token had the highest next-token probability. Top-5: fraction where it was within the five highest. Median target rank: median position of the expected token in the sorted next-token distribution. Mean target prob: mean next-token probability of the expected token. Each value is computed from the per-item records with integer arithmetic.",
  memorization:
    "Verbatim rate: fraction of passages where greedy decoding from the prefix reproduced the continuation token for token. Mean matched fraction: mean share of continuation tokens matched before the first mismatch.",
  "paired-bias":
    "Signed gap: mean of P(target | prompt A) minus P(target | prompt B), in basis points (1/100 of a percent). Absolute gap: mean of the absolute differences. Favoring A: number of pairs where the gap is positive. The target token here is ' he'."
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
        Each bar is the held-out accuracy of a logistic-regression probe trained on that hidden state (index 0 is the
        embedding output, the last is the final norm output). The tick marks the majority-class baseline on the held-out
        set. The probe weights are not returned. Each item's record holds the probe's predicted label per hidden state,
        which is what these accuracies are computed from.
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
        For each pair, the clean prompt's final-position residual stream at one layer is copied into the corrupted
        prompt's forward pass at that layer. Recovery is (patched log-prob minus corrupted log-prob) divided by (clean
        log-prob minus corrupted log-prob) for the target token, clipped to [0, 1]. Bars are the mean across pairs; the
        ± value is the standard deviation.
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
        <Tile k="Features listed" v={String(features.length)} />
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
        Firing rate: fraction of the scanned tokens (excluding the BOS token) on which the Gemma Scope 2 feature had a
        non-zero activation. The label lists the tokens on which the feature activated most strongly in this run. Labels
        are not part of the signed payload.
      </p>
    </div>
  );
}

export function PolicyChips({ policy }: { policy: Record<string, unknown> }) {
  const entries: Array<[string, string]> = [
    ["Strategy", String(policy.strategy)],
    ["Disclosed items", `${policy.disclosedItemPercent}% (min ${policy.minDisclosedItems}, max ${policy.maxDisclosedItems})`],
    ["Merkle scheme", String(policy.merkleScheme)],
    ["Per-item records", policy.perItemResultsSealed ? "only the seeded sample is returned" : "all returned"],
    ["Probe weights", policy.probeWeightsReturned ? "returned" : "not returned"],
    ["Raw activations", policy.rawActivationsReturned ? "returned" : "not returned; digests only"]
  ];
  return (
    <div className="policy-block">
      <div className="ev-col-title">Leakage policy</div>
      <div className="policy-tags">
        {entries.map(([key, value]) => (
          <span key={key}>
            {key}: {value}
          </span>
        ))}
      </div>
      <p className="metric-note">
        The runner applies these limits before anything leaves it: values are rounded to fixed-point integers at the
        scales above, at most three top tokens are ever reported, and only the seeded sample of per-item records is
        returned. The policy object is hashed into the receipt.
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
