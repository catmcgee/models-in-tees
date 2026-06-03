# MagicBlock Private ER Plan

This project includes a MagicBlock-aware adapter at `src/server/magicblock.ts`
and a deployed Anchor program with ER delegation instructions.

Program id:

```text
Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR
```

## Current Routing

| Operation | Route |
| --- | --- |
| Model bootstrap | Local private runner |
| Benchmark inference | Local private runner |
| Receipt signing | GCP Confidential VM runner key in deployment; local simulation in dev |
| TEE evidence | Google attestation token hash bound into receipt on deployment |
| Receipt timestamp | Deployed Anchor program on Solana devnet |
| MagicBlock status | Live status API + ER RPC probe |
| ER path | Delegate session PDA, finalize on ER, commit back |

## Verified Devnet Flow

`npm run magicblock:test` verifies:

1. `create_receipt` creates a `BenchmarkSession` PDA on devnet.
2. `delegate_session` delegates that PDA to MagicBlock.
3. Base-layer owner changes to `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`.
4. `finalize_receipt` executes on `https://devnet.magicblock.app/`.
5. `commit_session` executes on the ER.
6. `GetCommitmentSignature` resolves the base-layer commit signature.

## PER Target Architecture

1. Create a benchmark session account on Solana base layer.
2. Create a permission account that lists the evaluator, operator, and TEE
   runner identity.
3. Delegate both the session account and permission account into a MagicBlock
   Private Ephemeral Rollup.
4. Route benchmark submissions through the ER RPC for low-latency private
   session updates.
5. Let the TEE runner write signed metric commitments into the delegated session.
6. Use `MagicIntentBundleBuilder` to commit the final receipt digest back to base
   layer.
7. Add post-commit actions for rewards, leaderboard updates, or payment
   settlement if the benchmark becomes a paid public challenge.

## Why PER Is Useful Here

- Fast benchmark sessions without waiting for base-layer confirmation on every
  interaction.
- Permissioned access to session state while the model is being evaluated.
- A clean commit boundary when results need public timestamping.
- A path to paid/private benchmark markets without exposing model weights or
  sensitive eval data.

MagicBlock is not the primary privacy layer for the model. The TEE protects the
private weights and signs receipts. MagicBlock is useful when the demo becomes a
stateful challenge arena: many low-latency benchmark interactions can happen on
the ER, then the final receipt commitment settles back to Solana devnet.

## PER Next Step

Private ER permission accounts are still the next layer. The deployed program
currently uses standard ER delegation. To make the session permissioned, add
accounts like:

```text
BenchmarkSession
  authority
  model_commitment
  input_set_hash
  output_set_hash
  metrics_hash
  receipt_digest
  status

SessionPermission
  session
  tee_runner
  evaluator
  operator
```

After deployment, the API can replace the Memo commit with program instructions
and add MagicBlock delegation/commit instructions around those accounts.
