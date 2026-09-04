import { CheckCircle2 } from "lucide-react";
import { shortHash } from "../format.js";
import type { PublicExperimentRecord } from "../types.js";

interface Link {
  key: string;
  color: "green" | "blue" | "violet" | "red" | "amber";
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
      color: "green",
      label: "Model commitment",
      what: weightFiles ? `sha256 over the ${weightFiles} model files (weights, config, tokenizer)` : "sha256 over the model files (weights, config, tokenizer)",
      value: p?.model.commitment ?? modelCommitment ?? undefined,
      verified: p ? passed("receipt-signature") : undefined
    },
    {
      key: "registry",
      color: "green",
      label: "Dataset hash",
      what: "sha256 over the experiment's input items as they appear in the repository",
      value: p?.experiment.datasetHash ?? registryHash ?? undefined,
      verified: p ? passed("dataset-hash") : undefined
    },
    {
      key: "internals",
      color: "blue",
      label: "Residual-stream digests",
      what: p
        ? `${p.results.leafCount} items × ${String(p.model.architecture.hiddenStateCount ?? 27)} hidden states, one sha256 each, stored inside the item's record`
        : "one sha256 per hidden state per item, stored inside the item's record",
      value: p ? `${p.results.leafCount} leaves` : undefined,
      verified: p ? passed("leaf-count-matches-items") : undefined
    },
    {
      key: "root",
      color: "violet",
      label: "Merkle root",
      what: "RFC 6962 tree over all item records; returned items come with inclusion proofs",
      value: p?.results.resultsRoot,
      verified: p ? passed("disclosure-indices") : undefined
    },
    {
      key: "nonce",
      color: "red",
      label: "Attestation nonce",
      what: "sha256 of root, dataset hash, registry hash, model commitment, policy hash and signer key; passed to the VM's attestation token",
      value: p?.attestation.nonce,
      verified: p ? passed("attestation-nonce") : undefined
    },
    {
      key: "receipt",
      color: "amber",
      label: "Receipt digest",
      what: "sha256 of the signed payload: aggregates, returned records with proofs, nonce, evidence hash",
      value: record?.receipt.digest,
      verified: p ? passed("receipt-signature") : undefined
    },
    {
      key: "chain",
      color: "green",
      label: "Solana account",
      what: "digest, root, hashes and leaf count written to a program account; read back during audit",
      value: record?.solanaCommitment?.commitmentPda,
      verified: record?.solanaCommitment?.status === "confirmed" ? passed("chain-results-root") : undefined
    }
  ];

  return (
    <ol className="chain" data-live={Boolean(p)}>
      {links.map((link) => (
        <li
          className="chain-link"
          key={link.key}
          data-color={link.color}
          data-state={link.value ? (link.verified === false ? "fail" : link.verified ? "ok" : "set") : "empty"}
        >
          <span className="chain-node">
            {link.verified ? <CheckCircle2 /> : <span className="chain-dot" />}
          </span>
          <div className="chain-body">
            <div className="chain-label">{link.label}</div>
            <div className="chain-what">{link.what}</div>
            <div className="chain-value">{link.value ? (link.value.length > 40 ? shortHash(link.value, 12) : link.value) : "pending"}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
