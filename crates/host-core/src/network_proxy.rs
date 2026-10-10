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
static SYSTEM_PROXY_RELAY: RwLock<Option<String>> = RwLock::new(None);

/// Mirrors `DEFAULT_NETWORK_PROXY_BYPASS` in `packages/shared`: loopback plus
/// the private ranges a user's own LAN devices live in, so a custom proxy never
/// swallows a local model server, NAS or MCP endpoint.
const DEFAULT_BYPASS: &str =
    "localhost,127.0.0.1,::1,<local>,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16";

pub fn apply_from_settings(value: Option<&Value>) {
    let next = proxy_from_settings(value);
    if let Ok(mut slot) = MARKET_PROXY.write() {
        *slot = next;
    }
}

/// Configure Electron's ephemeral, loopback-only system/PAC proxy relay.
/// This value is runtime-only and is never copied into host-core's environment.
pub fn set_system_proxy_relay(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.len() > PROXY_URL_MAX {
        return Err("system proxy relay URL is too long".into());
    }
    let Some((credentials, address)) = value.split_once('@') else {
        return Err("system proxy relay URL must contain local credentials".into());
    };
    let Some(token) = credentials.strip_prefix("socks5://system-auto:") else {
        return Err("system proxy relay must use the internal SOCKS5 route".into());
    };
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("system proxy relay credential is invalid".into());
    }
    let Some(port) = address.strip_prefix("127.0.0.1:") else {
        return Err("system proxy relay must bind to IPv4 loopback".into());
    };
    let port = port
        .parse::<u16>()
        .map_err(|_| "system proxy relay port is invalid")?;
    if port == 0 {
        return Err("system proxy relay port is invalid".into());
    }
    let mut slot = SYSTEM_PROXY_RELAY
        .write()
        .map_err(|_| "system proxy relay state unavailable")?;
    *slot = Some(value.to_string());
    Ok(())
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

/// Extra curl arguments so marketplace downloads honor the selected route
/// without mutating host-core process env (Bash must not inherit credentials).
pub fn curl_proxy_args() -> Vec<String> {
    let mode = MARKET_PROXY
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    match mode {
        ProxyMode::System => SYSTEM_PROXY_RELAY
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .map(|url| vec!["--proxy".into(), url.replacen("socks5://", "socks5h://", 1)])
            .unwrap_or_default(),
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

/// Keep Windows Schannel downloads working when a revocation distribution
/// point is offline, while retaining normal certificate verification. Older
/// curl versions used best-effort revocation checks by default; newer ones
/// expose this flag explicitly.
#[cfg(windows)]
pub(crate) fn curl_tls_args() -> Vec<String> {
    let (version, help) = curl_version_and_help();
    curl_tls_args_for(&version, &help)
}

#[cfg(not(windows))]
pub(crate) fn curl_tls_args() -> Vec<String> {
    Vec::new()
}

#[cfg(any(windows, test))]
fn curl_tls_args_for(version: &[u8], help: &[u8]) -> Vec<String> {
    let version = String::from_utf8_lossy(version).to_ascii_lowercase();
    let option = b"--ssl-revoke-best-effort";
    let supported = help.windows(option.len()).any(|window| window == option);
    if version.contains("schannel") && supported {
        vec![String::from_utf8_lossy(option).into_owned()]
    } else {
        Vec::new()
    }
}

#[cfg(windows)]
fn curl_version_and_help() -> (Vec<u8>, Vec<u8>) {
    use std::process::Command;
    use std::sync::OnceLock;

    static CURL_TLS_ARGS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    CURL_TLS_ARGS
        .get_or_init(|| {
            let version = Command::new("curl")
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| output.stdout)
                .unwrap_or_default();
            let help = Command::new("curl")
                .args(["--help", "all"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| output.stdout)
                .unwrap_or_default();
            (version, help)
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    static TEST_STATE_LOCK: Mutex<()> = Mutex::new(());

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
        let _guard = TEST_STATE_LOCK.lock().unwrap();
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

    #[test]
    fn system_relay_requires_authenticated_loopback_and_routes_curl() {
        let _guard = TEST_STATE_LOCK.lock().unwrap();
        let token = "a".repeat(64);
        let relay_url = format!("socks5://system-auto:{token}@127.0.0.1:43210");

        for invalid in [
            "socks5://system-http:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@127.0.0.1:43210",
            "socks5://system-auto:short@127.0.0.1:43210",
            "socks5://system-auto:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@0.0.0.0:43210",
            "socks5://system-auto:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@127.0.0.1:0",
        ] {
            assert!(set_system_proxy_relay(invalid).is_err());
        }

        set_system_proxy_relay(&relay_url).unwrap();
        apply_from_settings(Some(&json!({})));
        let args = curl_proxy_args();
        if let Ok(mut relay) = SYSTEM_PROXY_RELAY.write() {
            *relay = None;
        }

        assert_eq!(
            args,
            vec![
                "--proxy".to_string(),
                format!("socks5h://system-auto:{token}@127.0.0.1:43210")
            ]
        );
    }

    #[test]
    fn curl_tls_args_only_use_supported_schannel_best_effort_revocation() {
        let option = b"--ssl-revoke-best-effort";
        assert_eq!(
            curl_tls_args_for(b"curl 8.13.0 Schannel", option),
            vec!["--ssl-revoke-best-effort"]
        );
        assert!(curl_tls_args_for(b"curl 8.13.0 OpenSSL", option).is_empty());
        assert!(curl_tls_args_for(b"curl 7.55.1 Schannel", b"--ssl-no-revoke").is_empty());
    }
}
