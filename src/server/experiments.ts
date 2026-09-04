/** Registry access with a TypeScript-side cross-check of every dataset hash. */

import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256HexSync } from "./canonical.js";
import { registryDir } from "./config.js";
import { getRegistryFromRunner } from "./runnerClient.js";
import type { AuditCheck, ExperimentDetail, ExperimentSummary, Registry, RegistryExperiment } from "./types.js";

let cache: { registry: Registry; loadedAt: string } | null = null;

export async function loadRegistry(force = false): Promise<Registry> {
  if (cache && !force) {
    return cache.registry;
  }
  const registry = await getRegistryFromRunner();
  cache = { registry, loadedAt: new Date().toISOString() };
  return registry;
}

export async function getExperiment(id: string): Promise<RegistryExperiment | undefined> {
  const registry = await loadRegistry();
  return registry.experiments.find((experiment) => experiment.id === id);
}

export function toSummary(experiment: RegistryExperiment, registryHash: string): ExperimentSummary {
  return {
    id: experiment.id,
    kind: experiment.kind,
    title: experiment.title,
    description: experiment.description,
    itemCount: experiment.itemCount,
    datasetHash: experiment.datasetHash,
    experimentHash: experiment.experimentHash,
    registryHash,
    params: experiment.params
  };
}

export function toDetail(experiment: RegistryExperiment, registryHash: string): ExperimentDetail {
  return { ...toSummary(experiment, registryHash), items: experiment.items };
}

/**
 * Recompute dataset/experiment/registry hashes from the JSON files with the
 * TypeScript canonical serialiser and compare with the runner's values.
 */
export async function crossCheckRegistry(): Promise<AuditCheck[]> {
  const registry = await loadRegistry(true);
  const checks: AuditCheck[] = [];
  const entries: Array<{ id: string; experimentHash: string }> = [];
  for (const experiment of registry.experiments) {
    const file = path.join(registryDir, `${experiment.id}.json`);
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch (error) {
      checks.push({ name: `registry-file:${experiment.id}`, status: "fail", detail: String(error) });
      continue;
    }
    const datasetHash = sha256HexSync(canonicalJson(document.items));
    const experimentHash = sha256HexSync(canonicalJson(document));
    entries.push({ id: experiment.id, experimentHash });
    checks.push({
      name: `dataset-hash:${experiment.id}`,
      status: datasetHash === experiment.datasetHash ? "pass" : "fail",
      detail: datasetHash
    });
    checks.push({
      name: `experiment-hash:${experiment.id}`,
      status: experimentHash === experiment.experimentHash ? "pass" : "fail",
      detail: experimentHash
    });
  }
  const registryHash = sha256HexSync(
    canonicalJson({
      schema: "tee-ai-experiment-registry/v1",
      experiments: entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    })
  );
  checks.push({
    name: "registry-hash",
    status: registryHash === registry.registryHash ? "pass" : "fail",
    detail: registryHash
  });
  return checks;
}
