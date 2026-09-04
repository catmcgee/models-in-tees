/**
 * Persistent Python worker client. One process, NDJSON over stdin/stdout,
 * strictly serial requests, automatic restart with backoff.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config, hfDir, llmDir, rootDir, saeDir } from "./config.js";
import type { ModelInfo, Registry, RunExperimentResult } from "./types.js";

const venvPython = path.join(rootDir, ".venv", "bin", "python");
const pythonBinary = fs.existsSync(venvPython) ? venvPython : "python3";
const runnerPath = path.join(rootDir, "src", "model", "model_runner.py");

export type RunnerState = "stopped" | "starting" | "ready" | "restarting" | "failed";

export interface RunnerError {
  code: string;
  message: string;
}

export class RunnerRequestError extends Error {
  code: string;
  constructor(error: RunnerError) {
    super(error.message);
    this.code = error.code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ReadyInfo {
  pid: number;
  model: { commitment: string; modelId: string };
  sae: { commitment: string } | null;
  registryHash: string;
  policyHash: string;
  loadMs: number;
}

class RunnerClient {
  state: RunnerState = "stopped";
  restarts = 0;
  startedAt: string | null = null;
  ready: ReadyInfo | null = null;
  lastError: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private readyPromise: Promise<ReadyInfo> | null = null;
  private stopping = false;
  private counter = 0;
  private backoffMs = 1000;

  start(): Promise<ReadyInfo> {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.stopping = false;
    this.state = this.restarts > 0 ? "restarting" : "starting";
    this.startedAt = new Date().toISOString();
    this.readyPromise = new Promise<ReadyInfo>((resolve, reject) => {
      const readyTimer = setTimeout(() => {
        reject(new Error(`runner did not become ready within ${config.runnerReadyTimeoutMs} ms`));
        this.child?.kill("SIGKILL");
      }, config.runnerReadyTimeoutMs);

      const child = spawn(pythonBinary, [runnerPath, "serve"], {
        cwd: rootDir,
        env: {
          ...process.env,
          TEE_AI_LLM_DIR: llmDir,
          TEE_AI_SAE_DIR: saeDir,
          TEE_AI_LLM_MODEL_ID: config.llmModelId,
          TEE_AI_SAE_REPO: config.saeRepo,
          TEE_AI_SAE_SUBFOLDER: config.saeSubfolder,
          HF_HOME: hfDir,
          HF_HUB_OFFLINE: config.hfOffline ? "1" : "0",
          HF_HUB_DISABLE_XET: "1",
          HF_HUB_DISABLE_PROGRESS_BARS: "1",
          TRANSFORMERS_VERBOSITY: "error",
          TOKENIZERS_PARALLELISM: "false",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONUNBUFFERED: "1",
          ...(config.hfToken ? { HF_TOKEN: config.hfToken } : {}),
          ...(config.torchThreads ? { TEE_AI_TORCH_THREADS: config.torchThreads } : {})
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;

      const stdout = readline.createInterface({ input: child.stdout });
      stdout.on("line", (line) => this.onLine(line, resolve, readyTimer));
      const stderr = readline.createInterface({ input: child.stderr });
      stderr.on("line", (line) => {
        if (line.trim()) {
          console.error(`[runner] ${line}`);
        }
      });

      child.on("error", (error) => {
        this.lastError = error.message;
        clearTimeout(readyTimer);
        reject(error);
        this.onExit(null);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(readyTimer);
        this.lastError = `runner exited (code=${code} signal=${signal})`;
        reject(new Error(this.lastError));
        this.onExit(code);
      });
    });
    return this.readyPromise;
  }

  private onLine(line: string, resolveReady: (info: ReadyInfo) => void, readyTimer: NodeJS.Timeout): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`[runner] non-JSON line on protocol channel: ${line.slice(0, 200)}`);
      return;
    }
    if (message.event === "ready") {
      clearTimeout(readyTimer);
      this.state = "ready";
      this.backoffMs = 1000;
      this.ready = message as unknown as ReadyInfo;
      resolveReady(this.ready);
      return;
    }
    if (message.event === "fatal") {
      const error = message.error as RunnerError | undefined;
      this.lastError = error?.message || "runner reported a fatal error";
      return;
    }
    const id = typeof message.id === "string" ? message.id : null;
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) {
      return;
    }
    this.pending.delete(id as string);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result);
    } else {
      const error = (message.error as RunnerError | undefined) || {
        code: "internal",
        message: "runner returned an error without detail"
      };
      pending.reject(new RunnerRequestError(error));
    }
  }

  private onExit(code: number | null): void {
    this.child = null;
    this.readyPromise = null;
    this.ready = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RunnerRequestError({ code: "runner-crashed", message: this.lastError || "runner exited" }));
      this.pending.delete(id);
    }
    if (this.stopping) {
      this.state = "stopped";
      return;
    }
    this.state = code === 3 ? "failed" : "restarting";
    this.restarts += 1;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => {
      if (!this.stopping) {
        this.start().catch((error) => {
          console.error(`[runner] restart failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }, delay).unref();
  }

  async request<T>(command: string, payload: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child) {
      throw new RunnerRequestError({ code: "runner-unavailable", message: this.lastError || "runner is not running" });
    }
    const id = `r${Date.now().toString(36)}-${(this.counter += 1)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RunnerRequestError({ code: "timeout", message: `${command} exceeded ${timeoutMs} ms` }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    });
    this.state = "stopped";
  }

  status(): { state: RunnerState; restarts: number; startedAt: string | null; ready: ReadyInfo | null; lastError: string | null } {
    return {
      state: this.state,
      restarts: this.restarts,
      startedAt: this.startedAt,
      ready: this.ready,
      lastError: this.lastError
    };
  }
}

let singleton: RunnerClient | null = null;

export function getRunner(): RunnerClient {
  if (!singleton) {
    singleton = new RunnerClient();
  }
  return singleton;
}

export function warmRunner(): Promise<ReadyInfo> {
  return getRunner().start();
}

export async function stopRunner(): Promise<void> {
  if (singleton) {
    await singleton.stop();
  }
}

export function getModelInfo(): Promise<ModelInfo> {
  return getRunner().request<ModelInfo>("model-info");
}

export function getRegistryFromRunner(): Promise<Registry> {
  return getRunner().request<Registry>("registry");
}

export function runExperiment(experimentId: string): Promise<RunExperimentResult> {
  return getRunner().request<RunExperimentResult>("run-experiment", { experimentId }, config.runTimeoutMs);
}

export function validateRegistry(): Promise<{ ok: boolean; registryHash: string | null; errors: string[]; experiments: unknown[] }> {
  return getRunner().request("validate-registry", {}, 10 * 60 * 1000);
}
