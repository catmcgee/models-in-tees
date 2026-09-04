/**
 * RFC 6962 Merkle tree over canonical leaves (mirrors tee_runner/merkle.py).
 *   leafHash = SHA256(0x00 || canonical(leaf))
 *   node     = SHA256(0x01 || left || right), split at largest power of two < n
 * Proof steps carry the sibling hash and the sibling's side.
 */

import { bytesToHex, canonicalJson, concatBytes, hexToBytes, sha256Bytes, utf8 } from "./canonical.js";

export const MERKLE_SCHEME = "rfc6962-sha256";

export interface MerkleProofStep {
  hash: string;
  side: "left" | "right";
}

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

export async function hashLeafBytes(leaf: unknown): Promise<Uint8Array> {
  return sha256Bytes(concatBytes(LEAF_PREFIX, utf8(canonicalJson(leaf))));
}

export async function hashLeaf(leaf: unknown): Promise<string> {
  return bytesToHex(await hashLeafBytes(leaf));
}

export async function hashNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256Bytes(concatBytes(NODE_PREFIX, left, right));
}

function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
}

async function rootBytes(hashes: Uint8Array[]): Promise<Uint8Array> {
  if (hashes.length === 0) {
    throw new Error("merkle root of zero leaves is undefined");
  }
  if (hashes.length === 1) {
    return hashes[0];
  }
  const k = splitPoint(hashes.length);
  return hashNode(await rootBytes(hashes.slice(0, k)), await rootBytes(hashes.slice(k)));
}

export async function computeMerkleRoot(leafHashes: string[]): Promise<string> {
  return bytesToHex(await rootBytes(leafHashes.map(hexToBytes)));
}

export async function inclusionProof(leafHashes: string[], index: number): Promise<MerkleProofStep[]> {
  const nodes = leafHashes.map(hexToBytes);
  if (index < 0 || index >= nodes.length) {
    throw new Error("leaf index out of range");
  }
  async function path(m: number, slice: Uint8Array[]): Promise<MerkleProofStep[]> {
    if (slice.length === 1) {
      return [];
    }
    const k = splitPoint(slice.length);
    if (m < k) {
      return [...(await path(m, slice.slice(0, k))), { hash: bytesToHex(await rootBytes(slice.slice(k))), side: "right" }];
    }
    return [...(await path(m - k, slice.slice(k))), { hash: bytesToHex(await rootBytes(slice.slice(0, k))), side: "left" }];
  }
  return path(index, nodes);
}

export async function verifyMerkleProof(input: {
  leafHash: string;
  proof: MerkleProofStep[];
  root: string;
}): Promise<{ ok: boolean; computedRoot: string }> {
  let current = hexToBytes(input.leafHash);
  for (const step of input.proof) {
    const sibling = hexToBytes(step.hash);
    if (step.side === "left") {
      current = await hashNode(sibling, current);
    } else if (step.side === "right") {
      current = await hashNode(current, sibling);
    } else {
      return { ok: false, computedRoot: bytesToHex(current) };
    }
  }
  const computedRoot = bytesToHex(current);
  return { ok: computedRoot === input.root, computedRoot };
}
