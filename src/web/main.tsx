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
  KeyRound,
  Loader2,
  Lock,
  RefreshCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  WalletCards,
  XCircle
} from "lucide-react";
import "./styles.css";

type VerificationState = "unchecked" | "checking" | "valid" | "invalid";

interface ModelInfo {
  commitment: string;
  architecture: Record<string, unknown>;
  weights_path: string;
  weights_public: boolean;
  meta: Record<string, unknown>;
}

interface ReceiptPayload {
  schema: "private-gpt2-receipt/v1";
  runId: string;
  issuedAt: string;
  promptHash: string;
  outputHash: string;
  paramsHash: string;
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
  generation: {
    latencyMs: number;
    tokenCount: {
      prompt: number;
      generated: number;
    };
    params: {
      maxNewTokens: number;
      temperature: number;
      topP: number;
    };
  };
}

interface Receipt {
  payload: ReceiptPayload;
  signature: string;
  digest: string;
  algorithm: string;
}

interface GenerationRecord {
  kind: "generation";
  id: string;
  prompt: string;
  generation: {
    model: ModelInfo;
    promptHash: string;
    output: string;
    outputHash: string;
    latencyMs: number;
    tokenCount: {
      prompt: number;
      generated: number;
    };
    params: {
      maxNewTokens: number;
      temperature: number;
      topP: number;
    };
  };
  receipt: Receipt;
  solanaCommitment?: {
    status: "confirmed" | "dry-run" | "failed";
    payer: string;
    signature?: string;
    explorerUrl?: string;
    memoHash: string;
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

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const SAMPLE_PROMPTS = [
  "OpenAI wants to let the public test GPT-2, but the checkpoint has to stay private. Explain how a TEE receipt helps.",
  "Write a short product note for a private model evaluation marketplace on Solana.",
  "A user asks the private model to summarize confidential telemetry. Describe what the public should be able to verify.",
  "Explain the difference between keeping model weights private and proving a model output was signed by a trusted runner."
];

function App() {
  const [prompt, setPrompt] = React.useState(SAMPLE_PROMPTS[0]);
  const [maxNewTokens, setMaxNewTokens] = React.useState(80);
  const [temperature, setTemperature] = React.useState(0.75);
  const [topP, setTopP] = React.useState(0.92);
  const [model, setModel] = React.useState<ModelInfo | null>(null);
  const [records, setRecords] = React.useState<GenerationRecord[]>([]);
  const [activeRecord, setActiveRecord] = React.useState<GenerationRecord | null>(null);
  const [solana, setSolana] = React.useState<SolanaStatus | null>(null);
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

    async function verifyAndAudit(record: GenerationRecord) {
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
      const [modelBody, receiptsBody, solanaBody, teeBody] = await Promise.all([
        apiGet<{ model: ModelInfo }>("/api/llm").catch(() => null),
        apiGet<{ records: GenerationRecord[] }>("/api/receipts"),
        apiGet<{ solana: SolanaStatus }>("/api/solana/status").catch(() => null),
        apiGet<{ summary: TeeEvidenceSummary }>("/api/tee/evidence").catch(() => null)
      ]);
      setModel(modelBody?.model || null);
      setRecords(receiptsBody.records);
      setActiveRecord((current) => current || receiptsBody.records[0] || null);
      setSolana(solanaBody?.solana || null);
      setTeeEvidence(teeBody?.summary || null);
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runGeneration() {
    setBusy("Running GPT-2");
    setError(null);
    try {
      const body = await apiPost<{ record: GenerationRecord }>("/api/generate", {
        prompt,
        maxNewTokens,
        temperature,
        topP
      });
      setActiveRecord(body.record);
      setModel(body.record.generation.model);
      setRecords((current) => [
        body.record,
        ...current.filter((record) => record.id !== body.record.id)
      ]);
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
        record: GenerationRecord;
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

  const activeTeeEvidence = activeRecord?.receipt.payload.runner.teeEvidence || teeEvidence;
  const activeModel = activeRecord?.generation.model || model;
  const proofItems = [
    {
      label: "Model",
      value: activeModel?.weights_public ? "Weights exposed" : "Weights hidden",
      detail: shortHash(activeModel?.commitment),
      icon: <Lock size={18} />,
      tone: activeModel?.weights_public ? "warn" : "good"
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
              <strong>Private GPT-2 Verifier</strong>
              <span>TEE-backed generation with Solana devnet receipts</span>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={refreshAll} disabled={!!busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
            <span>{busy || "Refresh"}</span>
          </button>
        </div>

        <div className="hero-grid">
          <section className="experiment-panel" aria-labelledby="experiment-title">
            <p className="eyebrow">Public demo</p>
            <h1 id="experiment-title">Try GPT-2 without seeing its weights.</h1>
            <p className="lead">
              Imagine OpenAI wanted the public to test GPT-2 while keeping the
              checkpoint private. Type a prompt, get a model response, then verify
              a signed receipt that binds the prompt hash, output hash, private
              model commitment, TEE evidence, and optional Solana timestamp.
            </p>

            <div className="how-strip" aria-label="Demo flow">
              <div>
                <span>1</span>
                <strong>Send a prompt</strong>
                <p>The browser sends text to the private runner, not weights.</p>
              </div>
              <div>
                <span>2</span>
                <strong>Read GPT-2 output</strong>
                <p>The API returns generated text plus hashes of the run.</p>
              </div>
              <div>
                <span>3</span>
                <strong>Verify the receipt</strong>
                <p>The receipt can be audited and timestamped on devnet.</p>
              </div>
            </div>

            <div className="preset-prompts" aria-label="Sample prompts">
              {SAMPLE_PROMPTS.map((sample, index) => (
                <button
                  type="button"
                  key={sample}
                  onClick={() => setPrompt(sample)}
                  className={prompt === sample ? "active" : ""}
                >
                  Prompt {index + 1}
                </button>
              ))}
            </div>

            <label className="prompt-box">
              <span>Prompt to private GPT-2</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>

            <div className="control-grid">
              <label className="range-field">
                <span>New tokens</span>
                <strong>{maxNewTokens}</strong>
                <input
                  type="range"
                  min={16}
                  max={180}
                  step={4}
                  value={maxNewTokens}
                  onChange={(event) => setMaxNewTokens(Number(event.target.value))}
                />
              </label>
              <label className="range-field">
                <span>Temperature</span>
                <strong>{temperature.toFixed(2)}</strong>
                <input
                  type="range"
                  min={0.1}
                  max={1.5}
                  step={0.05}
                  value={temperature}
                  onChange={(event) => setTemperature(Number(event.target.value))}
                />
              </label>
              <label className="range-field">
                <span>Top-p</span>
                <strong>{topP.toFixed(2)}</strong>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={topP}
                  onChange={(event) => setTopP(Number(event.target.value))}
                />
              </label>
            </div>

            <div className="run-row">
              <button
                className="primary-button"
                type="button"
                onClick={runGeneration}
                disabled={!!busy || prompt.trim().length < 1}
              >
                <Send size={18} />
                <span>Generate with GPT-2</span>
              </button>
            </div>
          </section>

          <ResultSummary record={activeRecord} verification={verification} busy={busy} />
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
              <h2>Generated text</h2>
            </div>
            {activeRecord && (
              <span className="pill">
                {activeRecord.generation.tokenCount.generated} tokens
              </span>
            )}
          </div>
          {activeRecord ? <OutputPanel record={activeRecord} /> : <EmptyState />}
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
            <h3>Private model</h3>
            <FactList
              items={[
                ["Weights", activeModel?.weights_public ? "public" : "private"],
                ["Model", String(activeModel?.architecture.model_id || "gpt2")],
                ["Commitment", activeModel?.commitment || "pending"],
                ["Architecture", modelArchitecture(activeModel)]
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
            <h3>Solana devnet</h3>
            <FactList
              items={[
                ["Base RPC", solana?.rpcUrl || "devnet"],
                ["Payer", solana?.payer || "pending"],
                ["Balance", solana ? `${solana.balanceSol.toFixed(4)} SOL` : "pending"],
                ["Latest anchor", activeRecord?.solanaCommitment?.memoHash || "local only"]
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
                    ["Schema", activeRecord.receipt.payload.schema],
                    ["Prompt", activeRecord.receipt.payload.promptHash],
                    ["Output", activeRecord.receipt.payload.outputHash],
                    ["Params", activeRecord.receipt.payload.paramsHash],
                    ["TEE key", activeRecord.receipt.payload.runner.publicKeyFingerprint],
                    ["Signature", activeRecord.receipt.signature]
                  ]}
                />
              </>
            ) : (
              <p className="muted-copy">Run GPT-2 to create a receipt.</p>
            )}
          </section>
        </div>
      </details>

      <section className="context-strip">
        <SlidersHorizontal size={18} />
        <p>
          This demo uses a TEE-style trust model, not ZK. The model checkpoint is
          kept off the public frontend, and each output gets a signed receipt
          that can be verified and optionally timestamped on Solana devnet.
        </p>
      </section>
    </main>
  );
}

function ResultSummary({
  record,
  verification,
  busy
}: {
  record: GenerationRecord | null;
  verification: VerificationState;
  busy: string | null;
}) {
  if (!record) {
    return (
      <aside className="result-panel waiting">
        <div className="result-icon">
          {busy ? <Loader2 className="spin" size={24} /> : <ShieldCheck size={24} />}
        </div>
        <span className="section-kicker">Current result</span>
        <h2>{busy || "Ready for GPT-2"}</h2>
        <p>
          No public weights are loaded in the browser. A run returns generated
          text, hashes, TEE evidence, and a signed receipt.
        </p>
      </aside>
    );
  }

  return (
    <aside className="result-panel generate">
      <div className="result-top">
        <span className="section-kicker">Current result</span>
        <VerificationBadge state={verification} />
      </div>
      <div className="verdict text-result">
        <span>GPT-2 continuation</span>
        <strong>{record.generation.tokenCount.generated} tokens</strong>
      </div>
      <p>{previewText(record.generation.output)}</p>
      <div className="score-grid">
        <div>
          <span>Latency</span>
          <strong>{formatMs(record.generation.latencyMs)}</strong>
        </div>
        <div>
          <span>Prompt hash</span>
          <strong>{shortHash(record.generation.promptHash, 7)}</strong>
        </div>
        <div>
          <span>Temperature</span>
          <strong>{record.generation.params.temperature.toFixed(2)}</strong>
        </div>
        <div>
          <span>Top-p</span>
          <strong>{record.generation.params.topP.toFixed(2)}</strong>
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

function OutputPanel({ record }: { record: GenerationRecord }) {
  return (
    <div className="generated-output">
      <div className="prompt-echo">
        <span>Prompt hash</span>
        <strong>{shortHash(record.generation.promptHash, 16)}</strong>
      </div>
      <article>
        <p>{record.generation.output}</p>
      </article>
      <div className="model-stats">
        <span>{formatMs(record.generation.latencyMs)}</span>
        <span>{record.generation.tokenCount.prompt} prompt tokens</span>
        <span>{record.generation.tokenCount.generated} generated tokens</span>
        <span>{shortHash(record.generation.outputHash, 12)}</span>
      </div>
    </div>
  );
}

function ChainNotice({ record }: { record: GenerationRecord }) {
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

function ReceiptCanvas({ record }: { record: GenerationRecord }) {
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
      record.receipt.payload.promptHash,
      record.receipt.payload.outputHash,
      record.receipt.payload.paramsHash,
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

function previewText(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 280 ? `${trimmed.slice(0, 280)}...` : trimmed;
}

function formatMs(value?: number): string {
  if (value === undefined || Number.isNaN(value)) return "n/a";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function verificationLabel(state: VerificationState): string {
  if (state === "valid") return "Signature valid";
  if (state === "invalid") return "Check failed";
  if (state === "checking") return "Checking";
  return "Unchecked";
}

function teeProofLabel(evidence?: TeeEvidenceSummary | null): string {
  if (!evidence) return "No evidence";
  if (evidence.hardwareModel) return evidence.hardwareModel;
  if (evidence.attestationStatus === "unavailable") return "Local simulation";
  return evidence.attestationStatus;
}

function chainLabel(record?: GenerationRecord | null): string {
  if (!record?.solanaCommitment) return "Local only";
  if (record.solanaCommitment.status === "confirmed") return "Anchored";
  if (record.solanaCommitment.status === "dry-run") return "Dry run";
  return "Failed";
}

function hardwareClaim(evidence?: TeeEvidenceSummary | null): string {
  if (!evidence) return "pending";
  if (evidence.hardwareModel) {
    return `${evidence.hardwareModel}${evidence.secureBoot ? " secure boot" : ""}`;
  }
  return evidence.attestationStatus === "unavailable"
    ? "local simulation"
    : evidence.attestationStatus;
}

function modelArchitecture(model?: ModelInfo | null): string {
  if (!model) return "pending";
  const arch = model.architecture;
  const family = String(arch.family || "model");
  if (arch.n_layer && arch.n_head && arch.n_embd) {
    return `${family}; ${arch.n_layer} layers; ${arch.n_head} heads; ${arch.n_embd} hidden`;
  }
  return family;
}

function toError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
