use anchor_lang::prelude::*;

declare_id!("Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR");

#[program]
pub mod private_gpt_receipts {
    use super::*;

    pub fn create_receipt(ctx: Context<CreateReceipt>, args: ReceiptArgs) -> Result<()> {
        require!(args.generated_token_count > 0, PrivateGptReceiptError::EmptyGeneration);

        let now = Clock::get()?.unix_timestamp;
        let session = &mut ctx.accounts.session;
        session.authority = ctx.accounts.payer.key();
        session.model_commitment = args.model_commitment;
        session.receipt_digest = args.receipt_digest;
        session.prompt_hash = args.prompt_hash;
        session.output_hash = args.output_hash;
        session.params_hash = args.params_hash;
        session.latency_ms = args.latency_ms;
        session.generated_token_count = args.generated_token_count;
        session.created_at = now;
        session.updated_at = now;
        session.status = SessionStatus::Created as u8;
        session.bump = ctx.bumps.session;
        Ok(())
    }

    pub fn update_receipt(ctx: Context<UpdateReceipt>, args: ReceiptUpdateArgs) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require_keys_eq!(
            session.authority,
            ctx.accounts.authority.key(),
            PrivateGptReceiptError::Unauthorized
        );

        session.output_hash = args.output_hash;
        session.params_hash = args.params_hash;
        session.latency_ms = args.latency_ms;
        session.generated_token_count = args.generated_token_count;
        session.updated_at = Clock::get()?.unix_timestamp;
        session.status = SessionStatus::Updated as u8;
        Ok(())
    }

    pub fn finalize_receipt(ctx: Context<FinalizeReceipt>) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require_keys_eq!(
            session.authority,
            ctx.accounts.authority.key(),
            PrivateGptReceiptError::Unauthorized
        );
        session.updated_at = Clock::get()?.unix_timestamp;
        session.status = SessionStatus::Finalized as u8;
        Ok(())
    }

}

const SESSION_SEED: &[u8] = b"session";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ReceiptArgs {
    pub receipt_digest: [u8; 32],
    pub prompt_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub params_hash: [u8; 32],
    pub model_commitment: [u8; 32],
    pub latency_ms: u32,
    pub generated_token_count: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ReceiptUpdateArgs {
    pub output_hash: [u8; 32],
    pub params_hash: [u8; 32],
    pub latency_ms: u32,
    pub generated_token_count: u16,
}

#[derive(Accounts)]
#[instruction(args: ReceiptArgs)]
pub struct CreateReceipt<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + GptReceiptSession::LEN,
        seeds = [SESSION_SEED, args.receipt_digest.as_ref()],
        bump
    )]
    pub session: Account<'info, GptReceiptSession>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateReceipt<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub session: Account<'info, GptReceiptSession>,
}

#[derive(Accounts)]
pub struct FinalizeReceipt<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub session: Account<'info, GptReceiptSession>,
}

#[account]
pub struct GptReceiptSession {
    pub authority: Pubkey,
    pub model_commitment: [u8; 32],
    pub receipt_digest: [u8; 32],
    pub prompt_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub params_hash: [u8; 32],
    pub latency_ms: u32,
    pub generated_token_count: u16,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: u8,
    pub bump: u8,
}

impl GptReceiptSession {
    pub const LEN: usize = 32 + (32 * 5) + 4 + 2 + 8 + 8 + 1 + 1;
}

#[repr(u8)]
pub enum SessionStatus {
    Created = 1,
    Updated = 2,
    Finalized = 3,
}

#[error_code]
pub enum PrivateGptReceiptError {
    #[msg("Generation must contain at least one output token.")]
    EmptyGeneration,
    #[msg("Only the session authority can update this receipt.")]
    Unauthorized,
}
