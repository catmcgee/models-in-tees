import {
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { config } from "./config.js";
import { sha256HexSync } from "./canonical.js";
import { commitExperimentToAnchorProgram, commitFields } from "./anchorCommit.js";
import { ensurePayerHasFunds, getBaseConnection, loadOrCreateDevnetPayer } from "./solanaPayer.js";
import type { SignedExperimentReceipt, SolanaCommitment } from "./types.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export { getBaseConnection, loadOrCreateDevnetPayer } from "./solanaPayer.js";

export async function getSolanaStatus(): Promise<{
  network: "devnet";
  rpcUrl: string;
  programId: string;
  payer: string;
  balanceSol: number;
  blockhash: string;
}> {
  const connection = getBaseConnection();
  const payer = loadOrCreateDevnetPayer();
  const [balanceLamports, blockhash] = await Promise.all([
    connection.getBalance(payer.publicKey, "confirmed"),
    connection.getLatestBlockhash("confirmed")
  ]);
  return {
    network: "devnet",
    rpcUrl: config.solanaRpcUrl,
    programId: config.experimentProgramId,
    payer: payer.publicKey.toBase58(),
    balanceSol: balanceLamports / LAMPORTS_PER_SOL,
    blockhash: blockhash.blockhash
  };
}

/** Anchor program first; Memo only if the program commit fails outright. */
export async function commitReceiptToDevnet(
  receipt: SignedExperimentReceipt,
  dryRun = false
): Promise<SolanaCommitment> {
  const programCommitment = await commitExperimentToAnchorProgram(receipt, dryRun);
  if (programCommitment.status !== "failed") {
    return programCommitment;
  }
  const memoCommitment = await commitMemo(receipt, dryRun);
  return { ...memoCommitment, anchorError: programCommitment.error };
}

async function commitMemo(receipt: SignedExperimentReceipt, dryRun: boolean): Promise<SolanaCommitment> {
  const connection = getBaseConnection();
  const payer = loadOrCreateDevnetPayer();
  const memo = `TEEAI:${JSON.stringify(buildMemoRecord(receipt))}`;
  const memoHash = sha256HexSync(memo);
  const base = {
    network: "devnet" as const,
    rpcUrl: config.solanaRpcUrl,
    payer: payer.publicKey.toBase58(),
    kind: "memo" as const,
    memo,
    memoHash
  };
  if (dryRun || config.disableSolanaCommit) {
    return { status: "dry-run", ...base };
  }
  try {
    await ensurePayerHasFunds(connection, payer.publicKey);
    const transaction = new Transaction().add(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
        data: Buffer.from(memo, "utf-8")
      })
    );
    const signature = await sendAndConfirmTransaction(connection, transaction, [payer], {
      commitment: "confirmed",
      skipPreflight: false
    });
    return {
      status: "confirmed",
      ...base,
      signature,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    };
  } catch (error) {
    return { status: "failed", ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildMemoRecord(receipt: SignedExperimentReceipt): Record<string, unknown> {
  return {
    schema: "tee-ai-devnet-experiment-memo/v1",
    receiptSchema: receipt.payload.schema,
    experimentId: receipt.payload.experiment.id,
    registryHash: receipt.payload.experiment.registryHash,
    ...commitFields(receipt),
    issuedAt: receipt.payload.issuedAt
  };
}
