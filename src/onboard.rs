//! submit-onboarding: registers a screened vendor in the tenant's ERP.
//!
//! The signatory's identity never enters this contract. The ERP body carries
//! `{{profile.first_name}}` / `{{profile.last_name}}` markers (plus, optionally,
//! `{{profile.verified_contacts.email.value}}`) which `http-with-placeholders`
//! resolves on the host from the calling user's profile — the user must have
//! granted this agent `submit-onboarding` on this contract for the ERP host.
//!
//! The ERP endpoint and optional bearer token come from the tenant's
//! `z:<tid>:secrets` map (`erp_onboarding_url`, `erp_api_key`), seeded by the
//! operator CLI. The contract returns only a status + reference and never
//! forwards the ERP response body (which would contain the resolved PII).

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::common::{find_pii_in_text, parse_input};

pub const SECRET_ERP_URL: &str = "erp_onboarding_url";
pub const SECRET_ERP_API_KEY: &str = "erp_api_key";
pub const MARKER_FIRST_NAME: &str = "{{profile.first_name}}";
pub const MARKER_LAST_NAME: &str = "{{profile.last_name}}";
/// Documented in the ADK placeholder guide, but the host WIT says nested markers
/// are rejected with `placeholder-denied` — so it is opt-in (`include_email: true`).
pub const MARKER_EMAIL: &str = "{{profile.verified_contacts.email.value}}";

#[derive(Clone, PartialEq, Eq)]
pub struct OnboardReq {
    pub vendor_id: String,
    pub screening_ref: String,
    pub include_email: bool,
    /// Free text for the ERP record. Rejected at parse time when it looks like personal
    /// data (see [`find_pii_in_text`]) and never logged — only its length shows in `Debug`.
    pub notes: Option<String>,
}

impl core::fmt::Debug for OnboardReq {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("OnboardReq")
            .field("vendor_id", &self.vendor_id)
            .field("screening_ref", &self.screening_ref)
            .field("include_email", &self.include_email)
            .field("notes", &self.notes.as_ref().map(|n| format!("<{} chars, not logged>", n.chars().count())))
            .finish()
    }
}

#[derive(Debug, serde::Serialize)]
pub struct OnboardResp {
    pub status: String,
    pub erp_reference: String,
    pub http_code: u16,
}

/// Parse + validate. Pure.
pub fn parse_request(input: &[u8]) -> Result<OnboardReq, String> {
    let v = parse_input("submit-onboarding", input)?;
    let vendor_id = v["vendor_id"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or("submit-onboarding: `vendor_id` (1–128 chars) is required")?
        .to_string();
    let screening_ref = v["screening_ref"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or("submit-onboarding: `screening_ref` is required — run screen-vendor first")?
        .to_string();
    let include_email = v.get("include_email").and_then(|x| x.as_bool()).unwrap_or(false);
    let notes = v.get("notes").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty());
    if let Some(kind) = notes.and_then(find_pii_in_text) {
        return Err(format!(
            "submit-onboarding: `notes` looks like it carries {} — notes must not contain personal data; the signatory reaches the ERP only via {{{{profile.*}}}} placeholders",
            kind.describe()
        ));
    }
    let notes = notes.map(|s| s.chars().take(1000).collect::<String>());
    Ok(OnboardReq { vendor_id, screening_ref, include_email, notes })
}

/// Build the ERP request body. Pure: contains only markers, never values.
pub fn build_erp_body(req: &OnboardReq, submitted_at: u64) -> serde_json::Value {
    let mut signatory = serde_json::Map::new();
    signatory.insert("first_name".into(), MARKER_FIRST_NAME.into());
    signatory.insert("last_name".into(), MARKER_LAST_NAME.into());
    signatory.insert("role".into(), "authorised_signatory".into());
    if req.include_email {
        signatory.insert("email".into(), MARKER_EMAIL.into());
    }
    serde_json::json!({
        "source": "t3n:z-tenant-kyb",
        "contract_version": crate::CONTRACT_VERSION,
        "vendor_id": req.vendor_id,
        "screening_ref": req.screening_ref,
        "signatory": signatory,
        "notes": req.notes,
        "submitted_at": submitted_at,
    })
}

/// Pick a reference out of the ERP response without exposing its body. Pure.
pub fn extract_reference(code: u16, body: &[u8]) -> String {
    if let Ok(j) = serde_json::from_slice::<serde_json::Value>(body) {
        for key in ["id", "reference", "erp_reference", "ticket", "request_id"] {
            if let Some(s) = j[key].as_str() {
                return s.to_string();
            }
            if let Some(n) = j[key].as_u64() {
                return n.to_string();
            }
        }
        // httpbin-style echo: use the request id header if present, never the echoed json.
        if let Some(s) = j["headers"]["X-Amzn-Trace-Id"].as_str() {
            return s.to_string();
        }
    }
    format!("http-{code}")
}

/// Entry point called from `lib.rs`.
pub fn submit_onboarding(input: &[u8]) -> Result<Vec<u8>, String> {
    let req = parse_request(input)?;

    #[cfg(target_arch = "wasm32")]
    {
        let resp = submit_onboarding_wasm(req)?;
        serde_json::to_vec(&resp).map_err(|e| e.to_string())
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("submit_onboarding is only implemented on the wasm32 target".to_string())
    }
}

#[cfg(target_arch = "wasm32")]
use crate::host::{
    interfaces::{http_with_placeholders as hwp, kv_store, logging},
    tenant::tenant_context,
};

#[cfg(target_arch = "wasm32")]
fn secrets_map_name() -> String {
    format!("z:{}:secrets", hex::encode(tenant_context::tenant_did()))
}

#[cfg(target_arch = "wasm32")]
fn read_secret(key: &str) -> Result<Option<String>, String> {
    let bytes = kv_store::get(&secrets_map_name(), key.as_bytes())
        .map_err(|e| format!("kv read `{key}`: {e}"))?;
    match bytes {
        None => Ok(None),
        Some(b) => String::from_utf8(b).map(Some).map_err(|e| e.to_string()),
    }
}

#[cfg(target_arch = "wasm32")]
fn submit_onboarding_wasm(req: OnboardReq) -> Result<OnboardResp, String> {
    let url = read_secret(SECRET_ERP_URL)?.ok_or(
        "erp_onboarding_url not found in z:<tid>:secrets — run `kyb deploy` (seeds it) before use",
    )?;
    let api_key = read_secret(SECRET_ERP_API_KEY)?;

    let mut headers = alloc::vec![("Accept".to_string(), "application/json".to_string())];
    if let Some(k) = api_key {
        headers.push(("Authorization".to_string(), format!("Bearer {k}")));
    }
    let body = build_erp_body(&req, tenant_context::cluster_timestamp_secs());
    // Opaque ids only — `notes` is free text and is never logged.
    let _ = logging::info(&format!(
        "onboarding vendor_id={} screening_ref={} include_email={}",
        req.vendor_id, req.screening_ref, req.include_email
    ));

    let resp = hwp::call(&hwp::Request {
        method: hwp::Verb::Post,
        url,
        headers: Some(headers),
        payload: Some(serde_json::to_vec(&body).map_err(|e| e.to_string())?),
    })
    .map_err(|e| format!("erp onboarding: {}", format_http_error(e)))?;

    if resp.code < 200 || resp.code >= 300 {
        // Log the status only — the body may echo resolved PII.
        let _ = logging::error(&format!("ERP onboarding HTTP {}", resp.code));
        return Err(format!("ERP onboarding failed: HTTP {}", resp.code));
    }
    Ok(OnboardResp {
        status: "submitted".to_string(),
        erp_reference: extract_reference(resp.code, &resp.payload),
        http_code: resp.code,
    })
}

/// Render a typed `http-with-placeholders` error without any resolved PII.
#[cfg(target_arch = "wasm32")]
fn format_http_error(e: hwp::HttpError) -> String {
    match e {
        hwp::HttpError::EgressDenied(host) => format!(
            "egress denied for host {host} — the user grant (agent-auth-update) must list it in allowedHosts"
        ),
        hwp::HttpError::PlaceholderDenied(marker) => format!("placeholder not permitted: {marker}"),
        hwp::HttpError::PlaceholderUnknown(field) => format!("user profile missing field: {field}"),
        hwp::HttpError::PlaceholderNoUserContext => {
            "no user context bound for placeholder resolution (call through an authenticated user grant)".to_string()
        }
        hwp::HttpError::UpstreamError(reason) => format!("upstream: {reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsing_requires_ids_and_rejects_inline_pii() {
        let r = parse_request(br#"{"vendor_id":" V-1 ","screening_ref":"scr-9","include_email":true,"notes":" ok "}"#).unwrap();
        assert_eq!(r.vendor_id, "V-1");
        assert!(r.include_email);
        assert_eq!(r.notes.as_deref(), Some("ok"));
        assert!(parse_request(br#"{"vendor_id":"V-1"}"#).unwrap_err().contains("screening_ref"));
        assert!(parse_request(br#"{"vendor_id":"","screening_ref":"x"}"#).unwrap_err().contains("vendor_id"));
        let err = parse_request(br#"{"vendor_id":"V-1","screening_ref":"x","signatory":{"email":"a@b.c"}}"#).unwrap_err();
        assert!(err.contains("inline PII") && err.contains("signatory.email"));
    }

    #[test]
    fn erp_body_carries_only_unresolved_markers() {
        let r = parse_request(br#"{"vendor_id":"V-1","screening_ref":"scr-9"}"#).unwrap();
        let body = build_erp_body(&r, 1_700_000_000);
        assert_eq!(body["signatory"]["first_name"], MARKER_FIRST_NAME);
        assert_eq!(body["signatory"]["last_name"], MARKER_LAST_NAME);
        assert!(body["signatory"].get("email").is_none(), "email marker must be opt-in");
        let s = body.to_string();
        assert!(s.contains("{{profile.first_name}}") && !s.contains("{{secrets."));
        let with_email = build_erp_body(&OnboardReq { include_email: true, ..r }, 1);
        assert_eq!(with_email["signatory"]["email"], MARKER_EMAIL);
    }

    #[test]
    fn reference_extraction_prefers_ids_and_never_echoes_body() {
        assert_eq!(extract_reference(201, br#"{"id":"ERP-42"}"#), "ERP-42");
        assert_eq!(extract_reference(200, br#"{"ticket":7}"#), "7");
        assert_eq!(
            extract_reference(200, br#"{"json":{"signatory":{"first_name":"Ada"}},"headers":{"X-Amzn-Trace-Id":"Root=1-abc"}}"#),
            "Root=1-abc"
        );
        assert_eq!(extract_reference(202, b"not json"), "http-202");
    }

    #[test]
    fn notes_carrying_personal_data_are_rejected_with_the_kind_named() {
        for (notes, kind) in [
            ("signatory reachable at ada.lovelace@example.com", "an e-mail address"),
            ("call +49 30 1234 5678 before Friday", "a phone-number-like run of 8+ digits"),
            ("settle to DE44 5001 0517 5407 3249 31", "an IBAN-shaped account number"),
        ] {
            let input = serde_json::json!({"vendor_id": "V-1", "screening_ref": "scr-9", "notes": notes}).to_string();
            let err = parse_request(input.as_bytes()).unwrap_err();
            assert!(err.contains("`notes`") && err.contains(kind), "{notes}: {err}");
            assert!(!err.contains(notes), "the error must not echo the notes");
        }
        // Ordinary vendor notes and an absent/blank field still pass.
        let ok = parse_request(br#"{"vendor_id":"V-1","screening_ref":"scr-9","notes":"preferred supplier, net 30, LEI 529900D6BF99LW9R2E68"}"#).unwrap();
        assert!(ok.notes.as_deref().unwrap().starts_with("preferred"));
        assert_eq!(parse_request(br#"{"vendor_id":"V-1","screening_ref":"scr-9","notes":"  "}"#).unwrap().notes, None);
    }

    #[test]
    fn debug_output_shows_ids_but_never_the_notes() {
        let r = parse_request(br#"{"vendor_id":"V-1","screening_ref":"scr-9","notes":"confidential remark"}"#).unwrap();
        let dbg = format!("{r:?}");
        assert!(dbg.contains("V-1") && dbg.contains("scr-9"), "{dbg}");
        assert!(!dbg.contains("confidential"), "{dbg}");
        assert!(dbg.contains("<19 chars, not logged>"), "{dbg}");
    }

    #[test]
    fn native_entry_point_returns_wasm_only_error() {
        let err = submit_onboarding(br#"{"vendor_id":"V-1","screening_ref":"scr-9"}"#).unwrap_err();
        assert!(err.contains("wasm32"));
    }
}
