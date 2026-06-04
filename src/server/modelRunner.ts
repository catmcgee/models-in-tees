import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, hfDir, llmDir, rootDir } from "./config.js";
import type { GenerationResult, InterpretabilityResult, ModelInfo } from "./types.js";

const venvPython = path.join(rootDir, ".venv", "bin", "python");
const pythonBinary = fs.existsSync(venvPython) ? venvPython : "python3";
const runnerPath = path.join(rootDir, "src", "model", "model_runner.py");

export async function getLlmInfo(): Promise<ModelInfo> {
  const result = await runPython("llm-info", {});
  if (!result.ok || !result.info) {
    throw new Error(result.error || "GPT-2 info failed");
  }
  return result.info as ModelInfo;
}

export async function generateText(payload: {
  prompt: string;
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
}): Promise<GenerationResult> {
  const result = await runPython("generate", payload);
  if (!result.ok) {
    throw new Error(result.error || "GPT-2 generation failed");
  }
  return result as GenerationResult;
}

export async function runInterpretability(payload: {
  prompt: string;
  corruptedPrompt?: string;
  targetToken?: string;
  topK?: number;
  maxPromptTokens?: number;
}): Promise<InterpretabilityResult> {
  const result = await runPython("interpret", payload);
  if (!result.ok) {
    throw new Error(result.error || "GPT-2 interpretability run failed");
  }
  return result as InterpretabilityResult;
}

async function runPython(
  command: "llm-info" | "generate" | "interpret" | "selftest",
  payload: Record<string, unknown>
): Promise<any> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(llmDir, { recursive: true });
    fs.mkdirSync(hfDir, { recursive: true });
    const child = spawn(pythonBinary, [runnerPath, command], {
      cwd: rootDir,
      env: {
        ...process.env,
        TEE_AI_LLM_DIR: llmDir,
        TEE_AI_LLM_MODEL_ID: config.llmModelId,
        HF_HOME: hfDir,
        HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || "1"
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
