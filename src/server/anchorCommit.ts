/**
 * experiment_receipts Anchor program client (hand-rolled Borsh, no IDL).
 *
 *   commit_experiment(args) -> PDA ["experiment", receipt_digest]
 *   ExperimentCommitment { authority, receipt_digest, model_commitment,
 *     experiment_id_hash, dataset_hash, results_root, policy_hash,
 *     tee_evidence_hash, leaf_count: u32, committed_at: i64, bump: u8 }
 */

import {
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { canonicalJson, sha256HexSync } from "./canonical.js";
import { ensurePayerHasFunds, getBaseConnection, loadOrCreateDevnetPayer } from "./solanaPayer.js";
import type { AuditCheck, ChainReadback, SignedExperimentReceipt, SolanaCommitment } from "./types.js";

const EXPERIMENT_SEED = Buffer.from("experiment");
const ACCOUNT_LEN = 8 + 32 + 32 * 7 + 4 + 8 + 1;

export function getExperimentProgramId(): PublicKey {
  return new PublicKey(config.experimentProgramId);
}

export function deriveExperimentPda(receiptDigest: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [EXPERIMENT_SEED, hexToBytes(receiptDigest)],
    getExperimentProgramId()
  );
  return pda;
}

export function experimentIdHash(id: string): string {
  return createHash("sha256").update(id, "utf-8").digest("hex");
}

interface CommitFields {
  receiptDigest: string;
  modelCommitment: string;
  experimentIdHash: string;
  datasetHash: string;
  resultsRoot: string;
  policyHash: string;
  teeEvidenceHash: string;
  leafCount: number;
}

export function commitFields(receipt: SignedExperimentReceipt): CommitFields {
  const p = receipt.payload;
  return {
    receiptDigest: receipt.digest,
    modelCommitment: p.model.commitment,
    experimentIdHash: experimentIdHash(p.experiment.id),
    datasetHash: p.experiment.datasetHash,
    resultsRoot: p.results.resultsRoot,
    policyHash: p.policyHash,
    teeEvidenceHash: p.attestation.teeEvidenceHash,
    leafCount: p.results.leafCount
  };
}

export async function commitExperimentToAnchorProgram(
  receipt: SignedExperimentReceipt,
  dryRun = false
): Promise<SolanaCommitment> {
  const connection = getBaseConnection();
  const payer = loadOrCreateDevnetPayer();
  const programId = getExperimentProgramId();
  const pda = deriveExperimentPda(receipt.digest);
  const message = buildCommitmentMessage(receipt);
  const memoHash = sha256HexSync(message);
  const base = {
    network: "devnet" as const,
    rpcUrl: config.solanaRpcUrl,
    payer: payer.publicKey.toBase58(),
    kind: "anchor-program" as const,
    programId: programId.toBase58(),
    commitmentPda: pda.toBase58(),
    memo: message,
    memoHash
  };

  if (dryRun || config.disableSolanaCommit) {
    return { status: "dry-run", ...base };
  }

  try {
    await ensurePayerHasFunds(connection, payer.publicKey);
    const existing = await connection.getAccountInfo(pda, "confirmed");
    if (existing) {
      return { status: "confirmed", ...base };
    }
    const instruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: encodeCommitExperimentArgs(commitFields(receipt))
    });
    const signature = await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer], {
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
    return {
      status: "failed",
      ...base,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function readExperimentCommitment(
  receipt: SignedExperimentReceipt,
  connection: Connection = getBaseConnection()
): Promise<ChainReadback> {
  const programId = getExperimentProgramId();
  const pda = deriveExperimentPda(receipt.digest);
  const checks: AuditCheck[] = [];
  const base = {
    programId: programId.toBase58(),
    pda: pda.toBase58(),
    explorerUrl: `https://explorer.solana.com/address/${pda.toBase58()}?cluster=devnet`
  };
  const account = await connection.getAccountInfo(pda, "confirmed");
  if (!account) {
    checks.push({ name: "chain-account-exists", status: "fail", detail: "no commitment account at the PDA" });
    return { ...base, exists: false, checks };
  }
  checks.push({ name: "chain-account-exists", status: "pass", detail: pda.toBase58() });
  checks.push({
    name: "chain-account-owner",
    status: account.owner.equals(programId) ? "pass" : "fail",
    detail: account.owner.toBase58()
  });
  const data = account.data;
  if (data.length !== ACCOUNT_LEN) {
    checks.push({ name: "chain-account-size", status: "fail", detail: `${data.length} bytes, expected ${ACCOUNT_LEN}` });
    return { ...base, exists: true, checks };
  }
  checks.push({ name: "chain-account-size", status: "pass", detail: `${data.length} bytes` });
  const discriminator = accountDiscriminator("ExperimentCommitment");
  checks.push({
    name: "chain-discriminator",
    status: data.subarray(0, 8).equals(discriminator) ? "pass" : "fail",
    detail: data.subarray(0, 8).toString("hex")
  });

  let offset = 8;
  const readPubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const readHash = () => {
    const value = data.subarray(offset, offset + 32).toString("hex");
    offset += 32;
    return value;
  };
  const decoded = {
    authority: readPubkey(),
    receiptDigest: readHash(),
    modelCommitment: readHash(),
    experimentIdHash: readHash(),
    datasetHash: readHash(),
    resultsRoot: readHash(),
    policyHash: readHash(),
    teeEvidenceHash: readHash(),
    leafCount: data.readUInt32LE(offset),
    committedAt: Number(data.readBigInt64LE(offset + 4)),
    bump: data.readUInt8(offset + 12)
  };

  const expected = commitFields(receipt);
  const compare = (name: string, actual: string | number, wanted: string | number) =>
    checks.push({ name, status: actual === wanted ? "pass" : "fail", detail: String(actual) });
  compare("chain-receipt-digest", decoded.receiptDigest, expected.receiptDigest);
  compare("chain-model-commitment", decoded.modelCommitment, expected.modelCommitment);
  compare("chain-experiment-id", decoded.experimentIdHash, expected.experimentIdHash);
  compare("chain-dataset-hash", decoded.datasetHash, expected.datasetHash);
  compare("chain-results-root", decoded.resultsRoot, expected.resultsRoot);
  compare("chain-policy-hash", decoded.policyHash, expected.policyHash);
  compare("chain-tee-evidence-hash", decoded.teeEvidenceHash, expected.teeEvidenceHash);
  compare("chain-leaf-count", decoded.leafCount, expected.leafCount);
  return { ...base, exists: true, account: decoded, checks };
}

export function encodeCommitExperimentArgs(fields: CommitFields): Buffer {
  return Buffer.concat([
    instructionDiscriminator("commit_experiment"),
    hexToBytes(fields.receiptDigest),
    hexToBytes(fields.modelCommitment),
    hexToBytes(fields.experimentIdHash),
    hexToBytes(fields.datasetHash),
    hexToBytes(fields.resultsRoot),
    hexToBytes(fields.policyHash),
    hexToBytes(fields.teeEvidenceHash),
    u32le(fields.leafCount)
  ]);
}

function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export function buildCommitmentMessage(receipt: SignedExperimentReceipt): string {
  return canonicalJson({
    schema: "tee-ai-anchor-commit/v2",
    ...commitFields(receipt),
    experimentId: receipt.payload.experiment.id,
    registryHash: receipt.payload.experiment.registryHash,
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
