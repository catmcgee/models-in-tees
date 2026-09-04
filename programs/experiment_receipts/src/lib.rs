//! experiment_receipts: immutable on-chain commitments for TEE experiment runs.
//!
//! One account per receipt digest. There is deliberately no update or close
//! instruction: once a run is committed, the commitment cannot be rewritten.

use anchor_lang::prelude::*;

declare_id!("Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR");

#[program]
pub mod experiment_receipts {
    use super::*;

    pub fn commit_experiment(ctx: Context<CommitExperiment>, args: ExperimentArgs) -> Result<()> {
        require!(args.leaf_count > 0, ExperimentReceiptError::EmptyExperiment);

        let commitment = &mut ctx.accounts.commitment;
        commitment.authority = ctx.accounts.payer.key();
        commitment.receipt_digest = args.receipt_digest;
        commitment.model_commitment = args.model_commitment;
        commitment.experiment_id_hash = args.experiment_id_hash;
        commitment.dataset_hash = args.dataset_hash;
        commitment.results_root = args.results_root;
        commitment.policy_hash = args.policy_hash;
        commitment.tee_evidence_hash = args.tee_evidence_hash;
        commitment.leaf_count = args.leaf_count;
        commitment.committed_at = Clock::get()?.unix_timestamp;
        commitment.bump = ctx.bumps.commitment;
        Ok(())
    }
}

const EXPERIMENT_SEED: &[u8] = b"experiment";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExperimentArgs {
    pub receipt_digest: [u8; 32],
    pub model_commitment: [u8; 32],
    pub experiment_id_hash: [u8; 32],
    pub dataset_hash: [u8; 32],
    pub results_root: [u8; 32],
    pub policy_hash: [u8; 32],
    pub tee_evidence_hash: [u8; 32],
    pub leaf_count: u32,
}

#[derive(Accounts)]
#[instruction(args: ExperimentArgs)]
pub struct CommitExperiment<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + ExperimentCommitment::LEN,
        seeds = [EXPERIMENT_SEED, args.receipt_digest.as_ref()],
        bump
    )]
    pub commitment: Account<'info, ExperimentCommitment>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct ExperimentCommitment {
    pub authority: Pubkey,
    pub receipt_digest: [u8; 32],
    pub model_commitment: [u8; 32],
    pub experiment_id_hash: [u8; 32],
    pub dataset_hash: [u8; 32],
    pub results_root: [u8; 32],
    pub policy_hash: [u8; 32],
    pub tee_evidence_hash: [u8; 32],
    pub leaf_count: u32,
    pub committed_at: i64,
    pub bump: u8,
}

impl ExperimentCommitment {
    pub const LEN: usize = 32 + (32 * 7) + 4 + 8 + 1;
}

#[error_code]
pub enum ExperimentReceiptError {
    #[msg("Experiment must commit at least one leaf.")]
    EmptyExperiment,
}
