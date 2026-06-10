import React from "react";
import {
  Anchor,
  ArrowUpRight,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  ShieldCheck,
  XCircle
} from "lucide-react";
import {
  EXAMPLE_EXPECTED_TOKEN,
  EXAMPLE_FEATURE_PROMPTS,
  EXAMPLE_MEMORIZATION,
  EXAMPLE_PAIRED_BIAS,
  EXAMPLE_PATCH_PAIRS,
  EXAMPLE_PROBE
} from "./exampleSuites";

type SuiteTab = "eval" | "probe" | "patch" | "features";
type VerificationState = "unchecked" | "checking" | "valid" | "invalid";

interface SuiteResult {
  available?: boolean;
  hint?: string;
  model: { commitment: string };
  suite: { kind: string; name: string; itemCount: number; datasetHash: string };
  metrics: Record<string, any>;
  policy: Record<string, any>;
  latencyMs: number;
  resultHash: string;
}

interface SuiteRecord {
  kind: "suite";
  id: string;
  experiment: string;
  result: SuiteResult;
  receipt: {
    payload: {
      runId: string;
      issuedAt: string;
      suite: SuiteResult["suite"];
      resultHash: string;
      policyHash: string;
      model: { commitment: string };
      runner: { publicKeyFingerprint: string; teeEvidenceHash?: string };
    };
    signature: string;
    digest: string;
  };
  solanaCommitment?: {
    status: string;
    explorerUrl?: string;
    memoHash: string;
    error?: string;
  } | null;
  createdAt: string;
}

interface TabState {
  text: string;
  record: SuiteRecord | null;
  verification: VerificationState;
  error: string | null;
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const TAB_CONFIG: Record<
  SuiteTab,
  {
    title: string;
    endpoint: string;
    intro: string;
    primer: Array<{ title: string; asks: string; gives: string; tradeoff: string }>;
    examples: Array<{ label: string; body: unknown }>;
  }
> = {
  eval: {
    title: "Behavior evals",
    endpoint: "/api/audit-suite",
    intro:
      "An eval runs many test prompts through the private model and returns one aggregate score. This is how real audits make claims: not “it answered one question” but “across N committed prompts it scored X.” The dataset is hashed, so nobody can quietly swap in easier questions after the fact.",
    primer: [
      {
        title: "Expected token",
        asks: "Does the model predict the right next word across a whole fact set?",
        gives: "Top-1 / top-5 accuracy, median rank, mean probability over the suite.",
        tradeoff: "Behavioral only: says how often it is right, not why."
      },
      {
        title: "Memorization",
        asks: "Does the model complete known texts verbatim (evidence they were in training data)?",
        gives: "Verbatim completion rate and mean matched-token fraction, greedy decoding.",
        tradeoff: "A live legal question for closed models; here demonstrated on famous public quotes."
      },
      {
        title: "Paired bias",
        asks: "Do two prompts differing in one detail (e.g. profession) shift a target word's probability?",
        gives: "Mean signed and absolute probability gaps, fraction of pairs favoring prompt A.",
        tradeoff: "Aggregate gaps only; single pairs are noise, the suite mean is the signal."
      }
    ],
    examples: [
      { label: "Capital facts (expected-token)", body: EXAMPLE_EXPECTED_TOKEN },
      { label: "Famous quotes (memorization)", body: EXAMPLE_MEMORIZATION },
      { label: "Profession pairs (paired-bias)", body: EXAMPLE_PAIRED_BIAS }
    ]
  },
  probe: {
    title: "Linear probe",
    endpoint: "/api/probe",
    intro:
      "A linear probe asks: does the model internally represent a concept? You provide labeled sentences (e.g. positive vs negative sentiment). Inside the runner, a tiny classifier is trained on each layer's hidden states. If it separates held-out examples well above chance at layer L, the concept is readable from the model's working memory at that depth — a claim about internals that black-box access cannot make. Only accuracies leave the enclave; the probe direction itself stays private.",
    primer: [
      {
        title: "What you submit",
        asks: "At least 24 short texts labeled 0 or 1 (at least 8 per class).",
        gives: "A held-out test accuracy for every layer, plus the majority-class baseline to beat.",
        tradeoff: "More examples = more reliable accuracies. The demo set is small, so expect noise."
      },
      {
        title: "How to read it",
        asks: "Where does accuracy rise above the baseline?",
        gives: "A layer profile: chance-level early, peaking where the concept is most linearly readable.",
        tradeoff: "“Represented” is not “used” — a probe shows the information exists, patching shows it matters."
      }
    ],
    examples: [{ label: "Sentiment (24 sentences)", body: EXAMPLE_PROBE }]
  },
  patch: {
    title: "Patch suite",
    endpoint: "/api/patch-suite",
    intro:
      "Activation patching is the causal experiment: run a corrupted prompt, splice in the clean prompt's hidden state at one layer, and see how much of the right answer comes back. One pair is an anecdote; a suite of pairs averaged with a spread is evidence. High mean recovery at a layer band means those layers causally carry the information that distinguishes clean from corrupted.",
    primer: [
      {
        title: "What you submit",
        asks: "3–12 clean/corrupted prompt pairs of the same type (e.g. country→capital).",
        gives: "Mean ± std of recovery per layer across pairs, plus the best-restoring layer.",
        tradeoff: "Patches the residual stream at the final token only — layer-level, not head-level, localization."
      },
      {
        title: "How to read it",
        asks: "Where does mean recovery jump?",
        gives: "The layer band where the distinguishing information arrives at the final position.",
        tradeoff: "A small std means the circuit location is consistent across prompts — the robust claim."
      }
    ],
    examples: [{ label: "Capital recall (6 pairs)", body: EXAMPLE_PATCH_PAIRS }]
  },
  features: {
    title: "SAE features",
    endpoint: "/api/features",
    intro:
      "Hidden states cram thousands of concepts into 768 dimensions (superposition), so single neurons mean little. A sparse autoencoder (SAE) un-smears them into individually meaningful directions called features. This lab reports which dictionary features fire on your prompts and how often — concept-level statistics about the model's internals, without the activations ever leaving the runner. The demo dictionary is trained on a tiny public corpus, so treat labels as hints, not verified concepts.",
    primer: [
      {
        title: "What you submit",
        asks: "Up to 16 prompts to scan.",
        gives: "Top features by firing rate with auto-labels (their top activating tokens) and mean strength.",
        tradeoff: "Auto-labels come from a small training corpus; frontier SAE work uses humans to verify labels."
      },
      {
        title: "How to read it",
        asks: "Do the firing features match what your prompts are about?",
        gives: "Mean active features per token (L0) — lower means a sparser, more interpretable code.",
        tradeoff: "If no dictionary is trained yet, run `npm run train:sae` once on the server."
      }
    ],
    examples: [{ label: "Mixed-topic scan (8 prompts)", body: EXAMPLE_FEATURE_PROMPTS }]
  }
};

function initialTabState(tab: SuiteTab): TabState {
  return {
    text: JSON.stringify(TAB_CONFIG[tab].examples[0].body, null, 2),
    record: null,
    verification: "unchecked",
    error: null
  };
}

export function AuditorLab() {
  const [tab, setTab] = React.useState<SuiteTab>("eval");
  const [states, setStates] = React.useState<Record<SuiteTab, TabState>>({
    eval: initialTabState("eval"),
    probe: initialTabState("probe"),
    patch: initialTabState("patch"),
    features: initialTabState("features")
  });
  const [busy, setBusy] = React.useState(false);
  const [unavailableHint, setUnavailableHint] = React.useState<string | null>(null);

  const config = TAB_CONFIG[tab];
  const state = states[tab];

  function patchState(target: SuiteTab, update: Partial<TabState>) {
    setStates((current) => ({ ...current, [target]: { ...current[target], ...update } }));
  }

  function loadExample(body: unknown) {
    patchState(tab, { text: JSON.stringify(body, null, 2), error: null });
  }

  async function run() {
    const activeTab = tab;
    setUnavailableHint(null);
    let parsed: any;
    try {
      parsed = JSON.parse(states[activeTab].text);
    } catch (error) {
      patchState(activeTab, { error: `Dataset is not valid JSON: ${String(error)}` });
      return;
    }
    const payload = activeTab === "eval" ? { suite: parsed } : parsed;
    setBusy(true);
    patchState(activeTab, { error: null });
    try {
      const body = await apiPost<{ record?: SuiteRecord; available?: boolean; hint?: string }>(
        TAB_CONFIG[activeTab].endpoint,
        payload
      );
      if (body.available === false) {
        setUnavailableHint(body.hint || "This experiment is not available yet.");
        return;
      }
      const record = body.record!;
      patchState(activeTab, { record, verification: "checking" });
      try {
        const verified = await apiPost<{ verification: { ok: boolean } }>("/api/verify", {
          receipt: record.receipt
        });
        patchState(activeTab, { verification: verified.verification.ok ? "valid" : "invalid" });
      } catch {
        patchState(activeTab, { verification: "invalid" });
      }
    } catch (error) {
      patchState(activeTab, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function anchor() {
    const activeTab = tab;
    const record = states[activeTab].record;
    if (!record) return;
    setBusy(true);
    try {
      const body = await apiPost<{ record: SuiteRecord }>(`/api/receipts/${record.id}/commit`, {});
      patchState(activeTab, { record: body.record });
    } catch (error) {
      patchState(activeTab, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel auditor-lab">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Auditor lab</span>
          <div className="panel-title">Verifiable audits of the private model</div>
        </div>
        <span className="pill-count">
          <FlaskConical /> aggregate-only · capped detail
        </span>
      </div>
      <p className="lede">
        Each experiment here produces one signed receipt binding{" "}
        <strong>dataset hash + model commitment + aggregate results + leakage policy</strong>. That is
        the artifact an auditor can hand to a third party: “the model whose weights hash to X scored Y
        on the committed dataset Z” — checkable without ever seeing the weights.
      </p>

      <div className="mode-tabs auditor-tabs" role="tablist" aria-label="Auditor experiment">
        {(Object.keys(TAB_CONFIG) as SuiteTab[]).map((key) => (
          <button
            key={key}
            type="button"
            className="mode-tab"
            data-active={tab === key}
            data-ready={Boolean(states[key].record)}
            onClick={() => setTab(key)}
          >
            <span className="tab-dot" />
            {TAB_CONFIG[key].title}
          </button>
        ))}
      </div>

      <p className="auditor-intro">{config.intro}</p>

      <div className="interp-primer">
        {config.primer.map((card) => (
          <div className="primer-card" data-active={true} key={card.title}>
            <div className="primer-title">{card.title}</div>
            <div className="primer-line">
              <strong>Asks</strong>
              <span>{card.asks}</span>
            </div>
            <div className="primer-line">
              <strong>Returns</strong>
              <span>{card.gives}</span>
            </div>
            <div className="primer-line">
              <strong>Caveat</strong>
              <span>{card.tradeoff}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="suite-editor">
        <div className="suite-editor-head">
          <span className="ev-col-title">Committed dataset (editable JSON)</span>
          <div className="load-row">
            {config.examples.map((example) => (
              <button
                key={example.label}
                className="mini-link"
                type="button"
                onClick={() => loadExample(example.body)}
              >
                Load: {example.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className="chat-input suite-textarea"
          value={state.text}
          spellCheck={false}
          onChange={(event) => patchState(tab, { text: event.target.value })}
        />
        <div className="suite-actions">
          <button className="send-btn" type="button" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="spin" /> : <Play />}
            <span>{busy ? "Running inside the runner…" : `Run ${config.title.toLowerCase()}`}</span>
          </button>
          {state.record && (
            <button className="btn btn-dark" type="button" onClick={anchor} disabled={busy}>
              <Anchor /> Anchor receipt
            </button>
          )}
        </div>
      </div>

      {state.error && (
        <div className="error-strip" role="alert">
          <XCircle />
          <span>{state.error}</span>
        </div>
      )}
      {unavailableHint && (
        <div className="error-strip" role="alert">
          <ShieldCheck />
          <span>{unavailableHint}</span>
        </div>
      )}

      {state.record && (
        <SuiteResultView tab={tab} record={state.record} verification={state.verification} />
      )}
    </section>
  );
}

function SuiteResultView({
  tab,
  record,
  verification
}: {
  tab: SuiteTab;
  record: SuiteRecord;
  verification: VerificationState;
}) {
  const result = record.result;
  const metrics = result.metrics;
  return (
    <div className="suite-result">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Aggregate result</span>
          <div className="panel-title">
            {result.suite.name} · {result.suite.itemCount} items
          </div>
        </div>
        <SuiteBadge state={verification} />
      </div>

      {tab === "eval" && <EvalMetrics metrics={metrics} kind={result.suite.kind} />}
      {tab === "probe" && <ProbeMetrics metrics={metrics} />}
      {tab === "patch" && <PatchMetrics metrics={metrics} />}
      {tab === "features" && <FeatureMetrics metrics={metrics} />}

      <div className="suite-receipt">
        <div className="ev-col-title">What the signed receipt binds together</div>
        <div className="kv">
          <Row k="Dataset hash" v={result.suite.datasetHash} />
          <Row k="Model commitment" v={record.receipt.payload.model.commitment} />
          <Row k="Result hash" v={result.resultHash} />
          <Row k="Leakage policy hash" v={record.receipt.payload.policyHash} />
          <Row k="TEE evidence hash" v={record.receipt.payload.runner.teeEvidenceHash || "pending"} />
          <Row k="Receipt digest" v={record.receipt.digest} />
        </div>
        {record.solanaCommitment && (
          <div className={`confirmed${record.solanaCommitment.status === "failed" ? " failed" : ""}`}>
            <span className="dot" />
            <div style={{ minWidth: 0 }}>
              <div className="confirmed-t">
                {record.solanaCommitment.explorerUrl ? (
                  <a href={record.solanaCommitment.explorerUrl} target="_blank" rel="noreferrer">
                    Solana {record.solanaCommitment.status}
                    <ArrowUpRight />
                  </a>
                ) : (
                  <span>Solana {record.solanaCommitment.status}</span>
                )}
              </div>
              <div className="confirmed-h">
                {record.solanaCommitment.error || record.solanaCommitment.memoHash}
              </div>
            </div>
          </div>
        )}
        <PolicyChips policy={result.policy} />
      </div>
    </div>
  );
}

function EvalMetrics({ metrics, kind }: { metrics: Record<string, any>; kind: string }) {
  const explain: Record<string, string> = {
    "expected-token":
      "Top-1 accuracy is how often the expected word was the model's #1 prediction. Top-5 means it was in the first five guesses. Median rank tells you how far down the right answer usually sits.",
    memorization:
      "Verbatim rate is the fraction of texts the model completed word-for-word under greedy decoding — strong evidence those texts were in its training data.",
    "paired-bias":
      "The signed gap is mean P(target | prompt A) minus P(target | prompt B). A positive gap with target “ he” means prompt A's subjects pull the model toward male pronouns more than prompt B's."
  };
  return (
    <div>
      <div className="metric-tiles">
        {Object.entries(metrics)
          .filter(([, value]) => typeof value === "number" || typeof value === "string")
          .map(([key, value]) => (
            <div className="metric-tile" key={key}>
              <div className="metric-k">{labelize(key)}</div>
              <div className="metric-v">{formatMetric(key, value)}</div>
            </div>
          ))}
      </div>
      <p className="metric-note">{explain[kind]}</p>
    </div>
  );
}

function ProbeMetrics({ metrics }: { metrics: Record<string, any> }) {
  const layers: Array<{ layer: number; label: string; testAccuracy: number }> = metrics.layers || [];
  const baseline = Number(metrics.majorityClassBaseline || 0.5);
  return (
    <div>
      <div className="metric-tiles">
        <Tile k="Best layer" v={String(metrics.bestLayer)} />
        <Tile k="Best test accuracy" v={pct(metrics.bestTestAccuracy)} />
        <Tile k="Baseline to beat" v={pct(baseline)} />
        <Tile k="Train / test split" v={`${metrics.counts?.train} / ${metrics.counts?.test}`} />
      </div>
      <div className="patch-bars">
        {layers.map((layer) => (
          <div className="patch-row" key={layer.layer}>
            <span>{layer.layer === 0 ? "emb" : `L${layer.layer}`}</span>
            <div className="patch-track">
              <div className="patch-fill" style={{ width: `${Math.round(layer.testAccuracy * 100)}%` }} />
              <div className="baseline-mark" style={{ left: `${Math.round(baseline * 100)}%` }} />
            </div>
            <strong>{pct(layer.testAccuracy)}</strong>
          </div>
        ))}
      </div>
      <p className="metric-note">
        Each bar is held-out probe accuracy at one layer; the tick is the majority-class baseline.
        Accuracy well above the tick means the concept is linearly readable from that layer's hidden
        states. The probe's weight vector never leaves the runner — it is a direction in private
        activation space.
      </p>
    </div>
  );
}

function PatchMetrics({ metrics }: { metrics: Record<string, any> }) {
  const layers: Array<{
    layer: number;
    meanClippedRecovery: number;
    stdClippedRecovery: number;
  }> = metrics.layers || [];
  return (
    <div>
      <div className="metric-tiles">
        <Tile k="Best layer" v={`L${metrics.bestLayer}`} />
        <Tile k="Best mean recovery" v={pct(metrics.bestMeanClippedRecovery)} />
        <Tile k="Pairs scored" v={`${metrics.scored} (skipped ${metrics.skipped})`} />
        <Tile k="Mean clean vs corrupted" v={`${metrics.meanCleanLogProb} / ${metrics.meanCorruptedLogProb}`} />
      </div>
      <div className="patch-bars">
        {layers.map((layer) => (
          <div className="patch-row" key={layer.layer}>
            <span>L{layer.layer}</span>
            <div className="patch-track">
              <div
                className="patch-fill"
                style={{ width: `${Math.round(layer.meanClippedRecovery * 100)}%` }}
              />
            </div>
            <strong>{pct(layer.meanClippedRecovery)}</strong>
            <em>± {pct(layer.stdClippedRecovery)}</em>
          </div>
        ))}
      </div>
      <p className="metric-note">
        Mean recovery across all pairs, with the spread. A sharp rise at consecutive layers with a
        small ± is the robust finding: that layer band causally carries the information separating
        clean from corrupted prompts, consistently across the suite.
      </p>
    </div>
  );
}

function FeatureMetrics({ metrics }: { metrics: Record<string, any> }) {
  const features: Array<{
    feature: number;
    label: string;
    exampleTokens: string[];
    firingRate: number;
    meanActivationWhenActive: number;
  }> = metrics.features || [];
  const sae = metrics.sae || {};
  return (
    <div>
      <div className="metric-tiles">
        <Tile k="Tokens scanned" v={String(metrics.tokenCount)} />
        <Tile k="Active features / token" v={String(metrics.meanActiveFeaturesPerToken)} />
        <Tile k="Dictionary size" v={`${sae.dFeatures} features @ layer ${sae.layer}`} />
        <Tile k="Dead features" v={String(sae.deadFeatures)} />
      </div>
      <div className="patch-bars">
        {features.map((feature) => (
          <div className="patch-row feature-row" key={feature.feature}>
            <span>#{feature.feature}</span>
            <div className="patch-track">
              <div className="patch-fill" style={{ width: `${Math.round(feature.firingRate * 100)}%` }} />
            </div>
            <strong>{pct(feature.firingRate)}</strong>
            <em className="feature-label">
              {feature.label === "unlabeled"
                ? "unlabeled (not in the training corpus's top features)"
                : feature.label}
            </em>
          </div>
        ))}
      </div>
      <p className="metric-note">
        Firing rate = fraction of your prompts' tokens on which the feature activated. Labels are the
        feature's top activating tokens from the (public) training corpus — hints, not verified
        concepts. {sae.note}
      </p>
    </div>
  );
}

function PolicyChips({ policy }: { policy: Record<string, any> }) {
  if (!policy) return null;
  const entries: Array<[string, string]> = [
    ["Strategy", String(policy.strategy)],
    ["Probability decimals", String(policy.probabilityDecimals)],
    ["Max top-k", String(policy.maxTopK)],
    ["Aggregates only", String(policy.suiteAggregatesOnly)],
    ["Per-item results", String(policy.perItemResultsReturned)],
    ["Probe weights returned", String(policy.probeWeightsReturned)]
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
        Detail caps, not quotas: numbers are coarsened, top-k is capped, and suites return aggregates
        only, so farming the API for high-precision outputs (the way model-extraction attacks work)
        yields little. The policy's hash is part of the signed receipt — an auditor can prove which
        caps governed the run.
      </p>
    </div>
  );
}

function SuiteBadge({ state }: { state: VerificationState }) {
  if (state === "valid") {
    return (
      <span className="badge badge-valid">
        <CheckCircle2 /> Receipt signature valid
      </span>
    );
  }
  if (state === "invalid") {
    return (
      <span className="badge badge-bad">
        <XCircle /> Check failed
      </span>
    );
  }
  return (
    <span className="badge badge-pending">
      <Loader2 className="spin" /> Checking
    </span>
  );
}

function Tile({ k, v }: { k: string; v: string }) {
  return (
    <div className="metric-tile">
      <div className="metric-k">{k}</div>
      <div className="metric-v">{v}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv-row">
      <div className="kv-k">{k}</div>
      <div className="kv-v">{v}</div>
    </div>
  );
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(describeApiError(payload.error) || `${url} failed`);
  }
  return payload as T;
}

function describeApiError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const fieldErrors = (error as { fieldErrors?: Record<string, string[]> }).fieldErrors;
    if (fieldErrors) {
      const lines = Object.entries(fieldErrors).map(
        ([field, messages]) => `${field}: ${messages.join("; ")}`
      );
      if (lines.length > 0) return lines.join(" · ");
    }
    return JSON.stringify(error);
  }
  return String(error || "");
}

function pct(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "n/a";
  const percent = num * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function labelize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}

function formatMetric(key: string, value: unknown): string {
  if (typeof value === "string") return value;
  const num = Number(value);
  const percentKeys = /accuracy|rate|fraction|probability|gap/i;
  if (percentKeys.test(key)) return pct(num);
  return String(num);
}
