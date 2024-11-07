use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
};

use super::{accounts::TokenParams, validation::checkers::TokenAccountInfo};

pub(crate) struct TryWithdrawParams<'a, 'info> {
    pub(crate) pool_key: &'a Pubkey,
    pub(crate) base_params: &'a TokenParams,
    pub(crate) quote_params: &'a TokenParams,
    pub(crate) token_program: &'a AccountInfo<'info>,
    pub(crate) quote_account: TokenAccountInfo<'a, 'info>,
    pub(crate) quote_vault: TokenAccountInfo<'a, 'info>,
    pub(crate) base_account: TokenAccountInfo<'a, 'info>,
    pub(crate) base_vault: TokenAccountInfo<'a, 'info>,
    pub(crate) quote_amount: u64,
    pub(crate) base_amount: u64,
}

pub(crate) fn try_withdraw<'a, 'info>(params: TryWithdrawParams<'a, 'info>) -> ProgramResult {
    let TryWithdrawParams {
        pool_key,
        base_params,
        quote_params,
        token_program,
        quote_account,
        quote_vault,
        base_account,
        base_vault,
        quote_amount,
        base_amount,
    } = params;
    for (withdraw_vault, withdraw_account, withdraw_amount, params) in [
        (quote_vault, quote_account, quote_amount, quote_params),
        (base_vault, base_account, base_amount, base_params),
    ] {
        maybe_invoke_withdraw(MaybeInvokeWithdrawParams {
            pool_key,
            mint_key: &params.mint_key,
            bump: params.vault_bump as u8,
            withdraw_amount,
            token_program,
            withdraw_account,
            withdraw_vault,
        })?;
    }
    Ok(())
}

pub(crate) struct MaybeInvokeWithdrawParams<'a, 'info> {
    pub(crate) pool_key: &'a Pubkey,
    pub(crate) mint_key: &'a Pubkey,
    pub(crate) bump: u8,
    pub(crate) withdraw_amount: u64,
    pub(crate) token_program: &'a AccountInfo<'info>,
    pub(crate) withdraw_account: TokenAccountInfo<'a, 'info>,
    pub(crate) withdraw_vault: TokenAccountInfo<'a, 'info>,
}

pub(crate) fn maybe_invoke_withdraw<'a, 'info>(
    params: MaybeInvokeWithdrawParams<'a, 'info>,
) -> ProgramResult {
    let MaybeInvokeWithdrawParams {
        pool_key,
        mint_key,
        bump,
        withdraw_amount,
        token_program,
        withdraw_account,
        withdraw_vault,
    } = params;
    if withdraw_amount != 0 {
        invoke_signed(
            &spl_token::instruction::transfer(
                token_program.key,
                withdraw_vault.key,
                withdraw_account.key,
                withdraw_vault.key,
                &[],
                withdraw_amount,
            )?,
            &[
                token_program.clone(),
                withdraw_vault.as_ref().clone(),
                withdraw_account.as_ref().clone(),
            ],
            &[&[b"vault", pool_key.as_ref(), mint_key.as_ref(), &[bump]]],
        )?;
    }
    Ok(())
}

pub(crate) struct MaybeInvokeDepositParams<'a, 'info> {
    pub(crate) deposit_amount: u64,
    pub(crate) token_program: &'a AccountInfo<'info>,
    pub(crate) deposit_account: TokenAccountInfo<'a, 'info>,
    pub(crate) deposit_vault: TokenAccountInfo<'a, 'info>,
    pub(crate) trader: &'a AccountInfo<'info>,
}

pub(crate) fn maybe_invoke_deposit<'a, 'info>(
    params: MaybeInvokeDepositParams<'a, 'info>,
) -> ProgramResult {
    let MaybeInvokeDepositParams {
        deposit_amount,
        token_program,
        deposit_account,
        deposit_vault,
        trader,
    } = params;
    if deposit_amount > 0 {
        invoke(
            &spl_token::instruction::transfer(
                token_program.key,
                deposit_account.key,
                deposit_vault.key,
                trader.key,
                &[],
                deposit_amount,
            )?,
            &[
                token_program.as_ref().clone(),
                deposit_account.as_ref().clone(),
                deposit_vault.as_ref().clone(),
                trader.as_ref().clone(),
            ],
        )?;
    }
    Ok(())
}

pub(crate) struct TryDepositParams<'a, 'info> {
    pub(crate) token_program: &'a AccountInfo<'info>,
    pub(crate) quote_account: TokenAccountInfo<'a, 'info>,
    pub(crate) quote_vault: TokenAccountInfo<'a, 'info>,
    pub(crate) base_account: TokenAccountInfo<'a, 'info>,
    pub(crate) base_vault: TokenAccountInfo<'a, 'info>,
    pub(crate) quote_amount: u64,
    pub(crate) base_amount: u64,
    pub(crate) trader: &'a AccountInfo<'info>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn try_deposit<'a, 'info>(params: TryDepositParams<'a, 'info>) -> ProgramResult {
    let TryDepositParams {
        token_program,
        quote_account,
        quote_vault,
        base_account,
        base_vault,
        quote_amount,
        base_amount,
        trader,
    } = params;
    for (deposit_vault, deposit_account, deposit_amount) in [
        (quote_vault, quote_account, quote_amount),
        (base_vault, base_account, base_amount),
    ] {
        maybe_invoke_deposit(MaybeInvokeDepositParams {
            deposit_amount,
            token_program,
            deposit_account,
            deposit_vault,
            trader,
        })?;
    }
    Ok(())
}
