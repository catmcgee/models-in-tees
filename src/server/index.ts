import cors from "cors";
import express from "express";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAttestationNonce } from "../shared/nonce.js";
import { verifyExperimentRecord } from "../shared/verify.js";
import { readExperimentCommitment } from "./anchorCommit.js";
import { auditReceiptEvidence } from "./audit.js";
import { config, rootDir } from "./config.js";
import { cachedRegistry, getExperiment, loadModelInfo, loadRegistry, primeCaches, toDetail, toSummary } from "./experiments.js";
import { CanonicalMismatchError, createSignedExperimentReceipt, getRunnerKey } from "./receipts.js";
import { currentRun, tryAcquire } from "./runLock.js";
import { getRunner, runExperiment, RunnerRequestError, warmRunner } from "./runnerClient.js";
import { commitReceiptToDevnet, getSolanaStatus } from "./solana.js";
import {
  getRecord,
  listRecords,
  listRecordsForExperiment,
  saveRecord,
  saveSealed,
  toPublicRecord
} from "./store.js";
import { getTeeEvidence, redactTeeEvidence, summarizeTeeEvidence } from "./teeEvidence.js";
import type { ExperimentRecord, PublicExperimentRecord, SignedExperimentReceipt } from "./types.js";

export function createApp(): express.Express {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", async (_req, res) => {
    const runner = getRunner().status();
    let registry: { ok: boolean; hash: string | null; experimentCount: number } = {
      ok: false,
      hash: null,
      experimentCount: 0
    };
    // Never wait on the worker here: a run may be in flight and the worker is serial.
    const loaded = cachedRegistry();
    if (loaded) {
      registry = { ok: true, hash: loaded.registryHash, experimentCount: loaded.experiments.length };
    }
    res.json({
      ok: true,
      service: config.serviceName,
      teeMode: config.teeMode,
      teeProvider: config.teeProvider,
      network: "devnet",
      runner: {
        state: runner.state,
        restarts: runner.restarts,
        startedAt: runner.startedAt,
        loadMs: runner.ready?.loadMs ?? null,
        lastError: runner.lastError
      },
      model: runner.ready?.model ?? null,
      registry,
      busy: currentRun()
    });
  });

  app.get("/api/model", async (_req, res) => {
    try {
      res.json({ ok: true, model: await loadModelInfo() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/experiments", async (_req, res) => {
    try {
      const registry = await loadRegistry();
      res.json({
        ok: true,
        registryHash: registry.registryHash,
        experiments: registry.experiments.map((experiment) => toSummary(experiment, registry.registryHash))
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/experiments/:id", async (req, res) => {
    try {
      const registry = await loadRegistry();
      const experiment = registry.experiments.find((item) => item.id === req.params.id);
      if (!experiment) {
        res.status(404).json({ ok: false, error: "Unknown experiment" });
        return;
      }
      res.json({
        ok: true,
        experiment: toDetail(experiment, registry.registryHash),
        runs: listRecordsForExperiment(experiment.id).map(toPublicRecord)
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/experiments/:id/run", async (req, res) => {
    let release: (() => void) | null = null;
    try {
      const experiment = await getExperiment(req.params.id);
      if (!experiment) {
        res.status(404).json({ ok: false, error: "Unknown experiment" });
        return;
      }
      const runId = `exp-${experiment.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const lock = tryAcquire({ experimentId: experiment.id, runId, startedAt: new Date().toISOString() });
      if (!lock) {
        res.setHeader("Retry-After", "30");
        res.status(409).json({ ok: false, error: "runner-busy", running: currentRun() });
        return;
      }
      release = lock.release;

      const startedAt = Date.now();
      const result = await runExperiment(experiment.id);
      const key = await getRunnerKey();
      const nonce = await deriveAttestationNonce({
        resultsRoot: result.results.resultsRoot,
        datasetHash: result.experiment.datasetHash,
        registryHash: result.experiment.registryHash,
        modelCommitment: result.model.commitment,
        policyHash: result.policyHash,
        publicKeyFingerprint: key.publicKeyFingerprint
      });
      const teeEvidence = await getTeeEvidence({ nonce, includeToken: true });
      const receipt = await createSignedExperimentReceipt({
        runId,
        result,
        teeEvidence,
        nonce,
        latencyMs: Date.now() - startedAt
      });

      const record: ExperimentRecord = {
        kind: "experiment",
        id: runId,
        experimentId: experiment.id,
        createdAt: new Date().toISOString(),
        receipt,
        descriptive: result.descriptive,
        timing: result.timing,
        solanaCommitment: null,
        teeEvidence,
        metricsHash: result.results.metricsHash
      };
      saveSealed({
        runId,
        experimentId: experiment.id,
        resultsRoot: result.results.resultsRoot,
        leafCount: result.results.leafCount,
        leafSchema: result.results.leafSchema,
        leaves: result.sealed.leaves,
        leafHashes: result.sealed.leafHashes
      });
      saveRecord(record);

      const publicRecord = toPublicRecord(record);
      const verification = await verifyExperimentRecord(publicRecord, {
        items: experiment.items,
        trustedFingerprints: config.trustedRunnerFingerprints
      });
      if (!verification.ok) {
        const failed = verification.checks.filter((check) => check.status === "fail").map((check) => check.name);
        res.status(500).json({ ok: false, error: `Receipt failed self-verification: ${failed.join(", ")}` });
        return;
      }
      res.json({ ok: true, record: publicRecord, verification });
    } catch (error) {
      sendError(res, error);
    } finally {
      release?.();
    }
  });

  app.get("/api/receipts", (_req, res) => {
    res.json({ ok: true, records: listRecords().map(toPublicRecord) });
  });

  app.get("/api/receipts/:id", (req, res) => {
    const record = getRecord(req.params.id);
    if (!record) {
      res.status(404).json({ ok: false, error: "Receipt not found" });
      return;
    }
    res.json({ ok: true, record: toPublicRecord(record) });
  });

  app.get("/api/receipts/:id/evidence", (req, res) => {
    const record = getRecord(req.params.id);
    if (!record) {
      res.status(404).json({ ok: false, error: "Receipt not found" });
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
      const experiment = await getExperiment(record.experimentId);
      const audit = await auditReceiptEvidence(record.receipt, record.teeEvidence, {
        items: experiment?.items,
        solanaCommitment: record.solanaCommitment,
        offline: req.query.offline === "1"
      });
      res.json({ ok: audit.ok, audit });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/receipts/:id/chain", async (req, res) => {
    try {
      const record = getRecord(req.params.id);
      if (!record) {
        res.status(404).json({ ok: false, error: "Receipt not found" });
        return;
      }
      res.json({ ok: true, chain: await readExperimentCommitment(record.receipt) });
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
      if (!dryRun) {
        record.solanaCommitment = solanaCommitment;
        saveRecord(record);
      }
      res.json({ ok: true, solanaCommitment, record: toPublicRecord(record) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/verify", async (req, res) => {
    try {
      const body = req.body as { record?: PublicExperimentRecord; receipt?: SignedExperimentReceipt; items?: Array<Record<string, unknown>> } | undefined;
      const receipt = body?.record?.receipt ?? body?.receipt;
      if (!receipt) {
        res.status(400).json({ ok: false, error: "Missing receipt" });
        return;
      }
      let items = body?.items;
      if (!items && receipt.payload?.experiment?.id) {
        items = (await getExperiment(receipt.payload.experiment.id))?.items;
      }
      const verification = await verifyExperimentRecord(
        { receipt },
        { items, trustedFingerprints: config.trustedRunnerFingerprints }
      );
      res.json({ ok: true, verification });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/audit", async (req, res) => {
    try {
      const body = req.body as { record?: PublicExperimentRecord; receipt?: SignedExperimentReceipt; evidence?: unknown } | undefined;
      const receipt = body?.record?.receipt ?? body?.receipt;
      if (!receipt) {
        res.status(400).json({ ok: false, error: "Missing receipt" });
        return;
      }
      const experiment = receipt.payload?.experiment?.id ? await getExperiment(receipt.payload.experiment.id) : undefined;
      const audit = await auditReceiptEvidence(receipt, (body?.evidence as never) || null, {
        items: experiment?.items,
        solanaCommitment: body?.record?.solanaCommitment ?? null
      });
      res.json({ ok: audit.ok, audit });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/runner-key", async (_req, res) => {
    try {
      const key = await getRunnerKey();
      res.json({ ok: true, key: { ...key, trustedFingerprints: config.trustedRunnerFingerprints } });
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

  app.get("/api/solana/status", async (_req, res) => {
    try {
      res.json({ ok: true, solana: await getSolanaStatus() });
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
  if (error instanceof RunnerRequestError) {
    const status = error.code === "unknown-experiment" ? 404 : error.code === "bad-request" ? 400 : 503;
    res.status(status).json({ ok: false, error: error.message, code: error.code });
    return;
  }
  if (error instanceof CanonicalMismatchError) {
    res.status(500).json({ ok: false, error: error.message, code: "canonical-mismatch" });
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

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(__filename)
  : false;

if (isDirectRun) {
  const app = createApp();
  app.listen(config.apiPort, () => {
    console.log(`[api] ${config.serviceName} listening on http://127.0.0.1:${config.apiPort} (${config.teeMode})`);
  });
  warmRunner()
    .then(async (ready) => {
      console.log(`[api] runner ready: model ${ready.model.commitment.slice(0, 16)}… registry ${ready.registryHash.slice(0, 16)}… in ${ready.loadMs} ms`);
      await primeCaches();
      console.log("[api] registry and model info cached");
    })
    .catch((error) => {
      console.error(`[api] runner failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
}
