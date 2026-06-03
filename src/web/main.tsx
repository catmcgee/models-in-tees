import React from "react";
import ReactDOM from "react-dom/client";
import {
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  Database,
  FileCheck2,
  Fingerprint,
  Gauge,
  KeyRound,
  Loader2,
  Lock,
  RadioTower,
  RefreshCcw,
  Send,
  ShieldCheck,
  WalletCards,
  XCircle
} from "lucide-react";
import "./styles.css";

type Label = "APPROVE" | "REVIEW" | "BLOCK" | "INSUFFICIENT";
type VerificationState = "unchecked" | "checking" | "valid" | "invalid";

interface BenchmarkCase {
  id: string;
  prompt: string;
  expected: Label;
}

interface Scenario extends BenchmarkCase {
  title: string;
  note: string;
}

interface ModelInfo {
  commitment: string;
  architecture: Record<string, unknown>;
  labels: Label[];
  weights_path: string;
  weights_public: boolean;
}

interface Prediction {
  id: string;
  prediction: Label;
  expected: Label | null;
  correct: boolean | null;
  confidence: number;
  latencyMs: number;
  output: string;
  scores: Record<Label, number>;
}

interface BenchmarkRecord {
  id: string;
  cases: BenchmarkCase[];
  run: {
    model: ModelInfo;
    predictions: Prediction[];
    metrics: {
      caseCount: number;
      labeledCaseCount: number;
      accuracy: number | null;
      avgConfidence: number;
      totalLatencyMs: number;
    };
  };
  receipt: {
    payload: {
      issuedAt: string;
      inputSetHash: string;
      outputSetHash: string;
      metricsHash: string;
      runner: {
        teeMode: string;
        teeProvider: string;
        publicKeyFingerprint: string;
        teeEvidenceHash?: string;
        teeEvidence?: TeeEvidenceSummary;
      };
      model: {
        commitment: string;
      };
    };
    signature: string;
    digest: string;
    algorithm: string;
  };
  solanaCommitment?: {
    status: "confirmed" | "dry-run" | "failed";
    payer: string;
    signature?: string;
    explorerUrl?: string;
    memoHash: string;
    error?: string;
  } | null;
  magicBlockFlow?: {
    ok: boolean;
    sessionPda: string;
    delegateSignature?: string;
    finalizeSignature?: string;
    commitErSignature?: string;
    baseCommitSignature?: string;
    delegatedOnBase?: boolean;
    error?: string;
  } | null;
  createdAt: string;
}

interface AuditCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

interface ReceiptAudit {
  ok: boolean;
  receiptDigest?: string;
  evidenceHash?: string;
  workloadHash?: string;
  checks: AuditCheck[];
}

interface TeeEvidenceSummary {
  evidenceHash: string;
  workloadHash?: string;
  source: string;
  collectedAt: string;
  nonce: string;
  attestationStatus: string;
  tokenHash?: string;
  reportHash?: string;
  hardwareModel?: string;
  secureBoot?: boolean;
  projectId?: string;
  zone?: string;
  instanceName?: string;
  errors?: string[];
}

interface SolanaStatus {
  rpcUrl: string;
  payer: string;
  balanceSol: number;
  blockhash: string;
}

interface MagicBlockStatus {
  ephemeralRollupRpcUrl: string;
  erRpc?: {
    ok: boolean;
    error?: string;
  };
  statusApi?: {
    regions: Array<{
      region: string;
      servers: Array<{
        endpoint: string;
        liveStatus: Record<string, boolean | null>;
      }>;
    }>;
  };
}

const LABELS: Label[] = ["APPROVE", "REVIEW", "BLOCK", "INSUFFICIENT"];
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const SCENARIOS: Scenario[] = [
  {
    id: "approve-public-data",
    title: "Clean analytics",
    note: "A low-risk request that should pass.",
    prompt:
      "Policy gate input: analytics request; public data; contains no pii; read only access.",
    expected: "APPROVE"
  },
  {
    id: "review-regulated",
    title: "Regulated export",
    note: "A request that needs human review.",
    prompt:
      "Classify this request: customer export; regulated workflow; cross border processing; unusual access pattern.",
    expected: "REVIEW"
  },
  {
    id: "block-secret",
    title: "Credential leak",
    note: "A request that should be blocked.",
    prompt:
      "Risk review packet: support ticket; contains secret keys; asks for raw credentials; bypasses access controls.",
    expected: "BLOCK"
  },
  {
    id: "insufficient-missing",
    title: "Missing context",
    note: "A request the model should not decide yet.",
    prompt:
      "Benchmark case: finance workflow; missing data owner; unknown destination; not enough context.",
    expected: "INSUFFICIENT"
  }
];

function App() {
  const [selectedScenarioId, setSelectedScenarioId] = React.useState(SCENARIOS[0].id);
  const [prompt, setPrompt] = React.useState(SCENARIOS[0].prompt);
  const [expected, setExpected] = React.useState<Label>(SCENARIOS[0].expected);
  const [model, setModel] = React.useState<ModelInfo | null>(null);
  const [records, setRecords] = React.useState<BenchmarkRecord[]>([]);
  const [activeRecord, setActiveRecord] = React.useState<BenchmarkRecord | null>(null);
  const [solana, setSolana] = React.useState<SolanaStatus | null>(null);
  const [magicblock, setMagicblock] = React.useState<MagicBlockStatus | null>(null);
  const [teeEvidence, setTeeEvidence] = React.useState<TeeEvidenceSummary | null>(null);
  const [audit, setAudit] = React.useState<ReceiptAudit | null>(null);
  const [busy, setBusy] = React.useState<string | null>("Loading");
  const [error, setError] = React.useState<string | null>(null);
  const [dryRunCommit, setDryRunCommit] = React.useState(false);
  const [verification, setVerification] =
    React.useState<VerificationState>("unchecked");

  React.useEffect(() => {
    refreshAll();
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function verifyAndAudit(record: BenchmarkRecord) {
      setVerification("checking");
      setAudit(null);
      try {
        const verified = await apiPost<{
          verification: { ok: boolean; reason?: string };
        }>("/api/verify", { receipt: record.receipt });
        if (!cancelled) {
          setVerification(verified.verification.ok ? "valid" : "invalid");
        }
      } catch {
        if (!cancelled) setVerification("invalid");
      }

      try {
        const nextAudit = await fetchReceiptAudit(record.id);
        if (!cancelled) setAudit(nextAudit);
      } catch {
        if (!cancelled) setAudit(null);
      }
    }

    if (!activeRecord) {
      setAudit(null);
      setVerification("unchecked");
      return () => {
        cancelled = true;
      };
    }

    verifyAndAudit(activeRecord);
    return () => {
      cancelled = true;
    };
  }, [activeRecord?.id]);

  async function refreshAll() {
    setBusy("Refreshing");
    setError(null);
    try {
      const [modelBody, receiptsBody, solanaBody, magicBody, teeBody] =
        await Promise.all([
          apiGet<{ model: ModelInfo }>("/api/model"),
          apiGet<{ records: BenchmarkRecord[] }>("/api/receipts"),
          apiGet<{ solana: SolanaStatus }>("/api/solana/status").catch(() => null),
          apiGet<{ magicblock: MagicBlockStatus }>("/api/magicblock/status").catch(
            () => null
          ),
          apiGet<{ summary: TeeEvidenceSummary }>("/api/tee/evidence").catch(
            () => null
          )
        ]);
      setModel(modelBody.model);
      setRecords(receiptsBody.records);
      setActiveRecord((current) => current || receiptsBody.records[0] || null);
      setSolana(solanaBody?.solana || null);
      setMagicblock(magicBody?.magicblock || null);
      setTeeEvidence(teeBody?.summary || null);
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  }

  function selectScenario(scenario: Scenario) {
    setSelectedScenarioId(scenario.id);
    setPrompt(scenario.prompt);
    setExpected(scenario.expected);
  }

  async function runPrivateModel(mode: "single" | "set" = "single") {
    setBusy(mode === "single" ? "Running private model" : "Running example set");
    setError(null);
    try {
      const cases =
        mode === "single"
          ? [
              {
                id: selectedScenarioId || "visitor-input",
                prompt,
                expected
              }
            ]
          : SCENARIOS.map(({ id, prompt: scenarioPrompt, expected: label }) => ({
              id,
              prompt: scenarioPrompt,
              expected: label
            }));
      const body = await apiPost<{ record: BenchmarkRecord }>("/api/benchmark", {
        cases
      });
      setActiveRecord(body.record);
      setRecords((current) => [body.record, ...current]);
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  }

  async function commitActiveReceipt() {
    if (!activeRecord) return;
    setBusy("Anchoring receipt");
    setError(null);
    try {
      const body = await apiPost<{
        record: BenchmarkRecord;
      }>(`/api/receipts/${activeRecord.id}/commit`, {
        dryRun: dryRunCommit
      });
      setActiveRecord(body.record);
      setRecords((current) =>
        current.map((record) => (record.id === body.record.id ? body.record : record))
      );
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runMagicBlockFlow() {
    if (!activeRecord) return;
    setBusy("Testing MagicBlock");
    setError(null);
    try {
      const body = await apiPost<{
        record: BenchmarkRecord;
      }>(`/api/receipts/${activeRecord.id}/magicblock`, {});
      setActiveRecord(body.record);
      setRecords((current) =>
        current.map((record) => (record.id === body.record.id ? body.record : record))
      );
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  }

  const activeTeeEvidence = activeRecord?.receipt.payload.runner.teeEvidence || teeEvidence;
  const latestPrediction = activeRecord?.run.predictions[0] || null;
  const metrics = activeRecord?.run.metrics || null;
  const proofItems = [
    {
      label: "Model",
      value: model?.weights_public ? "Weights exposed" : "Weights hidden",
      detail: shortHash(model?.commitment),
      icon: <Lock size={18} />,
      tone: model?.weights_public ? "warn" : "good"
    },
    {
      label: "Receipt",
      value: verificationLabel(verification),
      detail: shortHash(activeRecord?.receipt.digest),
      icon: <BadgeCheck size={18} />,
      tone: verification === "valid" ? "good" : verification === "invalid" ? "bad" : "idle"
    },
    {
      label: "TEE",
      value: teeProofLabel(activeTeeEvidence),
      detail: activeTeeEvidence?.source || "waiting for evidence",
      icon: <ShieldCheck size={18} />,
      tone: activeTeeEvidence ? "good" : "idle"
    },
    {
      label: "Devnet",
      value: chainLabel(activeRecord),
      detail: solana?.payer ? `payer ${shortHash(solana.payer, 8)}` : "not connected",
      icon: <WalletCards size={18} />,
      tone: activeRecord?.solanaCommitment?.status === "failed" ? "bad" : "idle"
    }
  ];

  return (
    <main className="app-shell">
      <header className="masthead">
        <div className="topline">
          <div className="brand">
            <span className="brand-mark">
              <Fingerprint size={24} />
            </span>
            <div>
              <strong>Private Model Verifier</strong>
              <span>TEE-backed policy model on Solana devnet</span>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={refreshAll} disabled={!!busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
            <span>{busy || "Refresh"}</span>
          </button>
        </div>

        <div className="hero-grid">
          <section className="experiment-panel" aria-labelledby="experiment-title">
            <p className="eyebrow">Public test</p>
            <h1 id="experiment-title">Send one request to a model you cannot inspect.</h1>
            <p className="lead">
              This is a public test harness for a private AI model. You can query
              the model and verify the run, but the model weights never appear in
              the browser or the public repo.
            </p>

            <div className="how-strip" aria-label="How to use this demo">
              <div>
                <span>1</span>
                <strong>Choose a request</strong>
                <p>Use a sample policy case or write your own request.</p>
              </div>
              <div>
                <span>2</span>
                <strong>Run the hidden model</strong>
                <p>The backend runs the model inside the private runner.</p>
              </div>
              <div>
                <span>3</span>
                <strong>Check the receipt</strong>
                <p>Verify the signed result, TEE evidence, and optional devnet anchor.</p>
              </div>
            </div>

            <div className="scenario-tabs" aria-label="Example scenarios">
              {SCENARIOS.map((scenario) => (
                <button
                  type="button"
                  key={scenario.id}
                  className={scenario.id === selectedScenarioId ? "active" : ""}
                  onClick={() => selectScenario(scenario)}
                >
                  <strong>{scenario.title}</strong>
                  <span>{scenario.note}</span>
                </button>
              ))}
            </div>

            <label className="prompt-box">
              <span>Request under review</span>
              <textarea
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setSelectedScenarioId("visitor-input");
                }}
              />
            </label>

            <div className="run-row">
              <label className="expected-select">
                <span>Your expected verdict</span>
                <select
                  value={expected}
                  onChange={(event) => setExpected(event.target.value as Label)}
                >
                  {LABELS.map((label) => (
                    <option value={label} key={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary-button"
                type="button"
                onClick={() => runPrivateModel("single")}
                disabled={!!busy || prompt.trim().length < 8}
              >
                <Send size={18} />
                <span>Run private model</span>
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => runPrivateModel("set")}
                disabled={!!busy}
              >
                <Gauge size={18} />
                <span>Run examples</span>
              </button>
            </div>
          </section>

          <ResultSummary
            record={activeRecord}
            prediction={latestPrediction}
            metrics={metrics}
            verification={verification}
            busy={busy}
          />
        </div>
      </header>

      {error && (
        <div className="error-strip" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      <section className="proof-row" aria-label="Proof summary">
        {proofItems.map((item) => (
          <ProofTile {...item} key={item.label} />
        ))}
      </section>

      <section className="workbench">
        <section className="panel output-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Model output</span>
              <h2>Readable result</h2>
            </div>
            {metrics && <span className="pill">{metrics.caseCount} case run</span>}
          </div>
          {activeRecord ? (
            <PredictionList record={activeRecord} />
          ) : (
            <EmptyState />
          )}
        </section>

        <section className="panel receipt-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Proof</span>
              <h2>What the receipt says</h2>
            </div>
            <VerificationBadge state={verification} />
          </div>

          {activeRecord ? (
            <>
              <div className="receipt-summary">
                <div>
                  <span>Run id</span>
                  <strong>{activeRecord.id}</strong>
                </div>
                <div>
                  <span>Issued</span>
                  <strong>{formatDate(activeRecord.createdAt)}</strong>
                </div>
                <div>
                  <span>Receipt digest</span>
                  <strong>{shortHash(activeRecord.receipt.digest, 14)}</strong>
                </div>
                <div>
                  <span>Model commitment</span>
                  <strong>{shortHash(activeRecord.receipt.payload.model.commitment, 14)}</strong>
                </div>
              </div>

              <div className="action-strip">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={dryRunCommit}
                    onChange={(event) => setDryRunCommit(event.target.checked)}
                  />
                  <span>Dry run</span>
                </label>
                <button
                  className="primary-button compact"
                  type="button"
                  onClick={commitActiveReceipt}
                  disabled={!!busy}
                >
                  <FileCheck2 size={16} />
                  <span>Anchor receipt</span>
                </button>
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={runMagicBlockFlow}
                  disabled={!!busy}
                >
                  <RadioTower size={16} />
                  <span>Try MagicBlock</span>
                </button>
              </div>

              <ChainNotice record={activeRecord} />
            </>
          ) : (
            <EmptyState />
          )}
        </section>
      </section>

      <details className="advanced-panel">
        <summary>
          <span>Evidence drawer</span>
          <ChevronDown size={18} />
        </summary>
        <div className="advanced-grid">
          <section>
            <h3>Hidden model</h3>
            <FactList
              items={[
                ["Weights", model?.weights_public ? "public" : "private"],
                ["Commitment", model?.commitment || "pending"],
                ["Architecture", modelArchitecture(model)],
                ["Labels", model?.labels.join(", ") || "pending"]
              ]}
            />
          </section>

          <section>
            <h3>TEE evidence</h3>
            <FactList
              items={[
                ["Source", activeTeeEvidence?.source || "pending"],
                ["Hardware", hardwareClaim(activeTeeEvidence)],
                ["Evidence hash", activeTeeEvidence?.evidenceHash || "pending"],
                ["Workload hash", audit?.workloadHash || activeTeeEvidence?.workloadHash || "pending"]
              ]}
            />
          </section>

          <section>
            <h3>Solana and MagicBlock</h3>
            <FactList
              items={[
                ["Base RPC", solana?.rpcUrl || "devnet"],
                ["Payer", solana?.payer || "pending"],
                ["Balance", solana ? `${solana.balanceSol.toFixed(4)} SOL` : "pending"],
                ["ER RPC", magicblock?.ephemeralRollupRpcUrl || "pending"],
                ["ER health", magicblock?.erRpc?.ok ? "online" : magicblock?.erRpc?.error || "pending"]
              ]}
            />
          </section>

          <section>
            <h3>Receipt hashes</h3>
            {activeRecord ? (
              <>
                <ReceiptCanvas record={activeRecord} />
                <FactList
                  items={[
                    ["Input set", activeRecord.receipt.payload.inputSetHash],
                    ["Output set", activeRecord.receipt.payload.outputSetHash],
                    ["Metrics", activeRecord.receipt.payload.metricsHash],
                    ["TEE key", activeRecord.receipt.payload.runner.publicKeyFingerprint],
                    ["Signature", activeRecord.receipt.signature]
                  ]}
                />
              </>
            ) : (
              <p className="muted-copy">Run the model to create a receipt.</p>
            )}
          </section>
        </div>
      </details>
    </main>
  );
}

function ResultSummary({
  record,
  prediction,
  metrics,
  verification,
  busy
}: {
  record: BenchmarkRecord | null;
  prediction: Prediction | null;
  metrics: BenchmarkRecord["run"]["metrics"] | null;
  verification: VerificationState;
  busy: string | null;
}) {
  if (!record || !prediction) {
    return (
      <aside className="result-panel waiting">
        <div className="result-icon">
          {busy ? <Loader2 className="spin" size={24} /> : <ShieldCheck size={24} />}
        </div>
        <span className="section-kicker">Current result</span>
        <h2>{busy || "Ready for a test"}</h2>
        <p>
          No public weights are loaded in the browser. A run returns only the
          verdict, confidence, and receipt.
        </p>
      </aside>
    );
  }

  return (
    <aside className={`result-panel ${labelTone(prediction.prediction)}`}>
      <div className="result-top">
        <span className="section-kicker">Current result</span>
        <VerificationBadge state={verification} />
      </div>
      <div className="verdict">
        <span>Model verdict</span>
        <strong>{prediction.prediction}</strong>
      </div>
      <p>{prediction.output}</p>
      <div className="score-grid">
        <div>
          <span>Confidence</span>
          <strong>{formatPercent(prediction.confidence)}</strong>
        </div>
        <div>
          <span>Expectation</span>
          <strong>{matchLabel(prediction)}</strong>
        </div>
        <div>
          <span>Latency</span>
          <strong>{formatMs(prediction.latencyMs)}</strong>
        </div>
        <div>
          <span>Set score</span>
          <strong>{formatPercent(metrics?.accuracy)}</strong>
        </div>
      </div>
    </aside>
  );
}

function ProofTile({
  icon,
  label,
  value,
  detail,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <article className={`proof-tile ${tone}`}>
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function VerificationBadge({ state }: { state: VerificationState }) {
  const icon =
    state === "valid" ? (
      <CheckCircle2 size={15} />
    ) : state === "invalid" ? (
      <XCircle size={15} />
    ) : state === "checking" ? (
      <Loader2 className="spin" size={15} />
    ) : (
      <BadgeCheck size={15} />
    );
  return (
    <span className={`verify-badge ${state}`}>
      {icon}
      {verificationLabel(state)}
    </span>
  );
}

function PredictionList({ record }: { record: BenchmarkRecord }) {
  return (
    <div className="prediction-stack">
      {record.run.predictions.map((prediction) => (
        <article className="prediction-row" key={prediction.id}>
          <div className={`label-chip ${labelTone(prediction.prediction)}`}>
            {prediction.prediction}
          </div>
          <div className="prediction-copy">
            <strong>{humanCaseName(prediction.id)}</strong>
            <span>{prediction.output}</span>
          </div>
          <div className="prediction-meter">
            <span>{formatPercent(prediction.confidence)}</span>
            <meter min={0} max={1} value={prediction.confidence} />
          </div>
        </article>
      ))}
    </div>
  );
}

function ChainNotice({ record }: { record: BenchmarkRecord }) {
  if (record.solanaCommitment) {
    return (
      <div className={`chain-notice ${record.solanaCommitment.status}`}>
        <KeyRound size={17} />
        <div>
          <strong>
            {record.solanaCommitment.explorerUrl ? (
              <a
                href={record.solanaCommitment.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                Solana {record.solanaCommitment.status}
                <ArrowUpRight size={13} />
              </a>
            ) : (
              `Solana ${record.solanaCommitment.status}`
            )}
          </strong>
          <span>{shortHash(record.solanaCommitment.memoHash, 14)}</span>
        </div>
      </div>
    );
  }

  if (record.magicBlockFlow) {
    return (
      <div className={`chain-notice ${record.magicBlockFlow.ok ? "confirmed" : "failed"}`}>
        <RadioTower size={17} />
        <div>
          <strong>{record.magicBlockFlow.ok ? "MagicBlock flow passed" : "MagicBlock flow failed"}</strong>
          <span>
            {shortHash(
              record.magicBlockFlow.baseCommitSignature || record.magicBlockFlow.error,
              14
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="chain-notice idle">
      <Database size={17} />
      <div>
        <strong>Receipt is local until anchored</strong>
        <span>Use devnet anchoring when you want a public timestamp.</span>
      </div>
    </div>
  );
}

function FactList({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="fact-list">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReceiptCanvas({ record }: { record: BenchmarkRecord }) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const scale = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * scale;
    canvas.height = height * scale;
    context.scale(scale, scale);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#111318";
    context.fillRect(0, 0, width, height);
    const hashes = [
      record.receipt.payload.inputSetHash,
      record.receipt.payload.outputSetHash,
      record.receipt.payload.metricsHash,
      record.receipt.payload.runner.teeEvidenceHash,
      record.receipt.payload.model.commitment,
      record.receipt.digest
    ].filter((hash): hash is string => Boolean(hash));
    const points = hashes.map((hash, index) => {
      const seed = parseInt(hash.slice(0, 8), 16);
      return {
        x: 24 + ((seed % 1000) / 1000) * (width - 48),
        y: 22 + index * ((height - 44) / Math.max(hashes.length - 1, 1)),
        color:
          ["#c7ff3d", "#20a4a8", "#ff6b3d", "#f5b942", "#7868e6", "#ffffff"][
            index
          ]
      };
    });
    context.strokeStyle = "rgba(255,255,255,.24)";
    context.lineWidth = 1;
    for (let index = 0; index < points.length - 1; index += 1) {
      context.beginPath();
      context.moveTo(points[index].x, points[index].y);
      context.lineTo(points[index + 1].x, points[index + 1].y);
      context.stroke();
    }
    points.forEach((point, index) => {
      context.fillStyle = point.color;
      context.beginPath();
      context.arc(point.x, point.y, index === points.length - 1 ? 6 : 4, 0, Math.PI * 2);
      context.fill();
    });
  }, [record]);

  return <canvas className="receipt-canvas" ref={ref} />;
}

function EmptyState() {
  return (
    <div className="empty-state">
      <ShieldCheck size={28} />
      <span>No model run yet</span>
    </div>
  );
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`);
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `${url} failed`);
  }
  return body as T;
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `${url} failed`);
  }
  return payload as T;
}

async function fetchReceiptAudit(recordId: string): Promise<ReceiptAudit> {
  const response = await fetch(`${API_BASE_URL}/api/receipts/${recordId}/audit`);
  const body = await response.json();
  if (!response.ok || !body.audit) {
    throw new Error(body.error || "Audit failed");
  }
  return body.audit as ReceiptAudit;
}

function shortHash(value?: string, length = 12): string {
  if (!value) return "pending";
  if (value.length <= length * 2) return value;
  return `${value.slice(0, length)}...${value.slice(-length)}`;
}

function formatPercent(value?: number | null): string {
  if (value === undefined || value === null) return "pending";
  return `${Math.round(value * 1000) / 10}%`;
}

function formatMs(value?: number | null): string {
  if (value === undefined || value === null) return "pending";
  return `${Math.round(value)} ms`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function teeProofLabel(evidence?: TeeEvidenceSummary | null): string {
  if (!evidence) return "No evidence yet";
  if (evidence.hardwareModel) return evidence.hardwareModel.replace("GCP_", "");
  return evidence.attestationStatus;
}

function hardwareClaim(evidence?: TeeEvidenceSummary | null): string {
  if (!evidence) return "pending";
  const boot =
    evidence.secureBoot === true
      ? "secure boot on"
      : evidence.secureBoot === false
        ? "secure boot off"
        : "secure boot unknown";
  return `${evidence.hardwareModel || evidence.attestationStatus} / ${boot}`;
}

function modelArchitecture(model: ModelInfo | null): string {
  if (!model) return "loading";
  const layers = model.architecture.layers;
  const heads = model.architecture.heads;
  const width = model.architecture.d_model;
  return `${layers} layers / ${heads} heads / ${width} width`;
}

function verificationLabel(state: VerificationState): string {
  if (state === "valid") return "Signature valid";
  if (state === "invalid") return "Signature failed";
  if (state === "checking") return "Checking";
  return "No receipt";
}

function chainLabel(record: BenchmarkRecord | null): string {
  if (!record?.solanaCommitment) return "Not anchored";
  if (record.solanaCommitment.status === "confirmed") return "Anchored";
  if (record.solanaCommitment.status === "dry-run") return "Dry run";
  return "Anchor failed";
}

function labelTone(label: Label): string {
  return label.toLowerCase();
}

function matchLabel(prediction: Prediction): string {
  if (prediction.correct === null) return "Not supplied";
  return prediction.correct ? "Matched" : `Expected ${prediction.expected}`;
}

function humanCaseName(id: string): string {
  const scenario = SCENARIOS.find((item) => item.id === id);
  if (scenario) return scenario.title;
  return id.replace(/[-_]/g, " ");
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
