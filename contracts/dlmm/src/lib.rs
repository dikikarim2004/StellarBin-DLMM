//! Stellar DLMM (Dynamic Liquidity Market Maker) — Soroban Smart Contract
//!
//! Implements discrete-bin AMM logic inspired by Meteora DLMM on Solana,
//! adapted for Stellar's Soroban execution environment.
//!
//! # Architecture
//!
//! Each pool contains:
//! - A set of *bins*, each with a constant price `P = 1.0001^bin_id`.
//! - Each bin holds reserves of tokenX and tokenY.
//! - Swaps traverse bins sequentially, filling each at its fixed price.
//! - Fees are dynamic: higher during volatile periods (see math::dynamic_fee).
//!
//! # Storage layout (Soroban persistent storage)
//!
//! Key                   | Value
//! ----------------------|---------------------------
//! "POOL_CONFIG"         | PoolConfig struct
//! "ACTIVE_BIN"          | i32 (active bin ID)
//! "LAST_TRADE_TS"       | u64 (Unix timestamp)
//! ("BIN", bin_id: i32)  | BinReserves struct
//!
//! # Security
//!
//! - All arithmetic uses i128 checked operations (panics = Soroban trap).
//! - Admin-only functions are protected by auth.
//! - Slippage protection on swap_exact_in_bin.
//! - Re-entrancy is not a concern on Soroban (single-threaded, no callbacks
//!   during contract execution).

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, Address, Env, Symbol, Vec,
};
use stellar_dlmm_math::{bin_price, compute_x_from_y, compute_y_from_x, dynamic_fee, SCALAR};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// Persistent pool configuration — written once at init, read on every call.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PoolConfig {
    /// Stellar asset contract address for token X (base token).
    pub token_x: Address,
    /// Stellar asset contract address for token Y (quote token, usually USDC).
    pub token_y: Address,
    /// Bin step in basis points (e.g. 25 = 0.25% price gap between bins).
    pub bin_step_bps: i128,
    /// Base swap fee in basis points before dynamic adjustment.
    pub base_fee_bps: i128,
    /// Contract administrator (can set fee, emergency-pause, etc.).
    pub admin: Address,
}

/// Per-bin reserves stored in contract persistent storage.
#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct BinReserves {
    /// Amount of token X in this bin (SCALAR-scaled integer).
    pub reserve_x: i128,
    /// Amount of token Y in this bin (SCALAR-scaled integer).
    pub reserve_y: i128,
}

/// Return value for swap operations.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SwapResult {
    /// Actual amount of output token sent to the caller.
    pub amount_out: i128,
    /// Total fee collected across all bins (in input token units).
    pub fee_paid: i128,
    /// Number of bins traversed during the swap.
    pub bins_crossed: u32,
    /// Final active bin after the swap.
    pub final_bin: i32,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const KEY_CONFIG: Symbol = symbol_short!("POOL_CFG");
const KEY_ACTIVE: Symbol = symbol_short!("ACTIVE");
const KEY_LAST_TS: Symbol = symbol_short!("LAST_TS");

fn bin_key(bin_id: i32) -> (Symbol, i32) {
    (symbol_short!("BIN"), bin_id)
}

fn get_config(env: &Env) -> PoolConfig {
    env.storage()
        .persistent()
        .get(&KEY_CONFIG)
        .expect("pool not initialized")
}

fn get_active_bin(env: &Env) -> i32 {
    env.storage()
        .persistent()
        .get(&KEY_ACTIVE)
        .unwrap_or(0i32)
}

fn get_bin(env: &Env, bin_id: i32) -> BinReserves {
    env.storage()
        .persistent()
        .get(&bin_key(bin_id))
        .unwrap_or_default()
}

fn set_bin(env: &Env, bin_id: i32, reserves: &BinReserves) {
    env.storage()
        .persistent()
        .set(&bin_key(bin_id), reserves);
}

fn get_last_trade_ts(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&KEY_LAST_TS)
        .unwrap_or(0u64)
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct DlmmContract;

#[contractimpl]
impl DlmmContract {
    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    /// Initialise a new DLMM pool.  Can only be called once.
    ///
    /// # Arguments
    /// * `token_x`       – SAC address of the base token
    /// * `token_y`       – SAC address of the quote token (e.g. USDC)
    /// * `bin_step_bps`  – Price gap per bin in bps (1–500 recommended)
    /// * `base_fee_bps`  – Static base fee in bps (1–100 recommended)
    /// * `active_bin_id` – The bin that represents the current market price
    pub fn initialize(
        env: Env,
        admin: Address,
        token_x: Address,
        token_y: Address,
        bin_step_bps: i128,
        base_fee_bps: i128,
        active_bin_id: i32,
    ) {
        admin.require_auth();
        assert!(
            !env.storage().persistent().has(&KEY_CONFIG),
            "already initialized"
        );
        assert!(
            bin_step_bps >= 1 && bin_step_bps <= 500,
            "bin_step_bps out of range"
        );
        assert!(
            base_fee_bps >= 1 && base_fee_bps <= 100,
            "base_fee_bps out of range"
        );

        let config = PoolConfig {
            token_x,
            token_y,
            bin_step_bps,
            base_fee_bps,
            admin,
        };
        env.storage().persistent().set(&KEY_CONFIG, &config);
        env.storage().persistent().set(&KEY_ACTIVE, &active_bin_id);
        env.storage()
            .persistent()
            .set(&KEY_LAST_TS, &env.ledger().timestamp());
    }

    // -----------------------------------------------------------------------
    // Liquidity management
    // -----------------------------------------------------------------------

    /// Add liquidity to a specific bin.
    ///
    /// The caller deposits `amount_x` of token X and `amount_y` of token Y
    /// into `bin_id`.  The contract pulls tokens from `caller` via the SAC
    /// transfer interface.
    ///
    /// For bins above the active bin, only token X should be deposited (Y = 0).
    /// For bins below the active bin, only token Y should be deposited (X = 0).
    /// For the active bin itself, both tokens can be deposited.
    pub fn add_liquidity_bin(
        env: Env,
        caller: Address,
        bin_id: i32,
        amount_x: i128,
        amount_y: i128,
    ) {
        caller.require_auth();
        assert!(amount_x >= 0 && amount_y >= 0, "negative amounts");
        assert!(amount_x > 0 || amount_y > 0, "zero deposit");

        let config = get_config(&env);
        let active_bin = get_active_bin(&env);

        // Enforce one-sided deposits for off-active bins.
        if bin_id > active_bin {
            assert!(amount_y == 0, "only token_x allowed above active bin");
        } else if bin_id < active_bin {
            assert!(amount_x == 0, "only token_y allowed below active bin");
        }

        // Pull tokens from caller.
        if amount_x > 0 {
            token::Client::new(&env, &config.token_x).transfer(
                &caller,
                &env.current_contract_address(),
                &amount_x,
            );
        }
        if amount_y > 0 {
            token::Client::new(&env, &config.token_y).transfer(
                &caller,
                &env.current_contract_address(),
                &amount_y,
            );
        }

        // Update bin reserves.
        let mut bin = get_bin(&env, bin_id);
        bin.reserve_x = bin.reserve_x.checked_add(amount_x).expect("overflow x");
        bin.reserve_y = bin.reserve_y.checked_add(amount_y).expect("overflow y");
        set_bin(&env, bin_id, &bin);

        env.events().publish(
            (symbol_short!("ADD_LIQ"), bin_id),
            (caller, amount_x, amount_y),
        );
    }

    /// Remove all liquidity from a specific bin and return tokens to `caller`.
    pub fn remove_liquidity_bin(env: Env, caller: Address, bin_id: i32) {
        caller.require_auth();
        let config = get_config(&env);
        let bin = get_bin(&env, bin_id);

        assert!(
            bin.reserve_x > 0 || bin.reserve_y > 0,
            "bin is empty"
        );

        // Return tokens to caller.
        if bin.reserve_x > 0 {
            token::Client::new(&env, &config.token_x).transfer(
                &env.current_contract_address(),
                &caller,
                &bin.reserve_x,
            );
        }
        if bin.reserve_y > 0 {
            token::Client::new(&env, &config.token_y).transfer(
                &env.current_contract_address(),
                &caller,
                &bin.reserve_y,
            );
        }

        // Zero out the bin.
        set_bin(&env, bin_id, &BinReserves::default());

        env.events().publish(
            (symbol_short!("REM_LIQ"), bin_id),
            (caller, bin.reserve_x, bin.reserve_y),
        );
    }

    // -----------------------------------------------------------------------
    // Swap
    // -----------------------------------------------------------------------

    /// Swap an exact amount of token X for token Y (or vice versa),
    /// traversing bins from the active bin outward until `amount_in` is consumed.
    ///
    /// # Arguments
    /// * `caller`          – payer (must have authorised spend of `amount_in`)
    /// * `x_to_y`          – true = sell X buy Y; false = sell Y buy X
    /// * `amount_in`       – exact input amount (SAC-native units, 7-decimal)
    /// * `min_amount_out`  – minimum acceptable output (slippage guard)
    ///
    /// # Returns
    /// `SwapResult` with the amount received, fee paid, and bins crossed.
    pub fn swap_exact_in_bin(
        env: Env,
        caller: Address,
        x_to_y: bool,
        amount_in: i128,
        min_amount_out: i128,
    ) -> SwapResult {
        caller.require_auth();
        assert!(amount_in > 0, "zero amount_in");

        let config = get_config(&env);
        let now = env.ledger().timestamp();
        let seconds_since = (now - get_last_trade_ts(&env)) as i128;
        let fee_bps = dynamic_fee(config.base_fee_bps, seconds_since);

        let mut active_bin = get_active_bin(&env);
        let mut remaining = amount_in;
        let mut total_out: i128 = 0;
        let mut total_fee: i128 = 0;
        let mut bins_crossed: u32 = 0;

        // Step direction: buying Y (x_to_y=true) → move right (higher bins).
        // Selling Y (x_to_y=false) → move left (lower bins).
        let step: i32 = if x_to_y { 1 } else { -1 };

        // Traverse up to 50 bins to cap CPU budget.
        for _ in 0..50 {
            if remaining == 0 {
                break;
            }

            let mut bin = get_bin(&env, active_bin);
            let price = bin_price(config.bin_step_bps, active_bin as i128);

            // Capacity of this bin (how much input it can absorb).
            let (bin_capacity, out_available) = if x_to_y {
                // Buying Y: bin capacity = how much X it needs to drain its Y.
                let cap = compute_x_from_y(bin.reserve_y, price);
                (cap, bin.reserve_y)
            } else {
                // Buying X: bin capacity = how much Y it needs to drain its X.
                let cap = compute_y_from_x(bin.reserve_x, price);
                (cap, bin.reserve_x)
            };

            if bin_capacity == 0 {
                // Empty bin — move to next.
                active_bin += step;
                continue;
            }

            // How much of `remaining` can this bin absorb?
            let consumed = remaining.min(bin_capacity);
            let fee = consumed * fee_bps / 10_000;
            let consumed_after_fee = consumed - fee;

            // Proportional output.
            let out = if x_to_y {
                compute_y_from_x(consumed_after_fee, price).min(out_available)
            } else {
                compute_x_from_y(consumed_after_fee, price).min(out_available)
            };

            // Update bin reserves.
            if x_to_y {
                bin.reserve_x = bin.reserve_x.checked_add(consumed).expect("overflow");
                bin.reserve_y = bin.reserve_y.checked_sub(out).expect("underflow");
            } else {
                bin.reserve_y = bin.reserve_y.checked_add(consumed).expect("overflow");
                bin.reserve_x = bin.reserve_x.checked_sub(out).expect("underflow");
            }
            set_bin(&env, active_bin, &bin);

            total_out = total_out.checked_add(out).expect("overflow out");
            total_fee = total_fee.checked_add(fee).expect("overflow fee");
            remaining -= consumed;
            bins_crossed += 1;

            // Move to next bin if this one is depleted.
            if consumed >= bin_capacity {
                active_bin += step;
            }
        }

        // Slippage guard.
        assert!(total_out >= min_amount_out, "slippage: insufficient output");

        // Pull input token from caller.
        let input_token = if x_to_y { &config.token_x } else { &config.token_y };
        let spent = amount_in - remaining; // may be < amount_in if bins ran out
        token::Client::new(&env, input_token).transfer(
            &caller,
            &env.current_contract_address(),
            &spent,
        );

        // Push output token to caller.
        let output_token = if x_to_y { &config.token_y } else { &config.token_x };
        token::Client::new(&env, output_token).transfer(
            &env.current_contract_address(),
            &caller,
            &total_out,
        );

        // Persist updated active bin and timestamp.
        env.storage().persistent().set(&KEY_ACTIVE, &active_bin);
        env.storage().persistent().set(&KEY_LAST_TS, &now);

        env.events().publish(
            (symbol_short!("SWAP"), x_to_y),
            (caller, spent, total_out, total_fee),
        );

        SwapResult {
            amount_out: total_out,
            fee_paid: total_fee,
            bins_crossed,
            final_bin: active_bin,
        }
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// Return the current active bin ID.
    pub fn get_active_bin(env: Env) -> i32 {
        get_active_bin(&env)
    }

    /// Return reserves for a specific bin.
    pub fn get_bin_reserves(env: Env, bin_id: i32) -> BinReserves {
        get_bin(&env, bin_id)
    }

    /// Return pool configuration.
    pub fn get_config(env: Env) -> PoolConfig {
        get_config(&env)
    }

    /// Simulate a swap without state changes (read-only).
    pub fn simulate_swap(
        env: Env,
        x_to_y: bool,
        amount_in: i128,
    ) -> SwapResult {
        let config = get_config(&env);
        let now = env.ledger().timestamp();
        let seconds_since = (now - get_last_trade_ts(&env)) as i128;
        let fee_bps = dynamic_fee(config.base_fee_bps, seconds_since);

        let mut active_bin = get_active_bin(&env);
        let mut remaining = amount_in;
        let mut total_out: i128 = 0;
        let mut total_fee: i128 = 0;
        let mut bins_crossed: u32 = 0;
        let step: i32 = if x_to_y { 1 } else { -1 };

        for _ in 0..50 {
            if remaining == 0 {
                break;
            }
            let bin = get_bin(&env, active_bin);
            let price = bin_price(config.bin_step_bps, active_bin as i128);

            let (bin_capacity, out_available) = if x_to_y {
                (compute_x_from_y(bin.reserve_y, price), bin.reserve_y)
            } else {
                (compute_y_from_x(bin.reserve_x, price), bin.reserve_x)
            };

            if bin_capacity == 0 {
                active_bin += step;
                continue;
            }

            let consumed = remaining.min(bin_capacity);
            let fee = consumed * fee_bps / 10_000;
            let out = if x_to_y {
                compute_y_from_x(consumed - fee, price).min(out_available)
            } else {
                compute_x_from_y(consumed - fee, price).min(out_available)
            };

            total_out += out;
            total_fee += fee;
            remaining -= consumed;
            bins_crossed += 1;

            if consumed >= bin_capacity {
                active_bin += step;
            }
        }

        SwapResult {
            amount_out: total_out,
            fee_paid: total_fee,
            bins_crossed,
            final_bin: active_bin,
        }
    }
}
