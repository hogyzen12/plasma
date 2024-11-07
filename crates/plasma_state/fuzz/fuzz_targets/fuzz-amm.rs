#![no_main]
use libfuzzer_sys::fuzz_target;
use plasma_fuzz::*;
use plasma_state::amm::Amm;

fuzz_target!(|actions: Vec<AmmAction>| {
    // println!("Starting: {:?}", actions);
    let mut amm = Amm::new(0, 5, 4, 0);
    let base = 279_900_000_000_000;
    let quote = 100_000_000_000;

    let lp_shares = ((base as f64) * (quote as f64)).sqrt() as u64;
    amm.mint(0, base, quote, Some(lp_shares)).unwrap();

    // fuzzed code goes here
    for action in actions {
        perform_action(&mut amm, action);
    }
});
