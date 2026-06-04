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

  const interpreted = await postJson(`${baseUrl}/api/interpret`, {
    prompt: "The capital of France is",
    corruptedPrompt: "The capital of Germany is",
    targetToken: " Paris",
    topK: 3,
    maxPromptTokens: 64
  });
  const interpretRecord = interpreted.record;
  if (!interpretRecord?.result?.resultHash || !interpretRecord?.receipt?.digest) {
    throw new Error("Interpretability endpoint did not return a result hash and receipt");
  }
  if (
    interpretRecord.result.params.rawActivationsReturned !== false ||
    interpretRecord.result.params.rawAttentionReturned !== false ||
    interpretRecord.result.params.weightsReturned !== false
  ) {
    throw new Error("Interpretability endpoint exposed raw model internals");
  }
  assertNoForbiddenKeys(interpretRecord.result, [
    "hiddenStates",
    "rawHiddenStates",
    "attentionTensor",
    "attentionWeights",
    "stateDict",
    "parameters",
    "gradients",
    "mlpActivations"
  ]);
  const interpretVerification = await postJson(`${baseUrl}/api/verify`, {
    receipt: interpretRecord.receipt
  });
  if (!interpretVerification.verification?.ok) {
    throw new Error(
      `Interpretability receipt verification failed: ${JSON.stringify(interpretVerification)}`
    );
  }
  const interpretAudit = await expectOk(
    `${baseUrl}/api/receipts/${interpretRecord.id}/audit`
  );
  if (!interpretAudit.audit?.ok) {
    throw new Error(`Interpretability receipt audit failed: ${JSON.stringify(interpretAudit)}`);
  }
  const interpretDryRun = await postJson(
    `${baseUrl}/api/receipts/${interpretRecord.id}/commit?dryRun=1`,
    {}
  );
  if (interpretDryRun.solanaCommitment?.status !== "dry-run") {
    throw new Error("Interpretability dry-run Solana commitment did not return dry-run status");
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
        interpretRunId: interpretRecord.id,
        interpretReceiptDigest: interpretRecord.receipt.digest,
        interpretResultHash: interpretRecord.result.resultHash,
        interpretDryRunMemoHash: interpretDryRun.solanaCommitment.memoHash,
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

function assertNoForbiddenKeys(value: unknown, forbidden: string[]): void {
  const keys = new Set(forbidden);
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (keys.has(key)) {
        throw new Error(`Interpretability result exposed forbidden field: ${key}`);
      }
      stack.push(child);
    }
  }
}
