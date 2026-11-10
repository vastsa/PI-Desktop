use serde_json::{json, Value};

const DEFAULT_DOH_SERVER_URL: &str = "https://1.1.1.1/dns-query";
const DOH_SERVER_URL_MAX_LENGTH: usize = 2048;

/// Authoritative validation of the device-local Desktop DNS preference.
/// The Host never installs a resolver or changes the environment inherited by Bash.
pub fn validate_network_dns(settings: &Value) -> Result<(), String> {
    parse_network_dns(settings.get("networkDns")).map(|_| ())
}

/// Tolerant reads never turn an unreadable saved preference into a DNS opt-in.
pub fn normalize_network_dns(value: Option<&Value>) -> Value {
    parse_network_dns(value).unwrap_or_else(|_| json!({"mode": "system"}))
}

fn parse_network_dns(value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(json!({"mode": "system"}));
    };
    let object = value.as_object().ok_or("networkDns must be an object")?;
    let mode = match object.get("mode").filter(|mode| !mode.is_null()) {
        None => "system",
        Some(Value::String(mode)) if matches!(mode.as_str(), "system" | "doh") => mode.as_str(),
        _ => return Err("networkDns.mode must be system or doh".into()),
    };
    let mut next = json!({"mode": mode});
    if let Some(value) = object.get("serverUrl") {
        let raw = value
            .as_str()
            .ok_or("networkDns.serverUrl must be a string")?
            .trim_matches(is_js_whitespace);
        // Mirror JavaScript's UTF-16 length and whitespace rules at the shared
        // settings boundary, before URL parsing can discard or escape input.
        if raw.is_empty()
            || raw.encode_utf16().count() > DOH_SERVER_URL_MAX_LENGTH
            || raw.chars().any(|ch| {
                is_js_whitespace(ch)
                    || matches!(ch, '\u{0000}'..='\u{001f}' | '\u{007f}' | '{' | '}' | '\\')
            })
        {
            return Err("networkDns.serverUrl must be a bounded HTTPS POST endpoint".into());
        }
        let url = reqwest::Url::parse(raw).map_err(|_| "networkDns.serverUrl is invalid")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some_and(|password| !password.is_empty())
            || url.fragment().is_some()
            || raw.contains('#')
        {
            return Err(
                "networkDns.serverUrl must use HTTPS without credentials or fragments".into(),
            );
        }
        next["serverUrl"] = Value::String(url.to_string());
    } else if mode == "doh" {
        next["serverUrl"] = Value::String(DEFAULT_DOH_SERVER_URL.into());
    }
    if let Some(value) = object.get("allowSystemFallback") {
        let fallback = value
            .as_bool()
            .ok_or("networkDns.allowSystemFallback must be a boolean")?;
        next["allowSystemFallback"] = Value::Bool(fallback);
    } else if mode == "doh" {
        next["allowSystemFallback"] = Value::Bool(false);
    }
    Ok(next)
}

/// ECMAScript WhiteSpace and LineTerminator, used by String.trim and /\s/.
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Optional runtime flag; legacy and independent headless callers remain off.
pub fn desktop_dns_enabled(params: &Value) -> Result<bool, String> {
    match params.get("desktopDnsEnabled") {
        None => Ok(false),
        Some(Value::Bool(enabled)) => Ok(*enabled),
        Some(_) => Err("desktopDnsEnabled must be a boolean".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_dns_flag_is_optional_and_strictly_boolean() {
        assert!(!desktop_dns_enabled(&json!({})).unwrap());
        assert!(desktop_dns_enabled(&json!({"desktopDnsEnabled": true})).unwrap());
        assert!(!desktop_dns_enabled(&json!({"desktopDnsEnabled": false})).unwrap());
        for value in [json!(null), json!(1), json!("true"), json!({}), json!([])] {
            assert_eq!(
                desktop_dns_enabled(&json!({"desktopDnsEnabled": value})).unwrap_err(),
                "desktopDnsEnabled must be a boolean"
            );
        }
    }

    #[test]
    fn shared_dns_defaults_and_disabled_preferences_are_normalized() {
        assert_eq!(normalize_network_dns(None), json!({"mode": "system"}));
        for (input, expected) in [
            (json!(null), json!({"mode": "system"})),
            (json!({}), json!({"mode": "system"})),
            (json!({"mode": null}), json!({"mode": "system"})),
            (
                json!({"mode": "doh"}),
                json!({
                    "mode": "doh", "serverUrl": "https://1.1.1.1/dns-query",
                    "allowSystemFallback": false,
                }),
            ),
            (
                json!({
                    "mode": "system", "serverUrl": " https://192.168.1.2/dns-query ",
                    "allowSystemFallback": true, "unknown": true,
                }),
                json!({
                    "mode": "system", "serverUrl": "https://192.168.1.2/dns-query",
                    "allowSystemFallback": true,
                }),
            ),
            (
                json!({"mode": "doh", "serverUrl": "https://resolver.example"}),
                json!({
                    "mode": "doh", "serverUrl": "https://resolver.example/",
                    "allowSystemFallback": false,
                }),
            ),
        ] {
            assert!(validate_network_dns(&json!({"networkDns": input})).is_ok());
            assert_eq!(normalize_network_dns(Some(&input)), expected, "{input}");
        }
    }

    #[test]
    fn invalid_shared_dns_shapes_and_endpoints_never_opt_in() {
        for input in [
            json!(true),
            json!([]),
            json!("doh"),
            json!({"mode": "unknown"}),
            json!({"mode": 1}),
            json!({"mode": "doh", "serverUrl": "http://resolver.example/dns-query"}),
            json!({"serverUrl": "https://user:secret@resolver.example/dns-query"}),
            json!({"serverUrl": "https://resolver.example/dns-query#"}),
            json!({"serverUrl": "https://resolver.example/dns query"}),
            json!({"serverUrl": "https://resolver.example/{?dns}"}),
            json!({"serverUrl": "https://resolver.example/\\query"}),
            json!({"serverUrl": 123}),
            json!({"serverUrl": null}),
            json!({"allowSystemFallback": "yes"}),
            json!({"allowSystemFallback": null}),
        ] {
            assert!(validate_network_dns(&json!({"networkDns": input})).is_err(), "{input}");
            assert_eq!(normalize_network_dns(Some(&input)), json!({"mode": "system"}));
        }
    }

    #[test]
    fn endpoint_limit_counts_utf16_before_url_encoding() {
        let prefix = "https://resolver.example/";
        let at_limit = format!("{prefix}{}", "a".repeat(2048 - prefix.len()));
        assert!(validate_network_dns(&json!({"networkDns": {"serverUrl": at_limit}})).is_ok());
        for raw in [
            format!("{at_limit}a"),
            format!("{prefix}{}", "\u{1f600}".repeat(1024)),
        ] {
            assert_eq!(
                validate_network_dns(&json!({"networkDns": {"serverUrl": raw}})).unwrap_err(),
                "networkDns.serverUrl must be a bounded HTTPS POST endpoint"
            );
        }
    }

    #[test]
    fn endpoint_whitespace_matches_the_shared_javascript_contract() {
        for whitespace in [
            ' ', '\t', '\n', '\u{00a0}', '\u{2007}', '\u{2028}', '\u{feff}',
        ] {
            let raw = format!("{whitespace}HTTPS://Resolver.Example:443/dns-query{whitespace}");
            assert_eq!(
                normalize_network_dns(Some(&json!({"serverUrl": raw}))),
                json!({"mode": "system", "serverUrl": "https://resolver.example/dns-query"})
            );
            let raw = format!("https://resolver.example/dns{whitespace}query");
            assert!(validate_network_dns(&json!({"networkDns": {"serverUrl": raw}})).is_err());
        }
        for control in ['\0', '\u{001f}', '\u{007f}'] {
            let raw = format!("https://resolver.example/{control}query");
            assert!(validate_network_dns(&json!({"networkDns": {"serverUrl": raw}})).is_err());
        }
    }
}
