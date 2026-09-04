import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { apiGet, apiPost, describeError } from "./api.js";
import { Catalog } from "./components/Catalog.js";
import { DisclosurePanel } from "./components/DisclosurePanel.js";
import { EvidenceDrawer } from "./components/EvidenceDrawer.js";
import { ExperimentPanel } from "./components/ExperimentPanel.js";
import { MetricsView, PolicyChips } from "./components/Metrics.js";
import { ReceiptPanel } from "./components/ReceiptPanel.js";
import { BindingChain } from "./components/BindingChain.js";
import { Topbar } from "./components/Topbar.js";
import { kindLabel, modelDisplayName, teeRuntimeName } from "./format.js";
import "./styles.css";
import type {
  ExperimentDetail,
  ExperimentSummary,
  HealthStatus,
  PublicExperimentRecord,
  SolanaCommitment,
  SolanaStatus,
  TeeEvidenceSummary
} from "./types.js";
import { useRecordVerification } from "./verify.js";

interface ModelInfoLite {
  modelId: string;
  commitment: string;
  architecture: Record<string, unknown>;
  files?: Array<{ path: string; sizeBytes: number; sha256: string }>;
  sae: { repoId: string; subfolder: string; commitment: string; width: number; layer: number } | null;
}

function shortRun(id: string): string {
  return id.split("-").slice(-1)[0];
}

function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [model, setModel] = useState<ModelInfoLite | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [registryHash, setRegistryHash] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [runs, setRuns] = useState<PublicExperimentRecord[]>([]);
  const [lastRuns, setLastRuns] = useState<Record<string, PublicExperimentRecord | undefined>>({});
  const [activeRecord, setActiveRecord] = useState<PublicExperimentRecord | null>(null);
  const [solana, setSolana] = useState<SolanaStatus | null>(null);
  const [evidence, setEvidence] = useState<TeeEvidenceSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [anchoring, setAnchoring] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [verifyToken, setVerifyToken] = useState(0);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const healthResponse = await apiGet<HealthStatus>("/api/health");
      setHealth(healthResponse);
      const [list, receipts, solanaResponse, evidenceResponse, modelResponse] = await Promise.allSettled([
        apiGet<{ registryHash: string; experiments: ExperimentSummary[] }>("/api/experiments"),
        apiGet<{ records: PublicExperimentRecord[] }>("/api/receipts"),
        apiGet<{ solana: SolanaStatus }>("/api/solana/status"),
        apiGet<{ summary: TeeEvidenceSummary }>("/api/tee/evidence"),
        apiGet<{ model: ModelInfoLite }>("/api/model")
      ]);
      if (list.status === "fulfilled") {
        setExperiments(list.value.experiments);
        setRegistryHash(list.value.registryHash);
        setSelectedId((current) => current ?? list.value.experiments[0]?.id ?? null);
      }
      if (receipts.status === "fulfilled") {
        const latest: Record<string, PublicExperimentRecord | undefined> = {};
        for (const record of receipts.value.records) {
          if (!latest[record.experimentId]) latest[record.experimentId] = record;
        }
        setLastRuns(latest);
      }
      if (solanaResponse.status === "fulfilled") setSolana(solanaResponse.value.solana);
      if (evidenceResponse.status === "fulfilled") setEvidence(evidenceResponse.value.summary);
      if (modelResponse.status === "fulfilled") setModel(modelResponse.value.model);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll health while the runner is warming up or another client is running.
  useEffect(() => {
    const state = health?.runner.state;
    if (state === "ready" && !health?.busy) return;
    const timer = setInterval(() => {
      apiGet<HealthStatus>("/api/health")
        .then((next) => {
          setHealth(next);
          if (next.runner.state === "ready" && experiments.length === 0) void refresh();
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [health?.runner.state, health?.busy, experiments.length, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    apiGet<{ experiment: ExperimentDetail; runs: PublicExperimentRecord[] }>(`/api/experiments/${selectedId}`)
      .then((response) => {
        if (cancelled) return;
        setDetail(response.experiment);
        setRuns(response.runs);
        setActiveRecord(response.runs[0] ?? null);
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const items = useMemo(() => detail?.items, [detail]);
  const bundle = useRecordVerification(activeRecord, items, verifyToken);

  async function runSelected() {
    if (!selectedId) return;
    setRunning(true);
    setError(null);
    try {
      const response = await apiPost<{ record: PublicExperimentRecord }>(`/api/experiments/${selectedId}/run`);
      setActiveRecord(response.record);
      setRuns((current) => [response.record, ...current]);
      setLastRuns((current) => ({ ...current, [response.record.experimentId]: response.record }));
      setEvidence(response.record.receipt.payload.attestation.teeEvidence);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRunning(false);
      apiGet<HealthStatus>("/api/health").then(setHealth).catch(() => undefined);
    }
  }

  async function anchorActive() {
    if (!activeRecord) return;
    setAnchoring(true);
    setError(null);
    try {
      const response = await apiPost<{ solanaCommitment: SolanaCommitment; record: PublicExperimentRecord }>(
        `/api/receipts/${activeRecord.id}/commit`,
        { dryRun }
      );
      const updated = dryRun ? { ...activeRecord, solanaCommitment: response.solanaCommitment } : response.record;
      setActiveRecord(updated);
      setRuns((current) => current.map((run) => (run.id === updated.id ? updated : run)));
      setVerifyToken((value) => value + 1);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAnchoring(false);
    }
  }

  const modelName = modelDisplayName(model?.modelId ?? health?.model?.modelId);
  const teeName = teeRuntimeName(evidence, health?.teeMode);
  const busyElsewhere = health?.busy && !running ? health.busy.experimentId : null;

  return (
    <div className="app">
      <Topbar
        health={health}
        subtitle={`${modelName} · ${teeName} · Solana devnet`}
        busy={refreshing}
        onRefresh={() => void refresh()}
      />

      <section className="panel hero">
        <div className="hero-copy">
          <span className="eyebrow">What this is</span>
          <h1 className="headline">
            Six fixed experiments, run inside a confidential VM against {modelName}. The weights are not published.
          </h1>
          <p className="lede">
            The experiments and their inputs are files in the public repository; the API only runs those. A run
            produces one record per input item. Each record contains the item's result and a digest of the model's
            residual stream at every layer for that item. All records are hashed into a Merkle tree. The root of that
            tree is fed into the VM's hardware attestation as its nonce, then signed together with the aggregate
            metrics, the leakage policy, and a sample of records chosen by a seed derived from the root. Only the
            sample is returned; the other records stay on the VM. This page recomputes each hash from the returned data
            rather than trusting the API's own verdict.
          </p>
          <div className="hero-chips">
            <span className="chip chip-mint">{experiments.length || 6} experiments</span>
            <span className="chip chip-violet">{evidence?.hardwareModel || teeName}</span>
            <span className="chip chip-blue">{activeRecord?.solanaCommitment?.status === "confirmed" ? "on Solana devnet" : "Solana devnet"}</span>
          </div>
          {error && <div className="error-strip">{error}</div>}
          {health && health.runner.state !== "ready" && (
            <div className="running-line">
              Runner is {health.runner.state}
              {health.runner.lastError ? `: ${health.runner.lastError}` : ". The model is being loaded."}
            </div>
          )}
        </div>
        <div className="hero-chain">
          <div className="chain-title">
            <span>Hashes produced by a run</span>
            <span>{activeRecord ? `run ${shortRun(activeRecord.id)}` : "no run selected"}</span>
          </div>
          <BindingChain
            record={activeRecord}
            registryHash={registryHash}
            modelCommitment={model?.commitment ?? health?.model?.commitment ?? null}
            weightFiles={model?.files?.length ?? null}
            checks={bundle.client?.checks}
          />
        </div>
      </section>

      <div className="lab-grid">
        <Catalog
          experiments={experiments}
          registryHash={registryHash}
          selectedId={selectedId}
          lastRuns={lastRuns}
          onSelect={(id) => {
            setSelectedId(id);
            setActiveRecord(null);
          }}
        />
        <ExperimentPanel
          experiment={detail}
          runs={runs}
          activeRecord={activeRecord}
          running={running}
          busyElsewhere={busyElsewhere}
          onRun={() => void runSelected()}
          onSelectRun={setActiveRecord}
        />
      </div>

      {activeRecord && detail && (
        <>
          <section className="panel results">
            <div className="panel-head">
              <div>
                <span className="eyebrow">{kindLabel(activeRecord.receipt.payload.experiment.kind)} · aggregate metrics (signed)</span>
                <div className="panel-title">{activeRecord.receipt.payload.experiment.title}</div>
              </div>
              <span className="pill-count">
                {activeRecord.timing.forwardPasses} forward passes · {activeRecord.timing.totalMs} ms in the runner
              </span>
            </div>
            <MetricsView
              kind={activeRecord.receipt.payload.experiment.kind}
              metrics={activeRecord.receipt.payload.results.metrics}
              descriptive={activeRecord.descriptive}
            />
            <PolicyChips policy={activeRecord.receipt.payload.policy} />
          </section>
          <div className="lower-grid">
            <DisclosurePanel record={activeRecord} items={items} checks={bundle.client?.checks} />
            <ReceiptPanel
              record={activeRecord}
              bundle={bundle}
              anchoring={anchoring}
              dryRun={dryRun}
              onToggleDryRun={() => setDryRun((value) => !value)}
              onAnchor={() => void anchorActive()}
            />
          </div>
        </>
      )}

      <EvidenceDrawer
        open={drawerOpen}
        onToggle={() => setDrawerOpen((value) => !value)}
        model={model}
        health={health}
        evidence={activeRecord?.receipt.payload.attestation.teeEvidence ?? evidence}
        solana={solana}
        record={activeRecord}
      />

      <div className="foot">
        Source: github.com/catmcgee/models-in-tees. Model: {modelName}. Runtime: {teeName}. Chain: Solana devnet.
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
