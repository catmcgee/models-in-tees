import type { ExperimentKind, TeeEvidenceSummary } from "./types.js";

export function shortHash(value?: string | null, length = 10): string {
  if (!value) return "pending";
  if (value.length <= length * 2 + 3) return value;
  return `${value.slice(0, length)}…${value.slice(-length)}`;
}

export function formatMs(value?: number | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "n/a";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function pctMilli(value: number): string {
  return `${(value / 10).toFixed(1)}%`;
}

export function pctBp(value: number, signed = false): string {
  const percent = value / 100;
  return `${signed && percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

/** Fixed-point metric formatting keyed on the unit suffix. */
export function formatMetric(key: string, value: unknown): string {
  if (typeof value !== "number") return String(value);
  if (/(Accuracy|Rate|Fraction|Recovery|Baseline|FavoringA)Milli$/.test(key)) return pctMilli(value);
  if (/LogProbMilli$/.test(key)) return (value / 1000).toFixed(3);
  if (/(PerToken|L0)Milli$/.test(key)) return (value / 1000).toFixed(1);
  if (/Milli$/.test(key)) return (value / 1000).toFixed(3);
  if (/GapBp$/.test(key)) return pctBp(value, true);
  if (/Bp$/.test(key)) return pctBp(value);
  if (/Centi$/.test(key)) return (value / 100).toFixed(2);
  return String(value);
}

export function labelize(key: string): string {
  return key
    .replace(/(Milli|Bp|Centi)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export const KIND_LABELS: Record<ExperimentKind, string> = {
  "expected-token": "Behavior eval",
  memorization: "Memorization",
  "paired-bias": "Paired bias",
  "linear-probe": "Linear probe",
  "activation-patching": "Activation patching",
  "sae-features": "SAE features"
};

export function kindLabel(kind: ExperimentKind): string {
  return KIND_LABELS[kind] ?? kind;
}

export function modelDisplayName(modelId?: string | null): string {
  if (!modelId) return "the model";
  const tail = modelId.split("/").pop() || modelId;
  return tail
    .replace(/[-_]+/g, " ")
    .replace(/\s*\bpt\b/i, "")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/(\d)b\b/g, "$1B");
}

export function teeRuntimeName(evidence?: TeeEvidenceSummary | null, teeMode?: string): string {
  const source = `${evidence?.source || ""} ${teeMode || ""}`.toLowerCase();
  if (evidence?.hardwareModel) return evidence.hardwareModel;
  if (source.includes("gcp") || source.includes("confidential")) return "GCP Confidential VM";
  if (source.includes("local") || evidence?.attestationStatus === "unavailable") return "local TEE simulator";
  return teeMode || "TEE";
}

export function hardwareClaim(evidence?: TeeEvidenceSummary | null): string {
  if (!evidence) return "pending";
  if (evidence.hardwareModel) {
    return `${evidence.hardwareModel}${evidence.secureBoot ? " · secure boot" : ""}`;
  }
  return evidence.attestationStatus === "unavailable" ? "local simulation" : evidence.attestationStatus;
}

export function architectureLine(arch?: Record<string, unknown> | null): string {
  if (!arch) return "pending";
  const layers = arch.numHiddenLayers;
  const hidden = arch.hiddenSize;
  const heads = arch.numAttentionHeads;
  if (layers && hidden && heads) {
    return `${String(arch.family || "model")} · ${layers} layers · ${hidden} hidden · ${heads} heads`;
  }
  return String(arch.family || "model");
}

export function itemPreview(item: Record<string, unknown> | undefined): string {
  if (!item) return "";
  const text =
    item.prompt ?? item.text ?? item.prefix ?? item.cleanPrompt ?? item.promptA ?? Object.values(item)[0];
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
}
