/**
 * End-to-end smoke test against an in-process API with the real runner:
 * registry -> single-flight run -> leak scan -> verify -> tamper -> audit ->
 * evidence -> dry-run commit -> chain read-back.
 */

import type { AddressInfo } from "node:net";
import { primeCaches } from "../src/server/experiments.js";
import { createApp } from "../src/server/index.js";
import { getRunner, stopRunner, warmRunner } from "../src/server/runnerClient.js";
import type { PublicExperimentRecord, RecordVerification } from "../src/shared/receiptTypes.js";

const FORBIDDEN_KEYS = [
  "sealed",
  "sealedLeaves",
  "leafHashes",
  "teeEvidence.attestation",
  "rawToken",
  "hiddenStates",
  "rawHiddenStates",
  "attentionTensor",
  "attentionWeights",
  "perItemResults",
  "stateDict",
  "parameters",
  "gradients",
  "mlpActivations",
  "privateKeyPem",
  "textproto"
];

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();

  try {
    console.log("[smoke] warming runner…");
    await warmRunner();
    await primeCaches();
    const health = await getJson<{ runner: { state: string }; registry: { ok: boolean; hash: string } }>(`${base}/api/health`);
    assert(health.runner.state === "ready", `runner state ${health.runner.state}`);
    assert(health.registry.ok, "registry not ok in health");

    const list = await getJson<{ registryHash: string; experiments: Array<{ id: string; kind: string; itemCount: number }> }>(
      `${base}/api/experiments`
    );
    assert(list.experiments.length > 0, "empty registry");
    const candidates = list.experiments.filter((e) => e.kind === "expected-token");
    const chosen = process.env.SMOKE_EXPERIMENT_ID
      ? list.experiments.find((e) => e.id === process.env.SMOKE_EXPERIMENT_ID)
      : (candidates.length ? candidates : list.experiments).sort((a, b) => a.itemCount - b.itemCount)[0];
    assert(chosen, "no experiment to run");
    console.log(`[smoke] registry ${list.registryHash.slice(0, 16)}… running ${chosen.id}`);

    const detail = await getJson<{ experiment: { id: string; items: unknown[] } }>(`${base}/api/experiments/${chosen.id}`);
    assert(detail.experiment.items.length === chosen.itemCount, "detail item count mismatch");

    // Single-flight: two concurrent runs -> one 200, one 409.
    const [first, second] = await Promise.all([
      fetch(`${base}/api/experiments/${chosen.id}/run`, { method: "POST" }),
      fetch(`${base}/api/experiments/${chosen.id}/run`, { method: "POST" })
    ]);
    const statuses = [first.status, second.status].sort();
    assert(statuses[0] === 200 && statuses[1] === 409, `expected [200,409], got [${statuses}]`);
    const runResponse = (await (first.status === 200 ? first : second).json()) as {
      record: PublicExperimentRecord;
      verification: RecordVerification;
    };
    const record = runResponse.record;
    assert(runResponse.verification.ok, "server self-verification failed");
    assertNoForbiddenKeys(record, "record");
    assert(/^[0-9a-f]{64}$/.test(record.receipt.payload.attestation.nonce), "nonce is not 64 hex");
    assert(
      record.receipt.payload.disclosure.leaves.length === record.receipt.payload.disclosure.count,
      "disclosed leaf count mismatch"
    );
    console.log(
      `[smoke] run ${record.id} root ${record.receipt.payload.results.resultsRoot.slice(0, 16)}… disclosed ${record.receipt.payload.disclosure.indices.join(",")}`
    );

    const verify = await postJson<{ verification: RecordVerification }>(`${base}/api/verify`, { record });
    assertAllPass(verify.verification, "verify");

    // Tamper 1: mutate a disclosed leaf -> its leaf hash check must fail.
    const tampered = structuredClone(record);
    const leaf = tampered.receipt.payload.disclosure.leaves[0];
    const numericKey = Object.keys(leaf.leaf).find((k) => typeof leaf.leaf[k] === "number" && k !== "index");
    assert(numericKey, "no numeric leaf field to tamper");
    (leaf.leaf as Record<string, unknown>)[numericKey] = (leaf.leaf[numericKey] as number) + 1;
    const tamperedVerify = await postJson<{ verification: RecordVerification }>(`${base}/api/verify`, { record: tampered });
    assert(!tamperedVerify.verification.ok, "tampered leaf verified");
    assert(
      tamperedVerify.verification.checks.some((c) => c.name.startsWith("disclosed-leaf-hash") && c.status === "fail"),
      "tampered leaf did not fail leaf-hash check"
    );

    // Tamper 2: mutate metrics -> digest/signature must fail.
    const tampered2 = structuredClone(record);
    (tampered2.receipt.payload.results.metrics as Record<string, unknown>).scored = 999;
    const tamperedVerify2 = await postJson<{ verification: RecordVerification }>(`${base}/api/verify`, { record: tampered2 });
    assert(
      tamperedVerify2.verification.checks.some((c) => c.name === "receipt-digest" && c.status === "fail"),
      "tampered metrics did not fail digest"
    );
    console.log("[smoke] tamper tests behave");

    const audit = await getJson<{ ok: boolean; audit: { checks: Array<{ name: string; status: string; detail?: string }> } }>(
      `${base}/api/receipts/${record.id}/audit?offline=1`
    );
    const failed = audit.audit.checks.filter((c) => c.status === "fail");
    assert(audit.ok, `audit failed: ${failed.map((c) => `${c.name}(${c.detail})`).join(", ")}`);
    for (const name of ["attestation-nonce", "evidence-nonce-match", "receipt-binds-evidence", "current-workload-match"]) {
      assert(audit.audit.checks.some((c) => c.name === name && c.status === "pass"), `audit check ${name} did not pass`);
    }

    const evidence = await getJson<{ summary: { nonce: string }; evidence: Record<string, unknown> }>(
      `${base}/api/receipts/${record.id}/evidence`
    );
    assert(evidence.summary.nonce === record.receipt.payload.attestation.nonce, "evidence nonce mismatch");
    assertNoForbiddenKeys(evidence.evidence, "evidence", ["rawToken", "textproto"]);

    const commit = await postJson<{ solanaCommitment: { status: string; kind: string; commitmentPda?: string } }>(
      `${base}/api/receipts/${record.id}/commit?dryRun=1`,
      {}
    );
    assert(commit.solanaCommitment.status === "dry-run", "dry-run commit status");
    assert(commit.solanaCommitment.kind === "anchor-program" && commit.solanaCommitment.commitmentPda, "dry-run pda");

    if (process.env.SMOKE_SKIP_RPC !== "1") {
      const chain = await getJson<{ ok: boolean; chain: { exists: boolean } }>(`${base}/api/receipts/${record.id}/chain`);
      assert(chain.ok && chain.chain.exists === false, "chain read-back of an uncommitted run should be exists:false");
    }

    const receipts = await getJson<{ records: PublicExperimentRecord[] }>(`${base}/api/receipts`);
    assert(receipts.records.some((r) => r.id === record.id), "record missing from listing");
    const key = await getJson<{ key: { publicKeyFingerprint: string } }>(`${base}/api/runner-key`);
    assert(key.key.publicKeyFingerprint === record.receipt.payload.runner.publicKeyFingerprint, "runner key mismatch");

    console.log(
      JSON.stringify(
        {
          ok: true,
          runId: record.id,
          experimentId: record.experimentId,
          resultsRoot: record.receipt.payload.results.resultsRoot,
          nonce: record.receipt.payload.attestation.nonce,
          receiptDigest: record.receipt.digest,
          workloadHash: record.receipt.payload.attestation.workloadHash,
          runnerRestarts: getRunner().status().restarts,
          elapsedMs: Date.now() - started
        },
        null,
        2
      )
    );
  } finally {
    server.close();
    await stopRunner();
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${body.error ?? ""}`);
  }
  return body;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${body.error ?? ""}`);
  }
  return body;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[smoke] ${message}`);
  }
}

function assertAllPass(verification: RecordVerification, label: string): void {
  const failed = verification.checks.filter((c) => c.status === "fail");
  assert(verification.ok && failed.length === 0, `${label}: ${failed.map((c) => `${c.name}(${c.detail})`).join(", ")}`);
}

function assertNoForbiddenKeys(value: unknown, label: string, keys: string[] = FORBIDDEN_KEYS): void {
  const flat = new Set<string>();
  walk(value, "", flat);
  for (const key of keys) {
    for (const seen of flat) {
      if (seen === key || seen.endsWith(`.${key}`) || seen.includes(`.${key}.`)) {
        throw new Error(`[smoke] ${label} leaks forbidden key ${seen}`);
      }
    }
  }
}

function walk(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, prefix, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const full = prefix ? `${prefix}.${key}` : key;
      out.add(full);
      walk(inner, full, out);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
