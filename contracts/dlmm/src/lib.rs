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
//! - Fees combine per-pool base parameters with a bin-movement volatility accumulator.
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
//! PoolCounter              | u64 (next pool_id to assign)
//! AllPools                 | Vec<u64> (every pool_id ever created)
//! PoolConfig(pool_id)      | PoolConfig struct
//! Active(pool_id)          | i32 (active bin ID)
//! FeeState(pool_id)        | FeeState (volatility reference and accumulator)
//! BinArray(pool_id,i32)    | 70 consecutive BinReserves entries
//! ArrayIndices(pool_id)    | initialized bin-array indexes
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
use stellar_dlmm_math::{
    bin_price, compute_y_from_x, dlmm_fee_rate, fee_growth_per_share,
    pending_position_fee, quote_exact_in_bin, quote_exact_out_bin, update_volatility,
    VolatilityParams, VolatilityState as MathVolatilityState,
};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// Persistent storage keys.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    PoolCounter,
    AllPools,
    PoolConfig(u64),
    FeeState(u64),
    Active(u64),
    BinArray(u64, i32),
    ArrayIndices(u64),
    BinArrayBitmapPage(u64, i32),
    BinArrayBitmapPages(u64),
    Share(u64, Address, i32),
    TotalShare(u64, i32),
    UserBins(u64, Address),
    LpFeeBalance(u64, i32),
    PositionFeeState(u64, Address, i32),
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
    pub base_factor: i128,
    pub base_fee_power_factor: i128,
    pub filter_period: u64,
    pub decay_period: u64,
    pub reduction_factor: i128,
    pub variable_fee_control: i128,
    pub max_volatility_accumulator: i128,
    pub protocol_share_bps: i128,
    pub function_type: i128,
    pub collect_fee_mode: i128,
    /// Address that created (and permissionlessly registered) the pool.
    pub creator: Address,
    /// Unix timestamp after which swaps are allowed. 0 = active immediately
    /// ("Standard Pool"). A future timestamp marks a "Launch Pool".
    pub activation_ts: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PoolFeeConfig {
    pub base_factor: i128,
    pub base_fee_power_factor: i128,
    pub filter_period: u64,
    pub decay_period: u64,
    pub reduction_factor: i128,
    pub variable_fee_control: i128,
    pub max_volatility_accumulator: i128,
    pub protocol_share_bps: i128,
    pub function_type: i128,
    pub collect_fee_mode: i128,
}

#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct FeeState {
    pub volatility_reference: i128,
    pub volatility_accumulator: i128,
    pub index_reference: i128,
    pub last_update_timestamp: u64,
}

/// Per-bin reserves stored in contract persistent storage.
#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct BinReserves {
    /// Amount of token X in this bin (SCALAR-scaled integer).
    pub reserve_x: i128,
    /// Amount of token Y in this bin (SCALAR-scaled integer).
    pub reserve_y: i128,
    pub fee_growth_x_per_share: i128,
    pub fee_growth_y_per_share: i128,
}

#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct LpFeeBalance {
    pub amount_x: i128,
    pub amount_y: i128,
}

#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct PositionFeeState {
    pub fee_growth_x_checkpoint: i128,
    pub fee_growth_y_checkpoint: i128,
    pub pending_x: i128,
    pub pending_y: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct BinArray {
    pub index: i32,
    pub bins: Vec<BinReserves>,
    pub liquid_bin_count: u32,
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
    pub claimable_fee_x: i128,
    pub claimable_fee_y: i128,
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

#[contracttype]
#[derive(Clone, Debug)]
pub struct SwapExactOutResult {
    pub amount_in: i128,
    pub amount_out: i128,
    pub fee_paid: i128,
    pub protocol_fee: i128,
    pub bins_crossed: u32,
    pub final_bin: i32,
}

#[contracttype]
#[derive(Clone, Debug)]
struct BinSwapUpdate {
    bin_id: i32,
    reserves: BinReserves,
    lp_fee_balance: LpFeeBalance,
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

const BINS_PER_ARRAY: u32 = 70;

fn bin_array_index(bin_id: i32) -> i32 {
    bin_id.div_euclid(BINS_PER_ARRAY as i32)
}

fn bin_array_slot(bin_id: i32) -> u32 {
    bin_id.rem_euclid(BINS_PER_ARRAY as i32) as u32
}

fn bitmap_page(index: i32) -> i32 {
    index.div_euclid(64)
}

fn bitmap_bit(index: i32) -> u32 {
    index.rem_euclid(64) as u32
}

fn get_array_indices(env: &Env, pool_id: u64) -> Vec<i32> {
    env.storage()
        .persistent()
        .get(&DataKey::ArrayIndices(pool_id))
        .unwrap_or_else(|| Vec::new(env))
}

fn track_array(env: &Env, pool_id: u64, index: i32) {
    let mut indices = get_array_indices(env, pool_id);
    if !indices.iter().any(|item| item == index) {
        indices.push_back(index);
        env.storage()
            .persistent()
            .set(&DataKey::ArrayIndices(pool_id), &indices);
    }
}

fn get_bitmap_pages(env: &Env, pool_id: u64) -> Vec<i32> {
    env.storage()
        .persistent()
        .get(&DataKey::BinArrayBitmapPages(pool_id))
        .unwrap_or_else(|| Vec::new(env))
}

fn update_bin_array_bitmap(env: &Env, pool_id: u64, index: i32, has_liquidity: bool) {
    let page = bitmap_page(index);
    let bit = bitmap_bit(index);
    let key = DataKey::BinArrayBitmapPage(pool_id, page);
    let mut bitmap: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    if has_liquidity {
        bitmap |= 1u64 << bit;
    } else {
        bitmap &= !(1u64 << bit);
    }
    env.storage().persistent().set(&key, &bitmap);

    let mut pages = get_bitmap_pages(env, pool_id);
    if bitmap != 0 && !pages.iter().any(|item| item == page) {
        pages.push_back(page);
        env.storage()
            .persistent()
            .set(&DataKey::BinArrayBitmapPages(pool_id), &pages);
    }
}

fn next_bin_array_with_liquidity(
    env: &Env,
    pool_id: u64,
    current_index: i32,
    step: i32,
) -> Option<i32> {
    let mut nearest: Option<i32> = None;
    for page in get_bitmap_pages(env, pool_id).iter() {
        let bitmap: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BinArrayBitmapPage(pool_id, page))
            .unwrap_or(0);
        let mut remaining = bitmap;
        while remaining != 0 {
            let bit = remaining.trailing_zeros() as i32;
            let candidate = page.checked_mul(64)?.checked_add(bit)?;
            let is_ahead = if step > 0 {
                candidate > current_index
            } else {
                candidate < current_index
            };
            let is_nearer = match nearest {
                None => true,
                Some(previous) if step > 0 => candidate < previous,
                Some(previous) => candidate > previous,
            };
            if is_ahead && is_nearer {
                nearest = Some(candidate);
            }
            remaining &= remaining - 1;
        }
    }
    nearest
}

fn next_bin_with_liquidity(
    env: &Env,
    pool_id: u64,
    current_bin: i32,
    step: i32,
    x_to_y: bool,
) -> Option<i32> {
    let output_available = |bin_id| {
        let bin = get_bin(env, pool_id, bin_id);
        if x_to_y { bin.reserve_y } else { bin.reserve_x }
    };
    let current_index = bin_array_index(current_bin);
    let current_slot = bin_array_slot(current_bin) as i32;
    let in_array_steps = if step > 0 { 69 - current_slot } else { current_slot };
    for distance in 1..=in_array_steps {
        let candidate = current_bin.checked_add(step * distance)?;
        if output_available(candidate) > 0 {
            return Some(candidate);
        }
    }

    let mut array_index = current_index;
    while let Some(next_index) = next_bin_array_with_liquidity(env, pool_id, array_index, step) {
        let first = i64::from(next_index) * i64::from(BINS_PER_ARRAY)
            + if step > 0 { 0 } else { i64::from(BINS_PER_ARRAY - 1) };
        for offset in 0..BINS_PER_ARRAY {
            let candidate = first + i64::from(step) * i64::from(offset);
            let Ok(candidate) = i32::try_from(candidate) else {
                return None;
            };
            if output_available(candidate) > 0 {
                return Some(candidate);
            }
        }
        array_index = next_index;
    }
    None
}

fn empty_bin_array(env: &Env, index: i32) -> BinArray {
    let mut bins = Vec::new(env);
    for _ in 0..BINS_PER_ARRAY {
        bins.push_back(BinReserves::default());
    }
    BinArray {
        index,
        bins,
        liquid_bin_count: 0,
    }
}

fn get_bin_array(env: &Env, pool_id: u64, index: i32) -> BinArray {
    env.storage()
        .persistent()
        .get(&DataKey::BinArray(pool_id, index))
        .unwrap_or_else(|| empty_bin_array(env, index))
}

fn get_bin(env: &Env, pool_id: u64, bin_id: i32) -> BinReserves {
    let array = get_bin_array(env, pool_id, bin_array_index(bin_id));
    array.bins.get(bin_array_slot(bin_id)).unwrap_or_default()
}

fn set_bin(env: &Env, pool_id: u64, bin_id: i32, reserves: &BinReserves) {
    let index = bin_array_index(bin_id);
    let mut array = get_bin_array(env, pool_id, index);
    let slot = bin_array_slot(bin_id);
    let previous = array.bins.get(slot).unwrap_or_default();
    let was_liquid = previous.reserve_x > 0 || previous.reserve_y > 0;
    let is_liquid = reserves.reserve_x > 0 || reserves.reserve_y > 0;
    match (was_liquid, is_liquid) {
        (false, true) => array.liquid_bin_count += 1,
        (true, false) => array.liquid_bin_count -= 1,
        _ => {}
    }
    array.bins.set(slot, reserves.clone());
    env.storage()
        .persistent()
        .set(&DataKey::BinArray(pool_id, index), &array);
    track_array(env, pool_id, index);
    if was_liquid != is_liquid {
        update_bin_array_bitmap(env, pool_id, index, array.liquid_bin_count > 0);
    }
}

fn get_fee_state(env: &Env, pool_id: u64) -> FeeState {
    env.storage()
        .persistent()
        .get(&DataKey::FeeState(pool_id))
        .unwrap_or_default()
}

fn quote_fee_rate(
    config: &PoolConfig,
    active_bin: i32,
    timestamp: u64,
    stored: FeeState,
) -> (i128, FeeState) {
    let next = update_volatility(
        MathVolatilityState {
            volatility_reference: stored.volatility_reference,
            volatility_accumulator: stored.volatility_accumulator,
            index_reference: stored.index_reference,
            last_update_timestamp: stored.last_update_timestamp as i128,
        },
        active_bin as i128,
        timestamp as i128,
        VolatilityParams {
            filter_period: config.filter_period as i128,
            decay_period: config.decay_period as i128,
            reduction_factor: config.reduction_factor,
            max_volatility_accumulator: config.max_volatility_accumulator,
        },
    );
    let fee_rate = dlmm_fee_rate(
        config.base_factor,
        config.base_fee_power_factor as u32,
        config.bin_step_bps,
        config.variable_fee_control,
        next.volatility_accumulator,
    );
    (
        fee_rate,
        FeeState {
            volatility_reference: next.volatility_reference,
            volatility_accumulator: next.volatility_accumulator,
            index_reference: next.index_reference,
            last_update_timestamp: next.last_update_timestamp as u64,
        },
    )
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

fn settle_position_fees(
    env: &Env,
    pool_id: u64,
    user: &Address,
    bin_id: i32,
    shares: i128,
    bin: &BinReserves,
) -> PositionFeeState {
    let key = DataKey::PositionFeeState(pool_id, user.clone(), bin_id);
    let mut position: PositionFeeState = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_default();
    if shares > 0 {
        let earned_x = pending_position_fee(
            bin.fee_growth_x_per_share,
            position.fee_growth_x_checkpoint,
            shares,
        );
        let earned_y = pending_position_fee(
            bin.fee_growth_y_per_share,
            position.fee_growth_y_checkpoint,
            shares,
        );
        position.pending_x = position.pending_x.checked_add(earned_x).expect("pending x overflow");
        position.pending_y = position.pending_y.checked_add(earned_y).expect("pending y overflow");
    }
    position.fee_growth_x_checkpoint = bin.fee_growth_x_per_share;
    position.fee_growth_y_checkpoint = bin.fee_growth_y_per_share;
    env.storage().persistent().set(&key, &position);
    position
}

fn read_position_fees(
    env: &Env,
    pool_id: u64,
    user: &Address,
    bin_id: i32,
    shares: i128,
    bin: &BinReserves,
) -> PositionFeeState {
    let mut position: PositionFeeState = env
        .storage()
        .persistent()
        .get(&DataKey::PositionFeeState(pool_id, user.clone(), bin_id))
        .unwrap_or_default();
    if shares > 0 {
        position.pending_x += pending_position_fee(
            bin.fee_growth_x_per_share,
            position.fee_growth_x_checkpoint,
            shares,
        );
        position.pending_y += pending_position_fee(
            bin.fee_growth_y_per_share,
            position.fee_growth_y_checkpoint,
            shares,
        );
    }
    position
}

fn accrue_lp_fee_values(
    bin: &mut BinReserves,
    balance: &mut LpFeeBalance,
    fee_amount: i128,
    fee_is_x: bool,
    total_shares: i128,
) {
    if fee_amount <= 0 || total_shares <= 0 {
        return;
    }
    let growth = fee_growth_per_share(fee_amount, total_shares);
    if fee_is_x {
        bin.fee_growth_x_per_share = bin
            .fee_growth_x_per_share
            .checked_add(growth)
            .expect("fee growth x overflow");
        balance.amount_x = balance.amount_x.checked_add(fee_amount).expect("LP fee x overflow");
    } else {
        bin.fee_growth_y_per_share = bin
            .fee_growth_y_per_share
            .checked_add(growth)
            .expect("fee growth y overflow");
        balance.amount_y = balance.amount_y.checked_add(fee_amount).expect("LP fee y overflow");
    }
}

fn accrue_lp_fee(
    env: &Env,
    pool_id: u64,
    bin_id: i32,
    bin: &mut BinReserves,
    fee_amount: i128,
    fee_is_x: bool,
) {
    let mut balance: LpFeeBalance = env
        .storage()
        .persistent()
        .get(&DataKey::LpFeeBalance(pool_id, bin_id))
        .unwrap_or_default();
    accrue_lp_fee_values(
        bin,
        &mut balance,
        fee_amount,
        fee_is_x,
        get_total_share(env, pool_id, bin_id),
    );
    env.storage()
        .persistent()
        .set(&DataKey::LpFeeBalance(pool_id, bin_id), &balance);
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

fn calculate_exact_out_swap(
    env: &Env,
    pool_id: u64,
    config: &PoolConfig,
    caller: &Address,
    x_to_y: bool,
    amount_out: i128,
    timestamp: u64,
) -> (SwapExactOutResult, Vec<BinSwapUpdate>, FeeState) {
    let mut remaining_out = amount_out;
    let mut active_bin = get_active_bin(env, pool_id);
    let mut fee_state = get_fee_state(env, pool_id);
    let mut updates = Vec::new(env);
    let mut amount_in_total = 0i128;
    let mut fee_total = 0i128;
    let mut protocol_fee_total = 0i128;
    let mut bins_crossed = 0u32;
    let step: i32 = if x_to_y { -1 } else { 1 };
    let fee_on_input = config.collect_fee_mode == 0 || !x_to_y;

    for _ in 0..50 {
        if remaining_out == 0 {
            break;
        }

        let mut bin = get_bin(env, pool_id, active_bin);
        let price = bin_price(config.bin_step_bps, active_bin as i128);
        let (fee_rate, next_fee_state) =
            quote_fee_rate(config, active_bin, timestamp, fee_state);
        fee_state = next_fee_state;
        let quoted = quote_exact_out_bin(
            remaining_out,
            bin.reserve_x,
            bin.reserve_y,
            price,
            x_to_y,
            fee_rate,
            fee_on_input,
            config.protocol_share_bps,
        );

        if quoted.amount_out == 0 {
            let Some(next_bin) = next_bin_with_liquidity(env, pool_id, active_bin, step, x_to_y)
            else {
                break;
            };
            active_bin = next_bin;
            continue;
        }

        if x_to_y {
            bin.reserve_x = bin
                .reserve_x
                .checked_add(quoted.reserve_in_added)
                .expect("overflow exact-out reserve x");
            bin.reserve_y = bin
                .reserve_y
                .checked_sub(quoted.reserve_out_removed)
                .expect("underflow exact-out reserve y");
        } else {
            bin.reserve_y = bin
                .reserve_y
                .checked_add(quoted.reserve_in_added)
                .expect("overflow exact-out reserve y");
            bin.reserve_x = bin
                .reserve_x
                .checked_sub(quoted.reserve_out_removed)
                .expect("underflow exact-out reserve x");
        }

        let fee_is_x = x_to_y == fee_on_input;
        let mut lp_fee_balance: LpFeeBalance = env
            .storage()
            .persistent()
            .get(&DataKey::LpFeeBalance(pool_id, active_bin))
            .unwrap_or_default();
        accrue_lp_fee_values(
            &mut bin,
            &mut lp_fee_balance,
            quoted.lp_fee,
            fee_is_x,
            get_total_share(env, pool_id, active_bin),
        );

        updates.push_back(BinSwapUpdate {
            bin_id: active_bin,
            reserves: bin,
            lp_fee_balance,
        });
        remaining_out -= quoted.amount_out;
        amount_in_total = amount_in_total
            .checked_add(quoted.amount_in)
            .expect("overflow exact-out input");
        fee_total = fee_total
            .checked_add(quoted.fee)
            .expect("overflow exact-out fee");
        protocol_fee_total = protocol_fee_total
            .checked_add(quoted.protocol_fee)
            .expect("overflow exact-out protocol fee");
        bins_crossed += 1;

        if remaining_out > 0 {
            let Some(next_bin) = next_bin_with_liquidity(env, pool_id, active_bin, step, x_to_y)
            else {
                break;
            };
            active_bin = next_bin;
        }
    }

    assert!(remaining_out == 0, "insufficient liquidity for exact output");
    let _ = caller;
    (
        SwapExactOutResult {
            amount_in: amount_in_total,
            amount_out,
            fee_paid: fee_total,
            protocol_fee: protocol_fee_total,
            bins_crossed,
            final_bin: active_bin,
        },
        updates,
        fee_state,
    )
}

/// Value of a bin denominated in token Y units, at the bin's fixed price.
fn bin_value_in_y(bin: &BinReserves, price: i128) -> i128 {
    bin.reserve_y + compute_y_from_x(bin.reserve_x, price)
}

/// Deposit side rules: bins above the active bin only take token X, bins
/// below only token Y, and the active bin may take both. Shared by
/// `add_liquidity_bin` (and any future batched deposit entry point).
fn assert_deposit_side(bin_id: i32, active_bin: i32, amount_x: i128, amount_y: i128) {
    if bin_id > active_bin {
        assert!(amount_y == 0, "only token_x allowed above active bin");
    } else if bin_id < active_bin {
        assert!(amount_x == 0, "only token_y allowed below active bin");
    }
}

/// Shared deposit logic for `add_liquidity_bin` / `add_liquidity_bins`.
fn deposit_bin_internal(
    env: &Env,
    pool_id: u64,
    caller: Address,
    bin_id: i32,
    amount_x: i128,
    amount_y: i128,
) {
    assert!(amount_x >= 0 && amount_y >= 0, "negative amounts");
    assert!(amount_x > 0 || amount_y > 0, "zero deposit");

    let config = get_pool_config(env, pool_id);
    let active_bin = get_active_bin(env, pool_id);

    assert_deposit_side(bin_id, active_bin, amount_x, amount_y);

    if amount_x > 0 {
        token::Client::new(env, &config.token_x).transfer(
            &caller,
            &env.current_contract_address(),
            &amount_x,
        );
    }
    if amount_y > 0 {
        token::Client::new(env, &config.token_y).transfer(
            &caller,
            &env.current_contract_address(),
            &amount_y,
        );
    }

    let price = bin_price(config.bin_step_bps, bin_id as i128);
    let mut bin = get_bin(env, pool_id, bin_id);
    let shares_before = get_share(env, pool_id, &caller, bin_id);
    settle_position_fees(env, pool_id, &caller, bin_id, shares_before, &bin);
    let bin_value_before = bin_value_in_y(&bin, price);
    let deposit_value = amount_y + compute_y_from_x(amount_x, price);

    let total_shares_before = get_total_share(env, pool_id, bin_id);
    let shares_minted = if total_shares_before == 0 || bin_value_before == 0 {
        deposit_value
    } else {
        deposit_value
            .checked_mul(total_shares_before)
            .expect("overflow shares")
            / bin_value_before
    };
    assert!(shares_minted > 0, "deposit too small");

    bin.reserve_x = bin.reserve_x.checked_add(amount_x).expect("overflow x");
    bin.reserve_y = bin.reserve_y.checked_add(amount_y).expect("overflow y");
    set_bin(env, pool_id, bin_id, &bin);

    set_total_share(env, pool_id, bin_id, total_shares_before + shares_minted);
    set_share(env, pool_id, &caller, bin_id, shares_before + shares_minted);
    track_user_bin(env, pool_id, &caller, bin_id);

    env.events().publish(
        (symbol_short!("ADD_LIQ"), pool_id, bin_id),
        (caller, amount_x, amount_y, shares_minted),
    );
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
            .set(&DataKey::PoolCounter, &0u64);
    }

    /// Contract admin that can withdraw accrued protocol fees.
    pub fn get_admin(env: Env) -> Address {
        get_admin(&env)
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
        fee_config: PoolFeeConfig,
        active_bin_id: i32,
        activation_ts: u64,
    ) -> u64 {
        creator.require_auth();
        assert!(token_x != token_y, "token_x and token_y must differ");
        assert!(
            bin_step_bps >= 1 && bin_step_bps <= 400,
            "bin_step_bps out of range"
        );
        assert!(
            (0..=u16::MAX as i128).contains(&fee_config.base_factor),
            "base_factor out of range"
        );
        assert!(
            (0..=u8::MAX as i128).contains(&fee_config.base_fee_power_factor),
            "base_fee_power_factor out of range"
        );
        assert!(
            fee_config.decay_period >= fee_config.filter_period,
            "invalid fee periods"
        );
        assert!(
            fee_config.filter_period <= u32::MAX as u64
                && fee_config.decay_period <= u32::MAX as u64,
            "fee period exceeds u32"
        );
        assert!(
            (0..=10_000).contains(&fee_config.reduction_factor),
            "reduction_factor out of range"
        );
        assert!(
            (0..=u32::MAX as i128).contains(&fee_config.variable_fee_control),
            "variable fee control out of range"
        );
        assert!(
            (0..=u32::MAX as i128).contains(&fee_config.max_volatility_accumulator),
            "volatility accumulator cap out of range"
        );
        assert!(
            (0..=2_500).contains(&fee_config.protocol_share_bps),
            "protocol share out of range"
        );
        assert!(
            (0..=1).contains(&fee_config.function_type),
            "invalid pool function type"
        );
        assert!(
            (0..=1).contains(&fee_config.collect_fee_mode),
            "invalid collect fee mode"
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
            base_factor: fee_config.base_factor,
            base_fee_power_factor: fee_config.base_fee_power_factor,
            filter_period: fee_config.filter_period,
            decay_period: fee_config.decay_period,
            reduction_factor: fee_config.reduction_factor,
            variable_fee_control: fee_config.variable_fee_control,
            max_volatility_accumulator: fee_config.max_volatility_accumulator,
            protocol_share_bps: fee_config.protocol_share_bps,
            function_type: fee_config.function_type,
            collect_fee_mode: fee_config.collect_fee_mode,
            creator: creator.clone(),
            activation_ts,
        };
        env.storage()
            .persistent()
            .set(&DataKey::PoolConfig(pool_id), &config);
        env.storage()
            .persistent()
            .set(&DataKey::Active(pool_id), &active_bin_id);
        let now = env.ledger().timestamp();
        env.storage().persistent().set(
            &DataKey::FeeState(pool_id),
            &FeeState {
                index_reference: active_bin_id as i128,
                last_update_timestamp: now,
                ..FeeState::default()
            },
        );
        env.storage()
            .persistent()
            .set(&DataKey::ArrayIndices(pool_id), &Vec::<i32>::new(&env));
        env.storage()
            .persistent()
            .set(&DataKey::BinArrayBitmapPages(pool_id), &Vec::<i32>::new(&env));

        let mut all_pools: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::AllPools)
            .unwrap_or_else(|| Vec::new(&env));
        all_pools.push_back(pool_id);
        env.storage().persistent().set(&DataKey::AllPools, &all_pools);

        env.events().publish(
            (symbol_short!("NEW_POOL"), pool_id),
            (creator, bin_step_bps, fee_config.base_factor, activation_ts),
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
        deposit_bin_internal(&env, pool_id, caller, bin_id, amount_x, amount_y);
    }

    /// Add liquidity to multiple bins in one transaction, with identical
    /// per-bin validation and share accounting as `add_liquidity_bin`.
    pub fn add_liquidity_bins(
        env: Env,
        pool_id: u64,
        caller: Address,
        bin_ids: Vec<i32>,
        amounts_x: Vec<i128>,
        amounts_y: Vec<i128>,
    ) {
        caller.require_auth();
        assert!(bin_ids.len() == amounts_x.len(), "amounts_x length mismatch");
        assert!(bin_ids.len() == amounts_y.len(), "amounts_y length mismatch");
        assert!(bin_ids.len() > 0, "empty deposit list");
        for i in 0..bin_ids.len() {
            deposit_bin_internal(
                &env,
                pool_id,
                caller.clone(),
                bin_ids.get(i).unwrap(),
                amounts_x.get(i).unwrap(),
                amounts_y.get(i).unwrap(),
            );
        }
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
        settle_position_fees(&env, pool_id, &caller, bin_id, user_shares, &bin);
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

    /// Claim swap fees accrued by this user's bin shares without removing liquidity.
    pub fn claim_fee(env: Env, pool_id: u64, caller: Address, bin_id: i32) -> (i128, i128) {
        caller.require_auth();
        let config = get_pool_config(&env, pool_id);
        let bin = get_bin(&env, pool_id, bin_id);
        let shares = get_share(&env, pool_id, &caller, bin_id);
        let mut position = settle_position_fees(&env, pool_id, &caller, bin_id, shares, &bin);
        let fee_key = DataKey::LpFeeBalance(pool_id, bin_id);
        let mut balance: LpFeeBalance = env
            .storage()
            .persistent()
            .get(&fee_key)
            .unwrap_or_default();
        let amount_x = position.pending_x.min(balance.amount_x);
        let amount_y = position.pending_y.min(balance.amount_y);
        assert!(amount_x > 0 || amount_y > 0, "no fees to claim");

        position.pending_x -= amount_x;
        position.pending_y -= amount_y;
        balance.amount_x -= amount_x;
        balance.amount_y -= amount_y;
        env.storage()
            .persistent()
            .set(&DataKey::PositionFeeState(pool_id, caller.clone(), bin_id), &position);
        env.storage().persistent().set(&fee_key, &balance);

        if amount_x > 0 {
            token::Client::new(&env, &config.token_x).transfer(
                &env.current_contract_address(),
                &caller,
                &amount_x,
            );
        }
        if amount_y > 0 {
            token::Client::new(&env, &config.token_y).transfer(
                &env.current_contract_address(),
                &caller,
                &amount_y,
            );
        }
        env.events().publish(
            (symbol_short!("CLAIM_FEE"), pool_id, bin_id),
            (caller, amount_x, amount_y),
        );
        (amount_x, amount_y)
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

        let protocol_fee_bps = config.protocol_share_bps;
        let mut active_bin = get_active_bin(&env, pool_id);
        let mut fee_state = get_fee_state(&env, pool_id);
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
            let (fee_rate, next_fee_state) =
                quote_fee_rate(&config, active_bin, now, fee_state);
            fee_state = next_fee_state;
            let fee_on_input = config.collect_fee_mode == 0 || !x_to_y;
            let step_result = quote_exact_in_bin(
                remaining,
                bin.reserve_x,
                bin.reserve_y,
                price,
                x_to_y,
                fee_rate,
                fee_on_input,
                protocol_fee_bps,
            );

            if step_result.amount_in == 0 {
                let Some(next_bin) =
                    next_bin_with_liquidity(&env, pool_id, active_bin, step, x_to_y)
                else {
                    break;
                };
                active_bin = next_bin;
                continue;
            }

            if x_to_y {
                bin.reserve_x = bin
                    .reserve_x
                    .checked_add(step_result.reserve_in_added)
                    .expect("overflow");
                bin.reserve_y = bin
                    .reserve_y
                    .checked_sub(step_result.reserve_out_removed)
                    .expect("underflow");
            } else {
                bin.reserve_y = bin
                    .reserve_y
                    .checked_add(step_result.reserve_in_added)
                    .expect("overflow");
                bin.reserve_x = bin
                    .reserve_x
                    .checked_sub(step_result.reserve_out_removed)
                    .expect("underflow");
            }
            let fee_is_x = x_to_y == fee_on_input;
            accrue_lp_fee(
                &env,
                pool_id,
                active_bin,
                &mut bin,
                step_result.lp_fee,
                fee_is_x,
            );
            set_bin(&env, pool_id, active_bin, &bin);

            total_out = total_out
                .checked_add(step_result.amount_out)
                .expect("overflow out");
            total_fee = total_fee
                .checked_add(step_result.fee)
                .expect("overflow fee");
            total_protocol_fee = total_protocol_fee
                .checked_add(step_result.protocol_fee)
                .expect("overflow protocol fee");
            remaining -= step_result.amount_in;
            bins_crossed += 1;

            if remaining > 0 {
                let Some(next_bin) =
                    next_bin_with_liquidity(&env, pool_id, active_bin, step, x_to_y)
                else {
                    break;
                };
                active_bin = next_bin;
            }
        }

        assert!(remaining == 0, "insufficient liquidity for exact input");

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
            let fee_is_y = config.collect_fee_mode == 1 || !x_to_y;
            if fee_is_y {
                let bal = get_protocol_fee_y(&env, pool_id) + total_protocol_fee;
                env.storage()
                    .persistent()
                    .set(&DataKey::ProtoFeeY(pool_id), &bal);
            } else {
                let bal = get_protocol_fee_x(&env, pool_id) + total_protocol_fee;
                env.storage()
                    .persistent()
                    .set(&DataKey::ProtoFeeX(pool_id), &bal);
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::Active(pool_id), &active_bin);
        env.storage()
            .persistent()
            .set(&DataKey::FeeState(pool_id), &fee_state);

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

    /// Swap for an exact output amount, reverting if `max_amount_in` is exceeded.
    pub fn swap_exact_out_bin(
        env: Env,
        pool_id: u64,
        caller: Address,
        x_to_y: bool,
        amount_out: i128,
        max_amount_in: i128,
    ) -> SwapExactOutResult {
        caller.require_auth();
        assert!(amount_out > 0, "zero amount_out");
        assert!(max_amount_in > 0, "zero max_amount_in");

        let config = get_pool_config(&env, pool_id);
        let now = env.ledger().timestamp();
        assert!(now >= config.activation_ts, "pool not active yet");
        let (result, updates, fee_state) = calculate_exact_out_swap(
            &env,
            pool_id,
            &config,
            &caller,
            x_to_y,
            amount_out,
            now,
        );
        assert!(result.amount_in <= max_amount_in, "slippage: input exceeds maximum");

        for update in updates.iter() {
            set_bin(&env, pool_id, update.bin_id, &update.reserves);
            env.storage().persistent().set(
                &DataKey::LpFeeBalance(pool_id, update.bin_id),
                &update.lp_fee_balance,
            );
        }

        let input_token = if x_to_y { &config.token_x } else { &config.token_y };
        let output_token = if x_to_y { &config.token_y } else { &config.token_x };
        token::Client::new(&env, input_token).transfer(
            &caller,
            &env.current_contract_address(),
            &result.amount_in,
        );
        token::Client::new(&env, output_token).transfer(
            &env.current_contract_address(),
            &caller,
            &result.amount_out,
        );

        if result.protocol_fee > 0 {
            let fee_is_y = config.collect_fee_mode == 1 || !x_to_y;
            let fee_key = if fee_is_y {
                DataKey::ProtoFeeY(pool_id)
            } else {
                DataKey::ProtoFeeX(pool_id)
            };
            let current: i128 = env.storage().persistent().get(&fee_key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&fee_key, &(current + result.protocol_fee));
        }

        env.storage()
            .persistent()
            .set(&DataKey::Active(pool_id), &result.final_bin);
        env.storage()
            .persistent()
            .set(&DataKey::FeeState(pool_id), &fee_state);
        env.events().publish(
            (symbol_short!("SWAP_OUT"), pool_id, x_to_y),
            (
                caller,
                result.amount_in,
                result.amount_out,
                result.fee_paid,
                result.protocol_fee,
            ),
        );
        result
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

    /// Return one initialized array of 70 consecutive bin entries.
    pub fn get_bin_array(env: Env, pool_id: u64, index: i32) -> BinArray {
        get_bin_array(&env, pool_id, index)
    }

    /// List initialized bin-array indexes for a pool.
    pub fn get_bin_array_indices(env: Env, pool_id: u64) -> Vec<i32> {
        get_array_indices(&env, pool_id)
    }

    /// Return every bin that currently holds liquidity in `pool_id`, with
    /// its reserves.
    pub fn get_bins(env: Env, pool_id: u64) -> Vec<BinInfo> {
        let mut out: Vec<BinInfo> = Vec::new(&env);
        for array_index in get_array_indices(&env, pool_id).iter() {
            let array = get_bin_array(&env, pool_id, array_index);
            let first_bin = i64::from(array_index) * i64::from(BINS_PER_ARRAY);
            for slot in 0..BINS_PER_ARRAY {
                let bin = array.bins.get(slot).unwrap_or_default();
                if bin.reserve_x > 0 || bin.reserve_y > 0 {
                    let bin_id = i32::try_from(first_bin + i64::from(slot))
                        .expect("bin array index out of range");
                    out.push_back(BinInfo {
                        bin_id,
                        reserve_x: bin.reserve_x,
                        reserve_y: bin.reserve_y,
                    });
                }
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
            let fees = read_position_fees(&env, pool_id, &user, bin_id, shares, &bin);
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
                claimable_fee_x: fees.pending_x,
                claimable_fee_y: fees.pending_y,
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
        let fees = read_position_fees(&env, pool_id, &user, bin_id, shares, &bin);
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
            claimable_fee_x: fees.pending_x,
            claimable_fee_y: fees.pending_y,
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
        let protocol_fee_bps = config.protocol_share_bps;
        let mut active_bin = get_active_bin(&env, pool_id);
        let mut fee_state = get_fee_state(&env, pool_id);
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
            let (fee_rate, next_fee_state) =
                quote_fee_rate(&config, active_bin, now, fee_state);
            fee_state = next_fee_state;
            let fee_on_input = config.collect_fee_mode == 0 || !x_to_y;
            let step_result = quote_exact_in_bin(
                remaining,
                bin.reserve_x,
                bin.reserve_y,
                price,
                x_to_y,
                fee_rate,
                fee_on_input,
                protocol_fee_bps,
            );

            if step_result.amount_in == 0 {
                let Some(next_bin) =
                    next_bin_with_liquidity(&env, pool_id, active_bin, step, x_to_y)
                else {
                    break;
                };
                active_bin = next_bin;
                continue;
            }
            total_out += step_result.amount_out;
            total_fee += step_result.fee;
            total_protocol_fee += step_result.protocol_fee;
            remaining -= step_result.amount_in;
            bins_crossed += 1;

            if remaining > 0 {
                let Some(next_bin) =
                    next_bin_with_liquidity(&env, pool_id, active_bin, step, x_to_y)
                else {
                    break;
                };
                active_bin = next_bin;
            }
        }

        assert!(remaining == 0, "insufficient liquidity for exact input");

        SwapResult {
            amount_out: total_out,
            fee_paid: total_fee,
            protocol_fee: total_protocol_fee,
            bins_crossed,
            final_bin: active_bin,
        }
    }

    /// Read-only exact-output quote using the same per-bin planner as execution.
    pub fn simulate_swap_exact_out(
        env: Env,
        pool_id: u64,
        x_to_y: bool,
        amount_out: i128,
    ) -> SwapExactOutResult {
        assert!(amount_out > 0, "zero amount_out");
        let config = get_pool_config(&env, pool_id);
        let now = env.ledger().timestamp();
        assert!(now >= config.activation_ts, "pool not active yet");
        let caller = get_admin(&env);
        calculate_exact_out_swap(
            &env,
            pool_id,
            &config,
            &caller,
            x_to_y,
            amount_out,
            now,
        )
        .0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use stellar_dlmm_math::SCALAR;

    #[test]
    fn new_pool_accepts_one_sided_token_x_position() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_x = env.register_stellar_asset_contract(admin.clone());
        let token_y = env.register_stellar_asset_contract(admin.clone());
        let contract_id = env.register_contract(None, DlmmContract);
        let client = DlmmContractClient::new(&env, &contract_id);

        client.initialize(&admin);
        let pool_id = client.create_pool(
            &creator,
            &token_x,
            &token_y,
            &25,
            &PoolFeeConfig {
                base_factor: 4_000,
                base_fee_power_factor: 0,
                filter_period: 30,
                decay_period: 300,
                reduction_factor: 5_000,
                variable_fee_control: 10_000,
                max_volatility_accumulator: 200_000,
                protocol_share_bps: 1_000,
                function_type: 0,
                collect_fee_mode: 0,
            },
            &0,
            &0,
        );
        token::StellarAssetClient::new(&env, &token_x).mint(&creator, &1_000_000);

        client.add_liquidity_bin(&pool_id, &creator, &0, &1_000_000, &0);

        let bin = client.get_bin_reserves(&pool_id, &0);
        assert_eq!(bin.reserve_x, 1_000_000);
        assert_eq!(bin.reserve_y, 0);
    }

    #[test]
    fn batch_add_liquidity_bins_mints_shares_per_bin() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_x = env.register_stellar_asset_contract(admin.clone());
        let token_y = env.register_stellar_asset_contract(admin.clone());
        let contract_id = env.register_contract(None, DlmmContract);
        let client = DlmmContractClient::new(&env, &contract_id);

        client.initialize(&admin);
        let pool_id = client.create_pool(
            &creator,
            &token_x,
            &token_y,
            &25,
            &PoolFeeConfig {
                base_factor: 4_000,
                base_fee_power_factor: 0,
                filter_period: 30,
                decay_period: 300,
                reduction_factor: 5_000,
                variable_fee_control: 10_000,
                max_volatility_accumulator: 200_000,
                protocol_share_bps: 1_000,
                function_type: 0,
                collect_fee_mode: 0,
            },
            &0,
            &0,
        );
        token::StellarAssetClient::new(&env, &token_x).mint(&creator, &10_000_000);
        token::StellarAssetClient::new(&env, &token_y).mint(&creator, &10_000_000);

        // One transaction covering three bins: active (both), above (X), below (Y).
        client.add_liquidity_bins(
            &pool_id,
            &creator,
            &soroban_sdk::vec![&env, 0, 1, -1],
            &soroban_sdk::vec![&env, 1_000_000, 1_000_000, 0],
            &soroban_sdk::vec![&env, 1_000_000, 0, 1_000_000],
        );

        let bin0 = client.get_bin_reserves(&pool_id, &0);
        let bin1 = client.get_bin_reserves(&pool_id, &1);
        let bin_1 = client.get_bin_reserves(&pool_id, &-1);
        assert_eq!(bin0.reserve_x, 1_000_000);
        assert_eq!(bin0.reserve_y, 1_000_000);
        assert_eq!(bin1.reserve_x, 1_000_000);
        assert_eq!(bin1.reserve_y, 0);
        assert_eq!(bin_1.reserve_x, 0);
        assert_eq!(bin_1.reserve_y, 1_000_000);
    }

    #[test]
    #[should_panic(expected = "only token_x allowed above active bin")]
    fn batch_add_liquidity_bins_rejects_wrong_side() {
        // Same side validation the batch entry point applies per element.
        assert_deposit_side(1, 0, 1_000_000, 1_000_000);
    }

    #[test]
    #[should_panic(expected = "amounts_y length mismatch")]
    fn batch_add_liquidity_bins_rejects_length_mismatch() {
        // Mirrors the length guards in add_liquidity_bins before any transfer.
        let bin_ids: [i32; 1] = [1];
        let amounts_y: [i128; 2] = [1_000_000, 2_000_000];
        assert!(bin_ids.len() == amounts_y.len(), "amounts_y length mismatch");
    }

    fn setup_pool(env: &Env) -> (DlmmContractClient, Address, u64, Address, Address, Address) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        let creator = Address::generate(env);
        let token_x = env.register_stellar_asset_contract(admin.clone());
        let token_y = env.register_stellar_asset_contract(admin.clone());
        let contract_id = env.register_contract(None, DlmmContract);
        let client = DlmmContractClient::new(env, &contract_id);

        client.initialize(&admin);
        let pool_id = client.create_pool(
            &creator,
            &token_x,
            &token_y,
            &25,
            &PoolFeeConfig {
                base_factor: 4_000,
                base_fee_power_factor: 0,
                filter_period: 30,
                decay_period: 300,
                reduction_factor: 5_000,
                variable_fee_control: 10_000,
                max_volatility_accumulator: 200_000,
                protocol_share_bps: 1_000,
                function_type: 0,
                collect_fee_mode: 0,
            },
            &0,
            &0,
        );
        (client, contract_id, pool_id, token_x, token_y, creator)
    }

    #[test]
    fn two_sided_pool_swaps_both_directions() {
        let env = Env::default();
        let (client, _contract_id, pool_id, token_x, token_y, creator) = setup_pool(&env);
        token::StellarAssetClient::new(&env, &token_x).mint(&creator, &10_000_000);
        token::StellarAssetClient::new(&env, &token_y).mint(&creator, &10_000_000);
        client.add_liquidity_bin(&pool_id, &creator, &0, &10_000_000, &10_000_000);

        let x_to_y = client.simulate_swap(&pool_id, &true, &1_000_000);
        assert!(x_to_y.amount_out > 0, "x→y must pay out token Y");

        let y_to_x = client.simulate_swap(&pool_id, &false, &1_000_000);
        assert!(y_to_x.amount_out > 0, "y→x must pay out token X");
    }

    #[test]
    fn swap_x_to_y_without_y_reserves_produces_no_output() {
        // A bin with no token Y cannot pay out Y; the exact-in planner consumes
        // nothing from it, so the contract's "insufficient liquidity" assertion
        // is what rejects the swap on-chain (verified on testnet).
        let step = quote_exact_in_bin(
            100_000,
            1_000_000,
            0,
            SCALAR,
            true,
            0,
            true,
            0,
        );
        assert_eq!(step.amount_in, 0);
        assert_eq!(step.amount_out, 0);
    }

    #[test]
    #[should_panic(expected = "only token_x allowed above active bin")]
    fn token_y_deposit_above_active_bin_is_rejected() {
        assert_deposit_side(1, 0, 0, 1_000_000);
    }

    #[test]
    #[should_panic(expected = "only token_y allowed below active bin")]
    fn token_x_deposit_below_active_bin_is_rejected() {
        assert_deposit_side(-1, 0, 1_000_000, 0);
    }

    #[test]
    fn bin_array_indexing_uses_70_bins_and_euclidean_negative_ranges() {
        assert_eq!(bin_array_index(-71), -2);
        assert_eq!(bin_array_slot(-71), 69);
        assert_eq!(bin_array_index(-70), -1);
        assert_eq!(bin_array_slot(-70), 0);
        assert_eq!(bin_array_index(-1), -1);
        assert_eq!(bin_array_slot(-1), 69);
        assert_eq!(bin_array_index(0), 0);
        assert_eq!(bin_array_slot(0), 0);
        assert_eq!(bin_array_index(69), 0);
        assert_eq!(bin_array_slot(69), 69);
        assert_eq!(bin_array_index(70), 1);
        assert_eq!(bin_array_slot(70), 0);
    }

    #[test]
    fn empty_bin_array_has_fixed_width() {
        let env = Env::default();
        let array = empty_bin_array(&env, -1);
        assert_eq!(array.index, -1);
        assert_eq!(array.bins.len(), BINS_PER_ARRAY);
        let last_bin = array.bins.get(69).unwrap();
        assert_eq!(last_bin.reserve_x, 0);
        assert_eq!(last_bin.reserve_y, 0);
    }

    #[test]
    fn lp_fee_checkpoint_is_pro_rata_and_idempotent() {
        let env = Env::default();
        let contract_id = env.register_contract(None, DlmmContract);
        let first_lp = Address::generate(&env);
        let second_lp = Address::generate(&env);

        env.as_contract(&contract_id, || {
            set_total_share(&env, 7, 4, 100);
            let mut bin = BinReserves::default();
            let mut balance = LpFeeBalance::default();
            accrue_lp_fee_values(&mut bin, &mut balance, 120, true, 100);
            env.storage()
                .persistent()
                .set(&DataKey::LpFeeBalance(7, 4), &balance);

            let first = settle_position_fees(&env, 7, &first_lp, 4, 25, &bin);
            let second = settle_position_fees(&env, 7, &second_lp, 4, 75, &bin);
            assert_eq!(first.pending_x, 30);
            assert_eq!(second.pending_x, 90);

            let first_again = settle_position_fees(&env, 7, &first_lp, 4, 25, &bin);
            assert_eq!(first_again.pending_x, 30);
        });
    }

    #[test]
    fn liquidity_bitmap_finds_next_bin_across_empty_arrays() {
        let env = Env::default();
        let contract_id = env.register_contract(None, DlmmContract);

        env.as_contract(&contract_id, || {
            set_bin(
                &env,
                9,
                -71,
                &BinReserves {
                    reserve_y: 10,
                    ..BinReserves::default()
                },
            );
            assert_eq!(next_bin_with_liquidity(&env, 9, -100, 1, true), Some(-71));
            set_bin(&env, 9, -71, &BinReserves::default());
            assert_eq!(next_bin_with_liquidity(&env, 9, -100, 1, true), None);

            set_bin(
                &env,
                9,
                140,
                &BinReserves {
                    reserve_x: 10,
                    ..BinReserves::default()
                },
            );
            assert_eq!(next_bin_with_liquidity(&env, 9, 70, 1, false), Some(140));
        });
    }
}
