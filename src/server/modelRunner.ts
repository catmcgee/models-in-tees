import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { modelDir, rootDir } from "./config.js";
import type { BenchmarkCase, ModelInfo, ModelRunResult } from "./types.js";

const venvPython = path.join(rootDir, ".venv", "bin", "python");
const pythonBinary = fs.existsSync(venvPython) ? venvPython : "python3";
const runnerPath = path.join(rootDir, "src", "model", "model_runner.py");

export async function getModelInfo(): Promise<ModelInfo> {
  const result = await runPython("info", {});
  if (!result.ok || !result.info) {
    throw new Error(result.error || "Model info failed");
  }
  return result.info as ModelInfo;
}

export async function runBenchmarkCases(
  cases: BenchmarkCase[]
): Promise<ModelRunResult> {
  const result = await runPython("run", { cases });
  if (!result.ok) {
    throw new Error(result.error || "Model run failed");
  }
  return result as ModelRunResult;
}

export async function bootstrapModel(force = false): Promise<Record<string, unknown>> {
  const args = force ? ["bootstrap", "--force"] : ["bootstrap"];
  return runPythonWithArgs(args, {});
}

async function runPython(
  command: "info" | "run" | "selftest",
  payload: Record<string, unknown>
): Promise<any> {
  return runPythonWithArgs([command], payload);
}

async function runPythonWithArgs(
  args: string[],
  payload: Record<string, unknown>
): Promise<any> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(modelDir, { recursive: true });
    const child = spawn(pythonBinary, [runnerPath, ...args], {
      cwd: rootDir,
      env: {
        ...process.env,
        TEE_AI_MODEL_DIR: modelDir
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Model runner exited with ${code}.\n${stderr || stdout || "No output"}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(
          new Error(
            `Could not parse model runner output: ${String(error)}\n${stdout}\n${stderr}`
          )
        );
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
