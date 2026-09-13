use serde_json::Value;
use std::sync::RwLock;

const PROXY_URL_MAX: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ProxyMode {
    #[default]
    System,
    Direct,
    Custom {
        url: String,
        bypass: String,
    },
}

static MARKET_PROXY: RwLock<ProxyMode> = RwLock::new(ProxyMode::System);

const DEFAULT_BYPASS: &str = "localhost,127.0.0.1,::1,<local>";

pub fn apply_from_settings(value: Option<&Value>) {
    let next = proxy_from_settings(value);
    if let Ok(mut slot) = MARKET_PROXY.write() {
        *slot = next;
    }
}

pub fn proxy_from_settings(value: Option<&Value>) -> ProxyMode {
    let Some(object) = value.and_then(Value::as_object) else {
        return ProxyMode::System;
    };
    let proxy = object.get("networkProxy").and_then(Value::as_object);
    let Some(proxy) = proxy else {
        return ProxyMode::System;
    };
    match proxy
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("system")
    {
        "direct" => ProxyMode::Direct,
        "custom" => {
            let url = proxy
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let bypass = proxy
                .get("bypass")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_BYPASS)
                .to_string();
            if url.is_empty() {
                ProxyMode::Direct
            } else {
                ProxyMode::Custom { url, bypass }
            }
        }
        _ => ProxyMode::System,
    }
}

pub fn validate_network_proxy(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let Some(proxy) = object.get("networkProxy") else {
        return Ok(());
    };
    if proxy.is_null() {
        return Ok(());
    }
    let Some(proxy) = proxy.as_object() else {
        return Err("networkProxy must be an object".into());
    };
    let mode = proxy
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("system");
    match mode {
        "system" | "direct" => Ok(()),
        "custom" => {
            let url = proxy.get("url").and_then(Value::as_str).unwrap_or("");
            parse_proxy_url(url).map(|_| ())
        }
        other => Err(format!("unknown networkProxy.mode '{other}'")),
    }
}

pub fn parse_proxy_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("proxy URL is required".into());
    }
    if trimmed.len() > PROXY_URL_MAX {
        return Err("proxy URL is too long".into());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("proxy URL must not contain whitespace".into());
    }
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err("proxy URL must include a scheme".into());
    };
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(
        scheme.as_str(),
        "http" | "https" | "socks" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return Err("proxy scheme must be http, https, or socks5".into());
    }
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let hostport = match hostport.rfind('@') {
        Some(at) => &hostport[at + 1..],
        None => hostport,
    };
    if hostport.is_empty() || hostport.starts_with(':') {
        return Err("proxy URL must include a host".into());
    }
    Ok(trimmed.to_string())
}

/// Extra curl arguments so marketplace downloads honor Custom/Direct without
/// mutating host-core process env (Bash must not inherit proxy credentials).
pub fn curl_proxy_args() -> Vec<String> {
    let mode = MARKET_PROXY
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    match mode {
        ProxyMode::System => Vec::new(),
        ProxyMode::Direct => vec!["--noproxy".into(), "*".into()],
        ProxyMode::Custom { url, bypass } => {
            let noproxy = bypass
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty() && *part != "<local>")
                .collect::<Vec<_>>()
                .join(",");
            let mut args = vec!["--proxy".into(), url];
            if !noproxy.is_empty() {
                args.push("--noproxy".into());
                args.push(noproxy);
            }
            args
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_accepts_http_and_socks5() {
        assert!(parse_proxy_url("http://127.0.0.1:7890").is_ok());
        assert!(parse_proxy_url("socks5://127.0.0.1:1080").is_ok());
        assert!(parse_proxy_url("ftp://127.0.0.1:1080").is_err());
        assert!(parse_proxy_url("http://").is_err());
        assert!(parse_proxy_url("socks5://127.0.0.1:1080 extra").is_err());
    }

    #[test]
    fn custom_mode_requires_url() {
        assert!(validate_network_proxy(&json!({
            "networkProxy": { "mode": "custom" }
        }))
        .is_err());
        assert!(validate_network_proxy(&json!({
            "networkProxy": { "mode": "custom", "url": "socks5://127.0.0.1:1080" }
        }))
        .is_ok());
        assert!(validate_network_proxy(&json!({
            "networkProxy": { "mode": "direct" }
        }))
        .is_ok());
    }

    #[test]
    fn curl_args_follow_applied_settings() {
        apply_from_settings(Some(&json!({
            "networkProxy": { "mode": "custom", "url": "socks5://127.0.0.1:1080" }
        })));
        let args = curl_proxy_args();
        assert_eq!(args[0], "--proxy");
        assert_eq!(args[1], "socks5://127.0.0.1:1080");
        assert!(args.contains(&"--noproxy".to_string()));

        apply_from_settings(Some(&json!({
            "networkProxy": { "mode": "direct" }
        })));
        assert_eq!(curl_proxy_args(), vec!["--noproxy", "*"]);

        apply_from_settings(Some(&json!({})));
        assert!(curl_proxy_args().is_empty());
    }
}
