use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::{Client, Method, StatusCode, Url};
use std::net::IpAddr;
use uuid::Uuid;

const MAX_REMOTE_OBJECT_BYTES: usize = 64 * 1024 * 1024;
const MAX_REMOTE_LIST_ENTRIES: usize = 4096;

#[derive(Debug, Clone)]
pub struct WebDavConfig {
    pub endpoint: String,
    pub username: String,
    pub password: String,
    pub directory: String,
    /// Whether the network policy in force allows a plaintext hop to a WebDAV
    /// endpoint. This is no longer the per-endpoint acknowledgement the sync
    /// settings used to carry: callers pass `crate::network_policy::relaxed()`,
    /// so `strict` refuses `http` outright while `relaxed` keeps it for a
    /// loopback, `.local` or private LAN host. A public `http` host is refused
    /// in either mode.
    pub allow_insecure_http: bool,
    pub missing_object_status: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub conditional_writes: bool,
    pub append_only: bool,
    pub missing_object_status: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct WebDavTransport {
    client: Client,
    base: Url,
    username: String,
    password: String,
    directory: String,
    missing_object_status: Option<StatusCode>,
}

fn validate_relative_directory(value: &str) -> Result<String> {
    let trimmed = value.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') {
            bail!("CONFIG_SYNC_INVALID: remote directory contains an unsafe path segment");
        }
        if part.len() > 128
            || !part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        {
            bail!("CONFIG_SYNC_INVALID: remote directory contains an unsupported character");
        }
        parts.push(part.to_string());
    }
    Ok(parts.join("/"))
}

fn is_lan_http_host(host: &str) -> bool {
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "localhost.localdomain") || host.ends_with(".local") {
        return true;
    }

    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            let octets = address.octets();
            address.is_loopback()
                || address.is_link_local()
                || octets[0] == 10
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
        }
        Ok(IpAddr::V6(address)) => {
            let segments = address.segments();
            address.is_loopback()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

/// Validate a WebDAV endpoint and return the base URL to address.
///
/// `allow_insecure_http` is the network policy's answer, so a plaintext `http`
/// endpoint is refused unless the relaxed mode asked for it *and* the host is
/// the user's own LAN. Public `http` stays refused in every mode: the request
/// would carry the WebDAV credentials in the clear across the internet.
fn validate_endpoint(raw: &str, allow_insecure_http: bool) -> Result<Url> {
    let mut url = Url::parse(raw.trim()).context("parse WebDAV endpoint")?;
    if !matches!(url.scheme(), "https" | "http") {
        bail!("CONFIG_SYNC_INVALID: WebDAV endpoint must use HTTPS");
    }
    if url.scheme() == "http" && !allow_insecure_http {
        bail!("CONFIG_SYNC_INVALID: HTTP requires the relaxed network policy");
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        bail!("CONFIG_SYNC_INVALID: endpoint must not contain userinfo");
    }
    if url.scheme() == "http" && !is_lan_http_host(url.host_str().unwrap_or_default()) {
        bail!(
            "CONFIG_SYNC_INVALID: HTTP is limited to localhost, .local, or private LAN addresses"
        );
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{path}/"));
    Ok(url)
}

impl WebDavTransport {
    pub fn new(config: &WebDavConfig) -> Result<Self> {
        let base = validate_endpoint(&config.endpoint, config.allow_insecure_http)?;
        let directory = validate_relative_directory(&config.directory)?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(false)
            .build()
            .context("build WebDAV client")?;
        Ok(Self {
            client,
            base,
            username: config.username.trim().to_string(),
            password: config.password.clone(),
            directory,
            missing_object_status: compatible_missing_object_status(config.missing_object_status),
        })
    }

    pub fn with_probe_result(mut self, probe: &ProbeResult) -> Self {
        self.missing_object_status = compatible_missing_object_status(probe.missing_object_status);
        self
    }

    fn url(&self, relative: &str) -> Result<Url> {
        if relative.is_empty() || relative.starts_with('/') || relative.contains("..") {
            bail!("CONFIG_SYNC_INVALID: unsafe remote object path");
        }
        let prefix = if self.directory.is_empty() {
            String::new()
        } else {
            format!("{}/", self.directory)
        };
        self.base
            .join(&format!("{prefix}{relative}"))
            .context("resolve WebDAV object URL")
    }

    fn authenticated(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.username.is_empty() {
            request
        } else {
            request.basic_auth(&self.username, Some(&self.password))
        }
    }

    async fn send(
        &self,
        method: Method,
        relative: &str,
        body: Option<Vec<u8>>,
        headers: HeaderMap,
    ) -> Result<reqwest::Response> {
        self.send_url(method, self.url(relative)?, body, headers)
            .await
    }

    async fn send_url(
        &self,
        method: Method,
        url: Url,
        body: Option<Vec<u8>>,
        headers: HeaderMap,
    ) -> Result<reqwest::Response> {
        let mut request = self.client.request(method, url).headers(headers);
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = self
            .authenticated(request)
            .send()
            .await
            .map_err(request_error)?;
        // A 201 often carries Location. Only a 3xx is a redirect, and the
        // client is built not to follow one.
        if response.status().is_redirection() {
            bail!(
                "CONFIG_SYNC_REDIRECT: use the direct WebDAV endpoint; redirects are not followed"
            );
        }
        Ok(response)
    }

    /// Create every missing collection from the selected endpoint down to
    /// `relative`. A nested remote directory such as `backups/pi` otherwise
    /// fails because its parent does not exist yet. Ancestors outside the
    /// endpoint are never created.
    pub async fn ensure_collection(&self, relative: &str) -> Result<()> {
        let target = self.url(relative)?;
        let base_path = self.base.path().trim_end_matches('/');
        let suffix = target
            .path()
            .trim_end_matches('/')
            .strip_prefix(base_path)
            .ok_or_else(|| anyhow::anyhow!("CONFIG_SYNC_INVALID: collection escaped endpoint"))?;
        let mut path = base_path.to_string();
        for segment in suffix.split('/').filter(|segment| !segment.is_empty()) {
            path.push('/');
            path.push_str(segment);
            let mut url = self.base.clone();
            url.set_path(&path);
            let response = self
                .send_url(
                    Method::from_bytes(b"MKCOL").expect("MKCOL is a valid method"),
                    url,
                    None,
                    HeaderMap::new(),
                )
                .await?;
            match response.status() {
                status
                    if status.is_success()
                        || status == StatusCode::METHOD_NOT_ALLOWED
                        || status == StatusCode::PRECONDITION_FAILED => {}
                status => return Err(status_error("collection create", status)),
            }
        }
        Ok(())
    }

    async fn limited_bytes(response: reqwest::Response) -> Result<Vec<u8>> {
        if response
            .content_length()
            .is_some_and(|length| length > MAX_REMOTE_OBJECT_BYTES as u64)
        {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote object is too large");
        }
        let mut response = response;
        let mut result = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            if result.len().saturating_add(chunk.len()) > MAX_REMOTE_OBJECT_BYTES {
                bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote object is too large");
            }
            result.extend_from_slice(&chunk);
        }
        Ok(result)
    }

    pub async fn get(&self, relative: &str) -> Result<Option<(Vec<u8>, Option<String>)>> {
        let response = self
            .send(Method::GET, relative, None, HeaderMap::new())
            .await?;
        if response.status() == StatusCode::NOT_FOUND
            || self.missing_object_status == Some(response.status())
        {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(status_error("GET", response.status()));
        }
        let etag = strong_etag(response.headers());
        Ok(Some((Self::limited_bytes(response).await?, etag)))
    }

    pub async fn put_unconditional(&self, relative: &str, body: Vec<u8>) -> Result<()> {
        let response = self
            .send(Method::PUT, relative, Some(body), HeaderMap::new())
            .await?;
        if !response.status().is_success() {
            return Err(status_error("unconditional write", response.status()));
        }
        Ok(())
    }

    /// List direct children of a WebDAV collection. Append-only compatibility
    /// mode uses this to discover per-device heads without overwriting a
    /// shared mutable head. The returned names are intentionally opaque; the
    /// caller validates them against its domain-specific identifier rules.
    pub async fn list_children(&self, relative: &str) -> Result<Vec<String>> {
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::HeaderName::from_static("depth"),
            HeaderValue::from_static("1"),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/xml; charset=utf-8"),
        );
        let body = br#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>"#
            .to_vec();
        let response = self
            .send(
                Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method"),
                relative,
                Some(body),
                headers,
            )
            .await?;
        if response.status().as_u16() == 405 || response.status().as_u16() == 501 {
            bail!("CONFIG_SYNC_UNSUPPORTED: WebDAV directory listing is not supported");
        }
        if response.status().as_u16() != 207 && !response.status().is_success() {
            return Err(status_error("directory listing", response.status()));
        }
        let body = Self::limited_bytes(response).await?;
        let text = String::from_utf8(body).context("decode WebDAV directory listing")?;
        let collection_url = self.url(relative)?;
        let collection_path = collection_url.path().trim_end_matches('/').to_string();
        let collection_origin = (
            collection_url.scheme().to_string(),
            collection_url.host_str().map(str::to_string),
            collection_url.port_or_known_default(),
        );
        let hrefs = regex::Regex::new(
            r"(?is)<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?href[^>]*>(.*?)</(?:[A-Za-z_][A-Za-z0-9_.-]*:)?href\s*>",
        )
        .expect("static WebDAV href expression")
        .captures_iter(&text)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().trim()))
        .map(xml_unescape)
        .filter_map(|href| {
            let href = href
                .split(['?', '#'])
                .next()
                .unwrap_or(&href);
            let href_url = self.base.join(href).ok()?;
            let href_origin = (
                href_url.scheme().to_string(),
                href_url.host_str().map(str::to_string),
                href_url.port_or_known_default(),
            );
            if href_origin != collection_origin {
                return None;
            }
            let child_path = href_url.path().trim_end_matches('/');
            let prefix = format!("{collection_path}/");
            let name = child_path.strip_prefix(&prefix)?;
            (!name.is_empty() && !name.contains('/')).then(|| name.to_string())
        })
        .take(MAX_REMOTE_LIST_ENTRIES + 1)
        .collect::<Vec<_>>();
        if hrefs.len() > MAX_REMOTE_LIST_ENTRIES {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: WebDAV directory has too many entries");
        }
        Ok(hrefs)
    }

    pub async fn put_if_none(&self, relative: &str, body: Vec<u8>) -> Result<bool> {
        let mut headers = HeaderMap::new();
        headers.insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
        let response = self
            .send(Method::PUT, relative, Some(body), headers)
            .await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED => Ok(false),
            status if status.is_success() => Ok(true),
            status => return Err(status_error("create", status)),
        }
    }

    pub async fn put_if_match(&self, relative: &str, etag: &str, body: Vec<u8>) -> Result<bool> {
        let mut headers = HeaderMap::new();
        headers.insert(
            IF_MATCH,
            HeaderValue::from_str(etag).context("invalid WebDAV ETag")?,
        );
        let response = self
            .send(Method::PUT, relative, Some(body), headers)
            .await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED => Ok(false),
            status if status.is_success() => Ok(true),
            status => return Err(status_error("conditional write", status)),
        }
    }

    pub async fn delete(&self, relative: &str) -> Result<()> {
        let response = self
            .send(Method::DELETE, relative, None, HeaderMap::new())
            .await?;
        if response.status() != StatusCode::NOT_FOUND && !response.status().is_success() {
            return Err(status_error("delete", response.status()));
        }
        Ok(())
    }

    pub async fn probe(&self) -> Result<ProbeResult> {
        self.ensure_collection(".probe").await?;
        let probe = format!(".probe/{}", Uuid::new_v4());
        let first_body = b"pi-desktop-config-sync-probe".to_vec();
        let second_body = b"pi-desktop-config-sync-probe-2".to_vec();
        let first = self.put_if_none(&probe, first_body.clone()).await?;
        if !first {
            bail!("CONFIG_SYNC_REMOTE: probe object unexpectedly existed");
        }
        let second = self.put_if_none(&probe, second_body.clone()).await?;
        let (strong_etag, readable) = self
            .get(&probe)
            .await?
            .map(|(bytes, etag)| (etag, bytes == first_body))
            .unwrap_or((None, false));
        let matched_update = if let Some(etag) = strong_etag.as_deref() {
            self.put_if_match(&probe, etag, second_body.clone())
                .await
                .unwrap_or(false)
        } else {
            false
        };
        let stale_rejected = if matched_update {
            if let Some(etag) = strong_etag.as_deref() {
                match self
                    .put_if_match(&probe, etag, b"pi-desktop-config-sync-stale".to_vec())
                    .await
                {
                    Ok(accepted) => !accepted,
                    Err(_) => false,
                }
            } else {
                false
            }
        } else {
            false
        };
        let updated_readable = self
            .get(&probe)
            .await?
            .is_some_and(|(bytes, _)| bytes == second_body);
        let probe_name = probe.rsplit('/').next().unwrap_or_default();
        let append_only = match self.list_children(".probe").await {
            Ok(children) => children.iter().any(|child| child == probe_name),
            Err(error) if error.to_string().starts_with("CONFIG_SYNC_UNSUPPORTED") => false,
            Err(error) => return Err(error),
        };
        self.delete(&probe).await?;
        let missing_object_status = match self
            .send(Method::GET, &probe, None, HeaderMap::new())
            .await?
            .status()
        {
            StatusCode::BAD_GATEWAY => Some(StatusCode::BAD_GATEWAY.as_u16()),
            _ => None,
        };
        Ok(ProbeResult {
            conditional_writes: !second
                && readable
                && matched_update
                && stale_rejected
                && updated_readable,
            append_only,
            missing_object_status,
        })
    }
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn strong_etag(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(ETAG)?.to_str().ok()?.trim();
    if value.is_empty() || value.starts_with("W/") {
        return None;
    }
    Some(value.to_string())
}

fn compatible_missing_object_status(value: Option<u16>) -> Option<StatusCode> {
    (value == Some(StatusCode::BAD_GATEWAY.as_u16())).then_some(StatusCode::BAD_GATEWAY)
}

fn request_error(error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow::anyhow!("CONFIG_SYNC_TIMEOUT: WebDAV request timed out")
    } else {
        anyhow::anyhow!(
            "CONFIG_SYNC_NETWORK: WebDAV connection failed; check the network and TLS certificate"
        )
    }
}

fn status_error(operation: &str, status: StatusCode) -> anyhow::Error {
    let code = match status.as_u16() {
        401 => "AUTH",
        403 => "PERMISSION",
        404 => "NOT_FOUND",
        409 | 423 => "CONFLICT",
        413 | 507 => "QUOTA",
        429 => "RATE_LIMIT",
        500..=599 => "SERVER",
        _ => "REMOTE",
    };
    anyhow::anyhow!("CONFIG_SYNC_{code}: WebDAV {operation} returned {status}")
}

pub fn remote_error_is_offline(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_lowercase();
    [
        "config_sync_network:",
        "config_sync_timeout:",
        "config_sync_server:",
        "config_sync_rate_limit:",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
        || text.contains("request failed")
        || text.contains("timed out")
        || text.contains("dns")
        || text.contains("connect")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashMap, HashSet};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Default)]
    struct FixtureState {
        objects: HashMap<String, Vec<u8>>,
        etags: HashMap<String, u64>,
        collections: HashSet<String>,
        next_etag: u64,
        weak_etag: bool,
        missing_status: Option<u16>,
        ignore_preconditions: bool,
        require_parent: bool,
    }

    async fn read_request(stream: &mut TcpStream) -> Option<(String, String, HeaderMap, Vec<u8>)> {
        let mut buffer = Vec::new();
        let header_end;
        loop {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(index) = buffer.windows(4).position(|value| value == b"\r\n\r\n") {
                header_end = index + 4;
                break;
            }
            if buffer.len() > 1024 * 1024 {
                return None;
            }
        }
        let header_text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
        let mut lines = header_text.split("\r\n");
        let request = lines.next()?.split_whitespace().collect::<Vec<_>>();
        if request.len() < 2 {
            return None;
        }
        let mut headers = HeaderMap::new();
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let name = reqwest::header::HeaderName::from_bytes(name.trim().as_bytes()).ok()?;
            let value = HeaderValue::from_str(value.trim()).ok()?;
            headers.insert(name, value);
        }
        let content_length = headers
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        while buffer.len() < header_end + content_length {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
        Some((
            request[0].to_string(),
            request[1].to_string(),
            headers,
            buffer[header_end..header_end + content_length].to_vec(),
        ))
    }

    async fn write_response(
        stream: &mut TcpStream,
        status: u16,
        headers: &[(&str, String)],
        body: &[u8],
    ) {
        let reason = match status {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            207 => "Multi-Status",
            404 => "Not Found",
            405 => "Method Not Allowed",
            412 => "Precondition Failed",
            502 => "Bad Gateway",
            _ => "Bad Request",
        };
        let mut response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str("\r\n");
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.write_all(body).await;
    }

    async fn handle_fixture_connection(mut stream: TcpStream, state: Arc<Mutex<FixtureState>>) {
        let Some((method, target, headers, body)) = read_request(&mut stream).await else {
            return;
        };
        let path = target.split('?').next().unwrap_or(&target).to_string();
        let response = {
            let mut state = state.lock().expect("fixture state");
            match method.as_str() {
                "MKCOL" => {
                    let normalized = path.trim_end_matches('/').to_string();
                    if state.require_parent {
                        let parent = normalized
                            .rsplit_once('/')
                            .map(|(parent, _)| parent)
                            .unwrap_or("");
                        if !parent.is_empty() && !state.collections.contains(parent) {
                            (409, Vec::new(), None)
                        } else if state.collections.insert(normalized) {
                            (201, Vec::new(), None)
                        } else {
                            (405, Vec::new(), None)
                        }
                    } else if state.collections.insert(path) {
                        (201, Vec::new(), None)
                    } else {
                        (405, Vec::new(), None)
                    }
                }
                "GET" => {
                    if let Some(value) = state.objects.get(&path) {
                        let etag = state.etags.get(&path).copied().unwrap_or_default();
                        let etag = if state.weak_etag {
                            format!("W/\"{etag}\"")
                        } else {
                            format!("\"{etag}\"")
                        };
                        (200, value.clone(), Some(etag))
                    } else if let Some(status) = state.missing_status {
                        (status, Vec::new(), None)
                    } else {
                        (404, Vec::new(), None)
                    }
                }
                "PROPFIND" => {
                    let collection = path.trim_end_matches('/');
                    if !state.collections.contains(collection) {
                        (404, Vec::new(), None)
                    } else {
                        let prefix = format!("{collection}/");
                        let mut entries = BTreeSet::new();
                        entries.insert(format!("{collection}/"));
                        for candidate in state
                            .collections
                            .iter()
                            .map(String::as_str)
                            .chain(state.objects.keys().map(String::as_str))
                        {
                            let Some(child) = candidate.strip_prefix(&prefix) else {
                                continue;
                            };
                            if !child.is_empty() && !child.contains('/') {
                                entries.insert(candidate.to_string());
                            }
                        }
                        let mut xml = String::from(
                            r#"<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">"#,
                        );
                        for entry in entries {
                            xml.push_str(&format!(
                                "<D:response><D:href>{entry}</D:href></D:response>"
                            ));
                        }
                        xml.push_str("</D:multistatus>");
                        (207, xml.into_bytes(), None)
                    }
                }
                "PUT" => {
                    let existing = state.objects.contains_key(&path);
                    let none_match = headers
                        .get(IF_NONE_MATCH)
                        .and_then(|value| value.to_str().ok())
                        .is_some_and(|value| value == "*");
                    let match_ok = headers
                        .get(IF_MATCH)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.trim_matches('"').parse::<u64>().ok())
                        .is_some_and(|expected| state.etags.get(&path) == Some(&expected));
                    if !state.ignore_preconditions
                        && ((none_match && existing)
                            || (headers.contains_key(IF_MATCH) && !match_ok))
                    {
                        (412, Vec::new(), None)
                    } else {
                        state.next_etag = state.next_etag.saturating_add(1);
                        let etag = state.next_etag;
                        state.objects.insert(path.clone(), body);
                        state.etags.insert(path, etag);
                        (201, Vec::new(), None)
                    }
                }
                "DELETE" => {
                    state.objects.remove(&path);
                    state.etags.remove(&path);
                    (204, Vec::new(), None)
                }
                _ => (400, Vec::new(), None),
            }
        };
        let response_headers = response
            .2
            .into_iter()
            .map(|etag| ("ETag", etag))
            .collect::<Vec<_>>();
        write_response(&mut stream, response.0, &response_headers, &response.1).await;
    }

    pub(crate) struct Fixture {
        pub(crate) endpoint: String,
        pub(crate) task: tokio::task::JoinHandle<()>,
    }

    pub(crate) async fn fixture(weak_etag: bool) -> Fixture {
        fixture_with_options(weak_etag, None, false, false).await
    }

    pub(crate) async fn fixture_ignoring_preconditions() -> Fixture {
        fixture_with_options(false, None, true, false).await
    }

    async fn fixture_with_options(
        weak_etag: bool,
        missing_status: Option<u16>,
        ignore_preconditions: bool,
        require_parent: bool,
    ) -> Fixture {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture");
        let address = listener.local_addr().expect("fixture address");
        let state = Arc::new(Mutex::new(FixtureState {
            weak_etag,
            missing_status,
            ignore_preconditions,
            require_parent,
            ..FixtureState::default()
        }));
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(handle_fixture_connection(stream, state.clone()));
            }
        });
        Fixture {
            endpoint: format!("http://{address}/"),
            task,
        }
    }

    fn fixture_transport(endpoint: &str) -> WebDavTransport {
        WebDavTransport::new(&WebDavConfig {
            endpoint: endpoint.to_string(),
            username: String::new(),
            password: String::new(),
            directory: "vault".into(),
            allow_insecure_http: true,
            missing_object_status: None,
        })
        .expect("transport")
    }

    #[test]
    fn endpoint_requires_https_unless_explicitly_acknowledged_for_lan_hosts() {
        assert!(validate_endpoint("http://192.168.1.10/root", false).is_err());
        assert!(validate_endpoint("http://192.168.1.10/root", true).is_ok());
        assert!(validate_endpoint("http://localhost/root", true).is_ok());
        assert!(validate_endpoint("http://nas.local/root", true).is_ok());
        assert!(validate_endpoint("http://0.0.0.0/root", true).is_err());
        assert!(validate_endpoint("http://[::]/root", true).is_err());
        assert!(validate_endpoint("http://dav.example.test/root", true).is_err());
        assert!(validate_endpoint("https://dav.example.test/root", false).is_ok());
        assert!(validate_endpoint("https://user:pass@dav.example.test/root", true).is_err());
    }

    #[test]
    fn remote_directory_rejects_traversal_and_unsafe_names() {
        assert!(validate_relative_directory("vault/../escape").is_err());
        assert!(validate_relative_directory("vault\\escape").is_err());
        assert!(validate_relative_directory("vault/%secret").is_err());
        assert_eq!(
            validate_relative_directory("/pi-desktop/config/").expect("safe directory"),
            "pi-desktop/config"
        );
    }

    #[test]
    fn weak_etags_are_not_accepted_for_head_cas() {
        let mut headers = HeaderMap::new();
        headers.insert(ETAG, HeaderValue::from_static("W/\"weak\""));
        assert_eq!(strong_etag(&headers), None);
        headers.insert(ETAG, HeaderValue::from_static("\"strong\""));
        assert_eq!(strong_etag(&headers).as_deref(), Some("\"strong\""));
    }

    #[tokio::test]
    async fn nested_directory_creates_missing_ancestors() {
        let fixture = fixture_with_options(false, None, false, true).await;
        let transport = WebDavTransport::new(&WebDavConfig {
            endpoint: fixture.endpoint.clone(),
            username: String::new(),
            password: String::new(),
            directory: "backups/pi/settings".into(),
            allow_insecure_http: true,
            missing_object_status: None,
        })
        .expect("transport");
        transport
            .ensure_collection("vault")
            .await
            .expect("nested collections");
    }

    #[tokio::test]
    async fn local_fixture_proves_conditional_writes() {
        let fixture = fixture(false).await;
        let transport = fixture_transport(&fixture.endpoint);
        let probe = transport.probe().await.expect("probe");
        assert!(probe.conditional_writes);
        assert!(probe.append_only);
        fixture.task.abort();
    }

    #[tokio::test]
    async fn probe_rejects_servers_that_ignore_conditional_headers() {
        let fixture = fixture_with_options(false, None, true, false).await;
        let transport = fixture_transport(&fixture.endpoint);
        let probe = transport.probe().await.expect("probe");
        assert!(!probe.conditional_writes);
        assert!(probe.append_only);
        fixture.task.abort();
    }

    #[tokio::test]
    async fn directory_listing_excludes_the_collection_itself() {
        let fixture = fixture(false).await;
        let transport = fixture_transport(&fixture.endpoint);
        transport
            .ensure_collection("heads")
            .await
            .expect("collection");
        transport
            .put_unconditional("heads/device-a", b"head".to_vec())
            .await
            .expect("head");
        assert_eq!(
            transport.list_children("heads").await.expect("listing"),
            vec!["device-a".to_string()]
        );
        fixture.task.abort();
    }

    #[tokio::test]
    async fn probe_records_bad_gateway_as_the_missing_object_status() {
        let fixture = fixture_with_options(false, Some(502), false, false).await;
        let transport = fixture_transport(&fixture.endpoint);
        let probe = transport.probe().await.expect("probe");
        assert!(probe.conditional_writes);
        assert_eq!(probe.missing_object_status, Some(502));
        let transport = transport.with_probe_result(&probe);
        assert!(transport
            .get("missing")
            .await
            .expect("missing get")
            .is_none());
        fixture.task.abort();
    }

    #[tokio::test]
    async fn empty_vault_initialization_has_one_winner() {
        let fixture = fixture(false).await;
        let transport = fixture_transport(&fixture.endpoint);
        let first = transport.put_if_none("header", b"first".to_vec());
        let second = transport.put_if_none("header", b"second".to_vec());
        let (first, second) = tokio::join!(first, second);
        let winners = [first.expect("first"), second.expect("second")]
            .into_iter()
            .filter(|value| *value)
            .count();
        assert_eq!(winners, 1);
        fixture.task.abort();
    }

    #[tokio::test]
    async fn stale_cas_writer_is_rejected() {
        let fixture = fixture(false).await;
        let transport = fixture_transport(&fixture.endpoint);
        assert!(transport
            .put_if_none("head", b"first".to_vec())
            .await
            .expect("create"));
        let (_, etag) = transport.get("head").await.expect("get").expect("head");
        let etag = etag.expect("strong etag");
        assert!(transport
            .put_if_match("head", &etag, b"second".to_vec())
            .await
            .expect("matching update"));
        assert!(!transport
            .put_if_match("head", &etag, b"stale".to_vec())
            .await
            .expect("stale update"));
        fixture.task.abort();
    }

    #[tokio::test]
    async fn weak_etag_fixture_is_not_accepted_by_probe() {
        let fixture = fixture(true).await;
        let transport = fixture_transport(&fixture.endpoint);
        assert!(!transport.probe().await.expect("probe").conditional_writes);
        fixture.task.abort();
    }
}
