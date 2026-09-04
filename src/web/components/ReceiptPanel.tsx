import { ArrowUpRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { formatDate, formatMs, shortHash } from "../format.js";
import type { AuditCheck, PublicExperimentRecord } from "../types.js";
import type { VerificationBundle } from "../verify.js";
import { StatusMark } from "./DisclosurePanel.js";

const GROUPS: Array<{ title: string; match: (name: string) => boolean }> = [
  { title: "Signature and hashes (computed in this browser)", match: (n) => /^(receipt-|runner-key|policy-hash|metrics-|dataset-hash|leaf-count)/.test(n) },
  { title: "Attestation nonce and evidence", match: (n) => /^(attestation-nonce|evidence-|tee-evidence|receipt-binds|current-workload)/.test(n) },
  { title: "Returned records (computed in this browser)", match: (n) => /^disclos/.test(n) },
  { title: "Google Confidential VM token (checked by the API against Google's keys)", match: (n) => /^google-/.test(n) },
  { title: "Solana account", match: (n) => /^chain-/.test(n) }
];

export function ReceiptPanel({
  record,
  bundle,
  anchoring,
  dryRun,
  onToggleDryRun,
  onAnchor
}: {
  record: PublicExperimentRecord;
  bundle: VerificationBundle;
  anchoring: boolean;
  dryRun: boolean;
  onToggleDryRun: () => void;
  onAnchor: () => void;
}) {
  const payload = record.receipt.payload;
  const chain = record.solanaCommitment;
  const merged = mergeChecks(bundle.client?.checks, bundle.audit?.checks);
  const failing = merged.filter((check) => check.status === "fail");
  const state = bundle.loading && !bundle.client ? "checking" : failing.length > 0 ? "invalid" : bundle.client ? "valid" : "checking";

  return (
    <section className="panel receipt">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Receipt</span>
          <div className="panel-title">Signature, attestation, and checks</div>
        </div>
        <Badge state={state} count={merged.length} failing={failing.length} />
      </div>

      <div className="commits">
        <div className="ev-col-title">Contents of the signed payload</div>
        <ul className="commit-list">
          <li><strong>Model commitment</strong> {shortHash(payload.model.commitment, 8)}: sha256 over the model files. The files are not published.</li>
          <li><strong>Merkle root</strong> {shortHash(payload.results.resultsRoot, 8)} over {payload.results.leafCount} per-item records, each containing the item's result and one residual-stream digest per hidden state{payload.sae ? " and a digest of the SAE activation tensor" : ""}.</li>
          <li><strong>{payload.disclosure.count} returned records</strong> with inclusion proofs, chosen by the seed.</li>
          <li><strong>Aggregate metrics</strong>, leakage policy, dataset hash, registry hash, experiment parameters.</li>
          <li><strong>Attestation nonce</strong> derived from the fields above, and the hash of the TEE evidence that carries the token with that nonce.</li>
        </ul>
      </div>

      <div className="kv receipt-kv">
        <Row k="Receipt digest" v={record.receipt.digest} />
        <Row k="Results Merkle root" v={payload.results.resultsRoot} />
        <Row k="Attestation nonce" v={payload.attestation.nonce} />
        <Row k="TEE evidence hash" v={payload.attestation.teeEvidenceHash} />
        <Row k="Workload hash" v={payload.attestation.workloadHash || "n/a"} />
        <Row k="Signer key fingerprint" v={payload.runner.publicKeyFingerprint} />
        <Row k="Issued" v={`${formatDate(payload.issuedAt)}, ${formatMs(payload.runner.latencyMs)} from request to signature`} />
      </div>

      <div className="check-groups">
        {GROUPS.map((group) => {
          const checks = merged.filter((check) => group.match(check.name));
          if (checks.length === 0) return null;
          return (
            <div className="check-group" key={group.title}>
              <div className="ev-col-title">{group.title}</div>
              <ul className="check-list">
                {checks.map((check) => (
                  <li className="check-row" data-status={check.status} key={check.name}>
                    <StatusMark status={check.status} />
                    <span className="check-name">{check.name}</span>
                    <span className="check-detail">{check.detail ? shortHash(check.detail, 14) : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {bundle.clientError && <div className="error-strip">Browser-side checks could not run: {bundle.clientError}</div>}
        {bundle.auditError && <div className="error-strip">The API's audit did not respond: {bundle.auditError}</div>}
      </div>

      <div className="receipt-actions">
        <button className="btn btn-dark" type="button" onClick={onAnchor} disabled={anchoring}>
          {anchoring ? <Loader2 className="spin" /> : <ArrowUpRight />}
          <span>{dryRun ? "Write to Solana (dry run)" : "Write to Solana devnet"}</span>
        </button>
        <label className="toggle" data-on={dryRun}>
          <input type="checkbox" checked={dryRun} onChange={onToggleDryRun} />
          <span className="track">
            <span className="knob" />
          </span>
          dry run
        </label>
      </div>
      {chain && (
        <div className={`confirmed${chain.status === "failed" ? " failed" : ""}`}>
          <span className="dot" />
          <div style={{ minWidth: 0 }}>
            <div className="confirmed-t">
              {chain.explorerUrl ? (
                <a href={chain.explorerUrl} target="_blank" rel="noreferrer">
                  Solana {chain.status} · {chain.kind}
                  <ArrowUpRight />
                </a>
              ) : (
                <span>
                  Solana {chain.status} · {chain.kind}
                </span>
              )}
            </div>
            <div className="confirmed-h">
              {chain.error || chain.anchorError || (chain.commitmentPda ? `PDA ${chain.commitmentPda}` : shortHash(chain.memoHash, 14))}
            </div>
          </div>
        </div>
      )}
      {bundle.chain && (
        <div className="chain-readback">
          <div className="ev-col-title">Account read back from Solana</div>
          <div className="kv">
            <Row k="Commitment account" v={bundle.chain.pda} />
            {bundle.chain.account && (
              <>
                <Row k="On-chain results root" v={bundle.chain.account.resultsRoot} />
                <Row k="On-chain TEE evidence hash" v={bundle.chain.account.teeEvidenceHash} />
                <Row k="Committed at" v={new Date(bundle.chain.account.committedAt * 1000).toISOString()} />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function mergeChecks(client?: AuditCheck[], server?: AuditCheck[]): AuditCheck[] {
  const seen = new Map<string, AuditCheck>();
  for (const check of client ?? []) seen.set(check.name, check);
  for (const check of server ?? []) {
    const existing = seen.get(check.name);
    // The browser result wins for checks both sides run; server-only checks are appended.
    if (!existing || (existing.status === "skip" && check.status !== "skip")) seen.set(check.name, check);
  }
  return [...seen.values()];
}

function Badge({ state, count, failing }: { state: "valid" | "invalid" | "checking"; count: number; failing: number }) {
  if (state === "valid") {
    return (
      <span className="badge badge-valid">
        <CheckCircle2 /> {count} checks pass
      </span>
    );
  }
  if (state === "invalid") {
    return (
      <span className="badge badge-bad">
        <XCircle /> {failing} of {count} checks fail
      </span>
    );
  }
  return (
    <span className="badge badge-pending">
      <Loader2 className="spin" /> Checking
    </span>
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
