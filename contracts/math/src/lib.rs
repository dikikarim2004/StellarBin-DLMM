//! Math library for Stellar DLMM — safe fixed-point arithmetic for bin price
//! calculations on Soroban.  All values use i128 with 18 decimal places of
//! precision (SCALAR = 10^18) to avoid floating-point and stay within
//! Soroban's i128 budget.
//!
//! Bin price formula: P(bin_id) = 1.0001^bin_id
//! Implemented via iterative integer exponentiation using the identity
//! (1 + step_bps / 10_000)^n, where step_bps is the pool's bin-step in bps.

#![no_std]

use soroban_sdk::{contract, contractimpl, Env};

/// Fixed-point scalar: 10^18.  All intermediate results are kept in this
/// scale to maximise precision before final division.
pub const SCALAR: i128 = 1_000_000_000_000_000_000_i128; // 10^18

pub const FEE_RATE_DENOMINATOR: i128 = 1_000_000_000;
pub const MAX_FEE_RATE: i128 = 100_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VolatilityParams {
    pub filter_period: i128,
    pub decay_period: i128,
    pub reduction_factor: i128,
    pub max_volatility_accumulator: i128,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VolatilityState {
    pub volatility_reference: i128,
    pub volatility_accumulator: i128,
    pub index_reference: i128,
    pub last_update_timestamp: i128,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BinSwapStep {
    pub amount_in: i128,
    pub amount_out: i128,
    pub fee: i128,
    pub lp_fee: i128,
    pub protocol_fee: i128,
    pub reserve_in_added: i128,
    pub reserve_out_removed: i128,
}

/// Safe addition — panics (traps the contract) on overflow.
#[inline(always)]
pub fn safe_add(a: i128, b: i128) -> i128 {
    a.checked_add(b).expect("overflow in add")
}

/// Safe subtraction — panics on underflow.
#[inline(always)]
pub fn safe_sub(a: i128, b: i128) -> i128 {
    a.checked_sub(b).expect("underflow in sub")
}

/// Safe multiplication — panics on overflow, then divides back by SCALAR.
/// Use when multiplying two SCALAR-scaled numbers together.
#[inline(always)]
pub fn safe_mul(a: i128, b: i128) -> i128 {
    a.checked_mul(b)
        .expect("overflow in mul")
        .checked_div(SCALAR)
        .expect("div by zero in mul")
}

/// Safe division — panics on zero divisor.
#[inline(always)]
pub fn safe_div(a: i128, b: i128) -> i128 {
    a.checked_mul(SCALAR)
        .expect("overflow in div scale")
        .checked_div(b)
        .expect("division by zero")
}

fn mul_scaled_nonnegative(a: i128, b: i128) -> i128 {
    assert!(a >= 0 && b >= 0, "negative fixed-point value");
    let a_whole = a / SCALAR;
    let a_fraction = a % SCALAR;
    let b_whole = b / SCALAR;
    let b_fraction = b % SCALAR;

    let whole = a_whole
        .checked_mul(b_whole)
        .and_then(|value| value.checked_mul(SCALAR))
        .expect("overflow fixed-point whole product");
    let cross_a = a_whole
        .checked_mul(b_fraction)
        .expect("overflow fixed-point cross product");
    let cross_b = b_whole
        .checked_mul(a_fraction)
        .expect("overflow fixed-point cross product");
    let fraction = a_fraction
        .checked_mul(b_fraction)
        .expect("overflow fixed-point fraction product")
        / SCALAR;

    whole
        .checked_add(cross_a)
        .and_then(|value| value.checked_add(cross_b))
        .and_then(|value| value.checked_add(fraction))
        .expect("overflow fixed-point result")
}

/// Calculate bin price as a SCALAR-scaled integer.
///
/// Formula: price = (1 + bin_step_bps / 10_000)^|offset| scaled by SCALAR.
/// Bin IDs are global; values that cannot fit the fixed-point representation trap.
///
/// # Arguments
/// * `bin_step_bps` – pool bin step in basis points (e.g. 25 = 0.25%)
/// * `offset` – signed distance from the active bin (active = 0)
///
/// # Returns
/// Price in SCALAR (10^18) fixed-point representation.
pub fn bin_price(bin_step_bps: i128, offset: i128) -> i128 {
    assert!(bin_step_bps > 0 && bin_step_bps <= 10_000, "invalid bin_step_bps");
    assert!(offset.unsigned_abs() <= i32::MAX as u128, "bin ID out of range");

    // base = (1 + bin_step_bps / 10_000) in SCALAR fixed-point
    let base = SCALAR + (SCALAR / 10_000) * bin_step_bps;

    let steps = offset.unsigned_abs() as u32;
    let mut result = SCALAR; // 1.0 in fixed-point

    // Fast exponentiation — O(log n) multiply budget.
    let mut b = base;
    let mut n = steps;
    while n > 0 {
        if n & 1 == 1 {
            result = mul_scaled_nonnegative(result, b);
        }
        n >>= 1;
        if n > 0 {
            b = mul_scaled_nonnegative(b, b);
        }
    }

    // For bins below active bin, price = 1 / result
    if offset < 0 {
        safe_div(SCALAR, result)
    } else {
        result
    }
}

/// Compute the amount of token Y received for `amount_x` of token X when
/// crossing a single bin at price `bin_price_scaled`.
///
/// In a DLMM a bin is a constant-price AMM: y = x * P
pub fn compute_y_from_x(amount_x: i128, bin_price_scaled: i128) -> i128 {
    safe_mul(amount_x, bin_price_scaled)
}

/// Compute the amount of token X received for `amount_y` of token Y at price P.
pub fn compute_x_from_y(amount_y: i128, bin_price_scaled: i128) -> i128 {
    safe_div(amount_y, bin_price_scaled)
}

/// Update the documented DLMM volatility reference and accumulator.
pub fn update_volatility(
    state: VolatilityState,
    active_bin_id: i128,
    timestamp: i128,
    params: VolatilityParams,
) -> VolatilityState {
    assert!(params.filter_period >= 0, "invalid filter period");
    assert!(params.decay_period >= params.filter_period, "invalid decay period");
    assert!(
        (0..=10_000).contains(&params.reduction_factor),
        "invalid reduction factor"
    );
    assert!(params.max_volatility_accumulator >= 0, "invalid volatility cap");
    assert!(timestamp >= state.last_update_timestamp, "timestamp moved backwards");

    let elapsed = timestamp - state.last_update_timestamp;
    let mut next = state;
    if elapsed >= params.decay_period {
        next.volatility_reference = 0;
        next.index_reference = active_bin_id;
        next.last_update_timestamp = timestamp;
    } else if elapsed >= params.filter_period {
        next.volatility_reference = state
            .volatility_accumulator
            .checked_mul(params.reduction_factor)
            .expect("overflow reducing volatility")
            / 10_000;
        next.index_reference = active_bin_id;
        next.last_update_timestamp = timestamp;
    }

    let bin_distance = (next.index_reference - active_bin_id).abs();
    next.volatility_accumulator = next
        .volatility_reference
        .checked_add(bin_distance.checked_mul(10_000).expect("overflow volatility distance"))
        .expect("overflow volatility accumulator")
        .min(params.max_volatility_accumulator);
    next
}

/// Calculate a base-plus-variable fee rate in 1e9 units.
pub fn dlmm_fee_rate(
    base_factor: i128,
    base_fee_power_factor: u32,
    bin_step_bps: i128,
    variable_fee_control: i128,
    volatility_accumulator: i128,
) -> i128 {
    assert!(base_factor >= 0, "invalid base factor");
    assert!(bin_step_bps > 0, "invalid bin step");
    assert!(variable_fee_control >= 0, "invalid variable fee control");
    assert!(volatility_accumulator >= 0, "invalid volatility accumulator");
    assert!(
        variable_fee_control <= u32::MAX as i128,
        "variable fee control exceeds u32"
    );
    assert!(
        volatility_accumulator <= u32::MAX as i128,
        "volatility accumulator exceeds u32"
    );

    let mut base_fee = base_factor
        .checked_mul(bin_step_bps)
        .and_then(|value| value.checked_mul(10))
        .expect("base fee overflow");
    for _ in 0..base_fee_power_factor {
        if base_fee >= MAX_FEE_RATE {
            return MAX_FEE_RATE;
        }
        base_fee = base_fee.checked_mul(10).expect("base fee overflow");
    }

    let volatility = volatility_accumulator
        .checked_mul(bin_step_bps)
        .expect("volatility fee overflow");
    let variable_numerator = variable_fee_control
        .checked_mul(volatility)
        .and_then(|value| value.checked_mul(volatility))
        .expect("variable fee overflow");
    let variable_fee = if variable_numerator == 0 {
        0
    } else {
        (variable_numerator - 1) / 100_000_000_000 + 1
    };

    base_fee
        .checked_add(variable_fee)
        .expect("total fee overflow")
        .min(MAX_FEE_RATE)
}

fn mul_div_ceil(amount: i128, multiplier: i128, denominator: i128) -> i128 {
    assert!(amount >= 0 && multiplier >= 0 && denominator > 0, "invalid fee math input");
    let quotient = amount / denominator;
    let remainder = amount % denominator;
    let whole = quotient
        .checked_mul(multiplier)
        .expect("fee multiplication overflow");
    let partial = remainder
        .checked_mul(multiplier)
        .expect("fee remainder overflow");
    let rounded = if partial == 0 {
        0
    } else {
        (partial - 1) / denominator + 1
    };
    whole.checked_add(rounded).expect("fee sum overflow")
}

fn mul_div_floor(amount: i128, multiplier: i128, denominator: i128) -> i128 {
    assert!(amount >= 0 && multiplier >= 0 && denominator > 0, "invalid fee math input");
    let quotient = amount / denominator;
    let remainder = amount % denominator;
    quotient
        .checked_mul(multiplier)
        .and_then(|whole| {
            remainder
                .checked_mul(multiplier)
                .map(|partial| whole + partial / denominator)
        })
        .expect("fee division overflow")
}

fn fee_from_amount_included(amount: i128, fee_rate: i128) -> i128 {
    mul_div_ceil(amount, fee_rate, FEE_RATE_DENOMINATOR)
}

fn fee_added_on_top(amount_excluding_fee: i128, fee_rate: i128) -> i128 {
    mul_div_ceil(
        amount_excluding_fee,
        fee_rate,
        FEE_RATE_DENOMINATOR - fee_rate,
    )
}

/// Quote one bin for an exact-input swap, including the configured fee side.
pub fn quote_exact_in_bin(
    amount_remaining: i128,
    reserve_x: i128,
    reserve_y: i128,
    price: i128,
    x_to_y: bool,
    fee_rate: i128,
    fee_on_input: bool,
    protocol_share_bps: i128,
) -> BinSwapStep {
    assert!(amount_remaining >= 0, "negative input amount");
    assert!(reserve_x >= 0 && reserve_y >= 0, "negative reserves");
    assert!(fee_rate >= 0 && fee_rate < FEE_RATE_DENOMINATOR, "invalid fee rate");
    assert!((0..=10_000).contains(&protocol_share_bps), "invalid protocol share");

    let out_available = if x_to_y { reserve_y } else { reserve_x };
    if amount_remaining == 0 || out_available == 0 {
        return BinSwapStep::default();
    }

    let bin_capacity = if x_to_y {
        compute_x_from_y(out_available, price)
    } else {
        compute_y_from_x(out_available, price)
    };
    if bin_capacity == 0 {
        return BinSwapStep::default();
    }

    let (amount_in, net_input, fee) = if fee_on_input {
        let fee_for_remaining = fee_from_amount_included(amount_remaining, fee_rate);
        let net_remaining = amount_remaining.saturating_sub(fee_for_remaining);
        if net_remaining <= bin_capacity {
            (amount_remaining, net_remaining, fee_for_remaining)
        } else {
            let fee = fee_added_on_top(bin_capacity, fee_rate);
            (
                bin_capacity.checked_add(fee).expect("input amount overflow"),
                bin_capacity,
                fee,
            )
        }
    } else {
        let consumed = amount_remaining.min(bin_capacity);
        (consumed, consumed, 0)
    };

    if amount_in == 0 || net_input == 0 {
        return BinSwapStep::default();
    }

    let gross_output = if x_to_y {
        compute_y_from_x(net_input, price).min(out_available)
    } else {
        compute_x_from_y(net_input, price).min(out_available)
    };
    let fee = if fee_on_input {
        fee
    } else {
        fee_from_amount_included(gross_output, fee_rate)
    };
    let protocol_fee = mul_div_floor(fee, protocol_share_bps, 10_000);
    let lp_fee = fee - protocol_fee;
    let amount_out = gross_output - if fee_on_input { 0 } else { fee };
    let reserve_in_added = amount_in - if fee_on_input { fee } else { 0 };
    let reserve_out_removed = gross_output;

    BinSwapStep {
        amount_in,
        amount_out,
        fee,
        lp_fee,
        protocol_fee,
        reserve_in_added,
        reserve_out_removed,
    }
}

/// Quote one bin for an exact-output swap. Returns a zero step if the bin lacks depth.
pub fn quote_exact_out_bin(
    amount_out: i128,
    reserve_x: i128,
    reserve_y: i128,
    price: i128,
    x_to_y: bool,
    fee_rate: i128,
    fee_on_input: bool,
    protocol_share_bps: i128,
) -> BinSwapStep {
    assert!(amount_out >= 0, "negative output amount");
    assert!(reserve_x >= 0 && reserve_y >= 0, "negative reserves");
    assert!(fee_rate >= 0 && fee_rate < FEE_RATE_DENOMINATOR, "invalid fee rate");
    assert!((0..=10_000).contains(&protocol_share_bps), "invalid protocol share");

    let out_available = if x_to_y { reserve_y } else { reserve_x };
    if amount_out == 0 || amount_out > out_available {
        return BinSwapStep::default();
    }

    let gross_output = if fee_on_input {
        amount_out
    } else {
        amount_out
            .checked_add(fee_added_on_top(amount_out, fee_rate))
            .expect("gross output overflow")
    };
    if gross_output > out_available {
        return BinSwapStep::default();
    }

    let net_input = if x_to_y {
        mul_div_ceil(gross_output, SCALAR, price)
    } else {
        mul_div_ceil(gross_output, price, SCALAR)
    };
    let fee = if fee_on_input {
        fee_added_on_top(net_input, fee_rate)
    } else {
        gross_output - amount_out
    };
    let amount_in = net_input
        .checked_add(if fee_on_input { fee } else { 0 })
        .expect("gross input overflow");
    let protocol_fee = mul_div_floor(fee, protocol_share_bps, 10_000);
    let lp_fee = fee - protocol_fee;

    BinSwapStep {
        amount_in,
        amount_out,
        fee,
        lp_fee,
        protocol_fee,
        reserve_in_added: amount_in - if fee_on_input { fee } else { 0 },
        reserve_out_removed: gross_output,
    }
}

pub fn fee_growth_per_share(fee_amount: i128, total_shares: i128) -> i128 {
    assert!(fee_amount >= 0 && total_shares > 0, "invalid fee growth inputs");
    fee_amount
        .checked_mul(SCALAR)
        .expect("fee growth overflow")
        / total_shares
}

pub fn pending_position_fee(
    current_growth: i128,
    checkpoint: i128,
    shares: i128,
) -> i128 {
    assert!(current_growth >= checkpoint, "fee checkpoint ahead of growth");
    assert!(shares >= 0, "negative position shares");
    current_growth
        .checked_sub(checkpoint)
        .and_then(|delta| delta.checked_mul(shares))
        .expect("pending fee overflow")
        / SCALAR
}

// ---------------------------------------------------------------------------
// Soroban contract wrapper — exposes math functions on-chain for composability
// ---------------------------------------------------------------------------

#[contract]
pub struct MathContract;

#[contractimpl]
impl MathContract {
    /// Return bin price at `offset` steps from the active bin.
    pub fn get_bin_price(_env: Env, bin_step_bps: i128, offset: i128) -> i128 {
        bin_price(bin_step_bps, offset)
    }

}

// ---------------------------------------------------------------------------
// Unit tests (run with: cargo test -p stellar-dlmm-math)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bin_price_active() {
        // Active bin (offset=0) must be exactly 1.0
        let price = bin_price(25, 0);
        assert_eq!(price, SCALAR);
    }

    #[test]
    fn test_bin_price_positive() {
        // offset=1, step=10000 (100%) → price should be 2.0
        let price = bin_price(10_000, 1);
        assert_eq!(price, 2 * SCALAR);
    }

    #[test]
    fn test_bin_price_negative() {
        // offset=-1, step=10000 → price should be 0.5
        let price = bin_price(10_000, -1);
        // 1/2 in fixed-point
        assert!((price - SCALAR / 2).abs() < 1_000, "Expected ~0.5, got {price}");
    }

    #[test]
    fn test_bin_price_accepts_large_global_bin_ids() {
        let price = bin_price(1, 100_000);
        assert!(price > SCALAR);
        assert!(price < i128::MAX);
    }

    #[test]
    fn test_volatility_accumulator_tracks_bin_movement() {
        let next = update_volatility(
            VolatilityState {
                volatility_reference: 10_000,
                index_reference: 20,
                last_update_timestamp: 100,
                ..VolatilityState::default()
            },
            18,
            105,
            VolatilityParams {
                filter_period: 10,
                decay_period: 60,
                reduction_factor: 5_000,
                max_volatility_accumulator: 200_000,
            },
        );
        assert_eq!(next.volatility_accumulator, 30_000);
        assert_eq!(next.last_update_timestamp, 100);
    }

    #[test]
    fn test_volatility_reference_reduces_after_filter_period() {
        let next = update_volatility(
            VolatilityState {
                volatility_reference: 10_000,
                volatility_accumulator: 40_000,
                index_reference: 20,
                last_update_timestamp: 100,
            },
            20,
            110,
            VolatilityParams {
                filter_period: 10,
                decay_period: 60,
                reduction_factor: 5_000,
                max_volatility_accumulator: 200_000,
            },
        );
        assert_eq!(next.volatility_reference, 20_000);
        assert_eq!(next.volatility_accumulator, 20_000);
        assert_eq!(next.last_update_timestamp, 110);
    }

    #[test]
    fn test_volatility_reference_resets_after_decay_period() {
        let next = update_volatility(
            VolatilityState {
                volatility_reference: 10_000,
                volatility_accumulator: 40_000,
                index_reference: 20,
                last_update_timestamp: 100,
            },
            25,
            160,
            VolatilityParams {
                filter_period: 10,
                decay_period: 60,
                reduction_factor: 5_000,
                max_volatility_accumulator: 200_000,
            },
        );
        assert_eq!(next.volatility_reference, 0);
        assert_eq!(next.volatility_accumulator, 0);
        assert_eq!(next.index_reference, 25);
    }

    #[test]
    fn test_dlmm_fee_rate_has_base_and_variable_components() {
        let base_only = dlmm_fee_rate(10, 0, 25, 0, 100);
        let with_variable = dlmm_fee_rate(10, 0, 25, 100, 1);
        assert_eq!(base_only, 2_500);
        assert_eq!(with_variable, 2_501);
    }

    #[test]
    fn test_dlmm_fee_rate_is_capped() {
        assert_eq!(
            dlmm_fee_rate(10_000, 3, 400, 1_000_000, 1_000_000),
            MAX_FEE_RATE
        );
    }

    #[test]
    fn test_exact_in_bin_fee_on_input() {
        let step = quote_exact_in_bin(1_000, 0, 1_000, SCALAR, true, 10_000_000, true, 2_500);
        assert_eq!(step.amount_in, 1_000);
        assert_eq!(step.fee, 10);
        assert_eq!(step.protocol_fee, 2);
        assert_eq!(step.amount_out, 990);
        assert_eq!(step.lp_fee, 8);
        assert_eq!(step.reserve_in_added, 990);
        assert_eq!(step.reserve_out_removed, 990);
    }

    #[test]
    fn test_exact_in_bin_fee_on_output() {
        let step = quote_exact_in_bin(1_000, 0, 1_000, SCALAR, true, 10_000_000, false, 2_500);
        assert_eq!(step.amount_in, 1_000);
        assert_eq!(step.fee, 10);
        assert_eq!(step.protocol_fee, 2);
        assert_eq!(step.amount_out, 990);
        assert_eq!(step.lp_fee, 8);
        assert_eq!(step.reserve_in_added, 1_000);
        assert_eq!(step.reserve_out_removed, 1_000);
    }

    #[test]
    fn test_exact_in_bin_drains_with_fee_on_top() {
        let step = quote_exact_in_bin(1_000, 0, 500, SCALAR, true, 10_000_000, true, 2_500);
        assert_eq!(step.amount_in, 506);
        assert_eq!(step.amount_out, 500);
        assert_eq!(step.fee, 6);
        assert_eq!(step.protocol_fee, 1);
        assert_eq!(step.lp_fee, 5);
        assert_eq!(step.reserve_in_added, 500);
    }

    #[test]
    fn test_exact_out_bin_fee_on_input_rounds_input_up() {
        let step = quote_exact_out_bin(990, 0, 1_000, SCALAR, true, 10_000_000, true, 2_500);
        assert_eq!(step.amount_out, 990);
        assert_eq!(step.amount_in, 1_000);
        assert_eq!(step.fee, 10);
        assert_eq!(step.protocol_fee, 2);
        assert_eq!(step.lp_fee, 8);
        assert_eq!(step.reserve_in_added, 990);
        assert_eq!(step.reserve_out_removed, 990);
    }

    #[test]
    fn test_exact_out_bin_fee_on_output_grosses_up_output() {
        let step = quote_exact_out_bin(990, 0, 1_000, SCALAR, true, 10_000_000, false, 2_500);
        assert_eq!(step.amount_out, 990);
        assert_eq!(step.amount_in, 1_000);
        assert_eq!(step.fee, 10);
        assert_eq!(step.protocol_fee, 2);
        assert_eq!(step.lp_fee, 8);
        assert_eq!(step.reserve_in_added, 1_000);
        assert_eq!(step.reserve_out_removed, 1_000);
    }

    #[test]
    fn test_exact_out_bin_rejects_output_above_depth() {
        let step = quote_exact_out_bin(1_001, 0, 1_000, SCALAR, true, 10_000_000, true, 2_500);
        assert_eq!(step, BinSwapStep::default());
    }

    #[test]
    fn test_position_fee_growth_claim_is_pro_rata() {
        let growth = fee_growth_per_share(120, 100);
        assert_eq!(pending_position_fee(growth, 0, 25), 30);
        assert_eq!(pending_position_fee(growth, growth, 25), 0);
    }

    #[test]
    fn test_safe_add_basic() {
        assert_eq!(safe_add(SCALAR, SCALAR), 2 * SCALAR);
    }

    #[test]
    fn test_compute_y_from_x() {
        // x=1, price=2 → y=2
        let y = compute_y_from_x(SCALAR, 2 * SCALAR);
        assert_eq!(y, 2 * SCALAR);
    }
}
