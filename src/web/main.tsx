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
type LabMode = "chat" | "lens" | "patch";

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

interface InterpretabilityReceiptPayload {
  schema: "private-gpt2-interpretability-receipt/v1";
  runId: string;
  issuedAt: string;
  promptHash: string;
  corruptedPromptHash?: string | null;
  resultHash: string;
  targetToken: {
    token: string;
    tokenId: number;
    source: "user" | "clean-final-argmax";
  };
  runner: ReceiptPayload["runner"];
  model: {
    commitment: string;
  };
}

interface InterpretabilityReceipt {
  payload: InterpretabilityReceiptPayload;
  signature: string;
  digest: string;
  algorithm: string;
}

type SignedAnyReceipt = Receipt | InterpretabilityReceipt;

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

interface HealthStatus {
  service: string;
  teeMode: string;
  network: string;
}

interface LensToken {
  rank: number;
  token: string;
  tokenId: number;
  probability: number;
}

interface LensLayer {
  layer: number;
  label: string;
  topTokens: LensToken[];
  target: {
    rank: number;
    probability: number;
    logit: number;
  };
}

interface AttentionLayerSummary {
  layer: number;
  meanEntropy: number;
  focusedHeads: Array<{
    head: number;
    focusPosition: number;
    focusToken: string;
    maxAttention: number;
    entropy: number;
  }>;
}

interface PatchLayerScore {
  layer: number;
  targetLogProb: number;
  recovery: number;
  clippedRecovery: number;
}

interface InterpretabilityResult {
  model: ModelInfo;
  promptHash: string;
  corruptedPromptHash?: string | null;
  target: {
    token: string;
    tokenId: number;
    source: "user" | "clean-final-argmax";
    cleanLogProb: number;
  };
  lens: {
    topK: number;
    position: number;
    layers: LensLayer[];
  };
  attention: {
    available: boolean;
    position?: number;
    tokenCount?: number;
    layers: AttentionLayerSummary[];
  };
  patching?: {
    available: boolean;
    cleanLogProb: number;
    corruptedLogProb: number;
    layers: PatchLayerScore[];
  } | null;
  params: {
    topK: number;
    maxPromptTokens: number;
    rawActivationsReturned: false;
    rawAttentionReturned: false;
    weightsReturned: false;
  };
  redaction: {
    exposes: string[];
    withholds: string[];
  };
  latencyMs: number;
  resultHash: string;
}

interface InterpretabilityRecord {
  kind: "interpretability";
  id: string;
  prompt: string;
  corruptedPrompt?: string;
  targetToken?: string;
  result: InterpretabilityResult;
  receipt: SignedAnyReceipt;
  solanaCommitment?: GenerationRecord["solanaCommitment"];
  createdAt: string;
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function App() {
  const [prompt, setPrompt] = React.useState("");
  const [labMode, setLabMode] = React.useState<LabMode>("chat");
  const [corruptedPrompt, setCorruptedPrompt] = React.useState("");
  const [targetToken, setTargetToken] = React.useState("");
  const [maxNewTokens, setMaxNewTokens] = React.useState(80);
  const [temperature, setTemperature] = React.useState(0.75);
  const [topP, setTopP] = React.useState(0.92);
  const [interpTopK, setInterpTopK] = React.useState(5);
  const [model, setModel] = React.useState<ModelInfo | null>(null);
  const [records, setRecords] = React.useState<GenerationRecord[]>([]);
  const [activeRecord, setActiveRecord] = React.useState<GenerationRecord | null>(null);
  const [health, setHealth] = React.useState<HealthStatus | null>(null);
  const [interpRecord, setInterpRecord] = React.useState<InterpretabilityRecord | null>(null);
  const [interpVerification, setInterpVerification] =
    React.useState<VerificationState>("unchecked");
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

  React.useEffect(() => {
    let cancelled = false;

    async function verifyInterpretability(record: InterpretabilityRecord) {
      setInterpVerification("checking");
      try {
        const verified = await apiPost<{
          verification: { ok: boolean; reason?: string };
        }>("/api/verify", { receipt: record.receipt });
        if (!cancelled) {
          setInterpVerification(verified.verification.ok ? "valid" : "invalid");
        }
      } catch {
        if (!cancelled) setInterpVerification("invalid");
      }
    }

    if (!interpRecord) {
      setInterpVerification("unchecked");
      return () => {
        cancelled = true;
      };
    }

    verifyInterpretability(interpRecord);
    return () => {
      cancelled = true;
    };
  }, [interpRecord?.id]);

  async function refreshAll() {
    setBusy("Refreshing");
    setError(null);
    try {
      const [healthBody, modelBody, receiptsBody, solanaBody, teeBody] = await Promise.all([
        apiGet<HealthStatus & { ok: true }>("/api/health").catch(() => null),
        apiGet<{ model: ModelInfo }>("/api/llm").catch(() => null),
        apiGet<{ records: GenerationRecord[] }>("/api/receipts").catch(
          () => ({ records: [] as GenerationRecord[] })
        ),
        apiGet<{ solana: SolanaStatus }>("/api/solana/status").catch(() => null),
        apiGet<{ summary: TeeEvidenceSummary }>("/api/tee/evidence").catch(() => null)
      ]);
      setHealth(healthBody || null);
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
    setInterpRecord(null);
    setPrompt("");
    setCorruptedPrompt("");
    setTargetToken("");
    refreshAll();
  }

  function send() {
    if (busy || prompt.trim().length < 1) return;
    if (labMode === "chat") {
      runGeneration();
      return;
    }
    if (labMode === "patch" && corruptedPrompt.trim().length < 1) {
      setError("Patch mode needs a corrupted prompt to compare against the clean prompt.");
      return;
    }
    runInterpretability();
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

  async function runInterpretability() {
    setBusy("Running interpretability");
    setError(null);
    try {
      const body = await apiPost<{ record: InterpretabilityRecord }>("/api/interpret", {
        prompt,
        corruptedPrompt:
          labMode === "patch" && corruptedPrompt.trim()
            ? corruptedPrompt.trim()
            : undefined,
        targetToken: targetToken.trim().length ? targetToken : undefined,
        topK: interpTopK,
        maxPromptTokens: 128
      });
      setInterpRecord(body.record);
      setModel(body.record.result.model);
      setDrawerOpen(true);
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
  const interpreting = busy === "Running interpretability";
  const activeReceipt =
    labMode === "chat" ? activeRecord?.receipt : interpRecord?.receipt || activeRecord?.receipt;
  const receiptVerification =
    labMode === "chat" ? verification : interpRecord ? interpVerification : verification;
  const activeTeeEvidence = activeReceipt?.payload.runner.teeEvidence || teeEvidence;
  const activeModel =
    labMode === "chat"
      ? activeRecord?.generation.model || model
      : interpRecord?.result.model || activeRecord?.generation.model || model;
  const commitment = activeModel?.commitment;
  const chain = labMode === "chat" ? activeRecord?.solanaCommitment : interpRecord?.solanaCommitment;
  const anchored = chain?.status === "confirmed" || chain?.status === "dry-run";
  const modelName = modelDisplayName(activeModel);
  const privateModelName = activeModel ? `private ${modelName}` : "private model";
  const checkpointName = activeModel ? `${modelName} checkpoint` : "model checkpoint";
  const networkName = networkDisplayName(health?.network, solana?.rpcUrl);
  const teeName = teeRuntimeName(activeTeeEvidence, health);
  const serviceName = activeModel ? `Private ${modelName} Verifier` : "Private Model Verifier";
  const proofSurface =
    labMode === "chat"
      ? `${teeName} generation with ${networkName} receipts`
      : `${teeName} interpretability with signed receipts`;
  const actionLabel =
    labMode === "chat"
      ? running
        ? "Running…"
        : "Send"
      : interpreting
        ? "Interpreting…"
        : labMode === "lens"
          ? "Run lens"
          : "Run patch";

  const statusItems = [
    {
      k: "Model",
      v: activeModel
        ? activeModel.weights_public
          ? "Weights exposed"
          : "Weights hidden"
        : "Loading model",
      h: commitment ? shortHash(commitment) : "waiting for /api/llm",
      icon: <Lock />,
      state: activeModel ? (activeModel.weights_public ? "bad" : "neutral") : "pending"
    },
    {
      k: "Receipt",
      v: verificationLabel(receiptVerification),
      h: activeReceipt ? shortHash(activeReceipt.digest) : "pending",
      icon: <BadgeCheck />,
      state:
        receiptVerification === "valid"
          ? "ok"
          : receiptVerification === "invalid"
            ? "bad"
            : receiptVerification === "checking"
              ? "neutral"
              : "pending"
    },
    {
      k: "TEE",
      v: activeTeeEvidence ? teeProofLabel(activeTeeEvidence) : teeName,
      h: activeTeeEvidence?.source || health?.teeMode || "waiting for /api/tee/evidence",
      icon: <Cpu />,
      state: activeTeeEvidence ? "ok" : health ? "neutral" : "pending"
    },
    {
      k: "Chain",
      v: activeReceipt ? chainStateLabel(chain) : networkName,
      h: solana?.payer
        ? `payer ${shortHash(solana.payer, 8)}`
        : health?.network
          ? "waiting for /api/solana/status"
          : "waiting for /api/health",
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
            <div className="brand-title">{serviceName}</div>
            <div className="brand-sub">{proofSurface}</div>
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
          Chat with {modelName} without seeing its <span className="accentword">weights.</span>
        </h1>
        <p className="lede">
          This public UI sends prompts to a {privateModelName} runner while the{" "}
          {checkpointName} stays off the frontend. Each answer comes back with a
          signed receipt binding the prompt hash, output hash, model commitment,{" "}
          {teeName} evidence, and optional {networkName} timestamp.
        </p>

        <div className="composer">
          <div className="mode-tabs" role="tablist" aria-label="Lab mode">
            {(["chat", "lens", "patch"] as LabMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className="mode-tab"
                data-active={labMode === mode}
                onClick={() => setLabMode(mode)}
              >
                {mode === "chat" ? "Chat" : mode === "lens" ? "Lens" : "Patch"}
              </button>
            ))}
          </div>

          <label className="composer-label" htmlFor="chat-prompt">
            {labMode === "chat" ? "Message to" : "Clean prompt for"} {privateModelName}
          </label>
          <div className="composer-row">
            <textarea
              id="chat-prompt"
              className="chat-input"
              placeholder={`Ask ${modelName} something…`}
              value={prompt}
              spellCheck={false}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <button
              className="send-btn"
              type="button"
              onClick={send}
              disabled={
                !!busy ||
                prompt.trim().length < 1 ||
                (labMode === "patch" && corruptedPrompt.trim().length < 1)
              }
            >
              {running || interpreting ? <Loader2 className="spin" /> : <Send />}
              <span>{actionLabel}</span>
            </button>
          </div>

          {labMode !== "chat" && (
            <div className="interp-input-grid">
              <label>
                <span>Target token</span>
                <input
                  value={targetToken}
                  onChange={(event) => setTargetToken(event.target.value)}
                  placeholder="Optional; defaults to final prediction"
                />
              </label>
              <label>
                <span>Top-k tokens</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={interpTopK}
                  onChange={(event) =>
                    setInterpTopK(Math.max(1, Math.min(5, Number(event.target.value) || 5)))
                  }
                />
              </label>
              {labMode === "patch" && (
                <label>
                  <span>Corrupted prompt</span>
                  <textarea
                    value={corruptedPrompt}
                    onChange={(event) => setCorruptedPrompt(event.target.value)}
                    placeholder="A contrast prompt for activation patching"
                  />
                </label>
              )}
            </div>
          )}

          {labMode === "chat" && (
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
          )}
        </div>

        {labMode !== "chat" && (
          <InterpretabilityPanel
            mode={labMode}
            record={interpRecord}
            verification={interpVerification}
            busy={interpreting}
            modelName={modelName}
          />
        )}
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
                <Loader2 className="spin" /> Generating inside {teeName}…
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
              {privateModelName}, {teeName} attestation, {networkName}, and receipt hashes
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
              <EvRow
                k="Weights"
                v={activeModel ? (activeModel.weights_public ? "public" : "private") : "pending"}
              />
              <EvRow k="Model" v={activeModel ? modelName : "pending"} />
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
              <div className="ev-col-title">{networkName}</div>
              <EvRow k="Base RPC" v={solana?.rpcUrl || health?.network || "pending"} />
              <EvRow k="Payer" v={solana?.payer || "pending"} />
              <EvRow
                k="Balance"
                v={solana ? `${solana.balanceSol.toFixed(4)} SOL` : "pending"}
              />
              <EvRow
                k="Latest anchor"
                v={chain?.memoHash ? shortHash(chain.memoHash) : activeReceipt ? "not anchored" : "no receipt"}
              />
            </div>
            <div>
              <div className="ev-col-title">Receipt hashes</div>
              {activeReceipt ? (
                <div>
                  <ReceiptChart receipt={activeReceipt} />
                  <EvRow k="Prompt hash" v={activeReceipt.payload.promptHash} />
                  {isGenerationSignedReceipt(activeReceipt) ? (
                    <>
                      <EvRow k="Output hash" v={activeReceipt.payload.outputHash} />
                      <EvRow k="Params hash" v={activeReceipt.payload.paramsHash} />
                    </>
                  ) : (
                    <>
                      <EvRow k="Result hash" v={activeReceipt.payload.resultHash} />
                      <EvRow
                        k="Target token"
                        v={`${JSON.stringify(activeReceipt.payload.targetToken.token)} · ${activeReceipt.payload.targetToken.source}`}
                      />
                    </>
                  )}
                  <EvRow k="TEE key" v={activeReceipt.payload.runner.publicKeyFingerprint} />
                  <EvRow k="Signature" v={activeReceipt.signature} />
                </div>
              ) : (
                <div className="ev-v" style={{ marginTop: 2 }}>
                  Run {modelName} to create a receipt.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="foot">
        {checkpointName} stays private · every answer is signed inside {teeName} ·
        optionally anchored on {networkName}
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

function InterpretabilityPanel({
  mode,
  record,
  verification,
  busy,
  modelName
}: {
  mode: Exclude<LabMode, "chat">;
  record: InterpretabilityRecord | null;
  verification: VerificationState;
  busy: boolean;
  modelName: string;
}) {
  return (
    <div className="interp-panel">
      <div className="interp-head">
        <div>
          <span className="eyebrow">Private interpretability lab</span>
          <div className="panel-title">
            {mode === "lens" ? "Logit lens and attention summary" : "Activation patching summary"}
          </div>
        </div>
        {record && <VerificationBadge state={verification} />}
      </div>

      {busy ? (
        <div className="empty">
          <span className="running-line">
            <Loader2 className="spin" /> Computing redacted interpretability artifacts…
          </span>
        </div>
      ) : record ? (
        <>
          <div className="interp-meta">
            <EvRow k="Experiment receipt" v={shortHash(record.receipt.digest, 14)} />
            <EvRow k="Result hash" v={shortHash(record.result.resultHash, 14)} />
            <EvRow
              k="Target token"
              v={`${JSON.stringify(record.result.target.token)} · ${record.result.target.source}`}
            />
            <EvRow k="Latency" v={formatMs(record.result.latencyMs)} />
          </div>
          {mode === "lens" ? (
            <LensView result={record.result} />
          ) : (
            <PatchView result={record.result} />
          )}
          <RedactionPolicy result={record.result} modelName={modelName} />
        </>
      ) : (
        <div className="empty">
          <div className="empty-ic">
            <Cpu />
          </div>
          <div className="empty-t">
            Run {mode === "lens" ? "Lens" : "Patch"} to create signed, redacted
            interpretability artifacts.
          </div>
        </div>
      )}
    </div>
  );
}

function LensView({ result }: { result: InterpretabilityResult }) {
  const focusedHeads = result.attention.layers
    .flatMap((layer) =>
      layer.focusedHeads.map((head) => ({
        ...head,
        layer: layer.layer
      }))
    )
    .sort((a, b) => b.maxAttention - a.maxAttention)
    .slice(0, 6);

  return (
    <div className="lens-layout">
      <div className="lens-grid">
        {result.lens.layers.map((layer) => (
          <div className="lens-layer" key={layer.layer}>
            <div className="lens-layer-head">
              <span>{layer.label}</span>
              <strong>rank {layer.target.rank}</strong>
            </div>
            <div className="token-row">
              {layer.topTokens.map((token) => (
                <span className="token-chip" key={`${layer.layer}-${token.rank}-${token.tokenId}`}>
                  {JSON.stringify(token.token)} {formatProbability(token.probability)}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="attention-card">
        <div className="ev-col-title">Attention focus summary</div>
        {focusedHeads.length > 0 ? (
          focusedHeads.map((head) => (
            <div className="attn-row" key={`${head.layer}-${head.head}`}>
              <span>
                L{head.layer} H{head.head}
              </span>
              <strong>{JSON.stringify(head.focusToken)}</strong>
              <em>{formatProbability(head.maxAttention)}</em>
            </div>
          ))
        ) : (
          <div className="ev-v">Attention summaries were unavailable from this runner.</div>
        )}
      </div>
    </div>
  );
}

function PatchView({ result }: { result: InterpretabilityResult }) {
  const patching = result.patching;
  if (!patching?.available) {
    return (
      <div className="empty compact-empty">
        <div className="empty-t">Run Patch with a corrupted prompt to compute recovery scores.</div>
      </div>
    );
  }
  const best = patching.layers.reduce((winner, layer) =>
    layer.clippedRecovery > winner.clippedRecovery ? layer : winner
  );

  return (
    <div className="patch-view">
      <div className="patch-summary">
        <EvRow k="Clean target log-prob" v={patching.cleanLogProb.toFixed(4)} />
        <EvRow k="Corrupted target log-prob" v={patching.corruptedLogProb.toFixed(4)} />
        <EvRow k="Best restoring layer" v={`Layer ${best.layer} · ${formatProbability(best.clippedRecovery)}`} />
      </div>
      <div className="patch-bars">
        {patching.layers.map((layer) => (
          <div className="patch-row" key={layer.layer}>
            <span>L{layer.layer}</span>
            <div className="patch-track">
              <div
                className="patch-fill"
                style={{ width: `${Math.round(layer.clippedRecovery * 100)}%` }}
              />
            </div>
            <strong>{formatProbability(layer.clippedRecovery)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function RedactionPolicy({
  result,
  modelName
}: {
  result: InterpretabilityResult;
  modelName: string;
}) {
  return (
    <div className="redaction">
      <div>
        <div className="ev-col-title">Exposed summaries</div>
        <div className="policy-tags">
          {result.redaction.exposes.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
      <div>
        <div className="ev-col-title">Withheld inside {modelName} runner</div>
        <div className="policy-tags withheld">
          {result.redaction.withholds.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
    </div>
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

function ReceiptChart({ receipt }: { receipt: SignedAnyReceipt }) {
  const payload = receipt.payload;
  const hashes = [
    payload.promptHash,
    isGenerationSignedReceipt(receipt) ? receipt.payload.outputHash : receipt.payload.resultHash,
    isGenerationSignedReceipt(receipt)
      ? receipt.payload.paramsHash
      : receipt.payload.corruptedPromptHash,
    payload.runner.teeEvidenceHash,
    payload.model.commitment,
    receipt.digest
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

function formatProbability(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
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

function modelDisplayName(model?: ModelInfo | null): string {
  const raw =
    model?.architecture.model_id ||
    model?.meta.model_id ||
    model?.architecture.family ||
    "model";
  const id = String(raw);
  if (id.toLowerCase() === "gpt2") return "GPT-2";
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function networkDisplayName(network?: string, rpcUrl?: string): string {
  const source = `${network || ""} ${rpcUrl || ""}`.toLowerCase();
  if (source.includes("devnet")) return "Solana devnet";
  if (source.includes("testnet")) return "Solana testnet";
  if (source.includes("mainnet")) return "Solana mainnet";
  if (network) return networkDisplayLabel(network);
  return "Solana network";
}

function networkDisplayLabel(network: string): string {
  return network
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function teeRuntimeName(
  evidence?: TeeEvidenceSummary | null,
  health?: HealthStatus | null
): string {
  const source = `${evidence?.source || ""} ${health?.teeMode || ""}`.toLowerCase();
  if (evidence?.hardwareModel) return evidence.hardwareModel;
  if (source.includes("gcp") || source.includes("confidential")) {
    return "GCP Confidential VM";
  }
  if (source.includes("local") || evidence?.attestationStatus === "unavailable") {
    return "local TEE simulator";
  }
  if (health?.teeMode) return health.teeMode;
  return "TEE";
}

function isGenerationSignedReceipt(receipt: SignedAnyReceipt): receipt is Receipt {
  return receipt.payload.schema === "private-gpt2-receipt/v1";
}

function chainLabel(record?: GenerationRecord | null): string {
  return chainStateLabel(record?.solanaCommitment);
}

function chainStateLabel(chain?: GenerationRecord["solanaCommitment"]): string {
  if (!chain) return "Local only";
  if (chain.status === "confirmed") return "Anchored";
  if (chain.status === "dry-run") return "Dry run";
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
