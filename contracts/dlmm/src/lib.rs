//! Stellar DLMM (Dynamic Liquidity Market Maker) — Soroban Smart Contract
//!
//! Implements discrete-bin AMM logic inspired by Meteora DLMM on Solana,
//! adapted for Stellar's Soroban execution environment.
//!
//! # Architecture
//!
//! A single deployed contract instance acts as a *pool registry*: anyone can
//! permissionlessly call `create_pool` to register a new token-pair pool
//! (own bin step / base fee / activation time), instead of deploying a new
//! contract per pool. Every other entry point takes a `pool_id` and only
//! touches that pool's isolated storage.
//!
//! Each pool contains:
//! - A set of *bins*, each with a constant price `P = 1.0001^bin_id`.
//! - Each bin holds reserves of tokenX and tokenY.
//! - Swaps traverse bins sequentially, filling each at its fixed price.
//! - Fees are dynamic: higher during volatile periods (see math::dynamic_fee).
//!
//! # Standard Pool vs. Launch Pool
//!
//! `create_pool` takes an `activation_ts`. `0` means the pool is tradable
//! immediately ("Standard Pool"). A future unix timestamp means the pool is a
//! "Launch Pool": liquidity can be seeded ahead of time, but `swap_exact_in_bin`
//! is rejected until `activation_ts` is reached — a simple anti-snipe window.
//!
//! # Fee split — platform vs. LP
//!
//! Every swap's fee is split between the pool's liquidity providers and the
//! protocol treasury, controlled by a single contract-wide `protocol_fee_bps`
//! (default 2000 = 20%, admin-adjustable via `set_protocol_fee_bps`). The LP
//! share of the fee is left in the bin (accrues to LPs pro-rata); the
//! protocol share accrues to a per-pool, per-token claimable balance that the
//! admin can withdraw via `withdraw_protocol_fees`.
//!
//! # Per-user positions (LP shares)
//!
//! Liquidity providers receive *shares* in each bin they deposit into. Shares
//! are minted proportional to the value added (measured in token Y terms) vs.
//! the bin's existing value. On removal, an LP redeems their shares for a
//! proportional slice of the bin's *current* reserves — which naturally
//! includes any LP-side swap fees the bin accrued while their liquidity sat
//! there. This means `remove_liquidity_bin` only ever returns the caller's
//! own share, never another LP's funds.
//!
//! # Storage layout (Soroban persistent storage, keyed by DataKey)
//!
//! Admin                    | Address (contract-wide admin)
//! ProtocolFeeBps           | i128 (contract-wide, default 2000 = 20%)
//! PoolCounter              | u64 (next pool_id to assign)
//! AllPools                 | Vec<u64> (every pool_id ever created)
//! PoolConfig(pool_id)      | PoolConfig struct
//! Active(pool_id)          | i32 (active bin ID)
//! LastTs(pool_id)          | u64 (Unix timestamp of last trade)
//! Bin(pool_id,i32)         | BinReserves struct
//! AllBins(pool_id)         | Vec<i32> (every bin that has ever held liquidity)
//! Share(pool_id,Addr,i32)  | i128 (an LP's shares in a bin)
//! TotalShare(pool_id,i32)  | i128 (total shares issued for a bin)
//! UserBins(pool_id,Addr)   | Vec<i32> (bins an LP has ever deposited into)
//! ProtoFeeX(pool_id)       | i128 (claimable protocol fee, token X)
//! ProtoFeeY(pool_id)       | i128 (claimable protocol fee, token Y)
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
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, Vec,
};
use stellar_dlmm_math::{bin_price, compute_x_from_y, compute_y_from_x, dynamic_fee};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// Persistent storage keys.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    ProtocolFeeBps,
    PoolCounter,
    AllPools,
    PoolConfig(u64),
    Active(u64),
    LastTs(u64),
    Bin(u64, i32),
    AllBins(u64),
    Share(u64, Address, i32),
    TotalShare(u64, i32),
    UserBins(u64, Address),
    ProtoFeeX(u64),
    ProtoFeeY(u64),
}

/// Persistent pool configuration — written once at pool creation, read on
/// every call touching that pool.
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
    /// Address that created (and permissionlessly registered) the pool.
    pub creator: Address,
    /// Unix timestamp after which swaps are allowed. 0 = active immediately
    /// ("Standard Pool"). A future timestamp marks a "Launch Pool".
    pub activation_ts: u64,
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

/// A bin plus its ID — returned by `get_bins` for the distribution chart.
#[contracttype]
#[derive(Clone, Debug)]
pub struct BinInfo {
    pub bin_id: i32,
    pub reserve_x: i128,
    pub reserve_y: i128,
}

/// A single LP position (one bin) — returned by `get_positions`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PositionInfo {
    pub bin_id: i32,
    /// LP shares held by the user in this bin.
    pub shares: i128,
    /// Total shares issued for the bin (for pro-rata display).
    pub total_shares: i128,
    /// Token X currently claimable by the user (their pro-rata slice).
    pub amount_x: i128,
    /// Token Y currently claimable by the user (their pro-rata slice).
    pub amount_y: i128,
}

/// Return value for swap operations.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SwapResult {
    /// Actual amount of output token sent to the caller.
    pub amount_out: i128,
    /// Total fee collected across all bins (in input token units).
    pub fee_paid: i128,
    /// Portion of `fee_paid` routed to the protocol treasury.
    pub protocol_fee: i128,
    /// Number of bins traversed during the swap.
    pub bins_crossed: u32,
    /// Final active bin after the swap.
    pub final_bin: i32,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn get_admin(env: &Env) -> Address {
    env.storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("contract not initialized")
}

fn get_protocol_fee_bps(env: &Env) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::ProtocolFeeBps)
        .unwrap_or(2000i128)
}

fn get_pool_config(env: &Env, pool_id: u64) -> PoolConfig {
    env.storage()
        .persistent()
        .get(&DataKey::PoolConfig(pool_id))
        .expect("pool does not exist")
}

fn get_active_bin(env: &Env, pool_id: u64) -> i32 {
    env.storage()
        .persistent()
        .get(&DataKey::Active(pool_id))
        .unwrap_or(0i32)
}

fn get_bin(env: &Env, pool_id: u64, bin_id: i32) -> BinReserves {
    env.storage()
        .persistent()
        .get(&DataKey::Bin(pool_id, bin_id))
        .unwrap_or_default()
}

fn set_bin(env: &Env, pool_id: u64, bin_id: i32, reserves: &BinReserves) {
    env.storage()
        .persistent()
        .set(&DataKey::Bin(pool_id, bin_id), reserves);
}

fn get_last_trade_ts(env: &Env, pool_id: u64) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::LastTs(pool_id))
        .unwrap_or(0u64)
}

fn get_all_bins(env: &Env, pool_id: u64) -> Vec<i32> {
    env.storage()
        .persistent()
        .get(&DataKey::AllBins(pool_id))
        .unwrap_or_else(|| Vec::new(env))
}

/// Record `bin_id` in `pool_id`'s bin registry if not already present.
fn track_bin(env: &Env, pool_id: u64, bin_id: i32) {
    let mut all = get_all_bins(env, pool_id);
    if !all.iter().any(|b| b == bin_id) {
        all.push_back(bin_id);
        env.storage().persistent().set(&DataKey::AllBins(pool_id), &all);
    }
}

fn get_share(env: &Env, pool_id: u64, user: &Address, bin_id: i32) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Share(pool_id, user.clone(), bin_id))
        .unwrap_or(0i128)
}

fn set_share(env: &Env, pool_id: u64, user: &Address, bin_id: i32, shares: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::Share(pool_id, user.clone(), bin_id), &shares);
}

fn get_total_share(env: &Env, pool_id: u64, bin_id: i32) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalShare(pool_id, bin_id))
        .unwrap_or(0i128)
}

fn set_total_share(env: &Env, pool_id: u64, bin_id: i32, shares: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::TotalShare(pool_id, bin_id), &shares);
}

fn get_user_bins(env: &Env, pool_id: u64, user: &Address) -> Vec<i32> {
    env.storage()
        .persistent()
        .get(&DataKey::UserBins(pool_id, user.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

/// Record `bin_id` in the user's personal bin registry for `pool_id` if not
/// already present.
fn track_user_bin(env: &Env, pool_id: u64, user: &Address, bin_id: i32) {
    let mut bins = get_user_bins(env, pool_id, user);
    if !bins.iter().any(|b| b == bin_id) {
        bins.push_back(bin_id);
        env.storage()
            .persistent()
            .set(&DataKey::UserBins(pool_id, user.clone()), &bins);
    }
}

fn get_protocol_fee_x(env: &Env, pool_id: u64) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::ProtoFeeX(pool_id))
        .unwrap_or(0i128)
}

fn get_protocol_fee_y(env: &Env, pool_id: u64) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::ProtoFeeY(pool_id))
        .unwrap_or(0i128)
}

/// Value of a bin denominated in token Y units, at the bin's fixed price.
fn bin_value_in_y(bin: &BinReserves, price: i128) -> i128 {
    bin.reserve_y + compute_y_from_x(bin.reserve_x, price)
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct DlmmContract;

#[contractimpl]
impl DlmmContract {
    // -----------------------------------------------------------------------
    // Contract-wide initialisation (once per deployed instance)
    // -----------------------------------------------------------------------

    /// Initialise the contract-wide admin and default protocol fee split.
    /// Can only be called once. Individual pools are created afterwards via
    /// `create_pool` — no per-pool initialisation is required.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        assert!(
            !env.storage().persistent().has(&DataKey::Admin),
            "already initialized"
        );
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::ProtocolFeeBps, &2000i128);
        env.storage()
            .persistent()
            .set(&DataKey::PoolCounter, &0u64);
    }

    /// Contract admin — can adjust the protocol fee split and withdraw
    /// accrued protocol fees. Does not gate pool creation (permissionless).
    pub fn get_admin(env: Env) -> Address {
        get_admin(&env)
    }

    /// Update the contract-wide protocol fee split (admin only).
    /// `new_bps` is the protocol's share of every swap fee, in basis points
    /// of the fee itself (e.g. 2000 = protocol keeps 20% of the fee, LPs
    /// keep the remaining 80%).
    pub fn set_protocol_fee_bps(env: Env, admin: Address, new_bps: i128) {
        admin.require_auth();
        assert!(admin == get_admin(&env), "not admin");
        assert!(new_bps >= 0 && new_bps <= 5000, "protocol fee out of range");
        env.storage()
            .persistent()
            .set(&DataKey::ProtocolFeeBps, &new_bps);
    }

    /// Current contract-wide protocol fee split, in bps of the swap fee.
    pub fn get_protocol_fee_bps(env: Env) -> i128 {
        get_protocol_fee_bps(&env)
    }

    // -----------------------------------------------------------------------
    // Pool creation — permissionless registry ("Create Pool")
    // -----------------------------------------------------------------------

    /// Register a new pool ("Standard Pool" if `activation_ts` is 0, else a
    /// "Launch Pool" that only allows swaps once `activation_ts` is reached).
    /// Anyone may call this — pool creation carries no on-chain gatekeeping,
    /// only network transaction fees.
    pub fn create_pool(
        env: Env,
        creator: Address,
        token_x: Address,
        token_y: Address,
        bin_step_bps: i128,
        base_fee_bps: i128,
        active_bin_id: i32,
        activation_ts: u64,
    ) -> u64 {
        creator.require_auth();
        assert!(token_x != token_y, "token_x and token_y must differ");
        assert!(
            bin_step_bps >= 1 && bin_step_bps <= 500,
            "bin_step_bps out of range"
        );
        assert!(
            base_fee_bps >= 1 && base_fee_bps <= 100,
            "base_fee_bps out of range"
        );

        let pool_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::PoolCounter)
            .unwrap_or(0u64);
        env.storage()
            .persistent()
            .set(&DataKey::PoolCounter, &(pool_id + 1));

        let config = PoolConfig {
            token_x,
            token_y,
            bin_step_bps,
            base_fee_bps,
            creator: creator.clone(),
            activation_ts,
        };
        env.storage()
            .persistent()
            .set(&DataKey::PoolConfig(pool_id), &config);
        env.storage()
            .persistent()
            .set(&DataKey::Active(pool_id), &active_bin_id);
        env.storage()
            .persistent()
            .set(&DataKey::LastTs(pool_id), &env.ledger().timestamp());

        let mut all_pools: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::AllPools)
            .unwrap_or_else(|| Vec::new(&env));
        all_pools.push_back(pool_id);
        env.storage().persistent().set(&DataKey::AllPools, &all_pools);

        env.events().publish(
            (symbol_short!("NEW_POOL"), pool_id),
            (creator, bin_step_bps, base_fee_bps, activation_ts),
        );

        pool_id
    }

    /// Every pool_id ever created, in creation order.
    pub fn list_pools(env: Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::AllPools)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Whether `pool_id` currently allows swaps (activation time reached).
    pub fn is_pool_active(env: Env, pool_id: u64) -> bool {
        let config = get_pool_config(&env, pool_id);
        env.ledger().timestamp() >= config.activation_ts
    }

    // -----------------------------------------------------------------------
    // Liquidity management
    // -----------------------------------------------------------------------

    /// Add liquidity to a specific bin, minting LP shares to the caller.
    ///
    /// For bins above the active bin, only token X should be deposited (Y = 0).
    /// For bins below the active bin, only token Y should be deposited (X = 0).
    /// For the active bin itself, both tokens can be deposited.
    ///
    /// Allowed even before a Launch Pool's `activation_ts` — LPs may seed
    /// liquidity ahead of time; only swaps are gated by activation.
    pub fn add_liquidity_bin(
        env: Env,
        pool_id: u64,
        caller: Address,
        bin_id: i32,
        amount_x: i128,
        amount_y: i128,
    ) {
        caller.require_auth();
        assert!(amount_x >= 0 && amount_y >= 0, "negative amounts");
        assert!(amount_x > 0 || amount_y > 0, "zero deposit");

        let config = get_pool_config(&env, pool_id);
        let active_bin = get_active_bin(&env, pool_id);

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

        // Value the deposit and the bin (in token Y terms) to mint shares.
        let price = bin_price(config.bin_step_bps, bin_id as i128);
        let mut bin = get_bin(&env, pool_id, bin_id);
        let bin_value_before = bin_value_in_y(&bin, price);
        let deposit_value = amount_y + compute_y_from_x(amount_x, price);

        let total_shares_before = get_total_share(&env, pool_id, bin_id);
        let shares_minted = if total_shares_before == 0 || bin_value_before == 0 {
            deposit_value
        } else {
            deposit_value
                .checked_mul(total_shares_before)
                .expect("overflow shares")
                / bin_value_before
        };
        assert!(shares_minted > 0, "deposit too small");

        // Update bin reserves.
        bin.reserve_x = bin.reserve_x.checked_add(amount_x).expect("overflow x");
        bin.reserve_y = bin.reserve_y.checked_add(amount_y).expect("overflow y");
        set_bin(&env, pool_id, bin_id, &bin);

        // Update share accounting.
        set_total_share(&env, pool_id, bin_id, total_shares_before + shares_minted);
        set_share(
            &env,
            pool_id,
            &caller,
            bin_id,
            get_share(&env, pool_id, &caller, bin_id) + shares_minted,
        );

        track_bin(&env, pool_id, bin_id);
        track_user_bin(&env, pool_id, &caller, bin_id);

        env.events().publish(
            (symbol_short!("ADD_LIQ"), pool_id, bin_id),
            (caller, amount_x, amount_y, shares_minted),
        );
    }

    /// Remove the caller's entire position in a bin, returning their pro-rata
    /// slice of the bin's current reserves (including accrued LP-side fees).
    pub fn remove_liquidity_bin(env: Env, pool_id: u64, caller: Address, bin_id: i32) {
        caller.require_auth();
        let config = get_pool_config(&env, pool_id);

        let user_shares = get_share(&env, pool_id, &caller, bin_id);
        assert!(user_shares > 0, "no position in bin");

        let total_shares = get_total_share(&env, pool_id, bin_id);
        assert!(total_shares > 0, "no shares issued");

        let mut bin = get_bin(&env, pool_id, bin_id);
        let x_out = bin
            .reserve_x
            .checked_mul(user_shares)
            .expect("overflow x_out")
            / total_shares;
        let y_out = bin
            .reserve_y
            .checked_mul(user_shares)
            .expect("overflow y_out")
            / total_shares;

        // Update reserves & share accounting first (checks-effects-interactions).
        bin.reserve_x -= x_out;
        bin.reserve_y -= y_out;
        set_bin(&env, pool_id, bin_id, &bin);
        set_total_share(&env, pool_id, bin_id, total_shares - user_shares);
        set_share(&env, pool_id, &caller, bin_id, 0);

        // Return tokens to caller.
        if x_out > 0 {
            token::Client::new(&env, &config.token_x).transfer(
                &env.current_contract_address(),
                &caller,
                &x_out,
            );
        }
        if y_out > 0 {
            token::Client::new(&env, &config.token_y).transfer(
                &env.current_contract_address(),
                &caller,
                &y_out,
            );
        }

        env.events().publish(
            (symbol_short!("REM_LIQ"), pool_id, bin_id),
            (caller, x_out, y_out, user_shares),
        );
    }

    // -----------------------------------------------------------------------
    // Protocol fee (platform fee) withdrawal
    // -----------------------------------------------------------------------

    /// Withdraw the protocol's accrued share of swap fees for `pool_id`
    /// (admin only). Returns the (token_x, token_y) amounts withdrawn.
    pub fn withdraw_protocol_fees(env: Env, pool_id: u64, admin: Address) -> (i128, i128) {
        admin.require_auth();
        assert!(admin == get_admin(&env), "not admin");
        let config = get_pool_config(&env, pool_id);

        let x_amt = get_protocol_fee_x(&env, pool_id);
        let y_amt = get_protocol_fee_y(&env, pool_id);

        if x_amt > 0 {
            env.storage()
                .persistent()
                .set(&DataKey::ProtoFeeX(pool_id), &0i128);
            token::Client::new(&env, &config.token_x).transfer(
                &env.current_contract_address(),
                &admin,
                &x_amt,
            );
        }
        if y_amt > 0 {
            env.storage()
                .persistent()
                .set(&DataKey::ProtoFeeY(pool_id), &0i128);
            token::Client::new(&env, &config.token_y).transfer(
                &env.current_contract_address(),
                &admin,
                &y_amt,
            );
        }

        env.events().publish(
            (symbol_short!("FEE_OUT"), pool_id),
            (admin, x_amt, y_amt),
        );

        (x_amt, y_amt)
    }

    /// Claimable-but-not-yet-withdrawn protocol fee balances for `pool_id`.
    pub fn get_protocol_fee_balance(env: Env, pool_id: u64) -> (i128, i128) {
        (
            get_protocol_fee_x(&env, pool_id),
            get_protocol_fee_y(&env, pool_id),
        )
    }

    // -----------------------------------------------------------------------
    // Swap
    // -----------------------------------------------------------------------

    /// Swap an exact amount of token X for token Y (or vice versa),
    /// traversing bins from the active bin outward until `amount_in` is
    /// consumed. Rejected until the pool's `activation_ts` is reached.
    pub fn swap_exact_in_bin(
        env: Env,
        pool_id: u64,
        caller: Address,
        x_to_y: bool,
        amount_in: i128,
        min_amount_out: i128,
    ) -> SwapResult {
        caller.require_auth();
        assert!(amount_in > 0, "zero amount_in");

        let config = get_pool_config(&env, pool_id);
        let now = env.ledger().timestamp();
        assert!(now >= config.activation_ts, "pool not active yet");

        let protocol_fee_bps = get_protocol_fee_bps(&env);
        let seconds_since = (now - get_last_trade_ts(&env, pool_id)) as i128;
        let fee_bps = dynamic_fee(config.base_fee_bps, seconds_since);

        let mut active_bin = get_active_bin(&env, pool_id);
        let mut remaining = amount_in;
        let mut total_out: i128 = 0;
        let mut total_fee: i128 = 0;
        let mut total_protocol_fee: i128 = 0;
        let mut bins_crossed: u32 = 0;

        // Step direction: bins above active hold token X only, bins below
        // hold token Y only (see `add_liquidity_bin`'s one-sided rule).
        // Buying Y (x_to_y=true, spending X) drains Y reserves, which sit at
        // and below the active bin → move left (lower bins) once a bin is
        // exhausted. Selling Y (x_to_y=false, spending Y) drains X reserves,
        // which sit at and above the active bin → move right (higher bins).
        let step: i32 = if x_to_y { -1 } else { 1 };

        // Traverse up to 50 bins to cap CPU budget.
        for _ in 0..50 {
            if remaining == 0 {
                break;
            }

            let mut bin = get_bin(&env, pool_id, active_bin);
            let price = bin_price(config.bin_step_bps, active_bin as i128);

            // Capacity of this bin (how much input it can absorb).
            let (bin_capacity, out_available) = if x_to_y {
                let cap = compute_x_from_y(bin.reserve_y, price);
                (cap, bin.reserve_y)
            } else {
                let cap = compute_y_from_x(bin.reserve_x, price);
                (cap, bin.reserve_x)
            };

            if bin_capacity == 0 {
                active_bin += step;
                continue;
            }

            let consumed = remaining.min(bin_capacity);
            let fee = consumed * fee_bps / 10_000;
            let protocol_fee = fee * protocol_fee_bps / 10_000;
            let consumed_after_fee = consumed - fee;

            let out = if x_to_y {
                compute_y_from_x(consumed_after_fee, price).min(out_available)
            } else {
                compute_x_from_y(consumed_after_fee, price).min(out_available)
            };

            // Update bin reserves. The LP share of the fee (fee - protocol_fee)
            // stays in the bin, accruing to LPs; the protocol share is
            // withheld from the bin and tracked separately for withdrawal.
            if x_to_y {
                bin.reserve_x = bin
                    .reserve_x
                    .checked_add(consumed - protocol_fee)
                    .expect("overflow");
                bin.reserve_y = bin.reserve_y.checked_sub(out).expect("underflow");
            } else {
                bin.reserve_y = bin
                    .reserve_y
                    .checked_add(consumed - protocol_fee)
                    .expect("overflow");
                bin.reserve_x = bin.reserve_x.checked_sub(out).expect("underflow");
            }
            set_bin(&env, pool_id, active_bin, &bin);

            total_out = total_out.checked_add(out).expect("overflow out");
            total_fee = total_fee.checked_add(fee).expect("overflow fee");
            total_protocol_fee = total_protocol_fee
                .checked_add(protocol_fee)
                .expect("overflow protocol fee");
            remaining -= consumed;
            bins_crossed += 1;

            if consumed >= bin_capacity {
                active_bin += step;
            }
        }

        assert!(total_out >= min_amount_out, "slippage: insufficient output");

        // Pull input token from caller.
        let input_token = if x_to_y { &config.token_x } else { &config.token_y };
        let spent = amount_in - remaining;
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

        // Credit the protocol's share to the claimable balance (already held
        // by the contract as part of `spent`, just not left in the bin).
        if total_protocol_fee > 0 {
            if x_to_y {
                let bal = get_protocol_fee_x(&env, pool_id) + total_protocol_fee;
                env.storage()
                    .persistent()
                    .set(&DataKey::ProtoFeeX(pool_id), &bal);
            } else {
                let bal = get_protocol_fee_y(&env, pool_id) + total_protocol_fee;
                env.storage()
                    .persistent()
                    .set(&DataKey::ProtoFeeY(pool_id), &bal);
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::Active(pool_id), &active_bin);
        env.storage().persistent().set(&DataKey::LastTs(pool_id), &now);

        env.events().publish(
            (symbol_short!("SWAP"), pool_id, x_to_y),
            (caller, spent, total_out, total_fee, total_protocol_fee),
        );

        SwapResult {
            amount_out: total_out,
            fee_paid: total_fee,
            protocol_fee: total_protocol_fee,
            bins_crossed,
            final_bin: active_bin,
        }
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// Return the current active bin ID for `pool_id`.
    pub fn get_active_bin(env: Env, pool_id: u64) -> i32 {
        get_active_bin(&env, pool_id)
    }

    /// Return reserves for a specific bin in `pool_id`.
    pub fn get_bin_reserves(env: Env, pool_id: u64, bin_id: i32) -> BinReserves {
        get_bin(&env, pool_id, bin_id)
    }

    /// Return every bin that currently holds liquidity in `pool_id`, with
    /// its reserves.
    pub fn get_bins(env: Env, pool_id: u64) -> Vec<BinInfo> {
        let all = get_all_bins(&env, pool_id);
        let mut out: Vec<BinInfo> = Vec::new(&env);
        for bin_id in all.iter() {
            let bin = get_bin(&env, pool_id, bin_id);
            if bin.reserve_x > 0 || bin.reserve_y > 0 {
                out.push_back(BinInfo {
                    bin_id,
                    reserve_x: bin.reserve_x,
                    reserve_y: bin.reserve_y,
                });
            }
        }
        out
    }

    /// Return all active LP positions for `user` across every bin of `pool_id`.
    pub fn get_positions(env: Env, pool_id: u64, user: Address) -> Vec<PositionInfo> {
        let bins = get_user_bins(&env, pool_id, &user);
        let mut out: Vec<PositionInfo> = Vec::new(&env);
        for bin_id in bins.iter() {
            let shares = get_share(&env, pool_id, &user, bin_id);
            if shares <= 0 {
                continue;
            }
            let total_shares = get_total_share(&env, pool_id, bin_id);
            let bin = get_bin(&env, pool_id, bin_id);
            let (amount_x, amount_y) = if total_shares > 0 {
                (
                    bin.reserve_x.checked_mul(shares).expect("overflow") / total_shares,
                    bin.reserve_y.checked_mul(shares).expect("overflow") / total_shares,
                )
            } else {
                (0, 0)
            };
            out.push_back(PositionInfo {
                bin_id,
                shares,
                total_shares,
                amount_x,
                amount_y,
            });
        }
        out
    }

    /// Return a single LP position (caller's shares & claimable amounts) in
    /// a bin of `pool_id`.
    pub fn get_position(env: Env, pool_id: u64, user: Address, bin_id: i32) -> PositionInfo {
        let shares = get_share(&env, pool_id, &user, bin_id);
        let total_shares = get_total_share(&env, pool_id, bin_id);
        let bin = get_bin(&env, pool_id, bin_id);
        let (amount_x, amount_y) = if total_shares > 0 && shares > 0 {
            (
                bin.reserve_x.checked_mul(shares).expect("overflow") / total_shares,
                bin.reserve_y.checked_mul(shares).expect("overflow") / total_shares,
            )
        } else {
            (0, 0)
        };
        PositionInfo {
            bin_id,
            shares,
            total_shares,
            amount_x,
            amount_y,
        }
    }

    /// Return `pool_id`'s configuration.
    pub fn get_config(env: Env, pool_id: u64) -> PoolConfig {
        get_pool_config(&env, pool_id)
    }

    /// Simulate a swap on `pool_id` without state changes (read-only).
    /// Rejected until the pool's `activation_ts` is reached, matching
    /// `swap_exact_in_bin`, so quotes never look tradable before a Launch
    /// Pool actually opens.
    pub fn simulate_swap(env: Env, pool_id: u64, x_to_y: bool, amount_in: i128) -> SwapResult {
        let config = get_pool_config(&env, pool_id);
        let now = env.ledger().timestamp();
        assert!(now >= config.activation_ts, "pool not active yet");
        let protocol_fee_bps = get_protocol_fee_bps(&env);
        let seconds_since = (now - get_last_trade_ts(&env, pool_id)) as i128;
        let fee_bps = dynamic_fee(config.base_fee_bps, seconds_since);

        let mut active_bin = get_active_bin(&env, pool_id);
        let mut remaining = amount_in;
        let mut total_out: i128 = 0;
        let mut total_fee: i128 = 0;
        let mut total_protocol_fee: i128 = 0;
        let mut bins_crossed: u32 = 0;
        // Must mirror `swap_exact_in_bin`'s step direction exactly, or quotes
        // will diverge from the actual on-chain swap outcome.
        let step: i32 = if x_to_y { -1 } else { 1 };

        for _ in 0..50 {
            if remaining == 0 {
                break;
            }
            let bin = get_bin(&env, pool_id, active_bin);
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
            let protocol_fee = fee * protocol_fee_bps / 10_000;
            let out = if x_to_y {
                compute_y_from_x(consumed - fee, price).min(out_available)
            } else {
                compute_x_from_y(consumed - fee, price).min(out_available)
            };

            total_out += out;
            total_fee += fee;
            total_protocol_fee += protocol_fee;
            remaining -= consumed;
            bins_crossed += 1;

            if consumed >= bin_capacity {
                active_bin += step;
            }
        }

        SwapResult {
            amount_out: total_out,
            fee_paid: total_fee,
            protocol_fee: total_protocol_fee,
            bins_crossed,
            final_bin: active_bin,
        }
    }
}
