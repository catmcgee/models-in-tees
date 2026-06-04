import React from "react";
import ReactDOM from "react-dom/client";
import {
  AlertTriangle,
  Anchor,
  ArrowUpRight,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Loader2,
  Lock,
  RefreshCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
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

function App() {
  const [prompt, setPrompt] = React.useState("");
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
  const [samplingOpen, setSamplingOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
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
        apiGet<{ records: GenerationRecord[] }>("/api/receipts").catch(
          () => ({ records: [] as GenerationRecord[] })
        ),
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

  function refresh() {
    setActiveRecord(null);
    setPrompt("");
    refreshAll();
  }

  function send() {
    if (busy || prompt.trim().length < 1) return;
    runGeneration();
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
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

  const running = busy === "Running GPT-2";
  const activeTeeEvidence = activeRecord?.receipt.payload.runner.teeEvidence || teeEvidence;
  const activeModel = activeRecord?.generation.model || model;
  const commitment = activeModel?.commitment;
  const chain = activeRecord?.solanaCommitment;
  const anchored = chain?.status === "confirmed" || chain?.status === "dry-run";

  const statusItems = [
    {
      k: "Model",
      v: activeModel?.weights_public ? "Weights exposed" : "Weights hidden",
      h: commitment ? shortHash(commitment) : "private",
      icon: <Lock />,
      state: activeModel?.weights_public ? "bad" : "neutral"
    },
    {
      k: "Receipt",
      v: verificationLabel(verification),
      h: activeRecord ? shortHash(activeRecord.receipt.digest) : "pending",
      icon: <BadgeCheck />,
      state:
        verification === "valid"
          ? "ok"
          : verification === "invalid"
            ? "bad"
            : verification === "checking"
              ? "neutral"
              : "pending"
    },
    {
      k: "TEE",
      v: teeProofLabel(activeTeeEvidence),
      h: activeTeeEvidence?.source || "waiting for evidence",
      icon: <Cpu />,
      state: activeTeeEvidence ? "ok" : "neutral"
    },
    {
      k: "Devnet",
      v: chainLabel(activeRecord),
      h: solana?.payer ? `payer ${shortHash(solana.payer, 8)}` : "not connected",
      icon: <Anchor />,
      state: chain?.status === "failed" ? "bad" : anchored ? "ok" : "neutral"
    }
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <SealedCube />
          </div>
          <div>
            <div className="brand-title">Private GPT-2 Verifier</div>
            <div className="brand-sub">TEE-backed generation with Solana devnet receipts</div>
          </div>
        </div>
        <button className="btn-ghost" type="button" onClick={refresh} disabled={!!busy}>
          {busy ? <Loader2 className="spin" /> : <RefreshCcw />}
          <span>{busy || "Refresh"}</span>
        </button>
      </header>

      {/* hero / composer */}
      <section className="panel hero-wide">
        <span className="eyebrow">Private chat demo</span>
        <h1 className="headline">
          Chat with GPT-2 without seeing its <span className="accentword">weights.</span>
        </h1>
        <p className="lede">
          Imagine OpenAI wanted the public to test GPT-2 while keeping the
          checkpoint private. Each answer comes back with a signed receipt binding
          the prompt hash, output hash, model commitment, TEE evidence, and optional
          Solana timestamp.
        </p>

        <div className="composer">
          <label className="composer-label" htmlFor="chat-prompt">
            Message to private GPT-2
          </label>
          <div className="composer-row">
            <textarea
              id="chat-prompt"
              className="chat-input"
              placeholder="Ask GPT-2 something…"
              value={prompt}
              spellCheck={false}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <button
              className="send-btn"
              type="button"
              onClick={send}
              disabled={!!busy || prompt.trim().length < 1}
            >
              {running ? <Loader2 className="spin" /> : <Send />}
              <span>{running ? "Running…" : "Send"}</span>
            </button>
          </div>

          <div className="sampling" data-open={samplingOpen}>
            <button
              className="sampling-toggle"
              type="button"
              onClick={() => setSamplingOpen((value) => !value)}
            >
              <SlidersHorizontal /> Sampling controls
              <ChevronDown className="caret" />
            </button>
            <div className="sampling-body">
              <Slider
                label="Temperature"
                value={temperature}
                min={0.1}
                max={1.5}
                step={0.05}
                fmt={(value) => value.toFixed(2)}
                onChange={setTemperature}
              />
              <Slider
                label="Top-p"
                value={topP}
                min={0.1}
                max={1}
                step={0.05}
                fmt={(value) => value.toFixed(2)}
                onChange={setTopP}
              />
              <Slider
                label="Max tokens"
                value={maxNewTokens}
                min={16}
                max={180}
                step={4}
                fmt={(value) => String(value)}
                onChange={setMaxNewTokens}
              />
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="error-strip" role="alert">
          <AlertTriangle />
          <span>{error}</span>
        </div>
      )}

      {/* status strip */}
      <section className="status-strip">
        {statusItems.map((item) => (
          <StatusTile key={item.k} {...item} />
        ))}
      </section>

      {/* output + proof */}
      <section className="lower-grid">
        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Model output</span>
              <div className="panel-title">Generated text</div>
            </div>
            {activeRecord && (
              <span className="pill-count">
                {activeRecord.generation.tokenCount.generated} tokens ·{" "}
                {formatMs(activeRecord.generation.latencyMs)}
              </span>
            )}
          </div>
          {running ? (
            <div className="empty">
              <span className="running-line">
                <Loader2 className="spin" /> Generating inside the TEE…
              </span>
            </div>
          ) : activeRecord ? (
            <div>
              <div className="gen-prompt">▸ {activeRecord.prompt}</div>
              <div className="gen-text">{activeRecord.generation.output}</div>
            </div>
          ) : (
            <EmptyState />
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Proof</span>
              <div className="panel-title">What the receipt says</div>
            </div>
            <VerificationBadge state={verification} />
          </div>
          {activeRecord ? (
            <div>
              <div className="kv">
                <div className="kv-row">
                  <div className="kv-k">Run ID</div>
                  <div className="kv-v">{activeRecord.id}</div>
                </div>
                <div className="kv-row">
                  <div className="kv-k">Issued</div>
                  <div className="kv-v">{formatDate(activeRecord.createdAt)}</div>
                </div>
                <div className="kv-row">
                  <div className="kv-k">Prompt hash</div>
                  <div className="kv-v">{shortHash(activeRecord.generation.promptHash)}</div>
                </div>
                <div className="kv-row">
                  <div className="kv-k">Output hash</div>
                  <div className="kv-v">{shortHash(activeRecord.generation.outputHash)}</div>
                </div>
                <div className="kv-row">
                  <div className="kv-k">Model commitment</div>
                  <div className="kv-v">
                    {shortHash(activeRecord.receipt.payload.model.commitment)}
                  </div>
                </div>
              </div>
              <div className="receipt-actions">
                <label className="toggle" data-on={dryRunCommit}>
                  <input
                    type="checkbox"
                    checked={dryRunCommit}
                    onChange={(event) => setDryRunCommit(event.target.checked)}
                  />
                  <span className="track">
                    <span className="knob" />
                  </span>
                  Dry run
                </label>
                <button
                  className="btn btn-dark"
                  type="button"
                  onClick={commitActiveReceipt}
                  disabled={!!busy}
                >
                  <Anchor /> Anchor receipt
                </button>
              </div>
              {chain && <ChainNotice record={activeRecord} />}
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
      </section>

      {/* evidence drawer */}
      <section className="drawer" data-open={drawerOpen}>
        <button
          className="drawer-toggle"
          type="button"
          onClick={() => setDrawerOpen((value) => !value)}
        >
          <div>
            <div className="dt-title">Evidence drawer</div>
            <div className="dt-sub">
              Private model, TEE attestation, Solana devnet and receipt hashes
            </div>
          </div>
          <span className="drawer-caret">
            <ChevronDown />
          </span>
        </button>
        <div className="drawer-body">
          <div className="evidence-grid">
            <div>
              <div className="ev-col-title">Private model</div>
              <EvRow k="Weights" v={activeModel?.weights_public ? "public" : "private"} />
              <EvRow k="Model" v={String(activeModel?.architecture.model_id || "gpt2")} />
              <EvRow k="Commitment" v={activeModel?.commitment || "pending"} />
              <EvRow k="Architecture" v={modelArchitecture(activeModel)} />
            </div>
            <div>
              <div className="ev-col-title">TEE evidence</div>
              <EvRow k="Source" v={activeTeeEvidence?.source || "pending"} />
              <EvRow k="Hardware" v={hardwareClaim(activeTeeEvidence)} />
              <EvRow k="Evidence hash" v={activeTeeEvidence?.evidenceHash || "pending"} />
              <EvRow
                k="Workload hash"
                v={audit?.workloadHash || activeTeeEvidence?.workloadHash || "pending"}
              />
            </div>
            <div>
              <div className="ev-col-title">Solana devnet</div>
              <EvRow k="Base RPC" v={solana?.rpcUrl || "devnet"} />
              <EvRow k="Payer" v={solana?.payer || "pending"} />
              <EvRow
                k="Balance"
                v={solana ? `${solana.balanceSol.toFixed(4)} SOL` : "pending"}
              />
              <EvRow k="Latest anchor" v={chain?.memoHash ? shortHash(chain.memoHash) : "local only"} />
            </div>
            <div>
              <div className="ev-col-title">Receipt hashes</div>
              {activeRecord ? (
                <div>
                  <ReceiptChart record={activeRecord} />
                  <EvRow k="Prompt hash" v={activeRecord.receipt.payload.promptHash} />
                  <EvRow k="Output hash" v={activeRecord.receipt.payload.outputHash} />
                  <EvRow k="TEE key" v={activeRecord.receipt.payload.runner.publicKeyFingerprint} />
                  <EvRow k="Signature" v={activeRecord.receipt.signature} />
                </div>
              ) : (
                <div className="ev-v" style={{ marginTop: 2 }}>
                  Run GPT-2 to create a receipt.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="foot">
        checkpoint stays private · every answer is signed inside the TEE · optionally
        anchored on Solana devnet
      </div>
    </div>
  );
}

// Brand mark — "Sealed cube" (Logo Options #05): an isometric cube rendered as a
// sealed black box, depth via face opacity. Single-color so it inverts cleanly.
function SealedCube() {
  return (
    <svg viewBox="0 0 100 100" stroke="currentColor" strokeWidth={6} strokeLinejoin="round">
      <polygon points="50 16 82 35 50 54 18 35" fill="currentColor" fillOpacity={1} />
      <polygon points="18 35 50 54 50 88 18 69" fill="currentColor" fillOpacity={0.45} />
      <polygon points="82 35 50 54 50 88 82 69" fill="currentColor" fillOpacity={0.72} />
    </svg>
  );
}

function StatusTile({
  k,
  v,
  h,
  icon,
  state
}: {
  k: string;
  v: string;
  h: string;
  icon: React.ReactNode;
  state: string;
}) {
  return (
    <div className="status">
      <div className="status-ic" data-state={state}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="status-k">{k}</div>
        <div className="status-v">{v}</div>
        <div className="status-h">{h}</div>
      </div>
    </div>
  );
}

function VerificationBadge({ state }: { state: VerificationState }) {
  if (state === "valid") {
    return (
      <span className="badge badge-valid">
        <CheckCircle2 /> Signature valid
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
  if (state === "checking") {
    return (
      <span className="badge badge-pending">
        <Loader2 className="spin" /> Checking
      </span>
    );
  }
  return <span className="badge badge-pending">Unchecked</span>;
}

function ChainNotice({ record }: { record: GenerationRecord }) {
  const chain = record.solanaCommitment;
  if (!chain) return null;
  const failed = chain.status === "failed";
  return (
    <div className={`confirmed${failed ? " failed" : ""}`}>
      <span className="dot" />
      <div style={{ minWidth: 0 }}>
        <div className="confirmed-t">
          {chain.explorerUrl ? (
            <a href={chain.explorerUrl} target="_blank" rel="noreferrer">
              Solana {chain.status}
              <ArrowUpRight />
            </a>
          ) : (
            <span>Solana {chain.status}</span>
          )}
        </div>
        <div className="confirmed-h">{chain.error || shortHash(chain.memoHash, 14)}</div>
      </div>
    </div>
  );
}

function EvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="ev-row">
      <div className="ev-k">{k}</div>
      <div className="ev-v">{v}</div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="slider-field">
      <div className="slider-head">
        <span className="slider-k">{label}</span>
        <span className="slider-v">{fmt(value)}</span>
      </div>
      <input
        className="rng"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(parseFloat(event.target.value))}
      />
    </div>
  );
}

function ReceiptChart({ record }: { record: GenerationRecord }) {
  const hashes = [
    record.receipt.payload.promptHash,
    record.receipt.payload.outputHash,
    record.receipt.payload.paramsHash,
    record.receipt.payload.runner.teeEvidenceHash,
    record.receipt.payload.model.commitment,
    record.receipt.digest
  ].filter((hash): hash is string => Boolean(hash));

  const colors = [
    "var(--approve)",
    "var(--review)",
    "var(--insuff)",
    "white",
    "oklch(0.78 0.14 70)",
    "var(--block)"
  ];

  const points = hashes.map((hash, index) => {
    const seed = parseInt(hash.slice(0, 6), 16) || 0;
    return {
      x: 12 + ((seed % 1000) / 1000) * 80,
      y: 16 + (index * 48) / Math.max(hashes.length - 1, 1)
    };
  });
  const path = points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");

  return (
    <div className="ev-chart">
      <svg
        viewBox="0 0 100 80"
        style={{ width: "100%", height: "100%" }}
        preserveAspectRatio="none"
      >
        <path d={path} fill="none" stroke="oklch(1 0 0 / 0.18)" strokeWidth="0.8" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === points.length - 1 ? 3 : 2.4}
            fill={colors[i % colors.length]}
          />
        ))}
      </svg>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-ic">
        <ShieldCheck />
      </div>
      <div className="empty-t">No model run yet</div>
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
