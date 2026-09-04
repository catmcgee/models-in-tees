import { ChevronDown } from "lucide-react";
import { architectureLine, hardwareClaim, modelDisplayName, shortHash } from "../format.js";
import type { HealthStatus, PublicExperimentRecord, SolanaStatus, TeeEvidenceSummary } from "../types.js";

interface ModelInfoLite {
  modelId: string;
  commitment: string;
  architecture: Record<string, unknown>;
  sae: { repoId: string; subfolder: string; commitment: string; width: number; layer: number } | null;
}

export function EvidenceDrawer({
  open,
  onToggle,
  model,
  health,
  evidence,
  solana,
  record
}: {
  open: boolean;
  onToggle: () => void;
  model: ModelInfoLite | null;
  health: HealthStatus | null;
  evidence: TeeEvidenceSummary | null;
  solana: SolanaStatus | null;
  record: PublicExperimentRecord | null;
}) {
  const receipt = record?.receipt;
  return (
    <section className="drawer" data-open={open}>
      <button className="drawer-toggle" type="button" onClick={onToggle}>
        <div>
          <div className="dt-title">Details</div>
          <div className="dt-sub">Model files, TEE evidence, Solana program, receipt hashes</div>
        </div>
        <span className="drawer-caret">
          <ChevronDown />
        </span>
      </button>
      <div className="drawer-body">
        <div className="evidence-grid">
          <div>
            <div className="ev-col-title">Model</div>
            <EvRow k="Model" v={model ? `${modelDisplayName(model.modelId)} (${model.modelId})` : "pending"} />
            <EvRow k="Weights" v="not published; committed by file hashes" />
            <EvRow k="Commitment" v={model?.commitment || health?.model?.commitment || "pending"} />
            <EvRow k="Architecture" v={architectureLine(model?.architecture)} />
            <EvRow
              k="SAE dictionary"
              v={model?.sae ? `${model.sae.repoId} · ${model.sae.subfolder} · ${shortHash(model.sae.commitment, 8)}` : "not loaded"}
            />
          </div>
          <div>
            <div className="ev-col-title">TEE evidence</div>
            <EvRow k="Mode" v={health?.teeMode || "pending"} />
            <EvRow k="Source" v={evidence?.source || "pending"} />
            <EvRow k="Hardware" v={hardwareClaim(evidence)} />
            <EvRow k="Evidence hash" v={evidence?.evidenceHash || "pending"} />
            <EvRow k="Workload hash" v={evidence?.workloadHash || "pending"} />
            {evidence?.errors && <EvRow k="Notes" v={evidence.errors.join(" · ")} />}
          </div>
          <div>
            <div className="ev-col-title">Solana devnet</div>
            <EvRow k="RPC" v={solana?.rpcUrl || "pending"} />
            <EvRow k="Program" v={solana?.programId || "pending"} />
            <EvRow k="Payer" v={solana?.payer || "pending"} />
            <EvRow k="Balance" v={solana ? `${solana.balanceSol.toFixed(4)} SOL` : "pending"} />
          </div>
          <div>
            <div className="ev-col-title">Receipt hashes</div>
            {receipt ? (
              <div>
                <EvRow k="Dataset hash" v={receipt.payload.experiment.datasetHash} />
                <EvRow k="Registry hash" v={receipt.payload.experiment.registryHash} />
                <EvRow k="Policy hash" v={receipt.payload.policyHash} />
                <EvRow k="Metrics hash" v={receipt.payload.results.metricsHash} />
                <EvRow k="Signature" v={receipt.signature} />
              </div>
            ) : (
              <div className="ev-v" style={{ marginTop: 2 }}>
                No run selected.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
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
