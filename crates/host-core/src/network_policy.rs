//! Trust policy for the endpoints the user enters themselves, as host-core
//! needs it.
//!
//! `packages/shared/src/network-policy.ts` holds the whole policy and lives in
//! the processes that judge an address. The host asks it one question: is the
//! relaxed mode in force? That is the answer the WebDAV transport needs before
//! it opens a plaintext hop to a LAN endpoint the user configured. The stored
//! settings value is mirrored here whenever the app hands the host its
//! settings, exactly as `network_proxy.rs` mirrors the proxy.
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

/// Mirrors `DEFAULT_NETWORK_POLICY` in `packages/shared/src/network-policy.ts`:
/// an absent section means the relaxed mode.
static RELAXED: AtomicBool = AtomicBool::new(true);

/// Mirror the stored `networkPolicy` section.
pub fn apply_from_settings(value: Option<&Value>) {
    RELAXED.store(relaxed_from_settings(value), Ordering::Relaxed);
}

/// Whether the relaxed mode is in force for `settings`.
///
/// An absent section means yes, which is the documented default; a policy
/// section a build before the mode existed wrote carries
/// `allowInsecureUserEndpoints: false`, and the user's own `false` survives as
/// `strict` — the same reading as `isRelaxedNetworkPolicy` in
/// `packages/shared`.
pub fn relaxed_from_settings(value: Option<&Value>) -> bool {
    let policy = value
        .and_then(Value::as_object)
        .and_then(|object| object.get("networkPolicy"))
        .and_then(Value::as_object);
    match policy
        .and_then(|policy| policy.get("mode"))
        .and_then(Value::as_str)
    {
        Some("strict") => false,
        Some("relaxed") => true,
        _ => {
            policy
                .and_then(|policy| policy.get("allowInsecureUserEndpoints"))
                .and_then(Value::as_bool)
                != Some(false)
        }
    }
}

/// Whether the relaxed mode is in force right now.
pub fn relaxed() -> bool {
    RELAXED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn network_policy_reading_follows_the_stored_mode() {
        assert!(relaxed_from_settings(None));
        assert!(relaxed_from_settings(Some(&json!({}))));
        assert!(relaxed_from_settings(Some(&json!({
            "networkPolicy": { "mode": "relaxed" }
        }))));
        assert!(relaxed_from_settings(Some(&json!({
            "networkPolicy": { "mode": "relaxed", "insecureNoticeAcknowledged": true }
        }))));
        assert!(!relaxed_from_settings(Some(&json!({
            "networkPolicy": { "mode": "strict" }
        }))));
        // An unusable mode falls back to the documented default, exactly as
        // `normalizeNetworkPolicy` does.
        assert!(relaxed_from_settings(Some(&json!({
            "networkPolicy": { "mode": "none" }
        }))));
        assert!(relaxed_from_settings(Some(&json!({
            "networkPolicy": "yes"
        }))));
    }

    #[test]
    fn network_policy_reading_migrates_the_older_plaintext_flag() {
        assert!(!relaxed_from_settings(Some(&json!({
            "networkPolicy": { "allowInsecureUserEndpoints": false }
        }))));
        assert!(relaxed_from_settings(Some(&json!({
            "networkPolicy": { "allowInsecureUserEndpoints": true }
        }))));
        // An explicit mode outranks the key it replaced.
        assert!(relaxed_from_settings(Some(&json!({
            "networkPolicy": { "mode": "relaxed", "allowInsecureUserEndpoints": false }
        }))));
    }
}
