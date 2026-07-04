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

/// Maximum bin ID offset from centre to cap exponentiation cost.
pub const MAX_BIN_OFFSET: i128 = 500;

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

/// Calculate bin price as a SCALAR-scaled integer.
///
/// Formula: price = (1 + bin_step_bps / 10_000)^|offset| scaled by SCALAR.
/// For bins below the active bin the result is the inverse.
///
/// # Arguments
/// * `bin_step_bps` – pool bin step in basis points (e.g. 25 = 0.25%)
/// * `offset` – signed distance from the active bin (active = 0)
///
/// # Returns
/// Price in SCALAR (10^18) fixed-point representation.
pub fn bin_price(bin_step_bps: i128, offset: i128) -> i128 {
    assert!(bin_step_bps > 0 && bin_step_bps <= 10_000, "invalid bin_step_bps");
    assert!(
        offset.abs() <= MAX_BIN_OFFSET,
        "bin offset exceeds maximum"
    );

    // base = (1 + bin_step_bps / 10_000) in SCALAR fixed-point
    let base = SCALAR + (SCALAR / 10_000) * bin_step_bps;

    let steps = offset.unsigned_abs() as u32;
    let mut result = SCALAR; // 1.0 in fixed-point

    // Fast exponentiation — O(log n) multiply budget.
    let mut b = base;
    let mut n = steps;
    while n > 0 {
        if n & 1 == 1 {
            result = result.checked_mul(b).expect("overflow expo") / SCALAR;
        }
        b = b.checked_mul(b).expect("overflow expo sq") / SCALAR;
        n >>= 1;
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

/// Dynamic fee calculation.
///
/// Base fee increases linearly with volatility, measured as time elapsed since
/// the last trade (shorter interval → higher recent activity → higher fee cap).
///
/// # Arguments
/// * `base_fee_bps` – pool's static base fee in bps
/// * `seconds_since_last_trade` – elapsed seconds; 0 means same block
///
/// # Returns
/// Effective fee in bps (clamped to [base_fee_bps, 200]).
pub fn dynamic_fee(base_fee_bps: i128, seconds_since_last_trade: i128) -> i128 {
    // Volatility decays as time passes: more time = cooler market = lower fee.
    // Spike factor: 100% extra fee at 0 seconds, decaying to 0 at 300 seconds.
    let decay_window: i128 = 300; // seconds
    let elapsed = seconds_since_last_trade.min(decay_window);
    let spike_fraction = SCALAR - (elapsed * SCALAR / decay_window); // 0..SCALAR

    // Extra fee capped at base_fee_bps (doubles at max volatility).
    let extra_bps = safe_mul(base_fee_bps * SCALAR, spike_fraction) / SCALAR;
    let effective = base_fee_bps + extra_bps;

    // Hard cap at 200 bps (2%) to protect LPs from toxic flow.
    effective.min(200)
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

    /// Return the dynamic fee for current conditions.
    pub fn get_dynamic_fee(
        _env: Env,
        base_fee_bps: i128,
        seconds_since_last_trade: i128,
    ) -> i128 {
        dynamic_fee(base_fee_bps, seconds_since_last_trade)
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
    fn test_dynamic_fee_no_activity() {
        // 0 seconds → max volatility → effective fee = 2 * base (capped at 200 bps)
        let fee = dynamic_fee(30, 0);
        assert_eq!(fee, 60); // 30 + 30
    }

    #[test]
    fn test_dynamic_fee_stale() {
        // 300+ seconds → no volatility spike → base fee
        let fee = dynamic_fee(30, 300);
        assert_eq!(fee, 30);
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
