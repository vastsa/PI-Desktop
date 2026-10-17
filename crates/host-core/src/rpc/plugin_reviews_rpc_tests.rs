// Test-only: every test here repoints the process-global
// `PI_DESKTOP_PLUGIN_MARKET_URL` and holds the shared market lock across the
// awaited RPC so no other test can move the source mid-call.
#![allow(clippy::await_holding_lock)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};

use super::handle_request;
use crate::plugins::reviews::MAX_REVIEW_RESPONSE_BYTES;
use crate::plugins::tests::MARKET_ENV_LOCK;
use crate::state::AppState;

/// Catalog source used while the host state is built, so opening it never
/// touches the fixture (the runtime is single-threaded and the listener could
/// not be accepted while `AppState::open` blocks).
const OFFLINE_MARKET_URL: &str = "file:///nope/does-not-exist-catalog.json";

/// Holds the shared market lock and restores the previous source on drop.
struct MarketEnv {
    _guard: MutexGuard<'static, ()>,
    previous: Option<OsString>,
}

impl MarketEnv {
    fn hold() -> Self {
        let guard = MARKET_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous = std::env::var_os("PI_DESKTOP_PLUGIN_MARKET_URL");
        Self {
            _guard: guard,
            previous,
        }
    }

    fn point_at(&self, value: &str) {
        // Safety: test-only process env mutation, serialized by the lock.
        unsafe { std::env::set_var("PI_DESKTOP_PLUGIN_MARKET_URL", value) };
    }
}

impl Drop for MarketEnv {
    fn drop(&mut self) {
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
    let state = Arc::new(Mutex::new(app_state));
    let tx = mpsc::unbounded_channel().0;
    (data, state, tx)
}

#[derive(Default)]
struct CenterState {
    /// Summary values keyed by plugin id; ids missing here are omitted, which
    /// is how the center reports unknown plugins.
    summaries: BTreeMap<String, Value>,
    /// Status and JSON body for the reviews route.
    reviews: Option<(u16, Value)>,
    /// Raw status and body for the summaries route, for malformed answers.
    summaries_override: Option<(u16, String)>,
    /// Answer the next request with a redirect to this location instead.
    redirect_to: Option<String>,
    /// Accept the request and never answer.
    hang: bool,
    /// Query strings the summaries route saw, in arrival order.
    summary_queries: Vec<String>,
    /// Every request target seen.
    requests: Vec<String>,
}

/// What one fixture request is answered with.
enum Reply {
    Body(u16, String),
    Redirect(String),
}

struct Center {
    catalog_url: String,
    state: Arc<StdMutex<CenterState>>,
}

impl Center {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(StdMutex::new(CenterState::default()));
        let serving = state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let state = serving.clone();
                tokio::spawn(async move { serve(stream, state).await });
            }
        });
        Self {
            catalog_url: format!("http://{address}/catalog.json"),
            state,
        }
    }

    fn set(&self, update: impl FnOnce(&mut CenterState)) {
        update(&mut self.state.lock().unwrap());
    }

    fn origin(&self) -> String {
        self.catalog_url
            .strip_suffix("/catalog.json")
            .unwrap()
            .to_string()
    }

    fn summary_queries(&self) -> Vec<String> {
        self.state.lock().unwrap().summary_queries.clone()
    }

    fn requests(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }

    /// Request targets the fixture saw for one API route.
    ///
    /// A concurrent test that opens an `AppState` while the shared market
    /// override points at this fixture makes a `/catalog.json` fetch, so
    /// counters that promise "no review traffic" count review traffic only.
    fn route_requests(&self, needle: &str) -> Vec<String> {
        self.requests()
            .into_iter()
            .filter(|target| target.contains(needle))
            .collect()
    }
}

async fn serve(mut stream: TcpStream, state: Arc<StdMutex<CenterState>>) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let request = String::from_utf8_lossy(&buffer);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.clone(), String::new()),
    };
    let response = {
        let mut state = state.lock().unwrap();
        state.requests.push(target.clone());
        if state.hang {
            None
        } else if let Some(location) = state.redirect_to.take() {
            Some(Reply::Redirect(location))
        } else if path == "/api/v1/review-summaries" {
            state.summary_queries.push(query.clone());
            match &state.summaries_override {
                Some((status, body)) => Some(Reply::Body(*status, body.clone())),
                None => {
                    let requested = query.strip_prefix("pluginIds=").unwrap_or("");
                    let mut map = Map::new();
                    for id in requested.split(',').filter(|id| !id.is_empty()) {
                        if let Some(summary) = state.summaries.get(id) {
                            map.insert(id.to_string(), summary.clone());
                        }
                    }
                    Some(Reply::Body(200, json!({ "summaries": map }).to_string()))
                }
            }
        } else if path.starts_with("/api/v1/plugins/") && path.ends_with("/reviews") {
            match &state.reviews {
                Some((status, body)) => Some(Reply::Body(*status, body.to_string())),
                None => Some(Reply::Body(
                    404,
                    "{\"error\":{\"code\":\"NOT_FOUND\"}}".to_string(),
                )),
            }
        } else {
            Some(Reply::Body(
                404,
                "{\"error\":{\"code\":\"NOT_FOUND\"}}".to_string(),
            ))
        }
    };
    let (status, body, location) = match response {
        // Hang: keep the connection open without ever answering.
        None => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            return;
        }
        Some(Reply::Body(status, body)) => (status, body, None),
        Some(Reply::Redirect(location)) => (302, String::new(), Some(location)),
    };
    let head = match location {
        Some(location) => format!(
            "HTTP/1.1 {status} Fixture\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ),
        None => format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            body.len()
        ),
    };
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.flush().await;
}

fn zero_summary(plugin_id: &str) -> Value {
    json!({
        "pluginId": plugin_id,
        "ratingAvg": null,
        "ratingCount": 0,
        "ratingDist": [0, 0, 0, 0, 0],
        "positiveCount": 0,
        "neutralCount": 0,
        "negativeCount": 0,
    })
}

fn error_code(error: &super::JsonRpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("errorCode"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

async fn summaries_via(
    state: Arc<Mutex<AppState>>,
    tx: mpsc::UnboundedSender<String>,
    ids: Value,
) -> Result<Value, super::JsonRpcError> {
    handle_request(
        state,
        "market.reviewSummaries",
        json!({ "pluginIds": ids }),
        tx,
    )
    .await
}

#[tokio::test]
async fn review_summaries_rpc_returns_only_the_centers_answers() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        fixture.summaries.insert(
            "demo.hello".into(),
            json!({
                "pluginId": "demo.hello",
                "ratingAvg": 4.5,
                "ratingCount": 2,
                "ratingDist": [0, 0, 0, 1, 1],
                "positiveCount": 2,
                "neutralCount": 0,
                "negativeCount": 0,
            }),
        );
        fixture
            .summaries
            .insert("demo.notes".into(), zero_summary("demo.notes"));
    });
    env.point_at(&center.catalog_url);

    let result = summaries_via(
        state,
        tx,
        json!(["demo.hello", "demo.notes", "demo.unknown"]),
    )
    .await
    .unwrap();

    assert_eq!(result["summaries"]["demo.hello"]["ratingAvg"], json!(4.5));
    assert_eq!(
        result["summaries"]["demo.hello"]["ratingDist"],
        json!([0, 0, 0, 1, 1])
    );
    // A known plugin without reviews gets the center's own zero summary.
    assert_eq!(result["summaries"]["demo.notes"]["ratingCount"], json!(0));
    // An unknown plugin is omitted, never fabricated as a zero row.
    assert!(result["summaries"].get("demo.unknown").is_none());
    assert_eq!(
        center.summary_queries(),
        vec!["pluginIds=demo.hello,demo.notes,demo.unknown"]
    );
}

#[tokio::test]
async fn review_summaries_rpc_dedupes_and_chunks_installed_ids() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    env.point_at(&center.catalog_url);

    let mut ids: Vec<String> = (0..205).map(|index| format!("demo.p{index}")).collect();
    ids.push("demo.p0".into());
    ids.push("demo.p100".into());
    let result = summaries_via(state, tx, json!(ids)).await.unwrap();
    assert_eq!(result["summaries"], json!({}));

    let queries = center.summary_queries();
    assert_eq!(queries.len(), 3, "{queries:?}");
    let batches: Vec<Vec<&str>> = queries
        .iter()
        .map(|query| {
            query
                .strip_prefix("pluginIds=")
                .unwrap()
                .split(',')
                .collect()
        })
        .collect();
    assert_eq!(batches[0].len(), 100);
    assert_eq!(batches[1].len(), 100);
    assert_eq!(batches[2].len(), 5);
    assert_eq!(batches[0].iter().filter(|id| **id == "demo.p0").count(), 1);
    assert_eq!(
        batches[1].iter().filter(|id| **id == "demo.p100").count(),
        1
    );
    assert_eq!(batches[2].first(), Some(&"demo.p200"));
}

#[tokio::test]
async fn review_summaries_rpc_is_empty_without_asking_the_center() {
    let env = MarketEnv::hold();
    // No service at all: an empty request must not need one.
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();

    let result = summaries_via(state, tx, json!([])).await.unwrap();
    assert_eq!(result, json!({ "summaries": {} }));
}

#[tokio::test]
async fn review_summaries_rpc_rejects_malformed_center_answers() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        fixture.summaries_override = Some((
            200,
            "{\"summaries\":{\"demo.hello\":{\"pluginId\":\"demo.hello\"}}}".into(),
        ));
    });
    env.point_at(&center.catalog_url);

    let error = summaries_via(state, tx, json!(["demo.hello"]))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_MARKET_INVALID");
    assert_eq!(error.code, 1026);
    assert!(error.message.contains("not readable"), "{}", error.message);
}

#[tokio::test]
async fn review_summaries_rpc_reports_a_legacy_center_as_unavailable() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        fixture.summaries_override = Some((404, "{\"error\":{\"code\":\"NOT_FOUND\"}}".into()));
    });
    env.point_at(&center.catalog_url);

    let error = summaries_via(state, tx, json!(["demo.hello"]))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NETWORK");
    assert!(
        error.message.contains("does not serve plugin reviews"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn review_summaries_rpc_never_fabricates_zeros_when_the_center_is_down() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    // Bind and drop a port so nothing answers on it.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    env.point_at(&format!("http://{address}/catalog.json"));

    let error = summaries_via(state, tx, json!(["demo.hello"]))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NETWORK");
    assert!(
        error.message.contains("review request failed"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn review_summaries_rpc_stays_bounded_when_the_center_stalls() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| fixture.hang = true);
    env.point_at(&center.catalog_url);

    let started = Instant::now();
    let error = summaries_via(state, tx, json!(["demo.hello"]))
        .await
        .unwrap_err();
    let elapsed = started.elapsed();
    assert_eq!(error_code(&error), "PLUGIN_NETWORK");
    assert!(
        elapsed >= Duration::from_secs(4),
        "answered too soon: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(15),
        "not bounded: {elapsed:?}"
    );
}

#[tokio::test]
async fn review_summaries_rpc_never_holds_the_host_state_lock_across_io() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| fixture.hang = true);
    env.point_at(&center.catalog_url);

    let call_state = state.clone();
    let call =
        tokio::spawn(async move { summaries_via(call_state, tx, json!(["demo.hello"])).await });
    // Let the review request reach the stalled center, then prove every other
    // host method can still take the state lock while it waits.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let held = tokio::time::timeout(Duration::from_secs(1), state.lock()).await;
    assert!(
        held.is_ok(),
        "the host state lock was held across review network I/O"
    );
    drop(held);

    let error = call.await.unwrap().unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NETWORK");
}

#[tokio::test]
async fn review_summaries_rpc_refuses_a_non_http_center() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();

    let error = summaries_via(state, tx, json!(["demo.hello"]))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NETWORK");
    assert!(error.message.contains("http(s)"), "{}", error.message);
}

#[tokio::test]
async fn review_summaries_rpc_keeps_the_center_bounded() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        let mut body = String::with_capacity(MAX_REVIEW_RESPONSE_BYTES + 64);
        body.push_str("{\"summaries\":{}}");
        body.push_str(&" ".repeat(MAX_REVIEW_RESPONSE_BYTES));
        fixture.summaries_override = Some((200, body));
    });
    env.point_at(&center.catalog_url);

    let error = summaries_via(state, tx, json!(["demo.hello"]))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_MARKET_INVALID");
    assert!(error.message.contains("1MiB"), "{}", error.message);
}

#[tokio::test]
async fn reviews_rpc_returns_the_page_with_a_trusted_review_url() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        fixture.reviews = Some((
            200,
            json!({
                "reviews": [{
                    "id": "r1",
                    "pluginId": "demo.hello",
                    "userId": "account-secret",
                    "authorName": "Ada",
                    "ratingHalfStars": 9,
                    "body": "Great plugin",
                    "status": "visible",
                    "pluginVersion": "1.2.0",
                    "helpfulCount": 3,
                    "createdAt": "2026-10-01T00:00:00Z",
                    "updatedAt": "2026-10-01T00:00:00Z",
                    "editedAt": null,
                    "hiddenReason": "internal moderation note",
                }],
                "nextCursor": "cursor-2",
                "summary": zero_summary("demo.hello"),
            }),
        ));
    });
    env.point_at(&center.catalog_url);

    let result = handle_request(
        state,
        "market.reviews",
        json!({
            "pluginId": "demo.hello",
            "limit": 10,
            "sentiment": "positive",
            "sort": "helpful",
            "cursor": "a b/c+d=e",
        }),
        tx,
    )
    .await
    .unwrap();

    assert_eq!(
        result["reviewUrl"],
        json!(format!("{}/plugins/demo.hello#reviews", center.origin()))
    );
    assert_eq!(result["reviews"][0]["authorName"], json!("Ada"));
    assert_eq!(result["reviews"][0]["ratingHalfStars"], json!(9));
    assert_eq!(result["nextCursor"], json!("cursor-2"));
    assert_eq!(result["summary"]["ratingCount"], json!(0));
    // A public read never carries the account id or moderation data, even
    // when a misbehaving center attaches them.
    let text = result.to_string();
    assert!(!text.contains("account-secret"), "{text}");
    assert!(!text.contains("hiddenReason"), "{text}");
    assert!(!text.contains("internal moderation note"), "{text}");
    assert_eq!(
        center.route_requests("/reviews"),
        vec![
            "/api/v1/plugins/demo.hello/reviews?limit=10&sentiment=positive&sort=helpful&cursor=a%20b%2Fc%2Bd%3De"
        ]
    );
}

#[tokio::test]
async fn reviews_rpc_refuses_non_visible_rows_in_the_public_list() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        fixture.reviews = Some((
            200,
            json!({
                "reviews": [{
                    "id": "r1",
                    "pluginId": "demo.hello",
                    "authorName": "Ada",
                    "ratingHalfStars": 9,
                    "body": "Held for moderation",
                    "status": "pending",
                    "pluginVersion": "",
                    "helpfulCount": 0,
                    "createdAt": "2026-10-01T00:00:00Z",
                    "updatedAt": "2026-10-01T00:00:00Z",
                    "editedAt": null,
                }],
                "nextCursor": null,
                "summary": zero_summary("demo.hello"),
            }),
        ));
    });
    env.point_at(&center.catalog_url);

    let error = handle_request(
        state,
        "market.reviews",
        json!({ "pluginId": "demo.hello" }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_MARKET_INVALID");
}

#[tokio::test]
async fn reviews_rpc_propagates_center_outages() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        fixture.reviews = Some((503, json!({ "error": { "code": "UNAVAILABLE" } })));
    });
    env.point_at(&center.catalog_url);

    let error = handle_request(
        state,
        "market.reviews",
        json!({ "pluginId": "demo.hello" }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NETWORK");
}

#[tokio::test]
async fn reviews_rpc_rejects_invalid_input_before_any_network() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    env.point_at(&center.catalog_url);

    let cases = [
        json!({}),
        json!({ "pluginId": "demo.hello", "limit": 0 }),
        json!({ "pluginId": "demo.hello", "limit": 101 }),
        json!({ "pluginId": "demo.hello", "sort": "oldest" }),
        json!({ "pluginId": "demo.hello", "sentiment": "angry" }),
        json!({ "pluginId": "demo.hello", "cursor": 7 }),
        json!({ "pluginId": "demo.hello/../admin" }),
    ];
    for case in cases {
        let error = handle_request(state.clone(), "market.reviews", case.clone(), tx.clone())
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), "INVALID_PARAMS", "{case}");
    }

    let error = summaries_via(state.clone(), tx.clone(), json!("demo.hello"))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    let error = summaries_via(state, tx, json!(["demo.hello", 42]))
        .await
        .unwrap_err();
    assert_eq!(error_code(&error), "INVALID_PARAMS");
    assert!(
        center.route_requests("/api/v1/").is_empty(),
        "{:?}",
        center.requests()
    );
}

/// One valid public row; cases mutate a copy.
fn valid_review(id: &str) -> Value {
    json!({
        "id": id,
        "pluginId": "demo.hello",
        "authorName": "Ada",
        "ratingHalfStars": 9,
        "body": "Works well.",
        "status": "visible",
        "pluginVersion": "1.2.0",
        "helpfulCount": 1,
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
        "editedAt": null,
    })
}

fn valid_page(reviews: Vec<Value>) -> Value {
    json!({
        "reviews": reviews,
        "nextCursor": null,
        "summary": zero_summary("demo.hello"),
    })
}

#[tokio::test]
async fn reviews_rpc_rejects_pages_that_break_the_public_contract() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    env.point_at(&center.catalog_url);

    let mut wrong_plugin = valid_review("r1");
    wrong_plugin["pluginId"] = json!("demo.other");

    let mut bad_date = valid_review("r1");
    bad_date["createdAt"] = json!("not-a-date");

    let inconsistent_summary = json!({
        "pluginId": "demo.hello",
        "ratingAvg": 4.0,
        "ratingCount": 3,
        "ratingDist": [0, 0, 0, 0, 0],
        "positiveCount": 3,
        "neutralCount": 0,
        "negativeCount": 0,
    });

    let cases: Vec<(&str, Value, u64)> = vec![
        ("wrong plugin", valid_page(vec![wrong_plugin]), 20),
        (
            "page over the limit",
            valid_page(vec![valid_review("r1"), valid_review("r2")]),
            1,
        ),
        ("invalid timestamp", valid_page(vec![bad_date]), 20),
        (
            "inconsistent summary",
            json!({
                "reviews": [],
                "nextCursor": null,
                "summary": inconsistent_summary,
            }),
            20,
        ),
    ];
    for (label, body, limit) in cases {
        center.set(|fixture| fixture.reviews = Some((200, body.clone())));
        let error = handle_request(
            state.clone(),
            "market.reviews",
            json!({ "pluginId": "demo.hello", "limit": limit }),
            tx.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error_code(&error), "PLUGIN_MARKET_INVALID", "{label}");
    }
}

#[tokio::test]
async fn reviews_rpc_never_follows_redirects() {
    let env = MarketEnv::hold();
    env.point_at(OFFLINE_MARKET_URL);
    let (_data, state, tx) = fixture_state();
    let center = Center::start().await;
    center.set(|fixture| {
        // If the read followed this, the fixture would answer the second
        // request with a valid page and the call would succeed.
        fixture.redirect_to =
            Some("/api/v1/plugins/demo.hello/reviews?limit=20&sentiment=all&sort=newest".into());
        fixture.reviews = Some((200, valid_page(vec![valid_review("r1")])));
    });
    env.point_at(&center.catalog_url);

    let error = handle_request(
        state,
        "market.reviews",
        json!({ "pluginId": "demo.hello" }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error_code(&error), "PLUGIN_NETWORK");
    assert!(error.message.contains("redirect"), "{}", error.message);
    assert_eq!(
        center.route_requests("/reviews").len(),
        1,
        "the redirect was followed: {:?}",
        center.requests()
    );
}
