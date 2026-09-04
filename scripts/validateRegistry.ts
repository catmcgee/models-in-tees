/**
 * Cross-language guard: TypeScript primitives must reproduce the Python test
 * vectors, the registry must validate under the real tokenizer, and every
 * dataset hash must agree between the two serialisers.
 */

import fs from "node:fs";
import path from "node:path";
import { crossCheckRegistry } from "../src/server/experiments.js";
import { stopRunner, validateRegistry } from "../src/server/runnerClient.js";
import { checkTestVectors, type TestVectors } from "../src/shared/vectors.js";

async function main(): Promise<void> {
  const vectorsPath = path.resolve("src/shared/test-vectors.json");
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf-8")) as TestVectors;
  const vectorChecks = await checkTestVectors(vectors);
  report("test vectors", vectorChecks);

  let ok = vectorChecks.every((c) => c.status === "pass");
  try {
    const runnerReport = await validateRegistry();
    console.log(`[registry] runner validation ${runnerReport.ok ? "ok" : "FAILED"} hash=${runnerReport.registryHash ?? "n/a"}`);
    for (const error of runnerReport.errors) {
      console.log(`  - ${error}`);
    }
    ok = ok && runnerReport.ok;
    const cross = await crossCheckRegistry();
    report("cross-check", cross);
    ok = ok && cross.every((c) => c.status === "pass");
  } finally {
    await stopRunner();
  }
  if (!ok) {
    process.exit(1);
  }
}

function report(label: string, checks: Array<{ name: string; status: string; detail?: string }>): void {
  const failed = checks.filter((c) => c.status !== "pass");
  console.log(`[${label}] ${checks.length - failed.length}/${checks.length} pass`);
  for (const check of failed) {
    console.log(`  FAIL ${check.name}: ${check.detail ?? ""}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
