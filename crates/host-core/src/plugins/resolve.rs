//! The plugin center's download interface.
//!
//! The platform says where a package is and never carries its bytes. One call
//! answers with the digest and every mirror that can serve the package; the
//! client picks one and verifies what it got.
//!
//! The resolve request is bounded so a slow platform cannot hold an install
//! open for a long time. Network failures, rate limits, and missing platform
//! mirrors use the freshly loaded catalog URL instead. Publication refusals
//! remain authoritative and are never bypassed.

use super::*;

/// The resolve endpoint answers only with metadata; keep it from blocking an
/// install longer than the catalog-backed download path needs to start.
const RESOLVE_TIMEOUT_SECONDS: &str = "3";

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
    resolve_once(&endpoint, &body)
}

/// One resolve request.
fn resolve_once(endpoint: &str, body: &str) -> Result<ResolvedDownload> {
    let (status, payload) = post_json(endpoint, body)?;
    if status != 200 {
        let error = refusal(status, &payload);
        return Err(error);
    }
    let resolved: ResolvedDownload = serde_json::from_slice(&payload).map_err(|error| {
        anyhow!("PLUGIN_MARKET_INVALID: the plugin center's answer is not readable: {error}")
    })?;
    if resolved.sha256.trim().is_empty() {
        return Err(anyhow!(
            "PLUGIN_MARKET_INVALID: the plugin center named no digest"
        ));
    }
    if resolved.downloads.is_empty() {
        return Err(anyhow!(
            "PLUGIN_MARKET_INVALID: the plugin center listed no download"
        ));
    }
    Ok(resolved)
}

/// Whether the catalog's package URL may safely answer a resolve failure.
///
/// A rate limit or missing platform mirror affects distribution metadata, not
/// the publication decision; the catalog package remains checksum-verified.
/// Explicit publication refusals and malformed responses stay authoritative.
pub(crate) fn allows_catalog_fallback(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    [
        "PLUGIN_NETWORK",
        "PLUGIN_MARKET_RATE_LIMITED",
        "PLUGIN_MARKET_NO_SOURCE",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
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
/// Answers with the status and response body. The body is written to a scratch
/// file and the status is read from `--write-out`, so an error answer still
/// yields the platform's error envelope instead of a curl diagnostic.
fn post_json(url: &str, body: &str) -> Result<(u16, Vec<u8>)> {
    let body_path = super::install::download_scratch_path();
    let response_path = super::install::download_scratch_path();
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
        "--write-out".into(),
        "%{http_code}".into(),
        "--max-time".into(),
        RESOLVE_TIMEOUT_SECONDS.into(),
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
            Ok((status, payload))
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
    fn publication_refusals_stay_authoritative_but_unavailable_resolve_uses_catalog() {
        let refused = refusal(
            403,
            br#"{"error":{"code":"NOT_PUBLISHED","message":"not yet"}}"#,
        );
        let text = refused.to_string();
        assert!(text.starts_with("PLUGIN_MARKET_NOT_PUBLISHED"), "{text}");
        assert!(!allows_catalog_fallback(&refused));

        let archived = refusal(403, br#"{"error":{"code":"PLUGIN_ARCHIVED"}}"#);
        assert!(archived.to_string().starts_with("PLUGIN_MARKET_ARCHIVED"));
        assert!(!allows_catalog_fallback(&archived));

        let missing = refusal(404, br#"{"error":{"code":"NOT_FOUND"}}"#);
        assert!(missing.to_string().starts_with("PLUGIN_MARKET_NOT_FOUND"));
        assert!(!allows_catalog_fallback(&missing));

        let limited = refusal(429, br#"{"error":{"code":"TOO_MANY_REQUESTS"}}"#);
        assert!(limited
            .to_string()
            .starts_with("PLUGIN_MARKET_RATE_LIMITED"));
        assert!(allows_catalog_fallback(&limited));

        let no_source = refusal(503, br#"{"error":{"code":"NO_DOWNLOAD_SOURCE"}}"#);
        assert!(no_source.to_string().starts_with("PLUGIN_MARKET_NO_SOURCE"));
        assert!(allows_catalog_fallback(&no_source));

        let down = refusal(502, b"<html>bad gateway</html>");
        assert!(down.to_string().starts_with("PLUGIN_NETWORK"), "{down}");
        assert!(allows_catalog_fallback(&down));

        // A body this client mangled is its own defect: falling back to the
        // catalog would install something the platform was never asked for.
        let mangled = refusal(400, br#"{"error":{"code":"BAD_BODY"}}"#);
        assert!(mangled.to_string().starts_with("PLUGIN_MARKET_INVALID"));
        assert!(!allows_catalog_fallback(&mangled));
    }

    #[test]
    fn resolve_metadata_request_has_a_three_second_deadline() {
        assert_eq!(RESOLVE_TIMEOUT_SECONDS, "3");
    }
}
