import { once } from "node:events";
import { createServer } from "node:http";
import { createApp } from "../src/server/index.js";

const server = createServer(createApp());
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Could not bind smoke server");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  await expectOk(`${baseUrl}/api/health`);
  await expectOk(`${baseUrl}/api/llm`);
  const teeEvidence = await expectOk(`${baseUrl}/api/tee/evidence`);
  if (!teeEvidence.summary?.evidenceHash) {
    throw new Error("TEE evidence endpoint did not return an evidence hash");
  }

  const generated = await postJson(`${baseUrl}/api/generate`, {
    prompt: "Explain why a private GPT-2 receipt is useful in one sentence.",
    maxNewTokens: 24,
    temperature: 0.7,
    topP: 0.9
  });
  const record = generated.record;
  if (!record?.generation?.output || !record?.receipt?.digest) {
    throw new Error("Generation endpoint did not return text and a receipt");
  }
  if (!record.receipt.payload.runner?.teeEvidenceHash) {
    throw new Error("Generation receipt did not bind TEE evidence");
  }
  const storedEvidence = await expectOk(`${baseUrl}/api/receipts/${record.id}/evidence`);
  if (storedEvidence.summary?.evidenceHash !== record.receipt.payload.runner.teeEvidenceHash) {
    throw new Error("Stored TEE evidence does not match the receipt evidence hash");
  }
  const audit = await expectOk(`${baseUrl}/api/receipts/${record.id}/audit`);
  if (!audit.audit?.ok) {
    throw new Error(`Receipt audit failed: ${JSON.stringify(audit)}`);
  }
  const verification = await postJson(`${baseUrl}/api/verify`, {
    receipt: record.receipt
  });
  if (!verification.verification?.ok) {
    throw new Error(`Receipt verification failed: ${JSON.stringify(verification)}`);
  }
  const dryRun = await postJson(
    `${baseUrl}/api/receipts/${record.id}/commit?dryRun=1`,
    {}
  );
  if (dryRun.solanaCommitment?.status !== "dry-run") {
    throw new Error("Dry-run Solana commitment did not return dry-run status");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId: record.id,
        receiptDigest: record.receipt.digest,
        teeEvidenceHash: record.receipt.payload.runner.teeEvidenceHash,
        workloadHash: audit.audit.workloadHash,
        dryRunMemoHash: dryRun.solanaCommitment.memoHash,
        generatedTokens: record.generation.tokenCount.generated
      },
      null,
      2
    )
  );
} finally {
  server.close();
}

async function expectOk(url: string): Promise<any> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}
