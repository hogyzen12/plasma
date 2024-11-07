use arbitrary::Arbitrary;
use plasma_state::amm::Amm;
use plasma_state::errors::*;
use std::env;
use std::fmt::Debug;

#[derive(Debug, Arbitrary, Clone, Copy)]
pub enum AmmAction {
    AddLiquidity(u8),
    RemoveLiquidity(u8),
    BuyExactIn(u8),
    SellExactIn(u8),
    BuyExactOut(u8),
    SellExactOut(u8),
    Tick,
}

const TOTAL_BASE_SUPPLY: u64 = 1_073_000_000_000_000;
const TOTAL_QUOTE_SUPPLY: u64 = 500_000_000_000_000_000;

pub fn perform_action(amm: &mut Amm, action: AmmAction) {
    let verbose = env::var("RUST_FUZZ_VERBOSE").is_ok();
    if verbose {
        println!("Action: {:?}", action);
        println!("Pool: {:?}", amm);
    }
    match action {
        AmmAction::AddLiquidity(r) => {
            // generate a float between 0 and 1
            let pct = r as f64 / 255.;

            let max_pct_of_supply = 0.3;
            let base_supply_max =
                (TOTAL_BASE_SUPPLY.saturating_sub(amm.base_reserves) as f64) * max_pct_of_supply;
            let quote_supply_max =
                TOTAL_QUOTE_SUPPLY.saturating_sub(amm.quote_reserves) as f64 * max_pct_of_supply;

            let base_amount = ((amm.base_reserves as f64 * pct) as u64).min(base_supply_max as u64);
            let quote_amount =
                ((amm.quote_reserves as f64 * pct) as u64).min(quote_supply_max as u64);
            if verbose {
                println!(
                    "AddLiquidity: base_amount: {}, quote_amount: {}",
                    base_amount, quote_amount,
                );
            }
            match amm.mint(amm.get_slot(), base_amount, quote_amount, None) {
                Ok(_) => {}
                Err(PlasmaStateError::BelowMinimumLpSharesRequired) => {
                    {};
                }
                Err(e) => {
                    panic!("unexpected error: {}", e);
                }
            }
        }
        AmmAction::RemoveLiquidity(r) => {
            // generate a float between 0 and 0.5
            let pct = r as f64 / (2. * 255.0);
            let lp_shares = (amm.total_lp_shares as f64 * pct) as u64;
            if verbose {
                println!("RemoveLiquidity: lp_shares: {}", lp_shares);
            }
            match amm.burn(amm.get_slot(), lp_shares) {
                Ok(_) => {}
                Err(PlasmaStateError::BelowMinimumWithdrawaRequired) => {
                    {};
                }
                Err(_) => {
                    return;
                }
            }
        }
        AmmAction::BuyExactIn(r) => {
            let pct = (r as f64 + 1.) / (10. * 255.0);
            let quote_remaining = TOTAL_QUOTE_SUPPLY.saturating_sub(amm.quote_reserves);
            if quote_remaining == 0 {
                return;
            }
            let quote_amount = (pct * quote_remaining as f64) as u64;
            if verbose {
                println!("BuyExactIn: quote_amount: {}", quote_amount);
            }
            let pool_start = amm.clone();
            let res = match amm.buy_exact_in(amm.get_slot(), quote_amount) {
                Ok(res) => res,
                Err(PlasmaStateError::SwapExactInTooLarge)
                | Err(PlasmaStateError::SwapOutputGreaterThanOrEqualToReserves(_, _))
                | Err(PlasmaStateError::Overflow)
                | Err(PlasmaStateError::Underflow) => {
                    // Rollback
                    *amm = pool_start;
                    return;
                }
                Err(e) => {
                    panic!("unexpected error: {}", e);
                }
            };
            assert!(pool_start.base_reserves - res.base_amount_to_transfer == amm.base_reserves);
            assert_eq!(
                pool_start.quote_reserves + res.quote_amount_to_transfer - res.fee_in_quote,
                amm.quote_reserves
            );
            assert!(
                pool_start.cumulative_quote_lp_fees
                    + pool_start.cumulative_quote_protocol_fees
                    + res.fee_in_quote
                    == amm.cumulative_quote_lp_fees + amm.cumulative_quote_protocol_fees
            );

            let fee_ratio = res.fee_in_quote as f64 / (res.quote_amount_to_transfer as f64);
            if res.quote_amount_to_transfer > 1000000 {
                assert!(
                    (fee_ratio - (amm.fee_in_bps as f64 / 10000.)).abs() < 0.00001,
                    "{} {} {:?}",
                    fee_ratio,
                    amm.fee_in_bps,
                    res
                );
            }
        }
        AmmAction::SellExactIn(r) => {
            let pct = (r as f64 + 1.) / (10. * 255.0);
            let base_remaining = TOTAL_BASE_SUPPLY - amm.base_reserves;
            let base_amount = (pct * base_remaining as f64) as u64;
            if verbose {
                println!("SellExactIn: base_amount: {}", base_amount);
            }
            let pool_start = amm.clone();
            let res = match amm.sell_exact_in(amm.get_slot(), base_amount) {
                Ok(res) => res,
                Err(PlasmaStateError::SwapExactInTooLarge)
                | Err(PlasmaStateError::SwapOutputGreaterThanOrEqualToReserves(_, _))
                | Err(PlasmaStateError::Overflow)
                | Err(PlasmaStateError::Underflow) => {
                    // Rollback
                    *amm = pool_start;
                    return;
                }
                Err(e) => {
                    panic!("unexpected error: {}", e);
                }
            };
            assert_eq!(
                pool_start.base_reserves + res.base_amount_to_transfer,
                amm.base_reserves
            );
            assert_eq!(
                pool_start.quote_reserves - res.quote_amount_to_transfer - res.fee_in_quote,
                amm.quote_reserves
            );
            assert_eq!(
                pool_start.cumulative_quote_lp_fees
                    + pool_start.cumulative_quote_protocol_fees
                    + res.fee_in_quote,
                amm.cumulative_quote_lp_fees + amm.cumulative_quote_protocol_fees
            );

            let fee_ratio = res.fee_in_quote as f64
                / (res.quote_amount_to_transfer as f64 + res.fee_in_quote as f64);
            if res.quote_amount_to_transfer > 1000000 {
                assert!(
                    (fee_ratio - (amm.fee_in_bps as f64 / 10000.)).abs() < 0.00001,
                    "{} {} {:?}",
                    fee_ratio,
                    amm.fee_in_bps,
                    res
                );
            }
        }
        AmmAction::BuyExactOut(r) => {
            let pct = (r as f64 + 1.) / (10. * 255.0);
            let quote_remaining = amm.quote_reserves;
            let quote_amount = (pct * quote_remaining as f64) as u64;
            let pool_start = amm.clone();
            let Ok(simres) = amm.simulate_buy_exact_in(quote_amount) else {
                return;
            };
            let base_amount_out = simres.base_amount_to_transfer;
            if verbose {
                println!("Sim {:?}", simres);
                println!("BuyExactOut: base_amount: {}", base_amount_out);
            }
            let res = match amm.buy_exact_out(amm.get_slot(), base_amount_out) {
                Ok(res) => res,
                Err(PlasmaStateError::SwapExactOutTooLarge)
                | Err(PlasmaStateError::SwapOutputGreaterThanOrEqualToReserves(_, _))
                | Err(PlasmaStateError::Overflow)
                | Err(PlasmaStateError::Underflow) => {
                    // Rollback
                    *amm = pool_start;
                    return;
                }
                Err(e) => {
                    panic!("unexpected error: {}", e);
                }
            };
            assert!(
                pool_start.base_reserves - res.base_amount_to_transfer == amm.base_reserves,
                "base_reserves: {} + {} != {}",
                pool_start.base_reserves,
                res.base_amount_to_transfer,
                amm.base_reserves
            );
            assert!(
                pool_start.quote_reserves + (res.quote_amount_to_transfer - res.fee_in_quote)
                    == amm.quote_reserves
            );
            assert!(
                pool_start.cumulative_quote_lp_fees
                    + pool_start.cumulative_quote_protocol_fees
                    + res.fee_in_quote
                    == amm.cumulative_quote_lp_fees + amm.cumulative_quote_protocol_fees
            );

            assert!(simres.base_amount_to_transfer == res.base_amount_to_transfer);

            let fee_ratio = res.fee_in_quote as f64 / (res.quote_amount_to_transfer as f64);
            if res.quote_amount_to_transfer > 1000000 {
                assert!(
                    (fee_ratio - (amm.fee_in_bps as f64 / 10000.)).abs() < 0.00001,
                    "{} {} {:?}",
                    fee_ratio,
                    amm.fee_in_bps,
                    res
                );
            }
        }
        AmmAction::SellExactOut(r) => {
            let pct = (r as f64 + 1.) / (10. * 256.0);
            let base_remaining = TOTAL_BASE_SUPPLY - amm.base_reserves;
            let base_amount = (pct * base_remaining as f64) as u64;
            let pool_start = amm.clone();
            let Ok(simres) = amm.simulate_sell_exact_in(base_amount) else {
                return;
            };
            let quote_amount_out = simres.quote_amount_to_transfer;

            if quote_amount_out >= amm.quote_reserves {
                return;
            }
            if verbose {
                println!("SellExactOut: quote_amount: {}", quote_amount_out);
            }
            let res = match amm.sell_exact_out(amm.get_slot(), quote_amount_out) {
                Ok(res) => res,
                Err(PlasmaStateError::SwapExactOutTooLarge)
                | Err(PlasmaStateError::SwapOutputGreaterThanOrEqualToReserves(_, _))
                | Err(PlasmaStateError::Overflow)
                | Err(PlasmaStateError::Underflow) => {
                    // Rollback
                    *amm = pool_start;
                    return;
                }
                Err(e) => {
                    panic!("unexpected error: {}", e);
                }
            };
            assert!(pool_start.base_reserves + res.base_amount_to_transfer == amm.base_reserves);
            assert!(
                pool_start.quote_reserves - res.quote_amount_to_transfer - res.fee_in_quote
                    == amm.quote_reserves,
                "quote_reserves: {} - {} - {} != {}",
                pool_start.quote_reserves,
                res.quote_amount_to_transfer,
                res.fee_in_quote,
                amm.quote_reserves,
            );
            assert!(
                pool_start.cumulative_quote_lp_fees
                    + pool_start.cumulative_quote_protocol_fees
                    + res.fee_in_quote
                    == amm.cumulative_quote_lp_fees + amm.cumulative_quote_protocol_fees
            );
            assert_eq!(
                simres.quote_amount_to_transfer,
                res.quote_amount_to_transfer
            );

            let fee_ratio = res.fee_in_quote as f64
                / (res.quote_amount_to_transfer as f64 + res.fee_in_quote as f64);
            if res.quote_amount_to_transfer > 1000000 {
                assert!(
                    (fee_ratio - (amm.fee_in_bps as f64 / 10000.)).abs() < 0.00001,
                    "{} {} {:?}",
                    fee_ratio,
                    amm.fee_in_bps,
                    res
                );
            }
        }
        AmmAction::Tick => {
            if verbose {
                println!("Tick");
            }
            assert!(amm.maybe_update_snapshot(amm.get_slot() + 1));
        }
    }
}
