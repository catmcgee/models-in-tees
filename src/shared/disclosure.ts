/** tee-ai-disclosure/v1 (mirrors tee_runner/disclosure.py). */

import { bytesToHex, concatBytes, hex32, hexToBytes, sha256Bytes, utf8 } from "./canonical.js";

export const DISCLOSURE_SCHEME = "tee-ai-disclosure/v1";
const DOMAIN = utf8("tee-ai-disclosure/v1");

export async function deriveDisclosureSeed(
  resultsRoot: string,
  datasetHash: string,
  modelCommitment: string
): Promise<string> {
  return bytesToHex(
    await sha256Bytes(
      concatBytes(
        DOMAIN,
        hex32(resultsRoot, "resultsRoot"),
        hex32(datasetHash, "datasetHash"),
        hex32(modelCommitment, "modelCommitment")
      )
    )
  );
}

export function disclosureCount(
  leafCount: number,
  percent: number,
  minimum: number,
  maximum: number
): number {
  if (leafCount <= 0) {
    return 0;
  }
  let wanted = Math.ceil((leafCount * percent) / 100);
  wanted = Math.max(minimum, Math.min(maximum, wanted));
  return Math.min(leafCount, wanted);
}

export async function deriveDisclosureIndices(
  seedHex: string,
  leafCount: number,
  count: number
): Promise<number[]> {
  if (count > leafCount) {
    throw new Error("cannot sample more indices than leaves");
  }
  const seed = hexToBytes(seedHex);
  const chosen: number[] = [];
  let counter = 0;
  while (chosen.length < count) {
    const suffix = new Uint8Array(4);
    new DataView(suffix.buffer).setUint32(0, counter, false);
    const digest = await sha256Bytes(concatBytes(seed, suffix));
    const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0, false);
    const index = Number(value % BigInt(leafCount));
    if (!chosen.includes(index)) {
      chosen.push(index);
    }
    counter += 1;
  }
  return chosen.sort((a, b) => a - b);
}
