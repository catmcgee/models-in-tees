# Committed Experiments over a Sealed Model

A public registry of pre-committed interpretability and behaviour experiments
runs inside a Google Confidential VM against a sealed
[`google/gemma-3-1b-pt`](https://huggingface.co/google/gemma-3-1b-pt). Every
per-item result is Merkle-committed, the root is bound into the hardware
attestation nonce, aggregates and a seeded sample of opened items are signed,
and the commitment can be written to a Solana program and read back.

Nobody types prompts. Nobody sees the weights. Anyone can recompute every hash
in the browser.

Live: https://modelsintees.mcgee.cat

## What Runs

- **Registry**: `src/experiments/*.json`, six experiments (behaviour evals,
  memorization, paired bias, linear probe, activation patching, Gemma Scope 2
  SAE features). Adding or editing one changes `registryHash` and the workload
  hash.
- **Runner**: `src/model/tee_runner/`, a persistent Python worker that loads
  the model once and speaks NDJSON to the API. Leaves are integers only
  (`Bp`, `Milli`, `Centi` fixed point) so hashing is byte-identical across
  Python and TypeScript.
- **API**: `src/server/`, Express + TypeScript. Runs one experiment at a time,
  derives the attestation nonce from the results, fetches the Confidential VM
  token with it, signs the receipt (Ed25519 over canonical JSON), stores the
  sealed leaves privately, and self-verifies before responding.
- **Verifier**: `src/shared/`, one implementation of canonical JSON, RFC 6962
  Merkle proofs, disclosure sampling, nonce derivation and Ed25519 that runs in
  Node and in the browser.
- **Frontend**: `src/web/`, Vite + React. Catalog, run, metrics, opened leaves
  with proofs, and a check list computed client-side.
- **Chain**: `programs/experiment_receipts/`, an Anchor program with a single
  immutable `commit_experiment` instruction; the audit reads the PDA back.

See [`docs/TRUST_MODEL.md`](docs/TRUST_MODEL.md) for what is proved and what is not.

## Setup

```bash
npm install
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
cp .env.example .env            # add HF_TOKEN (Gemma is gated: accept the licence on Hugging Face)
npm run fetch:artifacts         # downloads the model + SAE into private/, prints both commitments
npm run llm:test                # Python selftest: vectors, registry, commitments, one real run
npm run registry:validate       # TypeScript reproduces the Python vectors and every dataset hash
```

Run locally (`TEE_MODE=local-dev-sim`, no hardware token, every other check active):

```bash
npm run dev                     # API on :8787, Vite on :5173
npm test                        # selftest + typecheck + registry + build + smoke
```

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | runner state, registry hash, current run |
| `GET /api/model` | model + SAE commitments, architecture, runtime |
| `GET /api/experiments` | registry summaries |
| `GET /api/experiments/:id` | items + recent runs |
| `POST /api/experiments/:id/run` | run inside the TEE (409 while busy) |
| `GET /api/receipts`, `/:id` | public records (receipt, descriptive context, chain status) |
| `GET /api/receipts/:id/audit` | full audit: verifier checks, evidence, Google token, chain read-back |
| `GET /api/receipts/:id/chain` | decode the on-chain commitment and compare |
| `POST /api/receipts/:id/commit` | write to the Solana program (`?dryRun=1` to simulate) |
| `POST /api/verify` | browser-equivalent verification of a supplied record |
| `GET /api/runner-key` | signer public key and fingerprint |

## Adding an experiment

1. Add `src/experiments/<id>.json` (`schema: tee-ai-experiment/v1`, exact
   params for its kind, single-token targets).
2. `npm run registry:validate` (the Gemma tokenizer must agree that targets are
   one token).
3. Redeploy: the registry hash and workload hash change.

## Solana program

Program id `Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR` on devnet, upgraded
in place. To rebuild and upgrade:

```bash
anchor build
anchor program upgrade target/deploy/experiment_receipts.so \
  --program-id Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR \
  --provider.cluster devnet --provider.wallet ~/.config/solana/id.json
npm run chain:test              # real commit + read-back of the newest run
```

Do not run `anchor keys sync`; it would repoint `declare_id!` at a local keypair.

## Private artifacts

Never commit runtime-generated private state. `private/` (model, SAE, signing
key, records, sealed leaves, Solana payer), `*.pem`, `*.safetensors`, `.env`
are ignored. `public/runner-key.json` is the one key file that is meant to be
committed: it pins the VM's signing key for the frontend (`npm run key:export`
on the VM).

## Deployment

The API runs on a Google Confidential VM (see
[`docs/GCP_CONFIDENTIAL_VM.md`](docs/GCP_CONFIDENTIAL_VM.md)); the frontend is
on Vercel and proxies `/api/*` to the VM (`TEE_API_ORIGIN`).
