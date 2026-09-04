import { CheckCircle2 } from "lucide-react";
import { shortHash } from "../format.js";
import type { PublicExperimentRecord } from "../types.js";

interface Link {
  key: string;
  label: string;
  what: string;
  value?: string;
  verified?: boolean;
}

/**
 * The signature element: the chain of commitments a single run produces.
 * Empty until a run exists; then each link shows the real hash.
 */
export function BindingChain({
  record,
  registryHash,
  modelCommitment,
  weightFiles,
  checks
}: {
  record: PublicExperimentRecord | null;
  registryHash: string | null;
  modelCommitment: string | null;
  weightFiles: number | null;
  checks?: Array<{ name: string; status: string }>;
}) {
  const p = record?.receipt.payload;
  const passed = (name: string) => checks?.some((c) => c.name === name && c.status === "pass");
  const links: Link[] = [
    {
      key: "weights",
      label: "Sealed weights",
      what: weightFiles ? `sha256 of ${weightFiles} model files, never served` : "sha256 of every model file, never served",
      value: p?.model.commitment ?? modelCommitment ?? undefined,
      verified: p ? passed("receipt-signature") : undefined
    },
    {
      key: "registry",
      label: "Committed experiment",
      what: "dataset hash of the fixed items, inside the measured workload",
      value: p?.experiment.datasetHash ?? registryHash ?? undefined,
      verified: p ? passed("dataset-hash") : undefined
    },
    {
      key: "internals",
      label: "Model internals",
      what: p
        ? `${p.results.leafCount} items × ${String(p.model.architecture.hiddenStateCount ?? 27)} residual-stream digests, sealed in each leaf`
        : "one digest per layer per item of the actual residual stream, sealed",
      value: p ? `${p.results.leafCount} leaves` : undefined,
      verified: p ? passed("leaf-count-matches-items") : undefined
    },
    {
      key: "root",
      label: "Merkle root",
      what: "every per-item leaf, RFC 6962; opened items carry proofs",
      value: p?.results.resultsRoot,
      verified: p ? passed("disclosure-indices") : undefined
    },
    {
      key: "nonce",
      label: "Attestation nonce",
      what: "root ‖ dataset ‖ registry ‖ model ‖ policy ‖ signer, fed to the TEE",
      value: p?.attestation.nonce,
      verified: p ? passed("attestation-nonce") : undefined
    },
    {
      key: "receipt",
      label: "Signed receipt",
      what: "aggregates + opened leaves + evidence hash, Ed25519",
      value: record?.receipt.digest,
      verified: p ? passed("receipt-signature") : undefined
    },
    {
      key: "chain",
      label: "Solana commitment",
      what: "immutable account, decoded and compared on audit",
      value: record?.solanaCommitment?.commitmentPda,
      verified: record?.solanaCommitment?.status === "confirmed" ? passed("chain-results-root") : undefined
    }
  ];

  return (
    <ol className="chain" data-live={Boolean(p)}>
      {links.map((link) => (
        <li className="chain-link" key={link.key} data-state={link.value ? (link.verified === false ? "fail" : link.verified ? "ok" : "set") : "empty"}>
          <span className="chain-node">
            {link.verified ? <CheckCircle2 /> : <span className="chain-dot" />}
          </span>
          <div className="chain-body">
            <div className="chain-label">{link.label}</div>
            <div className="chain-what">{link.what}</div>
            {link.value && <div className="chain-value">{link.value.length > 40 ? shortHash(link.value, 12) : link.value}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
