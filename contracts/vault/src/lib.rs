//! Dynamic Vault Contract — Stellar Soroban
//!
//! Accepts asset deposits and allocates unutilised capital to yield-bearing
//! integrations (e.g. Blend Protocol lending pools).  When no external
//! integration is available the contract stubs the yield layer and holds
//! funds internally — this is the safe default for mainnet until a trusted
//! integration is audited.
//!
//! # Share accounting
//!
//! Vault uses a share model similar to ERC-4626:
//!   shares_minted = deposit_amount * total_shares / total_assets
//! On first deposit: shares = amount (1:1 bootstrap).
//!
//! # Storage layout
//!
//! Key               | Value
//! ------------------|----------------------------------
//! "VAULT_CFG"       | VaultConfig
//! "TOTAL_ASSETS"    | i128
//! "TOTAL_SHARES"    | i128
//! ("SHARE", addr)   | i128  (per-depositor share balance)

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug)]
pub struct VaultConfig {
    /// Underlying asset (SAC address).
    pub asset: Address,
    /// Vault administrator.
    pub admin: Address,
    /// Maximum total assets the vault will accept (circuit-breaker).
    pub deposit_cap: i128,
    /// Fee taken on yield profits (in bps, e.g. 500 = 5%).
    pub performance_fee_bps: i128,
}

const KEY_CONFIG: Symbol = symbol_short!("VAULT_CFG");
const KEY_ASSETS: Symbol = symbol_short!("TOTAL_ASS");
const KEY_SHARES: Symbol = symbol_short!("TOTAL_SHR");
// Stored separately (not inside VaultConfig) because soroban-sdk 20.x's
// `#[contracttype]` derive does not support `Option<Address>` fields directly.
// Presence of this key indicates the integration is configured.
const KEY_YIELD_INTEGRATION: Symbol = symbol_short!("YIELD_INT");

fn share_key(addr: &Address) -> (Symbol, Address) {
    (symbol_short!("SHARE"), addr.clone())
}

fn get_total_assets(env: &Env) -> i128 {
    env.storage().persistent().get(&KEY_ASSETS).unwrap_or(0i128)
}

fn get_total_shares(env: &Env) -> i128 {
    env.storage().persistent().get(&KEY_SHARES).unwrap_or(0i128)
}

fn get_shares(env: &Env, addr: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&share_key(addr))
        .unwrap_or(0i128)
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct VaultContract;

#[contractimpl]
impl VaultContract {
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    pub fn initialize(
        env: Env,
        admin: Address,
        asset: Address,
        deposit_cap: i128,
        performance_fee_bps: i128,
    ) {
        admin.require_auth();
        assert!(
            !env.storage().persistent().has(&KEY_CONFIG),
            "already initialized"
        );
        assert!(deposit_cap > 0, "deposit_cap must be > 0");
        assert!(performance_fee_bps <= 3_000, "performance fee too high (max 30%)");

        let config = VaultConfig {
            asset,
            admin,
            deposit_cap,
            performance_fee_bps,
        };
        // yield_integration intentionally left unset here: integrate Blend
        // by writing an address to KEY_YIELD_INTEGRATION when ready.
        env.storage().persistent().set(&KEY_CONFIG, &config);
        env.storage().persistent().set(&KEY_ASSETS, &0i128);
        env.storage().persistent().set(&KEY_SHARES, &0i128);
    }

    // -----------------------------------------------------------------------
    // Depositor interface
    // -----------------------------------------------------------------------

    /// Deposit `amount` of the vault's asset and receive shares in return.
    ///
    /// Pulls `amount` from `depositor` via SAC transfer then mints shares.
    pub fn deposit(env: Env, depositor: Address, amount: i128) -> i128 {
        depositor.require_auth();
        assert!(amount > 0, "zero deposit");

        let config: VaultConfig = env
            .storage()
            .persistent()
            .get(&KEY_CONFIG)
            .expect("vault not initialized");

        let total_assets = get_total_assets(&env);
        assert!(
            total_assets + amount <= config.deposit_cap,
            "deposit cap exceeded"
        );

        // Pull asset from depositor.
        token::Client::new(&env, &config.asset).transfer(
            &depositor,
            &env.current_contract_address(),
            &amount,
        );

        // Mint shares: first deposit is 1:1; subsequent use NAV.
        let total_shares = get_total_shares(&env);
        let shares_to_mint = if total_shares == 0 || total_assets == 0 {
            amount // bootstrap 1:1
        } else {
            amount
                .checked_mul(total_shares)
                .expect("overflow shares_to_mint")
                / total_assets
        };

        // Update state.
        let new_assets = total_assets.checked_add(amount).expect("overflow assets");
        let new_shares = total_shares
            .checked_add(shares_to_mint)
            .expect("overflow shares");
        let depositor_shares = get_shares(&env, &depositor)
            .checked_add(shares_to_mint)
            .expect("overflow depositor");

        env.storage().persistent().set(&KEY_ASSETS, &new_assets);
        env.storage().persistent().set(&KEY_SHARES, &new_shares);
        env.storage()
            .persistent()
            .set(&share_key(&depositor), &depositor_shares);

        env.events().publish(
            (symbol_short!("DEPOSIT"), depositor.clone()),
            (amount, shares_to_mint),
        );

        shares_to_mint
    }

    /// Redeem `shares` for the underlying asset.
    ///
    /// Burns caller's shares and returns proportional assets.
    pub fn withdraw(env: Env, caller: Address, shares: i128) -> i128 {
        caller.require_auth();
        assert!(shares > 0, "zero shares");

        let config: VaultConfig = env
            .storage()
            .persistent()
            .get(&KEY_CONFIG)
            .expect("vault not initialized");

        let caller_shares = get_shares(&env, &caller);
        assert!(caller_shares >= shares, "insufficient shares");

        let total_assets = get_total_assets(&env);
        let total_shares = get_total_shares(&env);

        // Proportional redemption: assets_out = shares * total_assets / total_shares
        let assets_out = shares
            .checked_mul(total_assets)
            .expect("overflow")
            / total_shares;

        // --- Yield integration stub ---
        // In a real integration, if assets_out > contract balance, we would
        // load the integration address from KEY_YIELD_INTEGRATION and redeem
        // from the lending protocol:
        //   BlendClient::new(&env, &integration).redeem(assets_out - balance);
        // For now we assume funds are always in the contract.

        // Update state.
        env.storage()
            .persistent()
            .set(&KEY_ASSETS, &(total_assets - assets_out));
        env.storage()
            .persistent()
            .set(&KEY_SHARES, &(total_shares - shares));
        env.storage()
            .persistent()
            .set(&share_key(&caller), &(caller_shares - shares));

        // Return assets to caller.
        token::Client::new(&env, &config.asset).transfer(
            &env.current_contract_address(),
            &caller,
            &assets_out,
        );

        env.events().publish(
            (symbol_short!("WITHDRAW"), caller),
            (shares, assets_out),
        );

        assets_out
    }

    // -----------------------------------------------------------------------
    // Admin: allocate idle capital to yield integration (stub)
    // -----------------------------------------------------------------------

    /// Allocate `amount` of idle vault capital to the configured yield integration.
    ///
    /// Currently a no-op stub — returns immediately when no integration is set.
    /// Wire up `BlendClient::supply()` here once the integration address is set.
    pub fn allocate_to_yield(env: Env, amount: i128) {
        let config: VaultConfig = env
            .storage()
            .persistent()
            .get(&KEY_CONFIG)
            .expect("vault not initialized");
        config.admin.require_auth();
        assert!(amount > 0, "zero amount");

        if env.storage().persistent().has(&KEY_YIELD_INTEGRATION) {
            // TODO: call Blend/lending pool supply function.
            // let integration: Address = env.storage().persistent().get(&KEY_YIELD_INTEGRATION).unwrap();
            // BlendClient::new(&env, &integration).supply(&env.current_contract_address(), amount);
            env.events()
                .publish((symbol_short!("ALLOC"),), (amount,));
        }
        // If no integration is set, idle capital stays in the vault — safe default.
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// Current NAV (net asset value) per share in asset units.
    pub fn nav_per_share(env: Env) -> i128 {
        let total_assets = get_total_assets(&env);
        let total_shares = get_total_shares(&env);
        if total_shares == 0 {
            return 1_000_000_0i128; // 1.0 in 7-decimal fixed-point
        }
        total_assets
            .checked_mul(1_000_000_0i128)
            .expect("overflow nav")
            / total_shares
    }

    /// Return the share balance for `addr`.
    pub fn balance_of(env: Env, addr: Address) -> i128 {
        get_shares(&env, &addr)
    }

    /// Return total vault assets under management.
    pub fn total_assets(env: Env) -> i128 {
        get_total_assets(&env)
    }
}
