# Private Model Verifier

Private Model Verifier is a public test harness for a private GPT-2-style model.
Users submit prompts, a hidden PyTorch/Hugging Face GPT-2 runner generates text,
and the API returns a signed receipt that binds the prompt hash, output hash,
model commitment, TEE evidence, and optional Solana devnet timestamp.

The demo is not a ZK proof system. The privacy claim comes from keeping model
weights and receipt keys outside the public source tree and, in
production-style deployments, running the API in a hardware-backed TEE such as a
Google Confidential VM.

## What Runs

- Frontend: Vite + React verifier demo
- API: Express + TypeScript
- Model runner: GPT-2 causal language model
- Receipt protocol: canonical JSON + Ed25519 signatures
- TEE evidence: Google Confidential VM attestation token when available
- Chain commit: Solana devnet Anchor program, with Memo fallback

## Private Artifacts

Do not commit runtime-generated private artifacts. They are ignored by
`.gitignore`, `.npmignore`, and `.dockerignore`.

```text
private/
target/deploy/*-keypair.json
*.pem
*.pt
*.safetensors
*.onnx
.env
```

The app downloads/caches GPT-2 files, generates receipt signing keys, Solana
devnet payer keys, and stored evidence under `private/`. Keep that directory
local or on the protected VM only.

## Setup

```bash
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm run llm:test
anchor build --ignore-keys
```

Copy `.env.example` to `.env` for local overrides. Do not commit `.env`.

## Run Locally

```bash
npm run dev
```

Open `http://localhost:5173`.

The API listens on `http://127.0.0.1:8787`.

## Test

```bash
npm test
npm run chain:test
```

`npm test` runs the model self-test, TypeScript checks, production frontend
build, and API smoke test. `chain:test` submits a live devnet receipt.
`llm:test` downloads/loads the configured GPT-2 model and prints its private
model commitment.

## Vercel Frontend

Vercel should deploy the frontend only. The TEE/API/model runner should remain
on infrastructure that can access the private model directory and TEE device.

Set this Vercel environment variable when the API is hosted elsewhere:

```text
TEE_API_ORIGIN=https://your-api-host.example
```

The Vercel project includes a same-origin `/api/*` proxy that forwards requests
to `TEE_API_ORIGIN`. This avoids browser mixed-content issues when the frontend
is served over HTTPS. For purely local development, leave `VITE_API_BASE_URL`
empty and Vite will proxy `/api` to `http://127.0.0.1:8787`.

## API Endpoints

```text
GET  /api/health
GET  /api/llm
GET  /api/tee/evidence
POST /api/generate
POST /api/verify
POST /api/audit
GET  /api/solana/status
GET  /api/receipts/:id
GET  /api/receipts/:id/evidence
GET  /api/receipts/:id/audit
POST /api/receipts/:id/commit
```

Production defaults are conservative:

- `ALLOW_RAW_TEE_EVIDENCE=0` redacts raw attestation tokens/reports from public
  responses.
- `ALLOW_PUBLIC_RECEIPT_LISTING=0` prevents listing all stored receipts.

Set an override to `1` only when you explicitly want that behavior.

## Solana Devnet

The default Anchor program id is configured in `Anchor.toml`,
`programs/private_gpt_receipts/src/lib.rs`, and
`PRIVATE_GPT_RECEIPT_PROGRAM_ID`.
Override it when deploying your own program.

The server creates a devnet payer at:

```text
private/solana/devnet-keypair.json
```

Fund the payer manually if the faucet is rate-limited.

## Trust Model

The public can verify receipt signatures, payload hashes, model commitments,
TEE evidence hashes, workload hashes, and Solana timestamp transactions. The
public cannot directly inspect private weights. Stronger production deployments
should generate and seal the receipt key inside a measured workload and bind the
exact workload image to the TEE attestation policy.

See [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md) and
[docs/GCP_CONFIDENTIAL_VM.md](docs/GCP_CONFIDENTIAL_VM.md).

## License

MIT License

Copyright (c) 2026 Private Model Verifier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
