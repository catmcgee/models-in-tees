/**
 * tee-ai-canonical-json/v1 — the one serialisation every hash and signature
 * in the system is computed over. Mirrors src/model/tee_runner/canonical.py.
 *
 * - values: object, array, string, boolean, null and *safe integers* only
 * - object keys sorted by UTF-16 code units (plain `<` on strings)
 * - no whitespace; strings escaped exactly like JSON.stringify
 * - SHA-256 over UTF-8 bytes, lowercase hex
 *
 * Browser-safe: no Node imports, WebCrypto for hashing.
 */

export class CanonicalError extends Error {}

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

export function canonicalJson(value: unknown, path = "$"): string {
  if (value === null) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError(`${path}: only safe integers are allowed (${String(value)})`);
    }
    return value === 0 ? "0" : String(value);
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CanonicalError(`${path}: integer exceeds 2^53-1`);
    }
    return value.toString();
  }
  if (typeof value === "string") {
    if (!isWellFormed(value)) {
      throw new CanonicalError(`${path}: string contains a lone surrogate`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`)}`
    );
    return `{${parts.join(",")}}`;
  }
  throw new CanonicalError(`${path}: unsupported type ${typeof value}`);
}

function isWellFormed(value: string): boolean {
  const fn = (value as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof fn === "function") {
    return fn.call(value);
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function assertNoFloats(value: unknown, path = "$"): void {
  canonicalJson(value, path);
}

// --- bytes ---------------------------------------------------------------

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new CanonicalError(`invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function hex32(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new CanonicalError(`${label} must be 32 bytes of lowercase hex`);
  }
  return hexToBytes(value);
}

// --- hashing (WebCrypto, async) -----------------------------------------------

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new Error("WebCrypto is not available in this environment");
  }
  return c.subtle;
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return new Uint8Array(await subtle().digest("SHA-256", buffer));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256Bytes(typeof data === "string" ? utf8(data) : data));
}

export async function canonicalHash(value: unknown): Promise<string> {
  return sha256Hex(utf8(canonicalJson(value)));
}

// --- base64url -----------------------------------------------------------------

export function base64urlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// --- fixed-point integer helpers (verifier side) ----------------------------------

export function divRound(a: number, b: number): number {
  if (b <= 0) {
    throw new Error("divRound requires b > 0");
  }
  return Math.floor((2 * a + b) / (2 * b));
}

export function meanFixed(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return divRound(values.reduce((sum, v) => sum + v, 0), values.length);
}
