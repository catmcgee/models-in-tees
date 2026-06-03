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
Machine: n2d-standard-2
Confidential compute type: SEV
API URL: https://<your-api-host>
```

Example VM creation command:

```bash
gcloud compute instances create <your-instance-name> \
  --project <your-gcp-project-id> \
  --zone <your-zone> \
  --machine-type n2d-standard-2 \
  --confidential-compute-type=SEV \
  --maintenance-policy=TERMINATE \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=40GB \
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
TEE_ATTESTATION_AUDIENCE=tee-ai-private-benchmark
GOTPM_USE_SUDO=1
PORT=8787
ALLOW_MODEL_BOOTSTRAP=0
ALLOW_RAW_TEE_EVIDENCE=0
ALLOW_PUBLIC_RECEIPT_LISTING=0
```

The public API process does not need to run as root. If `/dev/tpmrm0` is only
readable by root, use a narrow sudoers rule for `/usr/local/bin/gotpm` rather
than running the whole API as root.

## Expected Checks

- `/api/health` reports the configured TEE mode.
- `/api/model` returns a private model commitment without serving weights.
- `/api/tee/evidence` returns a receipt-bindable evidence hash.
- `/api/benchmark` returns signed receipts.
- `/api/receipts/:id/audit` verifies receipt signature, evidence hash, workload
  hash, Google token signature, issuer, audience, nonce, validity window, AMD
  SEV hardware claim, and secure boot claim when Google attestation is present.
- `/api/receipts/:id/commit` commits to the Solana devnet Anchor program.
- `/api/receipts/:id/magicblock` delegates the session to MagicBlock devnet,
  executes on the Ephemeral Rollup, and resolves the base-layer commit signature.

## Private Files

Keep these files on the VM only:

```text
private/attestation/
private/model/
private/records/
private/solana/
.env
```

They are ignored by the repository, but verify your GitHub import does not add
them manually.
