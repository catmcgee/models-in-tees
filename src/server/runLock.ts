/** Single-flight guard: the CPU box runs one experiment at a time. */

export interface RunningInfo {
  experimentId: string;
  runId: string;
  startedAt: string;
}

let current: RunningInfo | null = null;

export function tryAcquire(info: RunningInfo): { release: () => void } | null {
  if (current) {
    return null;
  }
  current = info;
  return {
    release: () => {
      if (current?.runId === info.runId) {
        current = null;
      }
    }
  };
}

export function currentRun(): RunningInfo | null {
  return current;
}
