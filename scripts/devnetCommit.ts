/** Real devnet commit + PDA read-back for the newest stored run. */

import { readExperimentCommitment } from "../src/server/anchorCommit.js";
import { commitReceiptToDevnet } from "../src/server/solana.js";
import { listRecords, saveRecord } from "../src/server/store.js";

async function main(): Promise<void> {
  const record = listRecords()[0];
  if (!record) {
    throw new Error("No stored runs. Run an experiment first (npm run api:test).");
  }
  console.log(`[chain] committing ${record.id} (${record.experimentId})`);
  const commitment = await commitReceiptToDevnet(record.receipt, false);
  console.log(JSON.stringify(commitment, null, 2));
  record.solanaCommitment = commitment;
  saveRecord(record);
  if (commitment.status !== "confirmed" || commitment.kind !== "anchor-program") {
    throw new Error("commit did not land in the Anchor program");
  }
  const readback = await readExperimentCommitment(record.receipt);
  const failed = readback.checks.filter((check) => check.status === "fail");
  console.log(JSON.stringify(readback, null, 2));
  if (failed.length > 0) {
    throw new Error(`chain read-back failed: ${failed.map((c) => c.name).join(", ")}`);
  }
  console.log("[chain] read-back matches the receipt");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
