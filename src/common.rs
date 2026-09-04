//! Shared guards and helpers. Everything here is target-independent and unit-tested natively.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

/// Person-level key names that must never be passed to this contract inline.
/// Compared after [`normalise_key`] (lower-case, `_`/`-`/space/`.` removed), so
/// `firstName`, `FIRST-NAME` and `first_name` are the same key. The signatory's
/// identity reaches the ERP only through `{{profile.*}}` markers.
pub const PII_KEYS: &[&str] = &[
    "firstname", "lastname", "givenname", "familyname", "middlename", "maidenname",
    "fullname", "personname", "signatoryname", "contactname",
    "mobile", "mobileno", "tel",
    "dob", "dateofbirth", "bornon",
    "ssn", "socialsecuritynumber", "nationalid", "nationalidnumber", "idnumber",
    "addressline", "homeaddress", "residentialaddress", "privateaddress",
];

/// Fragments that mark a key as person-level wherever they occur in the
/// normalised key: `contact_email`, `emailAddress`, `passportNo`, `birthdate`,
/// `telephone`, `iban_number` are all rejected.
pub const PII_FRAGMENTS: &[&str] = &["email", "phone", "passport", "birth", "iban"];

/// Contract flags that contain a fragment but carry no data.
const NOT_PII_KEYS: &[&str] = &["includeemail"];

/// Lower-case and drop the separators people use between words in a key.
pub fn normalise_key(k: &str) -> String {
    k.chars()
        .filter(|c| !matches!(c, '_' | '-' | ' ' | '.'))
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Does this key name look like personal data? Names only — values are never inspected.
pub fn is_pii_key(k: &str) -> bool {
    let nk = normalise_key(k);
    if NOT_PII_KEYS.contains(&nk.as_str()) {
        return false;
    }
    PII_KEYS.contains(&nk.as_str()) || PII_FRAGMENTS.iter().any(|f| nk.contains(f))
}

/// Reject any top-level (or nested) object key that looks like personal data.
/// Returns the offending key so the caller can produce a precise error.
pub fn find_pii_key(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            for (k, child) in map {
                if is_pii_key(k) {
                    return Some(k.clone());
                }
                if let Some(hit) = find_pii_key(child) {
                    return Some(format!("{k}.{hit}"));
                }
            }
            None
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_pii_key),
        _ => None,
    }
}

/// Parse raw input bytes as a JSON object, applying the PII guard first.
pub fn parse_input(fn_name: &str, input: &[u8]) -> Result<serde_json::Value, String> {
    let v: serde_json::Value =
        serde_json::from_slice(input).map_err(|e| format!("{fn_name}: bad input: {e}"))?;
    if !v.is_object() {
        return Err(format!("{fn_name}: input must be a JSON object"));
    }
    if let Some(key) = find_pii_key(&v) {
        return Err(format!(
            "{fn_name}: inline PII not accepted (field `{key}`) — person data reaches third parties only via {{{{profile.*}}}} placeholders"
        ));
    }
    Ok(v)
}

/// Normalise a legal name for fuzzy equality: lower-case, ASCII letters/digits only,
/// common corporate suffixes removed.
pub fn normalise_name(s: &str) -> String {
    const SUFFIXES: &[&str] = &[
        "gmbh", "ag", "ug", "kg", "ohg", "se", "ltd", "limited", "plc", "llc", "inc",
        "incorporated", "corp", "corporation", "sa", "sas", "sarl", "srl", "spa", "bv",
        "nv", "oy", "ab", "as", "aps", "sp z oo", "sro", "zrt", "kft", "co", "company",
    ];
    let lowered: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { ' ' })
        .collect();
    let tokens: Vec<&str> = lowered
        .split_whitespace()
        .filter(|t| !SUFFIXES.contains(t))
        .collect();
    tokens.join(" ")
}

/// True when two legal names agree after normalisation (either contains the other).
pub fn names_match(a: &str, b: &str) -> bool {
    let (na, nb) = (normalise_name(a), normalise_name(b));
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    na == nb || na.contains(&nb) || nb.contains(&na)
}

/// Minimal percent-encoding for a query-string value (RFC 3986 unreserved set kept).
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Validate an ISO-3166 alpha-2 code from the EU VAT area (VIES member codes).
pub fn is_vies_country(code: &str) -> bool {
    const CODES: &[&str] = &[
        "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU",
        "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
    ];
    CODES.contains(&code)
}

/// Strip spaces/dots/dashes and an optional leading country prefix from a VAT number.
pub fn clean_vat(country: &str, raw: &str) -> String {
    let compact: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    match compact.strip_prefix(country) {
        Some(rest) if rest.len() >= 2 => rest.to_string(),
        _ => compact,
    }
}

/// LEI: 20 alphanumeric characters (ISO 17442). Check-digit validation is left to GLEIF.
pub fn is_lei_shape(lei: &str) -> bool {
    lei.len() == 20 && lei.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pii_guard_catches_top_level_and_nested_keys() {
        assert_eq!(find_pii_key(&json!({"vendor_id": "v1"})), None);
        assert_eq!(
            find_pii_key(&json!({"vendor_id": "v1", "Email": "x@y.z"})),
            Some("Email".to_string())
        );
        assert_eq!(
            find_pii_key(&json!({"signatory": {"first_name": "A"}})),
            Some("signatory.first_name".to_string())
        );
        assert_eq!(
            find_pii_key(&json!({"contacts": [{"phone": "1"}]})),
            Some("contacts.phone".to_string())
        );
    }

    #[test]
    fn pii_guard_normalises_spelling_and_matches_fragments() {
        // Spellings that bypassed an exact-match list: camelCase, other separators, fragments.
        for k in [
            "firstName", "FIRST-NAME", "emailAddress", "contact_email", "e-mail", "birthdate",
            "date_of_birth", "passportNo", "mobile", "telephone", "signatory_name", "IBAN",
            "iban_number", "ssn",
        ] {
            assert_eq!(find_pii_key(&json!({ k: "x" })), Some(k.to_string()), "{k} must be rejected");
        }
        // Company-level keys and the contract's own inputs must pass.
        for k in [
            "vendor_id", "screening_ref", "notes", "country_code", "vat_number", "lei",
            "legal_name", "business_name", "company_address", "include_email",
        ] {
            assert_eq!(find_pii_key(&json!({ k: "x" })), None, "{k} must be accepted");
        }
    }

    #[test]
    fn parse_input_rejects_pii_with_precise_message() {
        let err = parse_input("screen-vendor", br#"{"country_code":"DE","date_of_birth":"1990-01-01"}"#)
            .unwrap_err();
        assert!(err.contains("inline PII not accepted"));
        assert!(err.contains("date_of_birth"));
    }

    #[test]
    fn parse_input_rejects_non_object_and_bad_json() {
        assert!(parse_input("f", b"[1,2]").unwrap_err().contains("must be a JSON object"));
        assert!(parse_input("f", b"nope").unwrap_err().contains("bad input"));
    }

    #[test]
    fn name_normalisation_ignores_suffixes_and_case() {
        assert_eq!(normalise_name("Siemens Aktiengesellschaft"), "siemens aktiengesellschaft");
        assert_eq!(normalise_name("SAP SE"), "sap");
        assert!(names_match("BMW AG", "bmw"));
        assert!(names_match("Bayerische Motoren Werke AG", "BAYERISCHE MOTOREN WERKE AKTIENGESELLSCHAFT"));
        assert!(!names_match("Siemens", "Bosch"));
        assert!(!names_match("", "Bosch"));
    }

    #[test]
    fn vat_cleaning_strips_prefix_and_noise() {
        assert_eq!(clean_vat("DE", "DE 123.456-789"), "123456789");
        assert_eq!(clean_vat("DE", "123456789"), "123456789");
        assert_eq!(clean_vat("FR", "fr12345678901"), "12345678901");
    }

    #[test]
    fn helpers_validate_shapes() {
        assert!(is_vies_country("DE"));
        assert!(!is_vies_country("US"));
        assert!(is_lei_shape("529900T8BM49AURSDO55"));
        assert!(!is_lei_shape("short"));
        assert_eq!(url_encode("SAP SE & Co"), "SAP%20SE%20%26%20Co");
    }
}
