import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { config, solanaDir } from "./config.js";
import { sha256Hex } from "./canonical.js";
import { commitReceiptToAnchorProgram } from "./anchorCommit.js";
import type { SignedReceipt, SolanaCommitment } from "./types.js";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);
const payerPath = path.join(solanaDir, "devnet-keypair.json");

export function getBaseConnection(): Connection {
  return new Connection(config.solanaRpcUrl, "confirmed");
}

export function loadOrCreateDevnetPayer(): Keypair {
  fs.mkdirSync(solanaDir, { recursive: true });
  if (fs.existsSync(payerPath)) {
    const secret = JSON.parse(fs.readFileSync(payerPath, "utf-8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const payer = Keypair.generate();
  fs.writeFileSync(payerPath, JSON.stringify([...payer.secretKey]), {
    mode: 0o600
  });
  return payer;
}

export async function getSolanaStatus(): Promise<{
  network: "devnet";
  rpcUrl: string;
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
    payer: payer.publicKey.toBase58(),
    balanceSol: balanceLamports / LAMPORTS_PER_SOL,
    blockhash: blockhash.blockhash
  };
}

export async function commitReceiptToDevnet(
  receipt: SignedReceipt,
  dryRun = false
): Promise<SolanaCommitment> {
  const programCommitment = await commitReceiptToAnchorProgram(receipt, dryRun);
  if (programCommitment.status !== "failed") {
    return programCommitment;
  }

  const connection = getBaseConnection();
  const payer = loadOrCreateDevnetPayer();
  const memoRecord = {
    schema: "tee-ai-devnet-memo/v1",
    receiptDigest: receipt.digest,
    modelCommitment: receipt.payload.model.commitment,
    inputSetHash: receipt.payload.inputSetHash,
    outputSetHash: receipt.payload.outputSetHash,
    metricsHash: receipt.payload.metricsHash,
    teeEvidenceHash: receipt.payload.runner.teeEvidenceHash || null,
    issuedAt: receipt.payload.issuedAt
  };
  const memo = `TEEAI:${JSON.stringify(memoRecord)}`;
  const memoHash = sha256Hex(memo);

  if (dryRun || config.disableSolanaCommit) {
    return {
      status: "dry-run",
      network: "devnet",
      rpcUrl: config.solanaRpcUrl,
      payer: payer.publicKey.toBase58(),
      kind: "memo",
      memo,
      memoHash
    };
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
      network: "devnet",
      rpcUrl: config.solanaRpcUrl,
      payer: payer.publicKey.toBase58(),
      kind: "memo",
      signature,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      memo,
      memoHash
    };
  } catch (error) {
    return {
      status: "failed",
      network: "devnet",
      rpcUrl: config.solanaRpcUrl,
      payer: payer.publicKey.toBase58(),
      kind: "memo",
      memo,
      memoHash,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function ensurePayerHasFunds(
  connection: Connection,
  payer: PublicKey
): Promise<void> {
  const balance = await connection.getBalance(payer, "confirmed");
  if (balance > 0.01 * LAMPORTS_PER_SOL) {
    return;
  }
  const airdropSignature = await connection.requestAirdrop(
    payer,
    0.05 * LAMPORTS_PER_SOL
  );
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature: airdropSignature,
      ...latest
    },
    "confirmed"
  );
}
