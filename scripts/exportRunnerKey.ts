/** Writes public/runner-key.json so the frontend can pin the runner's key. */

import fs from "node:fs";
import path from "node:path";
import { getRunnerKey } from "../src/server/receipts.js";

async function main(): Promise<void> {
  const key = await getRunnerKey();
  const target = path.resolve("public/runner-key.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify(
      {
        schema: "tee-ai-runner-key/v1",
        publicKeyPem: key.publicKeyPem,
        publicKeyFingerprint: key.publicKeyFingerprint,
        exportedAt: new Date().toISOString(),
        note: "Ed25519 public key of the receipt signer. Fingerprint = sha256(SPKI DER)."
      },
      null,
      2
    )}\n`
  );
  console.log(`wrote ${target} (${key.publicKeyFingerprint})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
