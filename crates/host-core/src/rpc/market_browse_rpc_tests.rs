// Test-only: every test here repoints the process-global
// `PI_DESKTOP_PLUGIN_MARKET_URL` and holds the shared market lock across the
// awaited RPC so no other test can move the source mid-call.
#![allow(clippy::await_holding_lock)]

use std::ffi::OsString;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};

use super::handle_request;
use crate::plugins::market_browse::clear_browse_cache;
use crate::plugins::tests::MARKET_ENV_LOCK;
use crate::state::AppState;

const OFFLINE_MARKET_URL: &str = "file:///nope/does-not-exist-catalog.json";

struct MarketEnv {
    _guard: MutexGuard<'static, ()>,
    previous: Option<OsString>,
}

impl MarketEnv {
    fn hold() -> Self {
        let guard = MARKET_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        clear_browse_cache();
        Self {
            _guard: guard,
            previous: std::env::var_os("PI_DESKTOP_PLUGIN_MARKET_URL"),
        }
    }

    fn point_at(&self, value: &str) {
        // Safety: test-only process env mutation, serialized by the lock.
        unsafe { std::env::set_var("PI_DESKTOP_PLUGIN_MARKET_URL", value) };
    }
}

impl Drop for MarketEnv {
    fn drop(&mut self) {
        clear_browse_cache();
        match &self.previous {
            Some(value) => unsafe { std::env::set_var("PI_DESKTOP_PLUGIN_MARKET_URL", value) },
            None => unsafe { std::env::remove_var("PI_DESKTOP_PLUGIN_MARKET_URL") },
        }
    }
}

fn fixture_state() -> (
    tempfile::TempDir,
    Arc<Mutex<AppState>>,
    mpsc::UnboundedSender<String>,
) {
    let data = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data.path()).unwrap();
    app_state.handshook = true;
    (
        data,
        Arc::new(Mutex::new(app_state)),
        mpsc::unbounded_channel().0,
    )
}

/// A center that answers the search route with a fixed status and body and
/// records every search target it saw.
struct Center {
    catalog_url: String,
    searches: Arc<StdMutex<Vec<String>>>,
}

impl Center {
    async fn start(status: u16, body: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let searches = Arc::new(StdMutex::new(Vec::new()));
        let seen = searches.clone();
        let body = body.to_string();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let seen = seen.clone();
                let body = body.clone();
                tokio::spawn(async move { serve(stream, status, body, seen).await });
            }
        });
        Self {
            catalog_url: format!("http://{address}/catalog.json"),
            searches,
        }
    }

    fn searches(&self) -> Vec<String> {
        self.searches.lock().unwrap().clone()
    }
}

async fn serve(mut stream: TcpStream, status: u16, body: String, seen: Arc<StdMutex<Vec<String>>>) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&buffer);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();
    let (status, body) = if target.starts_with("/api/v1/catalog/search") {
        seen.lock().unwrap().push(target);
        (status, body)
    } else {
        (404, "{}".to_string())
    };
    let head = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.flush().await;
}

fn remote_page() -> Value {
    json!({
        "total": 30,
        "pageCount": 15,
        "categories": [{ "id": "developer-tools", "count": 30 }],
        "categoryLabels": {
            "developer-tools": { "en": "Developer Tools", "zh-CN": "开发工具" }
        },
        "artifactBaseUrl": null,
        "plugins": [
            {
                "id": "acme.remote-only", "name": "Remote Only", "description": "From the center",
                "author": "acme", "categories": ["developer-tools"], "trust": "community", "downloads": 7,
                "versions": [{ "version": "2.0.0", "publishedAt": "2026-03-01T00:00:00Z",
                    "shasum": "ab".repeat(32), "url": "packages/acme.remote-only-2.0.0.piplug",
                    "sizeBytes": 10, "permissions": ["ui.panel"] }]
            },
            {
                "id": "acme.second", "name": "Second", "description": "",
                "author": "acme", "categories": ["developer-tools"],
                "versions": [{ "version": "1.0.0", "publishedAt": "2026-02-01T00:00:00Z",
                    "shasum": "cd".repeat(32), "url": "packages/acme.second-1.0.0.piplug",
                    "sizeBytes": 10, "permissions": [] }]
            }
        ]
    })
}

async fn browse(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    params: Value,
) -> Value {
    handle_request(state.clone(), "market.browse", params, tx.clone())
        .await
        .unwrap()
}

#[tokio::test]
async fn browse_serves_the_centers_page_caches_it_and_opens_its_detail() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start(200, remote_page()).await;
    env.point_at(&center.catalog_url);

    let params = json!({ "query": "remote", "category": "Tools", "sort": "popular", "seed": 5, "page": 2, "pageSize": 2 });
    let first = browse(&state, &tx, params.clone()).await;
    assert_eq!(first["source"], "remote");
    assert_eq!(first["total"], 30);
    assert_eq!(
        (
            first["page"].as_u64(),
            first["pageSize"].as_u64(),
            first["pageCount"].as_u64()
        ),
        (Some(2), Some(2), Some(15))
    );
    assert_eq!(first["sort"], "popular");
    assert_eq!(first["categories"][0]["id"], "developer-tools");
    // The facet carries the label for the host's language, and the card keeps
    // both the label it shows and the id a filter selects.
    assert!(
        first["categories"][0]["name"].is_string(),
        "facet has no label: {}",
        first["categories"]
    );
    let plugins = first["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 2);
    assert_eq!(plugins[0]["id"], "acme.remote-only");
    assert_eq!(plugins[0]["latestVersion"], "2.0.0");
    assert_eq!(plugins[0]["installed"], false);
    assert_eq!(plugins[0]["categoryIds"][0], "developer-tools");
    assert!(plugins[0]["categories"][0].as_str().unwrap() != "developer-tools");

    let searches = center.searches();
    assert_eq!(searches.len(), 1);
    assert!(
        searches[0].contains("sort=popular&page=2&pageSize=2&seed=5&q=remote&category=Tools"),
        "{}",
        searches[0]
    );

    // The same query inside the TTL is answered from the cache.
    browse(&state, &tx, params).await;
    assert_eq!(center.searches().len(), 1);

    // A card from the remote page opens even though the snapshot lacks it.
    let detail = handle_request(
        state.clone(),
        "market.getDetail",
        json!({ "id": "acme.remote-only" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(detail["plugin"]["id"], "acme.remote-only");
}

#[tokio::test]
async fn browse_falls_back_to_the_snapshot_when_the_center_lacks_the_route() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start(404, json!({ "error": { "code": "NOT_FOUND" } })).await;
    env.point_at(&center.catalog_url);

    let first = browse(&state, &tx, json!({ "pageSize": 1 })).await;
    assert_eq!(first["source"], "local");
    assert!(first["fallbackReason"]
        .as_str()
        .unwrap()
        .contains("PLUGIN_MARKET_UNSUPPORTED"));
    assert_eq!(first["pageSize"], 1);
    assert!(first["plugins"].as_array().unwrap().len() <= 1);
    // The bundled snapshot carries only `demo.*` samples, which browse hides.
    assert!(first["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| !p["id"].as_str().unwrap().starts_with("demo.")));

    // An unsupported center is remembered rather than asked per keystroke.
    browse(&state, &tx, json!({ "query": "x" })).await;
    assert_eq!(center.searches().len(), 1);
}

#[tokio::test]
async fn browse_rejects_an_oversized_page_and_falls_back() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start(200, remote_page()).await;
    env.point_at(&center.catalog_url);

    let answer = browse(&state, &tx, json!({ "pageSize": 1 })).await;
    assert_eq!(answer["source"], "local");
    assert!(answer["fallbackReason"]
        .as_str()
        .unwrap()
        .contains("PLUGIN_MARKET_INVALID"));
}

#[tokio::test]
async fn browse_backs_off_a_failing_center_and_refresh_clears_it() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start(500, json!({ "error": { "code": "INTERNAL" } })).await;
    env.point_at(&center.catalog_url);

    let first = browse(&state, &tx, json!({ "query": "a" })).await;
    assert_eq!(first["source"], "local");
    assert!(first["fallbackReason"]
        .as_str()
        .unwrap()
        .contains("PLUGIN_NETWORK"));
    // Typing on while the center is failing answers from the snapshot without
    // asking it again.
    browse(&state, &tx, json!({ "query": "ab" })).await;
    assert_eq!(center.searches().len(), 1);

    clear_browse_cache();
    browse(&state, &tx, json!({ "query": "abc" })).await;
    assert_eq!(center.searches().len(), 2);
}
