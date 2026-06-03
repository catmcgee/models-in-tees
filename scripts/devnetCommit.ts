import { generateText } from "../src/server/modelRunner.js";
import { createSignedGenerationReceipt } from "../src/server/receipts.js";
import { commitReceiptToDevnet } from "../src/server/solana.js";

const generation = await generateText({
  prompt: "Explain private GPT-2 receipts in one sentence.",
  maxNewTokens: 24,
  temperature: 0.7,
  topP: 0.9,
  seed: 20260603
});
const receipt = createSignedGenerationReceipt(
  `chain-${Date.now().toString(36)}`,
  generation
);
const commitment = await commitReceiptToDevnet(receipt, false);

console.log(
  JSON.stringify(
    {
      ok: commitment.status === "confirmed",
      receiptDigest: receipt.digest,
      generatedTokens: generation.tokenCount.generated,
      commitment
    },
    null,
    2
  )
);

if (commitment.status !== "confirmed") {
  process.exitCode = 1;
}
