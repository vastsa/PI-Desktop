use super::*;
use reqwest::header::{AUTHORIZATION, HOST};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
struct FixtureState {
    objects: HashMap<String, (Vec<u8>, String)>,
    weak_etag: bool,
    ignore_preconditions: bool,
    read_status: Option<u16>,
    fail_next_read: bool,
    fail_delete: bool,
}

pub(crate) struct Fixture {
    pub(crate) endpoint: String,
    pub(crate) task: tokio::task::JoinHandle<()>,
    state: Arc<Mutex<FixtureState>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<(Method, String, HeaderMap, Vec<u8>)> {
    let mut buffer = Vec::new();
    let header_end;
    loop {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|v| v == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if buffer.len() > 1024 * 1024 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split_whitespace();
    let method = Method::from_bytes(request.next()?.as_bytes()).ok()?;
    let path = request.next()?.to_string();
    let mut headers = HeaderMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes()).ok()?,
                HeaderValue::from_str(value.trim()).ok()?,
            );
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_REMOTE_OBJECT_BYTES {
        return None;
    }
    while buffer.len() < header_end + length {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some((
        method,
        path,
        headers,
        buffer[header_end..header_end + length].to_vec(),
    ))
}

// Verify every wire request (including conditional headers and optional token).
// The independent official AWS vector below anchors the signer itself.
fn authorized(method: &Method, path: &str, headers: &HeaderMap, body: &[u8]) -> Result<bool> {
    let host = headers
        .get(HOST)
        .ok_or_else(|| anyhow!("missing host"))?
        .to_str()?;
    let url = Url::parse(&format!("http://{host}{path}"))?;
    let timestamp = headers
        .get("x-amz-date")
        .ok_or_else(|| anyhow!("missing date"))?
        .to_str()?;
    let mut expected = HeaderMap::new();
    for name in [IF_MATCH, IF_NONE_MATCH] {
        if let Some(value) = headers.get(&name) {
            expected.insert(name, value.clone());
        }
    }
    let credentials = signing::Credentials {
        access_key_id: "fixture-access".into(),
        secret_access_key: "fixture-secret".into(),
        session_token: headers
            .get("x-amz-security-token")
            .map(|_| "fixture-session".into()),
    };
    signing::sign(
        method,
        &url,
        "us-east-1",
        &credentials,
        body,
        &mut expected,
        timestamp,
    )?;
    Ok(expected
        .iter()
        .all(|(name, value)| headers.get(name) == Some(value)))
}

async fn handle(mut stream: TcpStream, state: Arc<Mutex<FixtureState>>) {
    let Some((method, path, headers, body)) = read_request(&mut stream).await else {
        return;
    };
    let (status, response, etag) = {
        let mut state = state.lock().unwrap();
        if !authorized(&method, &path, &headers, &body).unwrap_or(false) {
            (
                403,
                b"fixture credential details must not escape".to_vec(),
                None,
            )
        } else if method == Method::GET && state.fail_next_read {
            state.fail_next_read = false;
            (503, Vec::new(), None)
        } else {
            match method {
                Method::GET => {
                    if let Some(status) = state.read_status {
                        (status, Vec::new(), None)
                    } else if let Some((body, etag)) = state.objects.get(&path) {
                        let tag = if state.weak_etag {
                            format!("W/{etag}")
                        } else {
                            etag.clone()
                        };
                        (200, body.clone(), Some(tag))
                    } else {
                        (404, Vec::new(), None)
                    }
                }
                Method::PUT => {
                    let existing = state.objects.get(&path);
                    let conflict = (headers.contains_key(IF_NONE_MATCH) && existing.is_some())
                        || headers.get(IF_MATCH).is_some_and(|value| {
                            existing.is_none_or(|(_, tag)| value != tag.as_str())
                        });
                    if conflict && !state.ignore_preconditions {
                        (412, Vec::new(), None)
                    } else {
                        let etag = format!("\"{}\"", hex::encode(Sha256::digest(&body)));
                        state.objects.insert(path, (body, etag));
                        (200, Vec::new(), None)
                    }
                }
                Method::DELETE if state.fail_delete => (403, Vec::new(), None),
                Method::DELETE => {
                    state.objects.remove(&path);
                    (204, Vec::new(), None)
                }
                _ => (405, Vec::new(), None),
            }
        }
    };
    let mut response_headers = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.len()
    );
    if let Some(etag) = etag {
        response_headers.push_str(&format!("ETag: {etag}\r\n"));
    }
    if status == 307 {
        response_headers.push_str("Location: http://127.0.0.1:1/must-not-follow\r\n");
    }
    response_headers.push_str("\r\n");
    stream.write_all(response_headers.as_bytes()).await.unwrap();
    stream.write_all(&response).await.unwrap();
}

pub(crate) async fn fixture(weak_etag: bool) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(FixtureState {
        weak_etag,
        ..Default::default()
    }));
    let serving_state = state.clone();
    let task = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                result = listener.accept() => {
                    let (stream, _) = result.unwrap();
                    requests.spawn(handle(stream, serving_state.clone()));
                }
                result = requests.join_next(), if !requests.is_empty() => { result.unwrap().unwrap(); }
            }
        }
    });
    Fixture {
        endpoint,
        task,
        state,
    }
}

pub(crate) async fn fixture_ignoring_preconditions() -> Fixture {
    let fixture = fixture(false).await;
    fixture.state.lock().unwrap().ignore_preconditions = true;
    fixture
}

fn config(endpoint: &str) -> S3Config {
    S3Config {
        endpoint: endpoint.into(),
        region: "us-east-1".into(),
        bucket: "fixture-bucket".into(),
        access_key_id: "fixture-access".into(),
        secret_access_key: "fixture-secret".into(),
        session_token: None,
        prefix: "nested/test prefix".into(),
        path_style: true,
        allow_insecure_http: true,
    }
}

#[test]
fn aws_official_get_object_signature_vector() -> Result<()> {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    let credentials = signing::Credentials {
        access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
        session_token: None,
    };
    let mut headers = HeaderMap::new();
    headers.insert("range", HeaderValue::from_static("bytes=0-9"));
    signing::sign(
        &Method::GET,
        &Url::parse("https://examplebucket.s3.amazonaws.com/test.txt")?,
        "us-east-1",
        &credentials,
        b"",
        &mut headers,
        "20130524T000000Z",
    )?;
    assert!(headers[AUTHORIZATION]
        .to_str()?
        .ends_with("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"));
    Ok(())
}

#[test]
fn addressing_and_input_boundaries() -> Result<()> {
    let mut config = config("https://s3.example.test:9443");
    let transport = S3Transport::new(&config)?;
    assert_eq!(
        transport.url("head")?.as_str(),
        "https://s3.example.test:9443/fixture-bucket/nested/test%20prefix/head"
    );
    config.path_style = false;
    let virtual_host = S3Transport::new(&config)?;
    assert_eq!(
        virtual_host.url("head")?.as_str(),
        "https://fixture-bucket.s3.example.test:9443/nested/test%20prefix/head"
    );
    for path in [
        "",
        "../secret",
        "a/../b",
        "a//b",
        "/outside",
        "a\\b",
        "a%2fb",
        "a?query",
        "a#fragment",
    ] {
        assert!(transport.url(path).is_err(), "accepted {path}");
    }
    for endpoint in [
        "http://public.example.test",
        "http://0.0.0.0",
        "http://[::]",
        "https://user:pass@s3.example.test",
        "https://s3.example.test/?secret=1",
        "https://s3.example.test/#fragment",
        "https://s3.example.test/path",
        "file:///tmp",
    ] {
        assert!(validate_endpoint(endpoint, true).is_err());
    }
    for endpoint in [
        "http://127.0.0.1",
        "http://[::1]",
        "http://192.168.1.10",
        "http://nas.local",
    ] {
        assert!(validate_endpoint(endpoint, false).is_err());
        assert!(validate_endpoint(endpoint, true).is_ok());
    }
    for etag in [
        "",
        "*",
        "W/\"weak\"",
        "\"\"",
        "\"one\",\"two\"",
        "\"line\nbreak\"",
    ] {
        assert!(!valid_etag(etag));
    }
    Ok(())
}

#[tokio::test]
async fn signed_probe_proves_cas_and_cleans_only_its_objects() -> Result<()> {
    let fixture = fixture(false).await;
    let mut config = config(&fixture.endpoint);
    config.session_token = Some("fixture-session".into());
    let transport = S3Transport::new(&config)?;
    assert!(transport.put_if_none("existing", b"keep".to_vec()).await?);
    assert!(transport.probe().await?.conditional_writes);
    assert_eq!(fixture.state.lock().unwrap().objects.len(), 1);
    assert_eq!(transport.get("existing").await?.unwrap().0, b"keep");
    let (first, second) = tokio::join!(
        transport.put_if_none("head", b"first".to_vec()),
        transport.put_if_none("head", b"second".to_vec())
    );
    assert_ne!(first?, second?);
    let (_, etag) = transport.get("head").await?.unwrap();
    let etag = etag.unwrap();
    let (first, second) = tokio::join!(
        transport.put_if_match("head", &etag, b"third".to_vec()),
        transport.put_if_match("head", &etag, b"fourth".to_vec())
    );
    assert_ne!(first?, second?);
    Ok(())
}

#[tokio::test]
async fn unsupported_servers_and_failed_probe_are_cleaned() -> Result<()> {
    for weak_etag in [false, true] {
        let fixture = fixture(weak_etag).await;
        fixture.state.lock().unwrap().ignore_preconditions = !weak_etag;
        assert!(
            !S3Transport::new(&config(&fixture.endpoint))?
                .probe()
                .await?
                .conditional_writes
        );
        assert!(fixture.state.lock().unwrap().objects.is_empty());
    }
    let fixture = fixture(false).await;
    fixture.state.lock().unwrap().fail_next_read = true;
    assert!(S3Transport::new(&config(&fixture.endpoint))?
        .probe()
        .await
        .is_err());
    assert!(fixture.state.lock().unwrap().objects.is_empty());
    fixture.state.lock().unwrap().fail_delete = true;
    assert!(S3Transport::new(&config(&fixture.endpoint))?
        .probe()
        .await
        .is_err());
    Ok(())
}

#[tokio::test]
async fn errors_preserve_auth_missing_offline_and_redirect_boundaries() -> Result<()> {
    let fixture = fixture(false).await;
    let mut config = config(&fixture.endpoint);
    config.secret_access_key = "invalid-secret".into();
    let error = S3Transport::new(&config)?.get("missing").await.unwrap_err();
    assert!(error.to_string().starts_with("CONFIG_SYNC_PERMISSION:"));
    assert!(!error.to_string().contains("credential details"));
    assert!(!remote_error_is_offline(&error));
    config.secret_access_key = "fixture-secret".into();
    let transport = S3Transport::new(&config)?;
    for (status, prefix, offline) in [
        (403, "CONFIG_SYNC_PERMISSION:", false),
        (502, "CONFIG_SYNC_SERVER:", true),
        (307, "CONFIG_SYNC_REDIRECT:", false),
    ] {
        fixture.state.lock().unwrap().read_status = Some(status);
        let error = transport.get("missing").await.unwrap_err();
        assert!(error.to_string().starts_with(prefix));
        assert_eq!(remote_error_is_offline(&error), offline);
    }
    fixture.state.lock().unwrap().read_status = None;
    assert!(transport.get("missing").await?.is_none());
    Ok(())
}

#[test]
fn service_error_details_never_echo_untrusted_text() {
    assert_eq!(
        service_error_code(b"<Error><Code>InvalidRequest</Code><Message>secret</Message></Error>"),
        Some("InvalidRequest")
    );
    assert_eq!(
        service_error_code(b"<Error><Code>reflected-secret</Code></Error>"),
        None
    );
    assert_eq!(
        service_error_code(b"<Message>InvalidRequest secret</Message>"),
        None
    );
    assert_eq!(service_error_code(&[0xff]), None);
}
