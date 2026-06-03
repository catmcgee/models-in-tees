import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, solanaDir } from "./config.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { SignedReceipt, SolanaCommitment } from "./types.js";

const SESSION_SEED = Buffer.from("session");
const payerPath = path.join(solanaDir, "devnet-keypair.json");

export function getPrivateBenchmarkProgramId(): PublicKey {
  return new PublicKey(config.privateBenchmarkProgramId);
}

export function deriveSessionPda(receiptDigest: string): PublicKey {
  const [session] = PublicKey.findProgramAddressSync(
    [SESSION_SEED, hexToBytes(receiptDigest)],
    getPrivateBenchmarkProgramId()
  );
  return session;
}

export async function commitReceiptToAnchorProgram(
  receipt: SignedReceipt,
  dryRun = false
): Promise<SolanaCommitment> {
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const payer = loadOrCreateDevnetPayer();
  const programId = getPrivateBenchmarkProgramId();
  const sessionPda = deriveSessionPda(receipt.digest);
  const message = buildCommitmentMessage(receipt);
  const memoHash = sha256Hex(message);

  if (dryRun || config.disableSolanaCommit) {
    return {
      status: "dry-run",
      network: "devnet",
      rpcUrl: config.solanaRpcUrl,
      payer: payer.publicKey.toBase58(),
      kind: "anchor-program",
      programId: programId.toBase58(),
      sessionPda: sessionPda.toBase58(),
      memo: message,
      memoHash
    };
  }

  try {
    await ensurePayerHasFunds(connection, payer.publicKey);
    const existing = await connection.getAccountInfo(sessionPda, "confirmed");
    if (existing) {
      return {
        status: "confirmed",
        network: "devnet",
        rpcUrl: config.solanaRpcUrl,
        payer: payer.publicKey.toBase58(),
        kind: "anchor-program",
        programId: programId.toBase58(),
        sessionPda: sessionPda.toBase58(),
        memo: message,
        memoHash
      };
    }

    const instruction = buildCreateReceiptInstruction(
      receipt,
      payer.publicKey,
      sessionPda,
      programId
    );
    const transaction = new Transaction().add(instruction);
    const signature = await sendAndConfirmTransaction(connection, transaction, [payer], {
      commitment: "confirmed",
      skipPreflight: false
    });

    return {
      status: "confirmed",
      network: "devnet",
      rpcUrl: config.solanaRpcUrl,
      payer: payer.publicKey.toBase58(),
      kind: "anchor-program",
      programId: programId.toBase58(),
      sessionPda: sessionPda.toBase58(),
      signature,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      memo: message,
      memoHash
    };
  } catch (error) {
    return {
      status: "failed",
      network: "devnet",
      rpcUrl: config.solanaRpcUrl,
      payer: payer.publicKey.toBase58(),
      kind: "anchor-program",
      programId: programId.toBase58(),
      sessionPda: sessionPda.toBase58(),
      memo: message,
      memoHash,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function fetchSessionAccount(
  connection: Connection,
  sessionPda: PublicKey
): Promise<Buffer | null> {
  const account = await connection.getAccountInfo(sessionPda, "confirmed");
  return account?.data || null;
}

function buildCreateReceiptInstruction(
  receipt: SignedReceipt,
  payer: PublicKey,
  sessionPda: PublicKey,
  programId: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: encodeCreateReceiptArgs(receipt)
  });
}

function encodeCreateReceiptArgs(receipt: SignedReceipt): Buffer {
  const discriminator = instructionDiscriminator("create_receipt");
  const accuracy = receipt.payload.metrics.accuracy;
  const accuracyPpm =
    typeof accuracy === "number" ? Math.round(Math.max(0, Math.min(1, accuracy)) * 1_000_000) : 0;
  const body = Buffer.concat([
    hexToBytes(receipt.digest),
    hexToBytes(receipt.payload.inputSetHash),
    hexToBytes(receipt.payload.outputSetHash),
    hexToBytes(receipt.payload.metricsHash),
    hexToBytes(receipt.payload.model.commitment),
    u32le(accuracyPpm),
    u16le(receipt.payload.metrics.caseCount)
  ]);
  return Buffer.concat([discriminator, body]);
}

function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function buildCommitmentMessage(receipt: SignedReceipt): string {
  return canonicalJson({
    schema: "tee-ai-anchor-commit/v1",
    receiptDigest: receipt.digest,
    modelCommitment: receipt.payload.model.commitment,
    inputSetHash: receipt.payload.inputSetHash,
    outputSetHash: receipt.payload.outputSetHash,
    metricsHash: receipt.payload.metricsHash,
    teeEvidenceHash: receipt.payload.runner.teeEvidenceHash || null,
    issuedAt: receipt.payload.issuedAt
  });
}

function hexToBytes(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Expected 32-byte hex string, got ${value}`);
  }
  return Buffer.from(value, "hex");
}

function u32le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u16le(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(Math.min(value, 65535));
  return buffer;
}

function loadOrCreateDevnetPayer(): Keypair {
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

async function ensurePayerHasFunds(
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
