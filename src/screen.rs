//! screen-vendor: company screening against two free, key-less public registers.
//!
//!   1. EU VIES  — POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
//!                 → { valid, name, address, requestDate, userError }
//!   2. GLEIF    — GET  https://api.gleif.org/api/v1/lei-records/<LEI>
//!                 or   https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=<name>&page[size]=5
//!                      (the record whose normalised legal name equals the looked-up name wins,
//!                      otherwise the first result)
//!
//! Only company identifiers cross the WIT boundary. Parsing and risk scoring are
//! pure functions (tested natively); only the two `http` calls are wasm32-only.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::common::{clean_vat, is_lei_shape, is_vies_country, names_match, normalise_name, parse_input};

pub const VIES_URL: &str = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
pub const GLEIF_BASE: &str = "https://api.gleif.org/api/v1/lei-records";
/// Records fetched by a GLEIF name search; the best normalised-name match among them is used.
pub const GLEIF_PAGE_SIZE: u8 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenReq {
    pub country_code: String,
    pub vat_number: String,
    pub lei: Option<String>,
    pub legal_name: Option<String>,
}

#[derive(Debug, Default, serde::Serialize, PartialEq, Eq)]
pub struct VatResult {
    pub checked: bool,
    pub valid: bool,
    pub name: Option<String>,
    pub address: Option<String>,
    pub request_date: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Default, serde::Serialize, PartialEq, Eq)]
pub struct LeiResult {
    pub checked: bool,
    pub found: bool,
    pub lei: Option<String>,
    pub legal_name: Option<String>,
    pub entity_status: Option<String>,
    pub registration_status: Option<String>,
    pub country: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ScreenResp {
    pub contract_version: &'static str,
    pub country_code: String,
    pub vat_number: String,
    pub vat: VatResult,
    pub lei: LeiResult,
    pub risk_flags: Vec<String>,
    pub screened_at: u64,
}

/// Parse + validate the request. Pure.
pub fn parse_request(input: &[u8]) -> Result<ScreenReq, String> {
    let v = parse_input("screen-vendor", input)?;
    let country_code = v["country_code"]
        .as_str()
        .ok_or("screen-vendor: `country_code` (ISO alpha-2, EU/VIES member) is required")?
        .trim()
        .to_ascii_uppercase();
    if !is_vies_country(&country_code) {
        return Err(format!(
            "screen-vendor: `{country_code}` is not a VIES member code (EU + XI)"
        ));
    }
    let vat_raw = v["vat_number"]
        .as_str()
        .ok_or("screen-vendor: `vat_number` is required")?;
    let vat_number = clean_vat(&country_code, vat_raw);
    if vat_number.len() < 2 || vat_number.len() > 15 {
        return Err("screen-vendor: `vat_number` must be 2–15 alphanumeric characters".to_string());
    }
    let lei = match v.get("lei").and_then(|x| x.as_str()) {
        Some(s) if !s.trim().is_empty() => {
            let s = s.trim().to_ascii_uppercase();
            if !is_lei_shape(&s) {
                return Err("screen-vendor: `lei` must be 20 alphanumeric characters".to_string());
            }
            Some(s)
        }
        _ => None,
    };
    let legal_name = v
        .get("legal_name")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(ScreenReq { country_code, vat_number, lei, legal_name })
}

/// Parse a VIES REST response body. Pure.
pub fn parse_vies(code: u16, body: &[u8]) -> VatResult {
    let mut r = VatResult { checked: true, ..Default::default() };
    if code != 200 {
        r.error = Some(format!("VIES HTTP {code}"));
        return r;
    }
    let j: serde_json::Value = match serde_json::from_slice(body) {
        Ok(j) => j,
        Err(e) => {
            r.error = Some(format!("VIES parse: {e}"));
            return r;
        }
    };
    if let Some(ue) = j["userError"].as_str() {
        if ue != "VALID" && ue != "INVALID" {
            // e.g. MS_UNAVAILABLE, SERVICE_UNAVAILABLE, INVALID_INPUT
            r.error = Some(format!("VIES {ue}"));
        }
    }
    r.valid = j["valid"].as_bool().unwrap_or(false);
    r.name = j["name"].as_str().filter(|s| *s != "---").map(str::to_string);
    r.address = j["address"].as_str().filter(|s| *s != "---").map(|s| s.replace('\n', ", "));
    r.request_date = j["requestDate"].as_str().map(str::to_string);
    r
}

/// Parse a GLEIF JSON:API response (single record or a filtered list); a list yields its first record. Pure.
pub fn parse_gleif(code: u16, body: &[u8]) -> LeiResult {
    parse_gleif_matching(code, body, None)
}

/// Like [`parse_gleif`], but a list yields the record whose normalised legal name equals
/// `wanted` (normalised) when there is one, else the first record. Pure.
pub fn parse_gleif_matching(code: u16, body: &[u8], wanted: Option<&str>) -> LeiResult {
    let mut r = LeiResult { checked: true, ..Default::default() };
    if code == 404 {
        return r; // found=false, no error: a clean "not registered"
    }
    if code != 200 {
        r.error = Some(format!("GLEIF HTTP {code}"));
        return r;
    }
    let j: serde_json::Value = match serde_json::from_slice(body) {
        Ok(j) => j,
        Err(e) => {
            r.error = Some(format!("GLEIF parse: {e}"));
            return r;
        }
    };
    let rec = match &j["data"] {
        serde_json::Value::Array(items) => {
            let wanted = wanted.map(normalise_name).filter(|w| !w.is_empty());
            let exact = wanted.and_then(|w| {
                items.iter().find(|it| {
                    it["attributes"]["entity"]["legalName"]["name"].as_str().is_some_and(|n| normalise_name(n) == w)
                })
            });
            exact.or_else(|| items.first())
        }
        _ => j.get("data"),
    };
    let Some(rec) = rec.filter(|it| it.is_object()) else { return r };
    let a = &rec["attributes"];
    r.found = true;
    r.lei = a["lei"].as_str().map(str::to_string);
    r.legal_name = a["entity"]["legalName"]["name"].as_str().map(str::to_string);
    r.entity_status = a["entity"]["status"].as_str().map(str::to_string);
    r.registration_status = a["registration"]["status"].as_str().map(str::to_string);
    r.country = a["entity"]["legalAddress"]["country"].as_str().map(str::to_string);
    r
}

/// A register answered HTTP 429: the check was throttled, not broken — retry later.
fn is_rate_limited(error: &str) -> bool {
    error.contains("HTTP 429")
}

/// Derive risk flags from the two register results. Pure.
pub fn risk_flags(req: &ScreenReq, vat: &VatResult, lei: &LeiResult) -> Vec<String> {
    let mut flags = Vec::new();
    if let Some(e) = &vat.error {
        flags.push(if is_rate_limited(e) { "VIES_RATE_LIMITED" } else { "VAT_CHECK_UNAVAILABLE" }.to_string());
    } else if !vat.valid {
        flags.push("VAT_INVALID".to_string());
    }
    if let Some(e) = &lei.error {
        flags.push(if is_rate_limited(e) { "GLEIF_RATE_LIMITED" } else { "LEI_CHECK_UNAVAILABLE" }.to_string());
    } else if !lei.found {
        flags.push("LEI_NOT_FOUND".to_string());
    } else {
        if lei.registration_status.as_deref() != Some("ISSUED") {
            flags.push("LEI_NOT_ISSUED".to_string()); // LAPSED / RETIRED / ANNULLED / PENDING_*
        }
        if lei.entity_status.as_deref() != Some("ACTIVE") {
            flags.push("ENTITY_NOT_ACTIVE".to_string());
        }
        if let Some(c) = &lei.country {
            // VIES uses EL for Greece and XI for Northern Ireland; GLEIF uses GR / GB.
            let expect = match req.country_code.as_str() { "EL" => "GR", "XI" => "GB", x => x };
            if c != expect {
                flags.push("COUNTRY_MISMATCH".to_string());
            }
        }
    }
    let claimed = req.legal_name.as_deref().or(vat.name.as_deref());
    if let (Some(claimed), Some(registered)) = (claimed, lei.legal_name.as_deref()) {
        if !names_match(claimed, registered) {
            flags.push("NAME_MISMATCH".to_string());
        }
    }
    if let (Some(claimed), Some(vies_name)) = (req.legal_name.as_deref(), vat.name.as_deref()) {
        if !names_match(claimed, vies_name) && !flags.iter().any(|f| f == "NAME_MISMATCH") {
            flags.push("NAME_MISMATCH".to_string());
        }
    }
    flags
}

/// Entry point called from `lib.rs`.
pub fn screen_vendor(input: &[u8]) -> Result<Vec<u8>, String> {
    let req = parse_request(input)?;

    #[cfg(target_arch = "wasm32")]
    {
        let resp = screen_vendor_wasm(req)?;
        serde_json::to_vec(&resp).map_err(|e| e.to_string())
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("screen_vendor is only implemented on the wasm32 target".to_string())
    }
}

#[cfg(target_arch = "wasm32")]
use crate::common::url_encode;
#[cfg(target_arch = "wasm32")]
use crate::host::{interfaces::{http as http_iface, logging}, tenant::tenant_context};

#[cfg(target_arch = "wasm32")]
fn screen_vendor_wasm(req: ScreenReq) -> Result<ScreenResp, String> {
    use serde_json::json;

    // 1) VIES — POST, JSON body, no auth.
    let vies_body = json!({ "countryCode": req.country_code, "vatNumber": req.vat_number });
    let vat = match http_iface::call(&http_iface::Request {
        method: http_iface::Verb::Post,
        url: VIES_URL.to_string(),
        headers: Some(alloc::vec![("Accept".to_string(), "application/json".to_string())]),
        payload: Some(serde_json::to_vec(&vies_body).map_err(|e| e.to_string())?),
    }) {
        Ok(r) => parse_vies(r.code, &r.payload),
        Err(e) => VatResult { checked: true, error: Some(format!("VIES transport: {e}")), ..Default::default() },
    };
    let _ = logging::info(&format!(
        "VIES {}{}: valid={} err={:?}",
        req.country_code, req.vat_number, vat.valid, vat.error
    ));

    // 2) GLEIF — by LEI if given, else by legal name (input, then VIES name).
    let lookup_name = req.legal_name.clone().or_else(|| vat.name.clone());
    let gleif_url = match (&req.lei, &lookup_name) {
        (Some(lei), _) => Some(format!("{GLEIF_BASE}/{lei}")),
        (None, Some(name)) => Some(format!(
            "{GLEIF_BASE}?filter%5Bentity.legalName%5D={}&page%5Bsize%5D={GLEIF_PAGE_SIZE}",
            url_encode(name)
        )),
        (None, None) => None,
    };
    let lei = match gleif_url {
        None => LeiResult::default(), // nothing to look up: checked=false
        Some(url) => match http_iface::call(&http_iface::Request {
            method: http_iface::Verb::Get,
            url,
            headers: Some(alloc::vec![("Accept".to_string(), "application/vnd.api+json".to_string())]),
            payload: None,
        }) {
            Ok(r) => parse_gleif_matching(r.code, &r.payload, lookup_name.as_deref()),
            Err(e) => LeiResult { checked: true, error: Some(format!("GLEIF transport: {e}")), ..Default::default() },
        },
    };
    let _ = logging::info(&format!(
        "GLEIF found={} status={:?} err={:?}",
        lei.found, lei.registration_status, lei.error
    ));

    let flags = risk_flags(&req, &vat, &lei);
    Ok(ScreenResp {
        contract_version: crate::CONTRACT_VERSION,
        country_code: req.country_code,
        vat_number: req.vat_number,
        vat,
        lei,
        risk_flags: flags,
        screened_at: tenant_context::cluster_timestamp_secs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIES_OK: &[u8] = br#"{"countryCode":"DE","vatNumber":"143593636","requestDate":"2026-09-04","valid":true,"name":"SAP SE","address":"DIETMAR-HOPP-ALLEE 16\n69190 WALLDORF"}"#;
    const VIES_BAD: &[u8] = br#"{"countryCode":"DE","vatNumber":"000000000","requestDate":"2026-09-04","valid":false,"name":"---","address":"---"}"#;
    const VIES_DOWN: &[u8] = br#"{"countryCode":"DE","vatNumber":"143593636","valid":false,"userError":"MS_UNAVAILABLE"}"#;
    const GLEIF_LIST: &[u8] = br#"{"data":[{"type":"lei-records","id":"529900D6BF99LW9R2E68","attributes":{"lei":"529900D6BF99LW9R2E68","entity":{"legalName":{"name":"SAP SE"},"status":"ACTIVE","legalAddress":{"country":"DE"}},"registration":{"status":"ISSUED"}}}]}"#;
    const GLEIF_LAPSED: &[u8] = br#"{"data":{"type":"lei-records","id":"X","attributes":{"lei":"X","entity":{"legalName":{"name":"Other GmbH"},"status":"INACTIVE","legalAddress":{"country":"AT"}},"registration":{"status":"LAPSED"}}}}"#;
    /// A name search for "SAP SE" as GLEIF ranks it: the subsidiary first, the parent second.
    const GLEIF_TWO: &[u8] = br#"{"data":[{"type":"lei-records","id":"A","attributes":{"lei":"AAAAAAAAAAAAAAAAAAAA","entity":{"legalName":{"name":"SAP America, Inc."},"status":"ACTIVE","legalAddress":{"country":"US"}},"registration":{"status":"ISSUED"}}},{"type":"lei-records","id":"B","attributes":{"lei":"529900D6BF99LW9R2E68","entity":{"legalName":{"name":"SAP SE"},"status":"ACTIVE","legalAddress":{"country":"DE"}},"registration":{"status":"ISSUED"}}}]}"#;

    fn req() -> ScreenReq {
        parse_request(br#"{"country_code":"de","vat_number":"DE 143593636","legal_name":"SAP SE"}"#).unwrap()
    }

    #[test]
    fn request_parsing_normalises_and_validates() {
        let r = req();
        assert_eq!(r.country_code, "DE");
        assert_eq!(r.vat_number, "143593636");
        assert_eq!(r.legal_name.as_deref(), Some("SAP SE"));
        assert!(parse_request(br#"{"country_code":"US","vat_number":"1"}"#).unwrap_err().contains("VIES member"));
        assert!(parse_request(br#"{"country_code":"DE"}"#).unwrap_err().contains("vat_number"));
        assert!(parse_request(br#"{"country_code":"DE","vat_number":"143593636","lei":"abc"}"#).unwrap_err().contains("20 alphanumeric"));
        assert!(parse_request(br#"{"country_code":"DE","vat_number":"143593636","first_name":"x"}"#).unwrap_err().contains("inline PII"));
        assert!(parse_request(br#"{"country_code":"DE","vat_number":"1"}"#).unwrap_err().contains("2–15"));
    }

    #[test]
    fn vies_parsing_covers_valid_invalid_and_unavailable() {
        let ok = parse_vies(200, VIES_OK);
        assert!(ok.valid && ok.error.is_none());
        assert_eq!(ok.name.as_deref(), Some("SAP SE"));
        assert_eq!(ok.address.as_deref(), Some("DIETMAR-HOPP-ALLEE 16, 69190 WALLDORF"));
        let bad = parse_vies(200, VIES_BAD);
        assert!(!bad.valid && bad.name.is_none() && bad.error.is_none());
        let down = parse_vies(200, VIES_DOWN);
        assert_eq!(down.error.as_deref(), Some("VIES MS_UNAVAILABLE"));
        assert_eq!(parse_vies(503, b"").error.as_deref(), Some("VIES HTTP 503"));
    }

    #[test]
    fn gleif_parsing_handles_list_single_and_404() {
        let l = parse_gleif(200, GLEIF_LIST);
        assert!(l.found);
        assert_eq!(l.lei.as_deref(), Some("529900D6BF99LW9R2E68"));
        assert_eq!(l.registration_status.as_deref(), Some("ISSUED"));
        let s = parse_gleif(200, GLEIF_LAPSED);
        assert_eq!(s.registration_status.as_deref(), Some("LAPSED"));
        let nf = parse_gleif(404, b"{}");
        assert!(nf.checked && !nf.found && nf.error.is_none());
    }

    #[test]
    fn gleif_name_search_prefers_the_exact_normalised_match() {
        // Exact (normalised) match wins over the top-ranked record …
        let sap = parse_gleif_matching(200, GLEIF_TWO, Some("sap se"));
        assert_eq!(sap.lei.as_deref(), Some("529900D6BF99LW9R2E68"));
        assert_eq!(sap.legal_name.as_deref(), Some("SAP SE"));
        // … the first record is used when nothing matches exactly, or when no name is known.
        assert_eq!(parse_gleif_matching(200, GLEIF_TWO, Some("Siemens")).lei.as_deref(), Some("AAAAAAAAAAAAAAAAAAAA"));
        assert_eq!(parse_gleif(200, GLEIF_TWO).lei.as_deref(), Some("AAAAAAAAAAAAAAAAAAAA"));
        assert!(!parse_gleif_matching(200, br#"{"data":[]}"#, Some("SAP SE")).found);
        // With the right record picked, the clean vendor has no flags.
        assert!(risk_flags(&req(), &parse_vies(200, VIES_OK), &sap).is_empty());
    }

    #[test]
    fn risk_flags_name_rate_limits_instead_of_unavailable() {
        let flags = risk_flags(&req(), &parse_vies(429, b""), &parse_gleif(429, b""));
        assert_eq!(flags, alloc::vec!["VIES_RATE_LIMITED".to_string(), "GLEIF_RATE_LIMITED".to_string()]);
        let generic = risk_flags(&req(), &parse_vies(503, b""), &parse_gleif(500, b""));
        assert_eq!(generic, alloc::vec!["VAT_CHECK_UNAVAILABLE".to_string(), "LEI_CHECK_UNAVAILABLE".to_string()]);
    }

    #[test]
    fn risk_flags_clean_vendor_has_none() {
        let flags = risk_flags(&req(), &parse_vies(200, VIES_OK), &parse_gleif(200, GLEIF_LIST));
        assert!(flags.is_empty(), "{flags:?}");
    }

    #[test]
    fn risk_flags_detect_invalid_vat_lapsed_lei_name_and_country_mismatch() {
        let flags = risk_flags(&req(), &parse_vies(200, VIES_BAD), &parse_gleif(200, GLEIF_LAPSED));
        for f in ["VAT_INVALID", "LEI_NOT_ISSUED", "ENTITY_NOT_ACTIVE", "COUNTRY_MISMATCH", "NAME_MISMATCH"] {
            assert!(flags.iter().any(|x| x == f), "missing {f} in {flags:?}");
        }
        let unavailable = risk_flags(&req(), &parse_vies(200, VIES_DOWN), &parse_gleif(404, b""));
        assert_eq!(unavailable, alloc::vec!["VAT_CHECK_UNAVAILABLE".to_string(), "LEI_NOT_FOUND".to_string()]);
    }

    #[test]
    fn output_never_carries_person_fields() {
        let resp = ScreenResp {
            contract_version: "0.1.0",
            country_code: "DE".into(),
            vat_number: "1".into(),
            vat: parse_vies(200, VIES_OK),
            lei: parse_gleif(200, GLEIF_LIST),
            risk_flags: alloc::vec![],
            screened_at: 0,
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(crate::common::find_pii_key(&parsed), None, "output leaks a person-level key: {json}");
    }

    #[test]
    fn native_entry_point_returns_wasm_only_error() {
        let err = screen_vendor(br#"{"country_code":"DE","vat_number":"143593636"}"#).unwrap_err();
        assert!(err.contains("wasm32"));
    }
}
