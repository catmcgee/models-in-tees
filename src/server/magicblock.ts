import { Connection } from "@solana/web3.js";
import { config } from "./config.js";

export interface MagicBlockStatus {
  network: "devnet";
  baseLayerRpcUrl: string;
  ephemeralRollupRpcUrl: string;
  privateErMode: "adapter-ready";
  statusApi?: {
    timezone?: string;
    days?: string[];
    regions: MagicBlockRegionStatus[];
  };
  erRpc?: {
    ok: boolean;
    health?: unknown;
    version?: unknown;
    error?: string;
  };
  routePlan: {
    initialization: "base-layer";
    delegation: "base-layer";
    privateOperations: "ephemeral-rollup";
    commit: "ephemeral-rollup-to-base-layer";
    currentDemoCommitment: "base-layer-memo";
  };
}

interface MagicBlockRegionStatus {
  region: string;
  servers: Array<{
    endpoint: string;
    displayName?: string;
    liveStatus: Record<string, boolean | null>;
  }>;
}

export async function getMagicBlockStatus(): Promise<MagicBlockStatus> {
  const [statusApiResult, erRpc] = await Promise.all([
    fetchStatusApi().catch((error) => ({ error: String(error) })),
    probeErRpc().catch((error) => ({ ok: false, error: String(error) }))
  ]);
  const statusApi =
    statusApiResult && !("error" in statusApiResult) ? statusApiResult : undefined;

  return {
    network: "devnet",
    baseLayerRpcUrl: config.solanaRpcUrl,
    ephemeralRollupRpcUrl: config.magicBlockErRpcUrl,
    privateErMode: "adapter-ready",
    statusApi,
    erRpc,
    routePlan: {
      initialization: "base-layer",
      delegation: "base-layer",
      privateOperations: "ephemeral-rollup",
      commit: "ephemeral-rollup-to-base-layer",
      currentDemoCommitment: "base-layer-memo"
    }
  };
}

async function fetchStatusApi(): Promise<MagicBlockStatus["statusApi"]> {
  const response = await fetchWithTimeout(config.magicBlockStatusUrl, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`MagicBlock status API returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as any;
  const regions = body?.environments?.devnet?.regions || {};
  const parsedRegions: MagicBlockRegionStatus[] = Object.entries(regions).map(
    ([region, value]: [string, any]) => {
      const servers = Object.entries(value?.servers || {}).map(
        ([endpoint, server]: [string, any]) => ({
          endpoint,
          displayName: server?.displayName,
          liveStatus: normalizeLiveStatus(server?.live_status || {})
        })
      );
      return { region, servers };
    }
  );
  return {
    timezone: body?.meta?.timezone,
    days: body?.meta?.days,
    regions: parsedRegions
  };
}

async function probeErRpc(): Promise<MagicBlockStatus["erRpc"]> {
  const connection = new Connection(config.magicBlockErRpcUrl, "processed");
  const version = await connection.getVersion();
  const health = await jsonRpc(config.magicBlockErRpcUrl, "getHealth");
  return { ok: true, version, health };
}

function normalizeLiveStatus(
  value: Record<string, unknown>
): Record<string, boolean | null> {
  return Object.fromEntries(
    ["er", "rpc_router", "pricing_oracle", "vrf_oracle"].map((service) => [
      service,
      typeof value[service] === "boolean" ? (value[service] as boolean) : null
    ])
  );
}

async function jsonRpc(url: string, method: string): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "tee-ai", method })
  });
  if (!response.ok) {
    throw new Error(`RPC ${method} returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as any;
  if (body.error) {
    throw new Error(body.error.message || JSON.stringify(body.error));
  }
  return body.result;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 6000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
