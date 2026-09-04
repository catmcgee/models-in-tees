import fs from "node:fs";
import path from "node:path";
import { recordsDir } from "./config.js";
import type { ExperimentRecord, PublicExperimentRecord, SealedRecord, StoredRecord } from "./types.js";

const recordsPath = path.join(recordsDir, "experiment-records.json");
const sealedDir = path.join(recordsDir, "experiments");
const records = loadRecords();

export function saveRecord<T extends StoredRecord>(record: T): T {
  records.set(record.id, record);
  persistRecords();
  return record;
}

export function getRecord(id: string): StoredRecord | undefined {
  return records.get(id);
}

export function listRecords(): StoredRecord[] {
  return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listRecordsForExperiment(experimentId: string, limit = 20): StoredRecord[] {
  return listRecords()
    .filter((record) => record.experimentId === experimentId)
    .slice(0, limit);
}

/** Whitelist projection. Never spread a stored record into a response. */
export function toPublicRecord(record: ExperimentRecord): PublicExperimentRecord {
  return {
    kind: "experiment",
    id: record.id,
    experimentId: record.experimentId,
    createdAt: record.createdAt,
    receipt: record.receipt,
    descriptive: record.descriptive,
    timing: record.timing,
    solanaCommitment: record.solanaCommitment
  };
}

export function saveSealed(sealed: SealedRecord): void {
  fs.mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
  const target = path.join(sealedDir, `${sealed.runId}.json`);
  const tempPath = `${target}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(sealed), { mode: 0o600 });
  fs.renameSync(tempPath, target);
}

export function readSealed(runId: string): SealedRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(sealedDir, `${runId}.json`), "utf-8")) as SealedRecord;
  } catch {
    return null;
  }
}

function loadRecords(): Map<string, StoredRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordsPath, "utf-8")) as StoredRecord[];
    return new Map(parsed.map((record) => [record.id, record]));
  } catch {
    return new Map();
  }
}

function persistRecords(): void {
  fs.mkdirSync(recordsDir, { recursive: true });
  const kept = listRecords().slice(0, 200);
  const tempPath = `${recordsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(kept, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, recordsPath);
}
