/** Ed25519 verification + SPKI fingerprint, usable in Node and browsers. */

import { base64urlDecode, bytesToHex, sha256Bytes } from "./canonical.js";

const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

export function spkiDerFromPem(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function rawKeyFromSpki(der: Uint8Array): Uint8Array {
  if (der.length !== 44) {
    throw new Error("unexpected Ed25519 SPKI length");
  }
  for (let i = 0; i < ED25519_SPKI_PREFIX.length; i += 1) {
    if (der[i] !== ED25519_SPKI_PREFIX[i]) {
      throw new Error("not an Ed25519 SPKI key");
    }
  }
  return der.slice(12);
}

/** sha256(SPKI DER) as 64 lowercase hex chars; whitespace-independent. */
export async function publicKeyFingerprint(pem: string): Promise<string> {
  return bytesToHex(await sha256Bytes(spkiDerFromPem(pem)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function verifyEd25519(
  publicKeyPem: string,
  message: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const der = spkiDerFromPem(publicKeyPem);
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    let key: CryptoKey | null = null;
    try {
      key = await subtle.importKey("spki", toArrayBuffer(der), { name: "Ed25519" }, true, ["verify"]);
    } catch {
      key = null; // runtime without WebCrypto Ed25519: use the pure-JS fallback below
    }
    if (key) {
      try {
        return await subtle.verify({ name: "Ed25519" }, key, toArrayBuffer(signature), toArrayBuffer(message));
      } catch {
        return false;
      }
    }
  }
  const { ed25519 } = await import("@noble/curves/ed25519");
  try {
    return ed25519.verify(signature, message, rawKeyFromSpki(der));
  } catch {
    return false;
  }
}

export function decodeSignature(signature: string): Uint8Array {
  return base64urlDecode(signature);
}
