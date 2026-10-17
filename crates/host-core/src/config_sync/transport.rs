use anyhow::{anyhow, bail, Result};
use reqwest::header::{HeaderMap, HeaderValue, ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::{Client, Method, StatusCode, Url};
use std::net::IpAddr;
use std::time::Duration;
use uuid::Uuid;

#[path = "signing.rs"]
mod signing;
#[cfg(test)]
#[path = "transport_tests.rs"]
pub(crate) mod tests;

const MAX_REMOTE_OBJECT_BYTES: usize = 64 * 1024 * 1024;

// Deliberately not Debug: connection credentials must never enter logs.
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub prefix: String,
    pub path_style: bool,
    pub allow_insecure_http: bool,
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub conditional_writes: bool,
}

pub struct S3Transport {
    client: Client,
    base: Url,
    key_prefix: String,
    region: String,
    credentials: signing::Credentials,
}

fn safe_path(value: &str, allow_empty: bool) -> Result<()> {
    if (value.is_empty() && !allow_empty) || value.len() > 1024 {
        bail!("CONFIG_SYNC_INVALID: invalid S3 object path length");
    }
    if value.is_empty() {
        return Ok(());
    }
    for segment in value.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || !segment
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.~ ".contains(&c))
        {
            bail!("CONFIG_SYNC_INVALID: unsafe S3 object path");
        }
    }
    Ok(())
}

fn is_lan_http_host(host: &str) -> bool {
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "localhost.localdomain") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn validate_endpoint(raw: &str, allow_insecure_http: bool) -> Result<Url> {
    let url =
        Url::parse(raw.trim()).map_err(|_| anyhow!("CONFIG_SYNC_INVALID: invalid S3 endpoint"))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        bail!(
            "CONFIG_SYNC_INVALID: S3 endpoint must be an HTTP(S) origin without userinfo, path, query or fragment"
        );
    }
    if url.scheme() == "http"
        && (!allow_insecure_http || !is_lan_http_host(url.host_str().unwrap_or_default()))
    {
        bail!(
            "CONFIG_SYNC_INVALID: HTTP requires relaxed network policy and a private LAN endpoint"
        );
    }
    Ok(url)
}

impl S3Transport {
    pub fn new(config: &S3Config) -> Result<Self> {
        let mut base = validate_endpoint(&config.endpoint, config.allow_insecure_http)?;
        safe_path(&config.prefix, true)?;
        if !(3..=63).contains(&config.bucket.len())
            || !config
                .bucket
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c))
            || !config
                .bucket
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !config
                .bucket
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            || config.bucket.contains("..")
            || config.bucket.contains(".-")
            || config.bucket.contains("-.")
            || config.bucket.parse::<IpAddr>().is_ok()
        {
            bail!("CONFIG_SYNC_INVALID: invalid S3 bucket name");
        }
        if config.region.is_empty()
            || config.region.len() > 128
            || !config
                .region
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || config.access_key_id.is_empty()
            || config.access_key_id.len() > 256
            || !config
                .access_key_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
            || config.secret_access_key.is_empty()
            || config.secret_access_key.len() > 4096
        {
            bail!("CONFIG_SYNC_INVALID: invalid S3 region or credentials");
        }
        if let Some(token) = &config.session_token {
            if token.len() > 16384 || HeaderValue::from_str(token).is_err() {
                bail!("CONFIG_SYNC_INVALID: invalid S3 session token");
            }
        }
        let bucket_path = if config.path_style {
            format!("{}/", config.bucket)
        } else {
            let host = base.host_str().unwrap_or_default();
            if host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok() {
                bail!("CONFIG_SYNC_INVALID: virtual-hosted S3 requires a DNS endpoint");
            }
            base.set_host(Some(&format!("{}.{host}", config.bucket)))
                .map_err(|_| anyhow!("CONFIG_SYNC_INVALID: invalid virtual-hosted S3 endpoint"))?;
            String::new()
        };
        let key_prefix = if config.prefix.is_empty() {
            bucket_path
        } else {
            format!("{bucket_path}{}/", config.prefix)
        };
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| anyhow!("CONFIG_SYNC_NETWORK: could not create S3 client"))?;
        Ok(Self {
            client,
            base,
            key_prefix,
            region: config.region.clone(),
            credentials: signing::Credentials {
                access_key_id: config.access_key_id.clone(),
                secret_access_key: config.secret_access_key.clone(),
                session_token: config.session_token.clone(),
            },
        })
    }

    fn url(&self, relative: &str) -> Result<Url> {
        safe_path(relative, false)?;
        let path = format!("{}{relative}", self.key_prefix);
        safe_path(&path, false)?;
        let mut url = self.base.clone();
        // The path alphabet is unreserved ASCII plus slash and space. Encode
        // space as %20, never '+', and preserve slashes for S3 canonicalization.
        url.set_path(&format!("/{}", path.replace(' ', "%20")));
        Ok(url)
    }

    async fn send(
        &self,
        method: Method,
        relative: &str,
        body: Vec<u8>,
        mut headers: HeaderMap,
    ) -> Result<reqwest::Response> {
        if body.len() > MAX_REMOTE_OBJECT_BYTES {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: S3 object is too large");
        }
        let url = self.url(relative)?;
        signing::sign(
            &method,
            &url,
            &self.region,
            &self.credentials,
            &body,
            &mut headers,
            &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
        )?;
        // reqwest derives Host / HTTP/2 :authority from this same URL. Keep it
        // in the signature, but do not emit a second explicit authority field.
        headers.remove(reqwest::header::HOST);
        let response = self
            .client
            .request(method, url)
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(request_error)?;
        if response.status().is_redirection() {
            bail!("CONFIG_SYNC_REDIRECT: use the direct S3 endpoint; redirects are not followed");
        }
        Ok(response)
    }

    async fn limited_bytes(mut response: reqwest::Response) -> Result<Vec<u8>> {
        if response
            .content_length()
            .is_some_and(|size| size > MAX_REMOTE_OBJECT_BYTES as u64)
        {
            bail!("CONFIG_SYNC_LIMIT_EXCEEDED: remote object is too large");
        }
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
            .send(Method::GET, relative, Vec::new(), HeaderMap::new())
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() != StatusCode::OK {
            return Err(response_error("read", response).await);
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| valid_etag(value))
            .map(str::to_string);
        Ok(Some((Self::limited_bytes(response).await?, etag)))
    }

    async fn conditional_put(
        &self,
        relative: &str,
        body: Vec<u8>,
        headers: HeaderMap,
    ) -> Result<bool> {
        let response = self.send(Method::PUT, relative, body, headers).await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT => Ok(false),
            status if status.is_success() => Ok(true),
            _ => Err(response_error("write", response).await),
        }
    }

    pub async fn put_if_none(&self, relative: &str, body: Vec<u8>) -> Result<bool> {
        let mut headers = HeaderMap::new();
        headers.insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
        self.conditional_put(relative, body, headers).await
    }

    pub async fn put_if_match(&self, relative: &str, etag: &str, body: Vec<u8>) -> Result<bool> {
        if !valid_etag(etag) {
            bail!("CONFIG_SYNC_INVALID: a strong S3 ETag is required");
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            IF_MATCH,
            HeaderValue::from_str(etag)
                .map_err(|_| anyhow!("CONFIG_SYNC_INVALID: invalid S3 ETag"))?,
        );
        self.conditional_put(relative, body, headers).await
    }

    pub async fn delete(&self, relative: &str) -> Result<()> {
        let response = self
            .send(Method::DELETE, relative, Vec::new(), HeaderMap::new())
            .await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(response_error("delete", response).await)
    }

    /// Only this random key is owned by the capability probe. Never enumerate,
    /// create a bucket, change its ACL, or remove any configured vault object.
    pub async fn probe(&self) -> Result<ProbeResult> {
        let path = format!("probe/{}", Uuid::new_v4());
        let first = self.put_if_none(&path, b"probe-one".to_vec()).await;
        if matches!(first, Ok(false)) {
            // A collision did not create an object owned by this probe.
            return Ok(ProbeResult {
                conditional_writes: false,
            });
        }
        let result = async {
            first?;
            if self
                .put_if_none(&path, b"must-not-replace".to_vec())
                .await?
            {
                return Ok(false);
            }
            let Some((first, Some(etag))) = self.get(&path).await? else {
                return Ok(false);
            };
            if first != b"probe-one" {
                return Ok(false);
            }
            if !self
                .put_if_match(&path, &etag, b"probe-two".to_vec())
                .await?
            {
                return Ok(false);
            }
            if self
                .put_if_match(&path, &etag, b"must-not-replace".to_vec())
                .await?
            {
                return Ok(false);
            }
            let Some((second, Some(new_etag))) = self.get(&path).await? else {
                return Ok(false);
            };
            Ok(second == b"probe-two" && etag != new_etag)
        }
        .await;
        let cleanup = async {
            self.delete(&path).await?;
            if self.get(&path).await?.is_some() {
                bail!("CONFIG_SYNC_REMOTE: S3 probe cleanup could not be verified");
            }
            Ok(())
        }
        .await;
        match (result, cleanup) {
            (Ok(conditional_writes), Ok(())) => Ok(ProbeResult { conditional_writes }),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => {
                Err(anyhow!("{error}; probe cleanup also failed: {cleanup}"))
            }
        }
    }
}

fn valid_etag(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 256
        && value.starts_with('"')
        && value.ends_with('"')
        && value[1..value.len() - 1]
            .bytes()
            .all(|c| c.is_ascii_graphic() && c != b'"')
}

fn request_error(error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!("CONFIG_SYNC_TIMEOUT: S3 request timed out")
    } else {
        anyhow!("CONFIG_SYNC_NETWORK: S3 connection failed; check the network and TLS certificate")
    }
}

// Only fixed service error names are returned; XML messages may echo secrets.
fn service_error_code(bytes: &[u8]) -> Option<&'static str> {
    const CODES: &[&str] = &[
        "SignatureDoesNotMatch",
        "AuthorizationHeaderMalformed",
        "InvalidRequest",
        "InvalidArgument",
        "MissingContentLength",
        "InvalidAccessKeyId",
        "RequestTimeTooSkewed",
        "RequestExpired",
        "InvalidToken",
        "ExpiredToken",
        "AccessDenied",
        "XAmzContentSHA256Mismatch",
        "InvalidHostHeader",
    ];
    let text = std::str::from_utf8(bytes).ok()?;
    CODES
        .iter()
        .copied()
        .find(|code| text.contains(&format!("<Code>{code}</Code>")))
}

async fn response_error(operation: &str, mut response: reqwest::Response) -> anyhow::Error {
    let error = status_error(operation, response.status());
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if bytes.len() + chunk.len() > 8192 {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(code) = service_error_code(&bytes) {
        anyhow!("{error} ({code})")
    } else {
        error
    }
}

fn status_error(operation: &str, status: StatusCode) -> anyhow::Error {
    let code = match status.as_u16() {
        401 => "AUTH",
        403 => "PERMISSION",
        404 => "NOT_FOUND",
        409 => "CONFLICT",
        413 | 507 => "QUOTA",
        429 => "RATE_LIMIT",
        500..=599 => "SERVER",
        _ => "REMOTE",
    };
    anyhow!(
        "CONFIG_SYNC_{code}: S3 {operation} returned HTTP {}",
        status.as_u16()
    )
}

pub fn remote_error_is_offline(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    [
        "CONFIG_SYNC_NETWORK:",
        "CONFIG_SYNC_TIMEOUT:",
        "CONFIG_SYNC_SERVER:",
        "CONFIG_SYNC_RATE_LIMIT:",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}
