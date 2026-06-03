import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const scanRoots = [
  ".dockerignore",
  ".env.example",
  ".gitignore",
  ".npmignore",
  "Anchor.toml",
  "api",
  "Cargo.toml",
  "README.md",
  "docs",
  "package.json",
  "package-lock.json",
  "programs",
  "scripts",
  "src",
  "vercel.json"
];

const blockedPatterns = [
  /-----BEGIN (?:RSA |OPENSSH |EC |)PRIVATE KEY-----/,
  /"private_key"\s*:/,
  /client_secret["']?\s*[:=]/i,
  /"type"\s*:\s*"service_account"/i,
  /private_key_id["']?\s*[:=]/i,
  /client_email["']?\s*[:=].*gserviceaccount\.com/i,
  /0184B7/i,
  /34\.42\.27\.172/,
  /tee-ai-tee-\d{8}/,
  /cat\.mcgee@/i,
  /\/Users\/[^/\s]+/,
  /developer\.gserviceaccount\.com/
];

const blockedPaths = [
  /^private(?:\/|$)/,
  /^target\/deploy\/.*keypair.*\.json$/,
  /\.pem$/,
  /\.pt$/,
  /\.safetensors$/,
  /\.onnx$/,
  /\.env$/
];

const findings: string[] = [];

for (const rootPath of scanRoots) {
  const absolute = path.join(root, rootPath);
  if (!fs.existsSync(absolute)) continue;
  for (const file of walk(absolute)) {
    const relative = path.relative(root, file);
    if (relative === "scripts/publicAudit.ts") {
      continue;
    }
    if (blockedPaths.some((pattern) => pattern.test(relative))) {
      findings.push(`${relative}: blocked private artifact path`);
      continue;
    }
    const content = fs.readFileSync(file, "utf-8");
    for (const pattern of blockedPatterns) {
      if (pattern.test(content)) {
        findings.push(`${relative}: matched ${pattern}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Public audit failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Public audit passed.");

function walk(fileOrDir: string): string[] {
  const stat = fs.statSync(fileOrDir);
  if (stat.isFile()) return [fileOrDir];
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(fileOrDir, { withFileTypes: true })
    .flatMap((entry) => walk(path.join(fileOrDir, entry.name)));
}
