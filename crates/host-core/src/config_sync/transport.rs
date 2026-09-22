use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, ETAG, IF_MATCH, IF_NONE_MATCH, LOCATION};
use reqwest::{Client, Method, StatusCode, Url};
use uuid::Uuid;

const MAX_REMOTE_OBJECT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct WebDavConfig {
    pub endpoint: String,
    pub username: String,
    pub password: String,
    pub directory: String,
    pub allow_insecure_http: bool,
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub conditional_writes: bool,
}

#[derive(Debug, Clone)]
pub struct WebDavTransport {
    client: Client,
    base: Url,
    username: String,
    password: String,
    directory: String,
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

fn validate_endpoint(raw: &str, allow_insecure_http: bool) -> Result<Url> {
    let mut url = Url::parse(raw.trim()).context("parse WebDAV endpoint")?;
    if !matches!(url.scheme(), "https" | "http") {
        bail!("CONFIG_SYNC_INVALID: WebDAV endpoint must use HTTPS");
    }
    if url.scheme() == "http" && !allow_insecure_http {
        bail!("CONFIG_SYNC_INVALID: HTTP requires explicit LAN-risk acknowledgement");
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        bail!("CONFIG_SYNC_INVALID: endpoint must not contain userinfo");
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
        })
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
        let url = self.url(relative)?;
        let mut request = self.client.request(method, url).headers(headers);
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = self
            .authenticated(request)
            .send()
            .await
            .context("WebDAV request failed")?;
        if response.headers().get(LOCATION).is_some() || response.status().is_redirection() {
            bail!("CONFIG_SYNC_SECURITY: WebDAV redirects are not permitted");
        }
        Ok(response)
    }

    /// Create a single collection below the configured vault directory. A
    /// WebDAV server may report 405 when the collection already exists; that
    /// is a successful idempotent result for this helper. We intentionally do
    /// not follow redirects or try to infer a different root.
    pub async fn ensure_collection(&self, relative: &str) -> Result<()> {
        let response = self
            .send(
                Method::from_bytes(b"MKCOL").expect("MKCOL is a valid method"),
                relative,
                None,
                HeaderMap::new(),
            )
            .await?;
        match response.status() {
            status
                if status.is_success()
                    || status == StatusCode::METHOD_NOT_ALLOWED
                    || status == StatusCode::PRECONDITION_FAILED =>
            {
                Ok(())
            }
            status => bail!("CONFIG_SYNC_REMOTE: WebDAV collection create returned {status}"),
        }
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
        while let Some(chunk) = response.chunk().await.context("read WebDAV response")? {
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
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            bail!(
                "CONFIG_SYNC_REMOTE: WebDAV GET returned {}",
                response.status()
            );
        }
        let etag = strong_etag(response.headers());
        Ok(Some((Self::limited_bytes(response).await?, etag)))
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
            status => bail!("CONFIG_SYNC_REMOTE: WebDAV create returned {status}"),
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
            status => bail!("CONFIG_SYNC_REMOTE: WebDAV conditional write returned {status}"),
        }
    }

    pub async fn delete(&self, relative: &str) -> Result<()> {
        let response = self
            .send(Method::DELETE, relative, None, HeaderMap::new())
            .await?;
        if response.status() != StatusCode::NOT_FOUND && !response.status().is_success() {
            bail!(
                "CONFIG_SYNC_REMOTE: WebDAV delete returned {}",
                response.status()
            );
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
        self.delete(&probe).await?;
        Ok(ProbeResult {
            conditional_writes: !second
                && readable
                && matched_update
                && stale_rejected
                && updated_readable,
        })
    }
}

fn strong_etag(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(ETAG)?.to_str().ok()?.trim();
    if value.is_empty() || value.starts_with("W/") {
        return None;
    }
    Some(value.to_string())
}

pub fn remote_error_is_offline(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("request failed")
        || text.contains("timed out")
        || text.contains("dns")
        || text.contains("connect")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
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
            404 => "Not Found",
            405 => "Method Not Allowed",
            412 => "Precondition Failed",
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
                    if state.collections.insert(path) {
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
                    } else {
                        (404, Vec::new(), None)
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
                    if (none_match && existing) || (headers.contains_key(IF_MATCH) && !match_ok) {
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
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture");
        let address = listener.local_addr().expect("fixture address");
        let state = Arc::new(Mutex::new(FixtureState {
            weak_etag,
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
        })
        .expect("transport")
    }

    #[test]
    fn endpoint_requires_https_unless_explicitly_acknowledged() {
        assert!(validate_endpoint("http://dav.example.test/root", false).is_err());
        assert!(validate_endpoint("http://dav.example.test/root", true).is_ok());
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
    async fn local_fixture_proves_conditional_writes() {
        let fixture = fixture(false).await;
        let transport = fixture_transport(&fixture.endpoint);
        assert!(transport.probe().await.expect("probe").conditional_writes);
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
