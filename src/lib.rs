//! z-tenant-kyb — vendor KYB (Know Your Business) onboarding agent for T3N tenants.
//!
//! Two contract functions:
//!   - `screen-vendor`: checks a company against two free, key-less public
//!     registers inside the enclave — EU VIES (VAT validity + registered name)
//!     and GLEIF (LEI record + registration status) — and returns a risk-flag
//!     summary. Company data only; the input parser rejects person-level PII.
//!   - `submit-onboarding`: registers the screened vendor in the tenant's ERP.
//!     The signatory's identity is never an input — the contract templates
//!     `{{profile.<field>}}` markers into the ERP body and the host's
//!     `http-with-placeholders` interface resolves them from the calling
//!     user's profile at dispatch time. The contract never holds plaintext PII
//!     and never returns the ERP echo body to the caller.
//!
//! Secrets (created/seeded by the operator CLI via the tenant SDK, read from the
//! z: KV map `z:<tid>:secrets`):
//!   - `erp_onboarding_url`  — full URL the onboarding POST goes to (required)
//!   - `erp_api_key`         — optional bearer token for that URL
//!
//! Capability set = the WIT imports in `wit/world.wit` (there is no manifest).
#![warn(clippy::style, missing_debug_implementations)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.1.0";

wit_bindgen::generate!({
    world: "tenant-kyb",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

pub mod common;
pub mod onboard;
pub mod screen;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::tenant_kyb::contracts::Guest for Component {
    fn screen_vendor(
        req: exports::z::tenant_kyb::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("screen-vendor: missing input")?;
        screen::screen_vendor(&input)
    }

    fn submit_onboarding(
        req: exports::z::tenant_kyb::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("submit-onboarding: missing input")?;
        onboard::submit_onboarding(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3);
        for p in parts {
            assert!(p.parse::<u32>().is_ok());
        }
    }
}
