import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  GetCommitmentSignature,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commitReceiptToAnchorProgram, getPrivateBenchmarkProgramId } from "./anchorCommit.js";
import { config, solanaDir } from "./config.js";
import type { MagicBlockFlow, SignedReceipt } from "./types.js";

const payerPath = path.join(solanaDir, "devnet-keypair.json");

export async function runMagicBlockReceiptFlow(
  receipt: SignedReceipt
): Promise<MagicBlockFlow> {
  const baseConnection = new Connection(config.solanaRpcUrl, "confirmed");
  const erConnection = new Connection(config.magicBlockErRpcUrl, "confirmed");
  const payer = loadOrCreateDevnetPayer();
  const programId = getPrivateBenchmarkProgramId();
  const anchorCommitment = await commitReceiptToAnchorProgram(receipt, false);

  if (anchorCommitment.status !== "confirmed" || !anchorCommitment.sessionPda) {
    return {
      ok: false,
      network: "devnet",
      erRpcUrl: config.magicBlockErRpcUrl,
      programId: programId.toBase58(),
      payer: payer.publicKey.toBase58(),
      sessionPda: anchorCommitment.sessionPda || "",
      error: anchorCommitment.error || "Could not create base-layer session."
    };
  }

  const session = new PublicKey(anchorCommitment.sessionPda);
  const before = await baseConnection.getAccountInfo(session, "confirmed");
  const flow: MagicBlockFlow = {
    ok: false,
    network: "devnet",
    erRpcUrl: config.magicBlockErRpcUrl,
    programId: programId.toBase58(),
    payer: payer.publicKey.toBase58(),
    sessionPda: session.toBase58(),
    createSignature: anchorCommitment.signature,
    ownerBefore: before?.owner.toBase58() || null
  };

  try {
    if (!before?.owner.equals(DELEGATION_PROGRAM_ID)) {
      flow.delegateSignature = await sendBaseInstruction(
        baseConnection,
        payer,
        buildDelegateSessionInstruction(receipt, session, programId, payer.publicKey)
      );
      await wait(1800);
    }

    const delegated = await baseConnection.getAccountInfo(session, "confirmed");
    flow.ownerAfterDelegate = delegated?.owner.toBase58() || null;
    flow.delegatedOnBase = delegated?.owner.equals(DELEGATION_PROGRAM_ID) || false;

    if (!flow.delegatedOnBase) {
      throw new Error("Base-layer account owner did not switch to the delegation program.");
    }

    flow.finalizeSignature = await sendErInstruction(
      erConnection,
      payer,
      buildFinalizeReceiptInstruction(session, payer.publicKey)
    );
    flow.commitErSignature = await sendErInstruction(
      erConnection,
      payer,
      buildCommitSessionInstruction(session, payer.publicKey)
    );
    flow.baseCommitSignature = await getCommitmentSignatureWithRetry(
      erConnection,
      flow.commitErSignature
    );
    flow.ok = true;
    return flow;
  } catch (error) {
    flow.error = error instanceof Error ? error.message : String(error);
    return flow;
  }
}

function buildDelegateSessionInstruction(
  receipt: SignedReceipt,
  session: PublicKey,
  programId: PublicKey,
  payer: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      {
        pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(session, programId),
        isSigner: false,
        isWritable: true
      },
      {
        pubkey: delegationRecordPdaFromDelegatedAccount(session),
        isSigner: false,
        isWritable: true
      },
      {
        pubkey: delegationMetadataPdaFromDelegatedAccount(session),
        isSigner: false,
        isWritable: true
      },
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([
      instructionDiscriminator("delegate_session"),
      Buffer.from(receipt.digest, "hex")
    ])
  });
}

function buildFinalizeReceiptInstruction(
  session: PublicKey,
  payer: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: getPrivateBenchmarkProgramId(),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: session, isSigner: false, isWritable: true }
    ],
    data: instructionDiscriminator("finalize_receipt")
  });
}

function buildCommitSessionInstruction(
  session: PublicKey,
  payer: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: getPrivateBenchmarkProgramId(),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true }
    ],
    data: instructionDiscriminator("commit_session")
  });
}

async function sendBaseInstruction(
  connection: Connection,
  payer: Keypair,
  instruction: TransactionInstruction
): Promise<string> {
  const transaction = new Transaction().add(instruction);
  return sendAndConfirmTransaction(connection, transaction, [payer], {
    commitment: "confirmed",
    skipPreflight: true
  });
}

async function sendErInstruction(
  connection: Connection,
  payer: Keypair,
  instruction: TransactionInstruction
): Promise<string> {
  const transaction = new Transaction().add(instruction);
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(payer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return signature;
}

async function getCommitmentSignatureWithRetry(
  connection: Connection,
  signature: string
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await GetCommitmentSignature(signature, connection);
    } catch (error) {
      lastError = error;
      await wait(1200 + attempt * 700);
    }
  }
  throw lastError;
}

function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
