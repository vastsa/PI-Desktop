//! AWS Signature Version 4 for the bounded, single-object S3 request surface.
//! HMAC uses the maintained ring implementation already used by rustls.
use anyhow::{anyhow, bail, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, HOST};
use reqwest::{Method, Url};
use sha2::{Digest, Sha256};

pub(super) struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

fn header(value: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(value)
        .map_err(|_| anyhow!("CONFIG_SYNC_INVALID: invalid S3 signing header"))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    ring::hmac::sign(&key, data.as_bytes()).as_ref().to_vec()
}

/// Paths are already encoded exactly once by the transport. S3 must not
/// normalize paths or encode the separating slashes a second time.
pub(super) fn sign(
    method: &Method,
    url: &Url,
    region: &str,
    credentials: &Credentials,
    body: &[u8],
    headers: &mut HeaderMap,
    timestamp: &str,
) -> Result<()> {
    if timestamp.len() != 16 || !timestamp.is_ascii() || url.query().is_some() {
        bail!("CONFIG_SYNC_INVALID: unsupported S3 signing input");
    }
    let hostname = url
        .host_str()
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: missing S3 host"))?;
    let host = match url.port() {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname.to_string(),
    };
    headers.insert(HOST, header(&host)?);
    headers.insert("x-amz-date", header(timestamp)?);
    let payload_hash = hex::encode(Sha256::digest(body));
    headers.insert("x-amz-content-sha256", header(&payload_hash)?);
    if let Some(token) = &credentials.session_token {
        headers.insert("x-amz-security-token", header(token)?);
    }
    let mut names: Vec<_> = headers.keys().map(|name| name.as_str()).collect();
    names.sort_unstable();
    let signed_headers = names.join(";");
    let mut canonical_headers = String::new();
    for name in names {
        let value = headers[name]
            .to_str()
            .map_err(|_| anyhow!("CONFIG_SYNC_INVALID: invalid S3 signing header"))?;
        let normalized = value.split_ascii_whitespace().collect::<Vec<_>>().join(" ");
        canonical_headers.push_str(&format!("{name}:{normalized}\n"));
    }
    let canonical_request = format!(
        "{method}\n{}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}",
        url.path()
    );
    let day = &timestamp[..8];
    let scope = format!("{day}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let date_key = hmac(
        format!("AWS4{}", credentials.secret_access_key).as_bytes(),
        day,
    );
    let region_key = hmac(&date_key, region);
    let service_key = hmac(&region_key, "s3");
    let signing_key = hmac(&service_key, "aws4_request");
    let signature = hex::encode(hmac(&signing_key, &string_to_sign));
    let authorization = format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}", credentials.access_key_id);
    let mut value = header(&authorization)?;
    value.set_sensitive(true);
    headers.insert(AUTHORIZATION, value);
    if let Some(value) = headers.get_mut("x-amz-security-token") {
        value.set_sensitive(true);
    }
    Ok(())
}
