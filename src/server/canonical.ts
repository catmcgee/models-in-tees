import { createHash } from "node:crypto";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value as JsonValue));
}

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, sortValue(inner)])
    );
  }
  return value;
}

export function sha256Hex(value: unknown): string {
  const material =
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : canonicalJson(value);
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
