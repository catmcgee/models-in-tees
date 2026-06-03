import cors from "cors";
import express from "express";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { auditReceiptEvidence } from "./audit.js";
import { config, rootDir } from "./config.js";
import { getMagicBlockStatus } from "./magicblock.js";
import { runMagicBlockReceiptFlow } from "./magicblockProgram.js";
import { bootstrapModel, getModelInfo, runBenchmarkCases } from "./modelRunner.js";
import { createSignedReceipt, verifySignedReceipt } from "./receipts.js";
import { commitReceiptToDevnet, getSolanaStatus } from "./solana.js";
import { getRecord, listRecords, saveRecord } from "./store.js";
import {
  getTeeEvidence,
  redactTeeEvidence,
  summarizeTeeEvidence
} from "./teeEvidence.js";
import type { BenchmarkCase, BenchmarkRecord, SignedReceipt } from "./types.js";

const caseSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  prompt: z.string().min(8).max(2400),
  expected: z.string().min(1).max(40).nullable().optional()
});

const benchmarkSchema = z.object({
  cases: z.array(caseSchema).min(1).max(64)
});

export function createApp(): express.Express {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "tee-ai-private-benchmark",
      teeMode: config.teeMode,
      network: "devnet"
    });
  });

  app.post("/api/model/bootstrap", async (req, res) => {
    try {
      if (!config.allowModelBootstrap) {
        res.status(403).json({
          ok: false,
          error: "Model bootstrap is disabled. Set ALLOW_MODEL_BOOTSTRAP=1 to enable it."
        });
        return;
      }
      const result = await bootstrapModel(req.query.force === "1");
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/model", async (_req, res) => {
    try {
      res.json({ ok: true, model: await getModelInfo() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/benchmark", async (req, res) => {
    try {
      const parsed = benchmarkSchema.parse(req.body);
      const cases = parsed.cases as BenchmarkCase[];
      const run = await runBenchmarkCases(cases);
      const id = `bench-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const teeEvidence = await getTeeEvidence({ includeToken: true });
      const receipt = createSignedReceipt(id, cases, run, teeEvidence);
      const record = saveRecord({
        id,
        cases,
        run,
        receipt,
        teeEvidence,
        solanaCommitment: null,
        magicBlockFlow: null,
        createdAt: new Date().toISOString()
      });
      res.json({ ok: true, record: publicRecord(record) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/tee/evidence", async (req, res) => {
    try {
      const includeToken = req.query.includeToken === "1" && config.allowRawTeeEvidence;
      const includeReport = req.query.includeReport === "1" && config.allowRawTeeEvidence;
      const evidence = await getTeeEvidence({
        nonce: stringParam(req.query.nonce),
        includeToken,
        includeReport
      });
      res.json({
        ok: true,
        evidence: redactTeeEvidence(evidence, { includeToken, includeReport }),
        summary: summarizeTeeEvidence(evidence)
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/tee/evidence", async (req, res) => {
    try {
      const includeToken = req.body?.includeToken === true && config.allowRawTeeEvidence;
      const includeReport = req.body?.includeReport === true && config.allowRawTeeEvidence;
      const evidence = await getTeeEvidence({
        nonce: typeof req.body?.nonce === "string" ? req.body.nonce : undefined,
        includeToken,
        includeReport
      });
      res.json({
        ok: true,
        evidence: redactTeeEvidence(evidence, { includeToken, includeReport }),
        summary: summarizeTeeEvidence(evidence)
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/receipts", (_req, res) => {
    const records = config.allowPublicReceiptListing
      ? listRecords().map(publicRecord)
      : [];
    res.json({ ok: true, records });
  });

  app.get("/api/receipts/:id", (req, res) => {
    const record = getRecord(req.params.id);
    if (!record) {
      res.status(404).json({ ok: false, error: "Receipt not found" });
      return;
    }
    res.json({ ok: true, record: publicRecord(record) });
  });

  app.get("/api/receipts/:id/evidence", (req, res) => {
    const record = getRecord(req.params.id);
    if (!record) {
      res.status(404).json({ ok: false, error: "Receipt not found" });
      return;
    }
    if (!record.teeEvidence) {
      res.status(404).json({ ok: false, error: "TEE evidence not stored" });
      return;
    }
    const includeToken = req.query.includeToken === "1" && config.allowRawTeeEvidence;
    const includeReport = req.query.includeReport === "1" && config.allowRawTeeEvidence;
    res.json({
      ok: true,
      evidence: redactTeeEvidence(record.teeEvidence, { includeToken, includeReport }),
      summary: summarizeTeeEvidence(record.teeEvidence)
    });
  });

  app.get("/api/receipts/:id/audit", async (req, res) => {
    try {
      const record = getRecord(req.params.id);
      if (!record) {
        res.status(404).json({ ok: false, error: "Receipt not found" });
        return;
      }
      const audit = await auditReceiptEvidence(record.receipt, record.teeEvidence);
      res.json({ ok: audit.ok, audit });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/receipts/:id/commit", async (req, res) => {
    try {
      const record = getRecord(req.params.id);
      if (!record) {
        res.status(404).json({ ok: false, error: "Receipt not found" });
        return;
      }
      const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;
      const solanaCommitment = await commitReceiptToDevnet(record.receipt, dryRun);
      record.solanaCommitment = solanaCommitment;
      saveRecord(record);
      res.json({ ok: true, solanaCommitment, record: publicRecord(record) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/receipts/:id/magicblock", async (req, res) => {
    try {
      const record = getRecord(req.params.id);
      if (!record) {
        res.status(404).json({ ok: false, error: "Receipt not found" });
        return;
      }
      const magicBlockFlow = await runMagicBlockReceiptFlow(record.receipt);
      record.magicBlockFlow = magicBlockFlow;
      saveRecord(record);
      res.json({ ok: magicBlockFlow.ok, magicBlockFlow, record: publicRecord(record) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/verify", (req, res) => {
    const receipt = req.body?.receipt as SignedReceipt | undefined;
    if (!receipt) {
      res.status(400).json({ ok: false, error: "Missing receipt" });
      return;
    }
    res.json({ ok: true, verification: verifySignedReceipt(receipt) });
  });

  app.post("/api/audit", async (req, res) => {
    try {
      const receipt = req.body?.receipt as SignedReceipt | undefined;
      if (!receipt) {
        res.status(400).json({ ok: false, error: "Missing receipt" });
        return;
      }
      const audit = await auditReceiptEvidence(receipt, req.body?.evidence || null);
      res.json({ ok: audit.ok, audit });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/solana/status", async (_req, res) => {
    try {
      res.json({ ok: true, solana: await getSolanaStatus() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/magicblock/status", async (_req, res) => {
    try {
      res.json({ ok: true, magicblock: await getMagicBlockStatus() });
    } catch (error) {
      sendError(res, error);
    }
  });

  const staticDir = path.join(rootDir, "dist");
  app.use(express.static(staticDir));
  app.get("*", (_req, res, next) => {
    if (fs.existsSync(path.join(staticDir, "index.html"))) {
      res.sendFile(path.join(staticDir, "index.html"));
      return;
    }
    next();
  });

  return app;
}

function sendError(res: express.Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: error.flatten() });
    return;
  }
  res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function publicRecord(record: BenchmarkRecord): Omit<BenchmarkRecord, "teeEvidence"> {
  const { teeEvidence: _teeEvidence, ...safeRecord } = record;
  return safeRecord;
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === __filename
  : false;

if (isDirectRun) {
  createApp().listen(config.apiPort, () => {
    console.log(`API listening on http://127.0.0.1:${config.apiPort}`);
  });
}
