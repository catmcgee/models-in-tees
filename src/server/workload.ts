import fs from "node:fs/promises";
import path from "node:path";
import { config, rootDir } from "./config.js";
import { sha256HexSync } from "./canonical.js";
import type { WorkloadMeasurement } from "./types.js";

const rootFiles = [
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "Anchor.toml",
  "Cargo.toml"
];

const measuredDirs = [
  "src/server",
  "src/shared",
  "src/experiments",
  "src/model",
  "src/web",
  "programs/experiment_receipts/src",
  "dist-server/src/server",
  "dist-server/src/shared",
  "dist/assets"
];

const excludedExtensions = new Set([".map", ".pyc", ".pyo"]);
const excludedDirs = new Set(["__pycache__", ".pytest_cache", "node_modules"]);

export async function getWorkloadMeasurement(): Promise<WorkloadMeasurement> {
  const files = await collectMeasuredFiles();
  const measured = {
    schema: "tee-ai-workload/v1" as const,
    files,
    config: {
      programId: config.experimentProgramId,
      solanaRpcUrl: config.solanaRpcUrl,
      llmModelId: config.llmModelId,
      saeRepo: config.saeRepo,
      saeSubfolder: config.saeSubfolder,
      teeMode: config.teeMode,
      teeProvider: config.teeProvider,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };

  return {
    ...measured,
    generatedAt: new Date().toISOString(),
    workloadHash: sha256HexSync(measured)
  };
}

async function collectMeasuredFiles(): Promise<WorkloadMeasurement["files"]> {
  const paths = new Set<string>();
  for (const file of rootFiles) {
    if (await exists(path.join(rootDir, file))) {
      paths.add(file);
    }
  }
  for (const dir of measuredDirs) {
    const absolute = path.join(rootDir, dir);
    if (await exists(absolute)) {
      for (const file of await walk(absolute)) {
        paths.add(path.relative(rootDir, file));
      }
    }
  }

  return Promise.all(
    [...paths]
      .filter((file) => !excludedExtensions.has(path.extname(file)))
      .sort()
      .map(async (file) => {
        const data = await fs.readFile(path.join(rootDir, file));
        return { path: file, sizeBytes: data.length, sha256: sha256HexSync(data) };
      })
  );
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return excludedDirs.has(entry.name) ? [] : await walk(absolute);
      }
      return entry.isFile() ? [absolute] : [];
    })
  );
  return nested.flat();
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
