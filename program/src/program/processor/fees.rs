use bytemuck::try_from_bytes_mut;
use solana_program::{
    account_info::AccountInfo, clock::Clock, msg, program_error::ProgramError, sysvar::Sysvar,
};

use crate::program::{
    accounts::{LpPositionAccount, LpPositionStatus, PoolAccount},
    events::{WithdrawLpFeesEvent, WithdrawProtocolFeesEvent},
    token_utils::{maybe_invoke_withdraw, MaybeInvokeWithdrawParams},
    validation::loaders::{PlasmaPoolContext, WithdrawLpFeesContext, WithdrawProtocolFeesContext},
};

pub(crate) fn process_withdraw_lp_fees<'a, 'info>(
    pool_context: &PlasmaPoolContext<'a, 'info>,
    accounts: &'a [AccountInfo<'info>],
) -> Result<WithdrawLpFeesEvent, ProgramError> {
    let WithdrawLpFeesContext {
        lp_position: lp_position_account,
        quote_account,
        quote_vault,
        token_program,
    } = WithdrawLpFeesContext::load(&pool_context, accounts)?;

    let slot = Clock::get()?.slot;
    let mut pool_bytes = pool_context.pool_info.try_borrow_mut_data()?;
    let pool = try_from_bytes_mut::<PoolAccount>(&mut *pool_bytes)
        .map_err(|_| ProgramError::InvalidAccountData)?;

    let mut lp_position_bytes = lp_position_account.info.try_borrow_mut_data()?;
    let lp_position = try_from_bytes_mut::<LpPositionAccount>(&mut *lp_position_bytes)
        .map_err(|_| ProgramError::InvalidAccountData)?;

    if matches!(
        LpPositionStatus::parse(lp_position.status)?,
        LpPositionStatus::RenouncedWithBurnedFees
    ) {
        msg!(
            "LP position has been burned ({}), cannot withdraw fees",
            lp_position.status
        );
        return Err(ProgramError::InvalidArgument);
    }

    let quote_fees_collected = lp_position.collect_fees(slot, &pool).map_err(|e| {
        msg!("Error collecting fees: {:?}", e);
        ProgramError::InvalidArgument
    })?;

    msg!("Collected fees: {}", quote_fees_collected);

    maybe_invoke_withdraw(MaybeInvokeWithdrawParams {
        pool_key: pool_context.pool_info.key,
        mint_key: &pool.header.quote_params.mint_key,
        bump: pool.header.quote_params.vault_bump as u8,
        withdraw_account: quote_account,
        withdraw_amount: quote_fees_collected,
        withdraw_vault: quote_vault,
        token_program: token_program.as_ref(),
    })?;

    Ok(WithdrawLpFeesEvent {
        fees_withdrawn: quote_fees_collected,
    })
}

pub(crate) fn process_withdraw_protocol_fees<'a, 'info>(
    pool_context: &PlasmaPoolContext<'a, 'info>,
    accounts: &'a [AccountInfo<'info>],
) -> Result<WithdrawProtocolFeesEvent, ProgramError> {
    let WithdrawProtocolFeesContext {
        quote_account,
        quote_vault,
        token_program,
    } = WithdrawProtocolFeesContext::load(&pool_context, accounts)?;

    let mut pool_bytes = pool_context.pool_info.try_borrow_mut_data()?;
    let pool = try_from_bytes_mut::<PoolAccount>(&mut *pool_bytes)
        .map_err(|_| ProgramError::InvalidAccountData)?;

    let recipient = pool_context.signer.key;
    let withdrawable_fees = pool.withdraw_protocol_fee(recipient)?;

    msg!(
        "Withdrawing {} protocol fees for {}",
        withdrawable_fees,
        recipient
    );

    maybe_invoke_withdraw(MaybeInvokeWithdrawParams {
        pool_key: pool_context.pool_info.key,
        mint_key: &pool.header.quote_params.mint_key,
        bump: pool.header.quote_params.vault_bump as u8,
        withdraw_account: quote_account,
        withdraw_amount: withdrawable_fees,
        withdraw_vault: quote_vault,
        token_program: token_program.as_ref(),
    })?;

    Ok(WithdrawProtocolFeesEvent {
        fees_withdrawn: withdrawable_fees,
        protocol_fee_recipient: *recipient,
    })
}
