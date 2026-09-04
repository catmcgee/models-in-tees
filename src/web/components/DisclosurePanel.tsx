import { CheckCircle2, ChevronDown, XCircle } from "lucide-react";
import { useState } from "react";
import { itemPreview, shortHash } from "../format.js";
import type { AuditCheck, DisclosedLeaf, PublicExperimentRecord } from "../types.js";

function checkStatus(checks: AuditCheck[] | undefined, name: string): "pass" | "fail" | "pending" {
  const found = checks?.find((check) => check.name === name);
  if (!found) return "pending";
  return found.status === "pass" ? "pass" : "fail";
}

export function DisclosurePanel({
  record,
  items,
  checks
}: {
  record: PublicExperimentRecord;
  items: Array<Record<string, unknown>> | undefined;
  checks: AuditCheck[] | undefined;
}) {
  const payload = record.receipt.payload;
  const { resultsRoot, leafCount } = payload.results;
  const disclosure = payload.disclosure;
  const seedStatus = checkStatus(checks, "disclosure-seed");
  const indicesStatus = checkStatus(checks, "disclosure-indices");
  return (
    <section className="panel disclosure">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Per-item records</span>
          <div className="panel-title">
            {disclosure.count} of {leafCount} records returned
          </div>
        </div>
        <span className="pill-count">root {shortHash(resultsRoot, 8)}</span>
      </div>
      <p className="metric-note">
        Each input item produced one record. All {leafCount} records are leaves of the Merkle tree whose root is
        above. Which records are returned is decided by a seed computed from the root, the dataset hash and the model
        commitment; the same run always returns the same records. The other {leafCount - disclosure.count} records
        are stored on the VM and not returned. Every record includes one digest per hidden state of the residual-stream
        vector the result was computed from; the vectors themselves are not returned.
      </p>
      <div className="check-inline">
        <StatusMark status={seedStatus} /> seed recomputed from root, dataset hash and model commitment
        <StatusMark status={indicesStatus} /> returned indices [{disclosure.indices.join(", ")}] match the seed
      </div>
      <div className="disclosure-table">
        {disclosure.leaves.map((leaf) => (
          <LeafRow
            key={leaf.index}
            leaf={leaf}
            preview={itemPreview(items?.[leaf.index])}
            hashStatus={checkStatus(checks, `disclosed-leaf-hash[${leaf.index}]`)}
            proofStatus={checkStatus(checks, `disclosed-proof[${leaf.index}]`)}
          />
        ))}
      </div>
    </section>
  );
}

function LeafRow({
  leaf,
  preview,
  hashStatus,
  proofStatus
}: {
  leaf: DisclosedLeaf;
  preview: string;
  hashStatus: "pass" | "fail" | "pending";
  proofStatus: "pass" | "fail" | "pending";
}) {
  const [open, setOpen] = useState(false);
  const fields = Object.entries(leaf.leaf).filter(([key]) => !["schema", "index", "itemHash"].includes(key) && !/[dD]igest/.test(key));
  const digestFields = Object.entries(leaf.leaf).filter(([key]) => /[dD]igest/.test(key));
  return (
    <div className="leaf-row" data-open={open}>
      <button type="button" className="leaf-head" onClick={() => setOpen((value) => !value)}>
        <span className="leaf-index">#{leaf.index}</span>
        <span className="leaf-preview">{preview || `item ${leaf.index}`}</span>
        <span className="leaf-status">
          <StatusMark status={hashStatus} /> record hash
          <StatusMark status={proofStatus} /> inclusion proof
        </span>
        <span className="drawer-caret">
          <ChevronDown />
        </span>
      </button>
      {open && (
        <div className="leaf-body">
          <div className="kv leaf-fields">
            {fields.map(([key, value]) => (
              <div className="kv-row" key={key}>
                <div className="kv-k">{key}</div>
                <div className="kv-v">{Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value)}</div>
              </div>
            ))}
            {digestFields.map(([key, value]) => (
              <div className="kv-row" key={key}>
                <div className="kv-k">{key} (one per hidden state)</div>
                <div className="kv-v digest-list">
                  {Array.isArray(value)
                    ? value.map((d, i) => <span key={i} title={`hidden state ${i}`}>{String(d).slice(0, 10)}</span>)
                    : String(value)}
                </div>
              </div>
            ))}
            <div className="kv-row">
              <div className="kv-k">record hash (Merkle leaf)</div>
              <div className="kv-v">{leaf.leafHash}</div>
            </div>
          </div>
          <div className="ev-col-title">Inclusion proof ({leaf.proof.length} sibling hashes, leaf to root)</div>
          <ol className="proof-steps">
            {leaf.proof.map((step, index) => (
              <li key={index}>
                <span className="proof-side">{step.side}</span>
                <span className="kv-v">{step.hash}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function StatusMark({ status }: { status: "pass" | "fail" | "pending" | "skip" }) {
  if (status === "pass") return <CheckCircle2 className="mark mark-pass" />;
  if (status === "fail") return <XCircle className="mark mark-fail" />;
  return <span className="mark mark-pending" />;
}
