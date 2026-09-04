/** Asserts the TypeScript primitives against src/shared/test-vectors.json. */

import { canonicalHash, canonicalJson, divRound } from "./canonical.js";
import { deriveDisclosureIndices, deriveDisclosureSeed, disclosureCount } from "./disclosure.js";
import { computeMerkleRoot, hashLeaf, inclusionProof, verifyMerkleProof } from "./merkle.js";
import { deriveAttestationNonce } from "./nonce.js";
import type { AuditCheck } from "./receiptTypes.js";

export interface TestVectors {
  canonical: Array<{ name: string; value: unknown; canonical: string; sha256: string }>;
  merkle: {
    leaves: unknown[];
    leafHashes: string[];
    roots: Array<{ n: number; root: string }>;
    proofs: Array<{ n: number; index: number; root: string; proof: Array<{ hash: string; side: "left" | "right" }> }>;
  };
  disclosure: Array<{
    resultsRoot: string;
    datasetHash: string;
    modelCommitment: string;
    leafCount: number;
    percent: number;
    min: number;
    max: number;
    count: number;
    seed: string;
    indices: number[];
  }>;
  nonce: Array<{
    inputs: {
      resultsRoot: string;
      datasetHash: string;
      registryHash: string;
      modelCommitment: string;
      policyHash: string;
      publicKeyFingerprint: string;
    };
    nonce: string;
  }>;
  fixedPoint: { divRound: Array<{ a: number; b: number; result: number }> };
}

export async function checkTestVectors(vectors: TestVectors): Promise<AuditCheck[]> {
  const checks: AuditCheck[] = [];
  const push = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, status: ok ? "pass" : "fail", detail });

  for (const item of vectors.canonical) {
    let ok = false;
    let detail = "";
    try {
      const canonical = canonicalJson(item.value);
      const hash = await canonicalHash(item.value);
      ok = canonical === item.canonical && hash === item.sha256;
      detail = ok ? hash : `got ${canonical}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    push(`canonical:${item.name}`, ok, detail);
  }

  const leafHashes = await Promise.all(vectors.merkle.leaves.map((leaf) => hashLeaf(leaf)));
  push("merkle:leaf-hashes", leafHashes.every((hash, i) => hash === vectors.merkle.leafHashes[i]));
  for (const entry of vectors.merkle.roots) {
    push(`merkle:root(n=${entry.n})`, (await computeMerkleRoot(leafHashes.slice(0, entry.n))) === entry.root);
  }
  for (const entry of vectors.merkle.proofs) {
    const proof = await inclusionProof(leafHashes.slice(0, entry.n), entry.index);
    const same = JSON.stringify(proof) === JSON.stringify(entry.proof);
    const verified = await verifyMerkleProof({ leafHash: leafHashes[entry.index], proof, root: entry.root });
    push(`merkle:proof(n=${entry.n},m=${entry.index})`, same && verified.ok);
  }

  for (const entry of vectors.disclosure) {
    const seed = await deriveDisclosureSeed(entry.resultsRoot, entry.datasetHash, entry.modelCommitment);
    const count = disclosureCount(entry.leafCount, entry.percent, entry.min, entry.max);
    const indices = await deriveDisclosureIndices(seed, entry.leafCount, count);
    push(
      `disclosure:n=${entry.leafCount}`,
      seed === entry.seed && count === entry.count && JSON.stringify(indices) === JSON.stringify(entry.indices),
      indices.join(",")
    );
  }

  for (const [i, entry] of vectors.nonce.entries()) {
    push(`nonce:${i}`, (await deriveAttestationNonce(entry.inputs)) === entry.nonce);
  }

  push(
    "fixed-point:divRound",
    vectors.fixedPoint.divRound.every((c) => divRound(c.a, c.b) === c.result)
  );
  return checks;
}
