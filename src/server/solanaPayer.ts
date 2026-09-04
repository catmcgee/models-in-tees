import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { config, solanaDir } from "./config.js";

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
  fs.writeFileSync(payerPath, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
  return payer;
}

export async function ensurePayerHasFunds(connection: Connection, payer: PublicKey): Promise<void> {
  const balance = await connection.getBalance(payer, "confirmed");
  if (balance > 0.01 * LAMPORTS_PER_SOL) {
    return;
  }
  const airdropSignature = await connection.requestAirdrop(payer, 0.05 * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: airdropSignature, ...latest }, "confirmed");
}
