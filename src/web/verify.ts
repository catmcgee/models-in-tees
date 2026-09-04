import { useEffect, useState } from "react";
import { verifyExperimentRecord } from "../shared/verify.js";
import { apiGet } from "./api.js";
import type { ChainReadback, PublicExperimentRecord, RecordVerification, RunnerKey, ServerAudit } from "./types.js";

export interface VerificationBundle {
  client: RecordVerification | null;
  clientError: string | null;
  audit: ServerAudit | null;
  auditError: string | null;
  chain: ChainReadback | null;
  loading: boolean;
}

let runnerKeyPromise: Promise<RunnerKey | null> | null = null;

export function loadPinnedRunnerKey(): Promise<RunnerKey | null> {
  if (!runnerKeyPromise) {
    runnerKeyPromise = fetch("/runner-key.json")
      .then(async (response) => (response.ok ? ((await response.json()) as RunnerKey) : null))
      .catch(() => null);
  }
  return runnerKeyPromise;
}

/** Verifies a record in the browser, then merges the server-side audit. */
export function useRecordVerification(
  record: PublicExperimentRecord | null,
  items: Array<Record<string, unknown>> | undefined,
  refreshToken = 0
): VerificationBundle {
  const [bundle, setBundle] = useState<VerificationBundle>({
    client: null,
    clientError: null,
    audit: null,
    auditError: null,
    chain: null,
    loading: false
  });

  useEffect(() => {
    let cancelled = false;
    if (!record) {
      setBundle({ client: null, clientError: null, audit: null, auditError: null, chain: null, loading: false });
      return;
    }
    setBundle((prev) => ({ ...prev, loading: true }));
    (async () => {
      let client: RecordVerification | null = null;
      let clientError: string | null = null;
      try {
        const pinned = await loadPinnedRunnerKey();
        client = await verifyExperimentRecord(record, {
          items,
          trustedFingerprints: pinned ? [pinned.publicKeyFingerprint] : undefined
        });
      } catch (error) {
        clientError = error instanceof Error ? error.message : String(error);
      }
      if (cancelled) return;
      setBundle((prev) => ({ ...prev, client, clientError }));

      let audit: ServerAudit | null = null;
      let auditError: string | null = null;
      try {
        audit = (await apiGet<{ audit: ServerAudit }>(`/api/receipts/${record.id}/audit`)).audit;
      } catch (error) {
        auditError = error instanceof Error ? error.message : String(error);
      }
      let chain: ChainReadback | null = null;
      if (record.solanaCommitment?.kind === "anchor-program" && record.solanaCommitment.status === "confirmed") {
        try {
          chain = (await apiGet<{ chain: ChainReadback }>(`/api/receipts/${record.id}/chain`)).chain;
        } catch {
          chain = null;
        }
      }
      if (cancelled) return;
      setBundle({ client, clientError, audit, auditError, chain, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [record?.id, record?.solanaCommitment?.status, items, refreshToken]);

  return bundle;
}
