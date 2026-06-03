import type { BenchmarkRecord } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import { privateDir } from "./config.js";

const recordsDir = path.join(privateDir, "records");
const recordsPath = path.join(recordsDir, "benchmark-records.json");
const records = loadRecords();

export function saveRecord(record: BenchmarkRecord): BenchmarkRecord {
  records.set(record.id, record);
  persistRecords();
  return record;
}

export function getRecord(id: string): BenchmarkRecord | undefined {
  return records.get(id);
}

export function listRecords(): BenchmarkRecord[] {
  return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function loadRecords(): Map<string, BenchmarkRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordsPath, "utf-8")) as BenchmarkRecord[];
    return new Map(parsed.map((record) => [record.id, record]));
  } catch {
    return new Map();
  }
}

function persistRecords(): void {
  fs.mkdirSync(recordsDir, { recursive: true });
  const records = listRecords().slice(0, 200);
  const tempPath = `${recordsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, recordsPath);
}
