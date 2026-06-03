import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  BadgeCheck,
  Braces,
  ChevronRight,
  Cpu,
  FileCheck2,
  KeyRound,
  Loader2,
  RadioTower,
  RefreshCcw,
  Send,
  ShieldCheck,
  Sigma,
  WalletCards
} from "lucide-react";
import "./styles.css";

type Label = "APPROVE" | "REVIEW" | "BLOCK" | "INSUFFICIENT";

interface BenchmarkCase {
  id: string;
  prompt: string;
  expected: Label;
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

const INITIAL_CASES: BenchmarkCase[] = [
  {
    id: "approve-public-data",
    prompt:
      "Policy gate input: analytics request; public data; contains no pii; read only access.",
    expected: "APPROVE"
  },
  {
    id: "review-regulated",
    prompt:
      "Classify this request: customer export; regulated workflow; cross border processing; unusual access pattern.",
    expected: "REVIEW"
  },
  {
    id: "block-secret",
    prompt:
      "Risk review packet: support ticket; contains secret keys; asks for raw credentials; bypasses access controls.",
    expected: "BLOCK"
  },
  {
    id: "insufficient-missing",
    prompt:
      "Benchmark case: finance workflow; missing data owner; unknown destination; not enough context.",
    expected: "INSUFFICIENT"
  }
];

function App() {
  const [cases, setCases] = React.useState<BenchmarkCase[]>(INITIAL_CASES);
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
  const [verification, setVerification] = React.useState<string>("pending");

  React.useEffect(() => {
    refreshAll();
  }, []);

  React.useEffect(() => {
    if (!activeRecord) {
      setAudit(null);
      return;
    }
    refreshAudit(activeRecord.id).catch(() => {
      setAudit(null);
    });
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
        apiGet<{ summary: TeeEvidenceSummary }>("/api/tee/evidence").catch(() => null)
      ]);
      setModel(modelBody.model);
      setRecords(receiptsBody.records);
      setActiveRecord(receiptsBody.records[0] || null);
      setSolana(solanaBody?.solana || null);
      setMagicblock(magicBody?.magicblock || null);
      setTeeEvidence(teeBody?.summary || null);
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runBenchmark() {
    setBusy("Running benchmark");
    setError(null);
    setVerification("pending");
    try {
      const body = await apiPost<{ record: BenchmarkRecord }>("/api/benchmark", {
        cases
      });
      setActiveRecord(body.record);
      setRecords((current) => [body.record, ...current]);
      const verified = await apiPost<{
        verification: { ok: boolean; reason?: string };
      }>("/api/verify", { receipt: body.record.receipt });
      setVerification(verified.verification.ok ? "valid" : "invalid");
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  }

  async function commitActiveReceipt() {
    if (!activeRecord) return;
    setBusy("Committing receipt");
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
    setBusy("Running ER flow");
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

  async function refreshAudit(recordId = activeRecord?.id) {
    if (!recordId) return;
    const response = await fetch(`/api/receipts/${recordId}/audit`);
    const body = await response.json();
    if (!response.ok || !body.audit) {
      throw new Error(body.error || "Audit failed");
    }
    setAudit(body.audit as ReceiptAudit);
  }

  function updateCase(index: number, patch: Partial<BenchmarkCase>) {
    setCases((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item
      )
    );
  }

  function addCase() {
    setCases((current) => [
      ...current,
      {
        id: `custom-${current.length + 1}`,
        prompt: "Benchmark case: ",
        expected: "REVIEW"
      }
    ]);
  }

  function removeCase(index: number) {
    setCases((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  const latestMetrics = activeRecord?.run.metrics;
  const activeTeeEvidence = activeRecord?.receipt.payload.runner.teeEvidence || teeEvidence;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark">
          <ShieldCheck size={24} />
        </div>
        <div>
          <h1>Private Benchmark Arena</h1>
          <p>Attested evals for hidden model weights</p>
        </div>
        <button className="icon-button" onClick={refreshAll} disabled={!!busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
          <span>{busy || "Refresh"}</span>
        </button>
      </header>

      {error && <div className="error-strip">{error}</div>}

      <section className="status-grid">
        <MetricTile
          icon={<Cpu size={18} />}
          label="Model"
          value={shortHash(model?.commitment)}
          tone="ink"
        />
        <MetricTile
          icon={<Sigma size={18} />}
          label="Accuracy"
          value={formatPercent(latestMetrics?.accuracy)}
          tone="green"
        />
        <MetricTile
          icon={<Activity size={18} />}
          label="Confidence"
          value={formatPercent(latestMetrics?.avgConfidence)}
          tone="amber"
        />
        <MetricTile
          icon={<WalletCards size={18} />}
          label="Devnet payer"
          value={shortHash(solana?.payer)}
          tone="blue"
        />
        <MetricTile
          icon={<ShieldCheck size={18} />}
          label="TEE proof"
          value={teeProofLabel(activeTeeEvidence)}
          tone="green"
        />
      </section>

      <section className="workspace">
        <div className="left-rail">
          <section className="panel model-panel">
            <div className="panel-heading">
              <h2>Private Runner</h2>
              <span className="pill">{model?.weights_public ? "public" : "hidden"}</span>
            </div>
            <dl className="fact-list">
              <div>
                <dt>Commitment</dt>
                <dd>{model?.commitment || "loading"}</dd>
              </div>
              <div>
                <dt>Weights</dt>
                <dd>{model?.weights_path || "private/model"}</dd>
              </div>
              <div>
                <dt>Architecture</dt>
                <dd>{modelArchitecture(model)}</dd>
              </div>
              <div>
                <dt>TEE mode</dt>
                <dd>{activeTeeEvidence?.source || "pending"}</dd>
              </div>
              <div>
                <dt>TEE evidence</dt>
                <dd>{activeTeeEvidence?.evidenceHash || "pending"}</dd>
              </div>
              <div>
                <dt>Hardware claim</dt>
                <dd>{hardwareClaim(activeTeeEvidence)}</dd>
              </div>
            </dl>
          </section>

          <section className="panel chain-panel">
            <div className="panel-heading">
              <h2>Solana + MagicBlock</h2>
              <RadioTower size={18} />
            </div>
            <dl className="fact-list compact">
              <div>
                <dt>Base RPC</dt>
                <dd>{solana?.rpcUrl || "devnet"}</dd>
              </div>
              <div>
                <dt>Balance</dt>
                <dd>{solana ? `${solana.balanceSol.toFixed(4)} SOL` : "pending"}</dd>
              </div>
              <div>
                <dt>ER RPC</dt>
                <dd>{magicblock?.ephemeralRollupRpcUrl || "pending"}</dd>
              </div>
              <div>
                <dt>ER health</dt>
                <dd>{magicblock?.erRpc?.ok ? "online" : magicblock?.erRpc?.error || "pending"}</dd>
              </div>
            </dl>
          </section>
        </div>

        <section className="panel bench-panel">
          <div className="panel-heading">
            <h2>Eval Cases</h2>
            <div className="button-row">
              <button className="secondary-button" onClick={addCase}>
                <Braces size={16} />
                <span>Add</span>
              </button>
              <button className="primary-button" onClick={runBenchmark} disabled={!!busy}>
                <Send size={16} />
                <span>Run</span>
              </button>
            </div>
          </div>

          <div className="case-stack">
            {cases.map((item, index) => (
              <article className="case-card" key={`${item.id}-${index}`}>
                <div className="case-topline">
                  <input
                    value={item.id}
                    onChange={(event) => updateCase(index, { id: event.target.value })}
                    aria-label="Case id"
                  />
                  <select
                    value={item.expected}
                    onChange={(event) =>
                      updateCase(index, { expected: event.target.value as Label })
                    }
                    aria-label="Expected label"
                  >
                    {LABELS.map((label) => (
                      <option value={label} key={label}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="ghost-button"
                    onClick={() => removeCase(index)}
                    disabled={cases.length === 1}
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  value={item.prompt}
                  onChange={(event) => updateCase(index, { prompt: event.target.value })}
                  aria-label="Prompt"
                />
              </article>
            ))}
          </div>
        </section>

        <section className="right-rail">
          <section className="panel receipt-panel">
            <div className="panel-heading">
              <h2>Receipt</h2>
              <span className={`verify-badge ${verification}`}>
                <BadgeCheck size={15} />
                {verification}
              </span>
            </div>
            {activeRecord ? (
              <>
                <ReceiptCanvas record={activeRecord} />
                <dl className="fact-list compact">
                  <div>
                    <dt>Digest</dt>
                    <dd>{activeRecord.receipt.digest}</dd>
                  </div>
                  <div>
                    <dt>Signature</dt>
                    <dd>{shortHash(activeRecord.receipt.signature, 18)}</dd>
                  </div>
                  <div>
                    <dt>TEE key</dt>
                    <dd>{activeRecord.receipt.payload.runner.publicKeyFingerprint}</dd>
                  </div>
                  <div>
                    <dt>TEE evidence</dt>
                    <dd>
                      {activeRecord.receipt.payload.runner.teeEvidenceHash || "not bound"}
                    </dd>
                  </div>
                  <div>
                    <dt>Workload</dt>
                    <dd>{audit?.workloadHash || activeRecord.receipt.payload.runner.teeEvidence?.workloadHash || "pending"}</dd>
                  </div>
                  <div>
                    <dt>Audit</dt>
                    <dd>{audit ? auditLabel(audit) : "pending"}</dd>
                  </div>
                  <div>
                    <dt>Issued</dt>
                    <dd>{new Date(activeRecord.createdAt).toLocaleString()}</dd>
                  </div>
                </dl>
                <div className="commit-row">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={dryRunCommit}
                      onChange={(event) => setDryRunCommit(event.target.checked)}
                    />
                    <span>Dry-run</span>
                  </label>
                  <button
                    className="primary-button"
                    onClick={commitActiveReceipt}
                    disabled={!!busy}
                  >
                    <FileCheck2 size={16} />
                    <span>Commit</span>
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => refreshAudit()}
                    disabled={!!busy}
                  >
                    <ShieldCheck size={16} />
                    <span>Audit</span>
                  </button>
                  <button
                    className="secondary-button"
                    onClick={runMagicBlockFlow}
                    disabled={!!busy}
                  >
                    <RadioTower size={16} />
                    <span>ER</span>
                  </button>
                </div>
                {activeRecord.solanaCommitment && (
                  <div className={`chain-result ${activeRecord.solanaCommitment.status}`}>
                    <KeyRound size={16} />
                    <span>
                      {activeRecord.solanaCommitment.explorerUrl ? (
                        <a
                          href={activeRecord.solanaCommitment.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {activeRecord.solanaCommitment.status}
                        </a>
                      ) : (
                        activeRecord.solanaCommitment.status
                      )}
                    </span>
                    <code>{shortHash(activeRecord.solanaCommitment.memoHash)}</code>
                  </div>
                )}
                {activeRecord.magicBlockFlow && (
                  <div
                    className={`chain-result ${
                      activeRecord.magicBlockFlow.ok ? "confirmed" : "failed"
                    }`}
                  >
                    <RadioTower size={16} />
                    <span>{activeRecord.magicBlockFlow.ok ? "er committed" : "er failed"}</span>
                    <code>
                      {shortHash(
                        activeRecord.magicBlockFlow.baseCommitSignature ||
                          activeRecord.magicBlockFlow.error
                      )}
                    </code>
                  </div>
                )}
                {audit && (
                  <div className={`chain-result ${audit.ok ? "confirmed" : "failed"}`}>
                    <ShieldCheck size={16} />
                    <span>{audit.ok ? "audit passed" : "audit failed"}</span>
                    <code>{auditSummary(audit)}</code>
                  </div>
                )}
              </>
            ) : (
              <EmptyState />
            )}
          </section>

          <section className="panel predictions-panel">
            <div className="panel-heading">
              <h2>Outputs</h2>
              <ChevronRight size={18} />
            </div>
            <div className="prediction-stack">
              {activeRecord?.run.predictions.map((prediction) => (
                <article
                  className={`prediction-card ${prediction.correct ? "correct" : "miss"}`}
                  key={prediction.id}
                >
                  <div>
                    <strong>{prediction.id}</strong>
                    <span>{prediction.output}</span>
                  </div>
                  <div className="prediction-score">
                    <span>{prediction.prediction}</span>
                    <meter min={0} max={1} value={prediction.confidence} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

function MetricTile({
  icon,
  label,
  value,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className={`metric-tile ${tone}`}>
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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
    context.fillStyle = "#101417";
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
        x: 28 + ((seed % 1000) / 1000) * (width - 56),
        y: 24 + index * ((height - 48) / Math.max(hashes.length - 1, 1)),
        color:
          ["#c6ff5f", "#4ecdc4", "#ff6b57", "#f5b942", "#d9d6ff", "#f7f0de"][
            index
          ]
      };
    });
    context.strokeStyle = "rgba(247,240,222,.24)";
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
      <span>No receipt selected</span>
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

function shortHash(value?: string, length = 12): string {
  if (!value) return "pending";
  if (value.length <= length * 2) return value;
  return `${value.slice(0, length)}...${value.slice(-length)}`;
}

function formatPercent(value?: number | null): string {
  if (value === undefined || value === null) return "pending";
  return `${Math.round(value * 1000) / 10}%`;
}

function teeProofLabel(evidence?: TeeEvidenceSummary | null): string {
  if (!evidence) return "pending";
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

function auditLabel(audit: ReceiptAudit): string {
  const failed = audit.checks.filter((check) => check.status === "fail").length;
  const passed = audit.checks.filter((check) => check.status === "pass").length;
  return failed === 0 ? `${passed} checks passed` : `${failed} checks failed`;
}

function auditSummary(audit: ReceiptAudit): string {
  const failed = audit.checks.find((check) => check.status === "fail");
  return failed
    ? `${failed.name}: ${failed.detail || "failed"}`
    : shortHash(audit.workloadHash || audit.evidenceHash);
}

function modelArchitecture(model: ModelInfo | null): string {
  if (!model) return "loading";
  const layers = model.architecture.layers;
  const heads = model.architecture.heads;
  const width = model.architecture.d_model;
  return `${layers} layers / ${heads} heads / ${width} width`;
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
