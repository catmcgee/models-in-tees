import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { config } from "./config.js";
import { fromBase64url, sha256Hex } from "./canonical.js";
import { getWorkloadMeasurement } from "./workload.js";
import type { TeeEvidence, TeeEvidenceSummary } from "./types.js";

const execFileAsync = promisify(execFile);
const metadataBaseUrl = "http://metadata.google.internal/computeMetadata/v1";

export interface TeeEvidenceOptions {
  nonce?: string;
  includeToken?: boolean;
  includeReport?: boolean;
}

export async function getTeeEvidence(
  options: TeeEvidenceOptions = {}
): Promise<TeeEvidence> {
  const nonce = normalizeNonce(options.nonce);
  const errors: string[] = [];
  const [gcpMetadata, runtime, workload, tokenResult, reportResult] = await Promise.all([
    collectGcpMetadata(errors),
    collectRuntimeEvidence(),
    getWorkloadMeasurement(),
    collectGoogleClaimsToken(nonce, options.includeToken === true, errors),
    options.includeReport === true
      ? collectTpmReport(nonce, true, errors)
      : Promise.resolve(null)
  ]);

  const attestation: TeeEvidence["attestation"] = {
    status: tokenResult
      ? "google-claims-token"
      : reportResult
        ? "local-tpm-report"
        : errors.length > 0
          ? "failed"
          : "unavailable",
    errors
  };
  if (tokenResult) {
    attestation.token = tokenResult;
  }
  if (reportResult) {
    attestation.report = reportResult;
  }

  const baseEvidence = {
    schema: "tee-evidence/v1" as const,
    collectedAt: new Date().toISOString(),
    teeMode: config.teeMode,
    teeProvider: config.teeProvider,
    source: detectEvidenceSource(gcpMetadata, tokenResult),
    nonce,
    ...(Object.keys(gcpMetadata).length > 0 ? { gcpMetadata } : {}),
    runtime,
    workload,
    attestation
  };

  return {
    ...baseEvidence,
    evidenceHash: sha256Hex(baseEvidence)
  };
}

export function summarizeTeeEvidence(evidence: TeeEvidence): TeeEvidenceSummary {
  const claims = evidence.attestation.token?.claims || {};
  const gce =
    typeof claims.submods === "object" &&
    claims.submods !== null &&
    "gce" in claims.submods &&
    typeof (claims.submods as { gce?: unknown }).gce === "object" &&
    (claims.submods as { gce?: unknown }).gce !== null
      ? ((claims.submods as { gce: Record<string, unknown> }).gce)
      : {};

  return {
    schema: "tee-evidence/v1",
    evidenceHash: evidence.evidenceHash,
    workloadHash: evidence.workload?.workloadHash,
    source: evidence.source,
    collectedAt: evidence.collectedAt,
    nonce: evidence.nonce,
    attestationStatus: evidence.attestation.status,
    tokenHash: evidence.attestation.token?.tokenHash,
    reportHash: evidence.attestation.report?.reportHash,
    subject: stringClaim(claims.sub),
    issuer: stringClaim(claims.iss),
    hardwareModel: stringClaim(claims.hwmodel),
    secureBoot:
      typeof claims.secboot === "boolean" ? claims.secboot : undefined,
    projectId:
      stringClaim(gce.project_id) || evidence.gcpMetadata?.["project/project-id"],
    zone: stringClaim(gce.zone) || shortZone(evidence.gcpMetadata?.["instance/zone"]),
    instanceName:
      stringClaim(gce.instance_name) || evidence.gcpMetadata?.["instance/name"],
    instanceId:
      stringClaim(gce.instance_id) || evidence.gcpMetadata?.["instance/id"],
    errors:
      evidence.attestation.errors.length > 0
        ? evidence.attestation.errors.slice(0, 4)
        : undefined
  };
}

export function redactTeeEvidence(
  evidence: TeeEvidence,
  options: { includeToken?: boolean; includeReport?: boolean } = {}
): TeeEvidence {
  const redacted = JSON.parse(JSON.stringify(evidence)) as TeeEvidence;
  if (!options.includeToken && redacted.attestation.token) {
    delete redacted.attestation.token.rawToken;
  }
  if (!options.includeReport && redacted.attestation.report) {
    delete redacted.attestation.report.textproto;
  }
  return redacted;
}

async function collectGcpMetadata(
  errors: string[]
): Promise<Record<string, string>> {
  const paths = [
    "project/project-id",
    "project/numeric-project-id",
    "instance/id",
    "instance/name",
    "instance/zone",
    "instance/machine-type",
    "instance/image",
    "instance/service-accounts/default/email"
  ];
  const entries = await Promise.all(
    paths.map(async (path) => {
      const value = await fetchMetadata(path);
      return value ? ([path, value] as const) : null;
    })
  );
  const metadata = Object.fromEntries(entries.filter((item) => item !== null));
  if (Object.keys(metadata).length === 0 && isGcpConfigured()) {
    errors.push("GCP metadata server was not reachable from this process.");
  }
  return metadata;
}

async function collectRuntimeEvidence(): Promise<TeeEvidence["runtime"]> {
  const [kernel, cpuFlags] = await Promise.all([getKernel(), getCpuFlags()]);
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    kernel,
    cpuFlags
  };
}

async function collectGoogleClaimsToken(
  nonce: string,
  includeRawToken: boolean,
  errors: string[]
): Promise<TeeEvidence["attestation"]["token"] | null> {
  try {
    const { stdout } = await execGotpm([
      "token",
      "--audience",
      config.teeAttestationAudience,
      "--custom-nonce",
      nonce
    ]);
    const rawToken = stdout.trim();
    if (!rawToken || rawToken.split(".").length < 3) {
      errors.push("gotpm token returned an invalid JWT.");
      return null;
    }
    const decoded = decodeJwt(rawToken);
    return {
      audience: stringClaim(decoded.claims.aud),
      issuer: stringClaim(decoded.claims.iss),
      subject: stringClaim(decoded.claims.sub),
      issuedAt: numberClaim(decoded.claims.iat),
      expiresAt: numberClaim(decoded.claims.exp),
      tokenHash: sha256Hex(rawToken),
      rawToken: includeRawToken ? rawToken : undefined,
      claims: decoded.claims,
      header: decoded.header
    };
  } catch (error) {
    errors.push(`gotpm token failed: ${errorMessage(error)}`);
    return null;
  }
}

async function collectTpmReport(
  nonce: string,
  includeTextproto: boolean,
  errors: string[]
): Promise<TeeEvidence["attestation"]["report"] | null> {
  try {
    const { stdout } = await execGotpm([
      "attest",
      "--key",
      "gceAK",
      "--nonce",
      sha256Hex(nonce),
      "--format",
      "textproto"
    ]);
    const textproto = stdout;
    return {
      nonce,
      format: "textproto",
      sizeBytes: Buffer.byteLength(textproto),
      reportHash: sha256Hex(textproto),
      textproto: includeTextproto ? textproto : undefined
    };
  } catch (error) {
    errors.push(`gotpm attest failed: ${errorMessage(error)}`);
    return null;
  }
}

async function execGotpm(
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const command = config.gotpmUseSudo ? "/usr/bin/sudo" : config.gotpmPath;
  const finalArgs = config.gotpmUseSudo
    ? ["-n", config.gotpmPath, ...args]
    : args;
  return await execFileAsync(command, finalArgs, {
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

async function fetchMetadata(path: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`${metadataBaseUrl}/${path}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getKernel(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("uname", ["-a"], { timeout: 1000 });
    return stdout.trim();
  } catch {
    return os.release();
  }
}

async function getCpuFlags(): Promise<string[] | undefined> {
  try {
    const cpuInfo = await fs.readFile("/proc/cpuinfo", "utf-8");
    const flagsLine = cpuInfo
      .split("\n")
      .find((line) => line.startsWith("flags") || line.startsWith("Features"));
    const flags = flagsLine?.split(":")[1]?.trim().split(/\s+/) || [];
    const interesting = flags.filter((flag) =>
      ["sev", "sev_es", "sev_snp", "tdx_guest", "tpm", "sme", "aes"].includes(flag)
    );
    return interesting.length > 0 ? interesting : undefined;
  } catch {
    return undefined;
  }
}

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [encodedHeader, encodedClaims] = token.split(".");
  return {
    header: JSON.parse(fromBase64url(encodedHeader).toString("utf-8")) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(fromBase64url(encodedClaims).toString("utf-8")) as Record<
      string,
      unknown
    >
  };
}

function detectEvidenceSource(
  metadata: Record<string, string>,
  token?: TeeEvidence["attestation"]["token"] | null
): string {
  if (token?.claims.hwmodel === "GCP_AMD_SEV") {
    return "gcp-confidential-vm-sev";
  }
  if (Object.keys(metadata).length > 0) {
    return "gcp-vm";
  }
  return "local-dev";
}

function normalizeNonce(value?: string): string {
  if (!value) {
    return randomBytes(24).toString("hex");
  }
  return value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 96) || randomBytes(24).toString("hex");
}

function isGcpConfigured(): boolean {
  return config.teeProvider.includes("google") || config.teeMode.includes("gcp");
}

function shortZone(value?: string): string | undefined {
  return value?.split("/").pop();
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberClaim(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const childError = error as Error & { stderr?: string; code?: string | number };
    const stderr = childError.stderr?.trim();
    return stderr || childError.message;
  }
  return String(error);
}
