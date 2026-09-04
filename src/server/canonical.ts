/** Node wrapper over the shared canonical module with synchronous hashing. */

import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonical.js";

export {
  canonicalJson,
  CanonicalError,
  assertNoFloats,
  bytesToHex,
  hexToBytes
} from "../shared/canonical.js";

export function sha256HexSync(value: unknown): string {
  const material =
    typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return createHash("sha256").update(material).digest("hex");
}

export function base64url(data: Buffer): string {
  return data
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fromBase64url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(
    normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "="),
    "base64"
  );
}
