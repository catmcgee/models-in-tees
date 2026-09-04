# Google Cloud Confidential VM Deployment

This project can run the API/model side on a Google Cloud Confidential VM using
AMD SEV. The frontend can be served by the API or deployed separately on Vercel.

Use placeholders in this document for your own project. Do not commit project
ids, billing ids, static IPs, service account keys, VM usernames, or generated
attestation/model/solana files.

## Example Resources

```text
Project: <your-gcp-project-id>
Zone: <your-zone>
Instance: <your-instance-name>
Machine: n2d-standard-4 (16 GB; the fp32 Gemma-3-1B needs ~4 GB plus headroom)
Confidential compute type: SEV
API URL: https://<your-api-host>
```

Example VM creation command:

```bash
gcloud compute instances create <your-instance-name> \
  --project <your-gcp-project-id> \
  --zone <your-zone> \
  --machine-type n2d-standard-4 \
  --confidential-compute-type=SEV \
  --maintenance-policy=TERMINATE \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=60GB \
  --boot-disk-type=pd-balanced \
  --tags=tee-ai-api \
  --shielded-secure-boot \
  --shielded-vtpm \
  --shielded-integrity-monitoring
```

## Service Environment

The API expects private state under `TEE_AI_ROOT/private`.

```text
NODE_ENV=production
TEE_AI_ROOT=/opt/tee-ai
TEE_MODE=gcp-confidential-vm-sev
TEE_PROVIDER=google-confidential-vm
TEE_ATTESTATION_AUDIENCE=tee-ai-experiments
TEE_AI_LLM_MODEL_ID=google/gemma-3-1b-pt
TEE_AI_SAE_REPO=google/gemma-scope-2-1b-pt
TEE_AI_SAE_SUBFOLDER=resid_post/layer_13_width_16k_l0_medium
HF_HUB_OFFLINE=1
TEE_AI_TORCH_THREADS=4
EXPERIMENT_RECEIPTS_PROGRAM_ID=Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR
GOTPM_USE_SUDO=1
PORT=8787
ALLOW_MODEL_BOOTSTRAP=0
ALLOW_RAW_TEE_EVIDENCE=0
```

The public API process does not need to run as root. If `/dev/tpmrm0` is only
readable by root, use a narrow sudoers rule for `/usr/local/bin/gotpm` rather
than running the whole API as root.

## First Deploy Of The Experiment Runner

```bash
cd /opt/tee-ai && git pull
npm ci
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Debian 12 python3.11
HF_TOKEN=<token with Gemma access> npm run fetch:artifacts             # one-time, ~2.2 GB into private/
npm run llm:test                                                       # selftest, prints commitments
npm run build                                                          # dist-server + dist (both measured)
npm run key:export && git add public/runner-key.json && git commit -m "Pin runner key"
sudo systemctl restart tee-ai-api                                      # runs: npm run start
```

The worker loads the model once at boot (`GET /api/health` shows
`runner.state`), then serves runs serially. Do not run `fetch:artifacts` on a
box that is already serving; the commitment cache is rehashed on every worker
start.

## Expected Checks

- `/api/health` reports `runner.state: ready` and the registry hash.
- `/api/model` returns the model and SAE commitments without serving weights.
- `POST /api/experiments/capital-facts-v1/run` returns a record whose
  `verification.ok` is true.
- `/api/receipts/:id/audit` must show `google-token-nonce` passing: the token's
  `eat_nonce` equals the nonce derived from the results (this confirms Google
  echoes the 64-hex custom nonce unchanged).
- `/api/receipts/:id/commit` writes to the Solana devnet program and
  `/api/receipts/:id/chain` decodes it.

## Private Files

Keep these files on the VM only:

```text
private/attestation/        Ed25519 receipt key
private/hf/                 Hugging Face cache metadata
private/llm/                model snapshot + commitment cache
private/sae/                Gemma Scope snapshot + commitment cache
private/records/            public records and sealed per-item leaves
private/solana/             devnet payer
.env
```

They are ignored by the repository, but verify your GitHub import does not add
them manually.
