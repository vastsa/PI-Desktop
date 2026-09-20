//! The plugin center's download interface.
//!
//! The platform says where a package is and never carries its bytes. One call
//! answers with the digest and every mirror that can serve the package; the
//! client picks one and verifies what it got.
//!
//! Two kinds of failure are worth telling apart, because the caller answers
//! them differently: a platform that could not be *reached* is covered by the
//! catalog's own URL (the platform's contract says so explicitly), while a
//! platform that *answered* has an opinion — not published, archived, unknown,
//! rate limited — and papering over it would install something it is not
//! offering.

use super::*;

/// One place a package can be fetched from.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ResolvedMirror {
    #[serde(default)]
    pub source: String,
    pub url: String,
}

/// Where a package can be fetched from, and the digest to check it against.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedDownload {
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub downloads: Vec<ResolvedMirror>,
}

/// Resolve endpoint for a catalog URL.
///
/// Built from the catalog's own origin, so the request cannot leave the host
/// the catalog came from. A non-http(s) catalog — a local file a test or a
/// developer pointed the environment override at — has no endpoint.
pub(crate) fn endpoint_for(catalog_url: &str) -> Option<String> {
    let (scheme, rest) = catalog_url.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // Credentials in the authority would make the request authenticate against
    // a host the user never chose.
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some(format!("{scheme}://{authority}/api/v1/download/resolve"))
}

/// Ask the platform where a package is.
pub(crate) fn request(
    catalog_url: &str,
    device_id: &str,
    plugin_id: &str,
    version: &str,
) -> Result<ResolvedDownload> {
    let endpoint = endpoint_for(catalog_url)
        .ok_or_else(|| anyhow!("PLUGIN_NETWORK: {catalog_url} is not an http(s) catalog"))?;
    let body = json!({
        "deviceId": device_id,
        "pluginId": plugin_id,
        "version": version,
    })
    .to_string();
    match resolve_once(&endpoint, &body) {
        Ok(resolved) => Ok(resolved),
        Err(Attempt::Failed(error)) => Err(error),
        // The platform answers a caller that asks too often with the interval
        // to wait. One retry is what its contract describes, and a longer loop
        // would be the broken client the limit exists to catch.
        Err(Attempt::RateLimited { wait, .. }) => {
            std::thread::sleep(wait);
            match resolve_once(&endpoint, &body) {
                Ok(resolved) => Ok(resolved),
                Err(Attempt::Failed(error)) | Err(Attempt::RateLimited { error, .. }) => Err(error),
            }
        }
    }
}

/// What one resolve attempt produced.
enum Attempt {
    /// The platform could not answer, or answered something unusable.
    Failed(anyhow::Error),
    /// It answered `429` and named how long to wait.
    RateLimited {
        error: anyhow::Error,
        wait: Duration,
    },
}

/// One resolve request.
fn resolve_once(endpoint: &str, body: &str) -> std::result::Result<ResolvedDownload, Attempt> {
    let (status, payload, headers) = post_json(endpoint, body).map_err(Attempt::Failed)?;
    if status != 200 {
        let error = refusal(status, &payload);
        if status == 429 {
            return Err(Attempt::RateLimited {
                error,
                wait: retry_after(&headers).unwrap_or(Duration::from_secs(1)),
            });
        }
        return Err(Attempt::Failed(error));
    }
    let resolved: ResolvedDownload = serde_json::from_slice(&payload).map_err(|error| {
        Attempt::Failed(anyhow!(
            "PLUGIN_MARKET_INVALID: the plugin center's answer is not readable: {error}"
        ))
    })?;
    if resolved.sha256.trim().is_empty() {
        return Err(Attempt::Failed(anyhow!(
            "PLUGIN_MARKET_INVALID: the plugin center named no digest"
        )));
    }
    if resolved.downloads.is_empty() {
        return Err(Attempt::Failed(anyhow!(
            "PLUGIN_MARKET_INVALID: the plugin center listed no download"
        )));
    }
    Ok(resolved)
}

/// Seconds the platform asked the caller to wait, when it said so.
///
/// Clamped: a deployment may name a longer interval than an install should
/// block on, and the platform's own default is sixty seconds.
fn retry_after(headers: &str) -> Option<Duration> {
    let value = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("retry-after")
            .then(|| value.trim())
    })?;
    let seconds: u64 = value.parse().ok()?;
    Some(Duration::from_secs(seconds.clamp(1, 60)))
}

/// Whether a resolve failure is one the catalog's own URL may answer.
///
/// Only a transport failure or an unavailable deployment: those are the cases
/// the platform's contract covers with "install from the catalog's URL". Every
/// refusal keeps its own error so the surface can say what happened.
pub(crate) fn is_recoverable(error: &anyhow::Error) -> bool {
    error.to_string().starts_with("PLUGIN_NETWORK")
}

/// The error a non-2xx answer becomes.
fn refusal(status: u16, payload: &[u8]) -> anyhow::Error {
    let envelope: Option<Value> = serde_json::from_slice(payload).ok();
    let error = envelope.as_ref().and_then(|value| value.get("error"));
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("no reason given");
    let prefix = match code {
        "NOT_PUBLISHED" => "PLUGIN_MARKET_NOT_PUBLISHED",
        "PLUGIN_ARCHIVED" => "PLUGIN_MARKET_ARCHIVED",
        "NOT_FOUND" => "PLUGIN_MARKET_NOT_FOUND",
        "TOO_MANY_REQUESTS" => "PLUGIN_MARKET_RATE_LIMITED",
        "NO_DOWNLOAD_SOURCE" => "PLUGIN_MARKET_NO_SOURCE",
        "PLUGIN_REQUIRED" | "BAD_REQUEST" | "BAD_BODY" | "METHOD" => "PLUGIN_MARKET_INVALID",
        // Anything else is a deployment that could not answer, which the
        // catalog's own URL is allowed to cover.
        _ => "PLUGIN_NETWORK",
    };
    anyhow!("{prefix}: the plugin center answered {status}: {message}")
}

/// POST a JSON body with curl.
///
/// Answers with the status, the response body and the response headers: the
/// body carries the platform's error envelope, and the headers carry the
/// interval a rate-limited caller is asked to wait. The body is written to a
/// scratch file and the status is read from `--write-out`, so an error answer
/// still yields the envelope instead of a curl diagnostic.
fn post_json(url: &str, body: &str) -> Result<(u16, Vec<u8>, String)> {
    let body_path = super::install::download_scratch_path();
    let response_path = super::install::download_scratch_path();
    let headers_path = super::install::download_scratch_path();
    fs::write(&body_path, body).with_context(|| format!("write resolve body for {url}"))?;

    let mut args: Vec<String> = vec![
        "--silent".into(),
        "--show-error".into(),
        "--request".into(),
        "POST".into(),
        "--header".into(),
        "Content-Type: application/json".into(),
        "--header".into(),
        "Accept: application/json".into(),
        "--data-binary".into(),
        format!("@{}", body_path.to_string_lossy()),
        "--output".into(),
        response_path.to_string_lossy().into_owned(),
        // The retry interval arrives in a header, so the headers are kept.
        "--dump-header".into(),
        headers_path.to_string_lossy().into_owned(),
        "--write-out".into(),
        "%{http_code}".into(),
        "--max-time".into(),
        "30".into(),
        "--max-redirs".into(),
        "3".into(),
        "--location".into(),
        // Keep a redirect a POST: curl otherwise re-sends it as a GET, which the
        // endpoint does answer but which would drop the body it reads.
        "--post301".into(),
        "--post302".into(),
        "--post303".into(),
        "--user-agent".into(),
        "pi-desktop-host-core".into(),
    ];
    args.extend(crate::network_proxy::curl_proxy_args());
    if url.starts_with("https://") {
        args.push("--proto".into());
        args.push("=https".into());
        args.push("--proto-redir".into());
        args.push("=https".into());
    }
    args.push(url.to_string());

    let outcome = std::process::Command::new("curl").args(&args).output();
    let result = match outcome {
        Ok(output) if output.status.success() => {
            let status = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u16>()
                .unwrap_or(0);
            let payload = fs::read(&response_path).unwrap_or_default();
            let headers = fs::read_to_string(&headers_path).unwrap_or_default();
            Ok((status, payload, headers))
        }
        Ok(output) => {
            let err = decode_curl_output(&output.stderr);
            Err(anyhow!(
                "PLUGIN_NETWORK: resolve request failed for {url}: {err}"
            ))
        }
        Err(error) => Err(anyhow!(
            "PLUGIN_NETWORK: curl is required to reach the plugin center: {error}"
        )),
    };
    let _ = fs::remove_file(&body_path);
    let _ = fs::remove_file(&response_path);
    let _ = fs::remove_file(&headers_path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_keeps_the_catalogs_origin() {
        assert_eq!(
            endpoint_for("https://plugins.aiuo.net/catalog.json").as_deref(),
            Some("https://plugins.aiuo.net/api/v1/download/resolve")
        );
        assert_eq!(
            endpoint_for("http://127.0.0.1:8787/catalog.json").as_deref(),
            Some("http://127.0.0.1:8787/api/v1/download/resolve"),
            "a development deployment on a port keeps it"
        );
        assert_eq!(endpoint_for("file:///tmp/catalog.json"), None);
        assert_eq!(
            endpoint_for("https://user:secret@plugins.aiuo.net/catalog.json"),
            None,
            "a catalog url carrying credentials is not one to send a device id to"
        );
    }

    #[test]
    fn a_refusal_is_not_recoverable_and_a_dead_deployment_is() {
        let refused = refusal(
            403,
            br#"{"error":{"code":"NOT_PUBLISHED","message":"not yet"}}"#,
        );
        let text = refused.to_string();
        assert!(text.starts_with("PLUGIN_MARKET_NOT_PUBLISHED"), "{text}");
        assert!(!is_recoverable(&refused));

        let archived = refusal(403, br#"{"error":{"code":"PLUGIN_ARCHIVED"}}"#);
        assert!(archived.to_string().starts_with("PLUGIN_MARKET_ARCHIVED"));

        let limited = refusal(429, br#"{"error":{"code":"TOO_MANY_REQUESTS"}}"#);
        assert!(limited
            .to_string()
            .starts_with("PLUGIN_MARKET_RATE_LIMITED"));

        let no_source = refusal(503, br#"{"error":{"code":"NO_DOWNLOAD_SOURCE"}}"#);
        assert!(no_source.to_string().starts_with("PLUGIN_MARKET_NO_SOURCE"));

        let down = refusal(502, b"<html>bad gateway</html>");
        assert!(down.to_string().starts_with("PLUGIN_NETWORK"), "{down}");
        assert!(is_recoverable(&down));

        // A body this client mangled is its own defect: falling back to the
        // catalog would install something the platform was never asked for.
        let mangled = refusal(400, br#"{"error":{"code":"BAD_BODY"}}"#);
        assert!(mangled.to_string().starts_with("PLUGIN_MARKET_INVALID"));
        assert!(!is_recoverable(&mangled));
    }

    #[test]
    fn a_rate_limit_waits_what_the_platform_asked_for() {
        let headers = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 12\r\n\r\n";
        assert_eq!(retry_after(headers), Some(Duration::from_secs(12)));
        // The header name is case-insensitive and the value may carry spaces.
        assert_eq!(
            retry_after("retry-after:   7  \r\n"),
            Some(Duration::from_secs(7))
        );
        // A deployment may ask for longer than an install should block on.
        assert_eq!(
            retry_after("Retry-After: 600\r\n"),
            Some(Duration::from_secs(60))
        );
        // No header, or one that is not a number of seconds: wait the minimum.
        assert_eq!(retry_after("HTTP/1.1 429\r\n\r\n"), None);
        assert_eq!(retry_after("Retry-After: soon\r\n"), None);
    }
}
