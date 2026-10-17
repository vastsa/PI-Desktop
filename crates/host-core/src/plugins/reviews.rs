//! Anonymous plugin reviews read from the plugin center.
//!
//! The desktop reads reviews and rating summaries through the host, so the
//! renderer keeps no network access of its own and no account, cookie, or
//! device credential is involved. Every request URL is built from the origin
//! of the effective catalog source — the trusted official center, or the
//! environment override that points a dev build or a test at a local fixture —
//! so review content can never redirect a request to another host.
//!
//! Reads are bounded: five seconds and one mebibyte per request, with ids
//! deduplicated and batched to the center's hundred-id summaries limit. A
//! failure propagates as an error; a zero summary is only ever the center's
//! own answer, never something this module made up. Redirects are refused —
//! every URL is already built against the trusted origin, so a 3xx is an
//! answer to reject, not a hop to follow — and curl is required, exactly as
//! for the plugin center's other endpoints.

use std::collections::{BTreeMap, BTreeSet};

use chrono::DateTime;

use super::*;

/// How long one review read may take before it is abandoned.
pub(crate) const REVIEW_TIMEOUT_SECONDS: u64 = 5;

/// Reviews are text; a larger answer is a broken one, not a page to render.
pub(crate) const MAX_REVIEW_RESPONSE_BYTES: usize = 1024 * 1024;

/// The number of plugin ids one summaries request may carry.
pub(crate) const MAX_SUMMARY_IDS: usize = 100;

/// Bodies a public read may carry; the write contract bounds them at 2000
/// unicode codepoints.
const MAX_REVIEW_BODY_CHARS: usize = 2000;

/// Display bounds for the strings a review row carries.
const MAX_AUTHOR_NAME_CHARS: usize = 200;
const MAX_PLUGIN_VERSION_CHARS: usize = 128;

/// Aggregated visible reviews for one plugin.
///
/// `rating_avg` is null exactly when nothing visible can be averaged; the
/// distribution is floored into whole-star buckets (4.5 -> index 3), matching
/// the center's contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReviewSummary {
    pub plugin_id: String,
    pub rating_avg: Option<f64>,
    pub rating_count: u64,
    pub rating_dist: [u64; 5],
    pub positive_count: u64,
    pub neutral_count: u64,
    pub negative_count: u64,
}

/// Moderation state of one review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginReviewStatus {
    Visible,
    Pending,
    Hidden,
    Deleted,
}

/// One review as the public read returns it.
///
/// The field set is deliberately the public contract: the author's account id,
/// a hidden reason, and moderation/audit fields are not part of it, and serde
/// drops anything a misbehaving center might attach beyond these fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReview {
    pub id: String,
    pub plugin_id: String,
    pub author_name: String,
    pub rating_half_stars: u8,
    pub body: String,
    pub status: PluginReviewStatus,
    pub plugin_version: String,
    pub helpful_count: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub edited_at: Option<String>,
}

/// One page of public reviews plus where the full list lives on the web.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReviewPage {
    pub reviews: Vec<PluginReview>,
    pub next_cursor: Option<String>,
    pub summary: PluginReviewSummary,
    /// Reviews webpage on the trusted center, built by the host.
    pub review_url: String,
}

/// Which reviews one read asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PluginReviewQuery {
    pub(crate) plugin_id: String,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: u32,
    pub(crate) sentiment: ReviewSentiment,
    pub(crate) sort: ReviewSort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewSentiment {
    All,
    Positive,
    Neutral,
    Negative,
}

impl ReviewSentiment {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Positive => "positive",
            Self::Neutral => "neutral",
            Self::Negative => "negative",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "positive" => Some(Self::Positive),
            "neutral" => Some(Self::Neutral),
            "negative" => Some(Self::Negative),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewSort {
    Newest,
    Helpful,
}

impl ReviewSort {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Newest => "newest",
            Self::Helpful => "helpful",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "newest" => Some(Self::Newest),
            "helpful" => Some(Self::Helpful),
            _ => None,
        }
    }
}

impl PluginManager {
    /// Origin of the trusted plugin center in effect.
    ///
    /// The effective catalog source decides: the configured official center,
    /// or the environment override a dev build or a test pointed at a local
    /// fixture. Only the origin is kept — review reads cannot leave the host
    /// the catalog came from — and a non-http(s) source has no review service
    /// at all, which callers report as unavailable rather than as zero data.
    pub(crate) fn review_origin(&self) -> Result<String> {
        review_origin_for_catalog(&self.market_source_url())
            .ok_or_else(|| anyhow!("PLUGIN_NETWORK: plugin reviews need an http(s) plugin center"))
    }
}

/// Trusted origin of a catalog URL.
///
/// The same rule the download-resolve endpoint uses: the scheme must be
/// http(s), the authority must be present and free of credentials, and only a
/// small host/port alphabet is admitted, so an odd catalog URL cannot smuggle
/// a query, fragment, or userinfo into a review request.
pub(crate) fn review_origin_for_catalog(catalog_url: &str) -> Option<String> {
    let (scheme, rest) = catalog_url.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty()
        || !authority
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}

/// Deduplicate plugin ids and split them into center-sized batches.
///
/// The center accepts at most [`MAX_SUMMARY_IDS`] ids per summaries request,
/// and callers hand over the ids of whatever rows they are showing; dedup
/// keeps a plugin from being asked twice when several surfaces contribute the
/// same id.
pub(crate) fn summary_id_chunks(ids: &[String]) -> Vec<Vec<String>> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::with_capacity(ids.len());
    for id in ids {
        if seen.insert(id.as_str()) {
            unique.push(id.clone());
        }
    }
    unique
        .chunks(MAX_SUMMARY_IDS)
        .map(<[String]>::to_vec)
        .collect()
}

/// Summaries URL for one batch of ids on the trusted origin.
pub(crate) fn summaries_url(origin: &str, ids: &[String]) -> String {
    format!(
        "{origin}/api/v1/review-summaries?pluginIds={}",
        ids.join(",")
    )
}

/// Reviews URL for one query on the trusted origin.
pub(crate) fn reviews_url(origin: &str, query: &PluginReviewQuery) -> String {
    let mut url = format!(
        "{origin}/api/v1/plugins/{}/reviews?limit={}&sentiment={}&sort={}",
        encode_component(&query.plugin_id),
        query.limit,
        query.sentiment.as_str(),
        query.sort.as_str(),
    );
    if let Some(cursor) = &query.cursor {
        url.push_str("&cursor=");
        url.push_str(&encode_component(cursor));
    }
    url
}

/// Public reviews webpage for one plugin on the trusted center.
pub(crate) fn review_page_url(origin: &str, plugin_id: &str) -> String {
    format!("{origin}/plugins/{}#reviews", encode_component(plugin_id))
}

/// Read summaries for the given ids, batched and deduplicated.
///
/// Ids the center does not know are left out; ids the center answers for but
/// nobody asked about are dropped. A failed batch fails the whole read — a
/// partial map would be indistinguishable from "no reviews".
pub(crate) fn fetch_review_summaries(
    origin: &str,
    ids: &[String],
) -> Result<BTreeMap<String, PluginReviewSummary>> {
    let requested: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    let mut summaries = BTreeMap::new();
    for chunk in summary_id_chunks(ids) {
        let url = summaries_url(origin, &chunk);
        let (status, payload) = get_json(&url)?;
        if status != 200 {
            return Err(center_refusal(&url, status, &payload));
        }
        let wire: SummariesWire = serde_json::from_slice(&payload).map_err(|error| {
            anyhow!("PLUGIN_MARKET_INVALID: the plugin center's review summary answer is not readable: {error}")
        })?;
        for (id, summary) in wire.summaries {
            if !requested.contains(id.as_str()) {
                continue;
            }
            validate_summary(&summary, &id)?;
            summaries.insert(id, summary);
        }
    }
    Ok(summaries)
}

/// Read one page of public reviews plus its summary and webpage URL.
pub(crate) fn fetch_reviews(origin: &str, query: &PluginReviewQuery) -> Result<PluginReviewPage> {
    let url = reviews_url(origin, query);
    let (status, payload) = get_json(&url)?;
    if status != 200 {
        return Err(center_refusal(&url, status, &payload));
    }
    let wire: ReviewsWire = serde_json::from_slice(&payload).map_err(|error| {
        anyhow!("PLUGIN_MARKET_INVALID: the plugin center's review answer is not readable: {error}")
    })?;
    validate_summary(&wire.summary, &query.plugin_id)?;
    // The center owns paging, but a page larger than the limit that was asked
    // for is not one this client will render.
    if wire.reviews.len() > query.limit as usize {
        bail!("PLUGIN_MARKET_INVALID: the plugin center returned more reviews than the page limit");
    }
    for review in &wire.reviews {
        validate_review(review, &query.plugin_id)?;
    }
    validate_cursor(wire.next_cursor.as_deref())?;
    Ok(PluginReviewPage {
        reviews: wire.reviews,
        next_cursor: wire.next_cursor,
        summary: wire.summary,
        review_url: review_page_url(origin, &query.plugin_id),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummariesWire {
    summaries: BTreeMap<String, PluginReviewSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewsWire {
    reviews: Vec<PluginReview>,
    next_cursor: Option<String>,
    summary: PluginReviewSummary,
}

/// Validate one summary against the public contract.
///
/// The counters are one partition of the same visible rows: the five floor
/// buckets and the three sentiment counts each add up to `ratingCount`, and
/// the average exists exactly when there is at least one rating.
fn validate_summary(summary: &PluginReviewSummary, expected_id: &str) -> Result<()> {
    if summary.plugin_id != expected_id {
        bail!(
            "PLUGIN_MARKET_INVALID: review summary for {expected_id} names {}",
            summary.plugin_id
        );
    }
    let distribution = summary
        .rating_dist
        .iter()
        .try_fold(0_u64, |total, count| total.checked_add(*count));
    if distribution != Some(summary.rating_count) {
        bail!("PLUGIN_MARKET_INVALID: review summary for {expected_id} does not add up to its rating count");
    }
    let sentiments = summary
        .positive_count
        .checked_add(summary.neutral_count)
        .and_then(|total| total.checked_add(summary.negative_count));
    if sentiments != Some(summary.rating_count) {
        bail!("PLUGIN_MARKET_INVALID: review summary for {expected_id} sentiment counts do not add up to its rating count");
    }
    match (summary.rating_count, summary.rating_avg) {
        // No visible ratings means no average; a number there would render as
        // ratings nobody left.
        (0, Some(_)) => {
            bail!("PLUGIN_MARKET_INVALID: review summary for {expected_id} averages zero ratings")
        }
        (count, None) if count > 0 => {
            bail!("PLUGIN_MARKET_INVALID: review summary for {expected_id} has ratings but no average")
        }
        (_, Some(average)) if !average.is_finite() || !(0.0..=5.0).contains(&average) => {
            bail!("PLUGIN_MARKET_INVALID: review summary for {expected_id} has an out-of-range average");
        }
        _ => {}
    }
    Ok(())
}

/// Validate one public review row against the public contract.
///
/// The row must belong to the plugin that was asked about, carry a visible
/// moderation state, a 2..=10 half-star rating, ISO-8601 timestamps, and
/// display-bounded text; the author's account id and moderation details are
/// not part of the shape at all.
fn validate_review(review: &PluginReview, expected_plugin_id: &str) -> Result<()> {
    if review.plugin_id != expected_plugin_id {
        bail!(
            "PLUGIN_MARKET_INVALID: review {} belongs to {}, not {expected_plugin_id}",
            review.id,
            review.plugin_id
        );
    }
    if review.id.trim().is_empty() {
        bail!("PLUGIN_MARKET_INVALID: the public review list carried a review without an id");
    }
    if !(2..=10).contains(&review.rating_half_stars) {
        bail!(
            "PLUGIN_MARKET_INVALID: review {} has an out-of-range rating",
            review.id
        );
    }
    // The public list carries visible rows only; a moderation state leaking
    // into it is a contract violation, not something to render.
    if review.status != PluginReviewStatus::Visible {
        bail!("PLUGIN_MARKET_INVALID: the public review list carried a non-visible row");
    }
    if review.body.trim().is_empty() || review.body.chars().count() > MAX_REVIEW_BODY_CHARS {
        bail!(
            "PLUGIN_MARKET_INVALID: review {} has a body outside the public bounds",
            review.id
        );
    }
    if review.author_name.chars().count() > MAX_AUTHOR_NAME_CHARS {
        bail!(
            "PLUGIN_MARKET_INVALID: review {} has an author name outside the public bounds",
            review.id
        );
    }
    if review.plugin_version.chars().count() > MAX_PLUGIN_VERSION_CHARS {
        bail!(
            "PLUGIN_MARKET_INVALID: review {} has a plugin version outside the public bounds",
            review.id
        );
    }
    validate_review_date(&review.id, "createdAt", &review.created_at)?;
    validate_review_date(&review.id, "updatedAt", &review.updated_at)?;
    if let Some(edited_at) = &review.edited_at {
        validate_review_date(&review.id, "editedAt", edited_at)?;
    }
    Ok(())
}

fn validate_review_date(review_id: &str, field: &str, value: &str) -> Result<()> {
    if DateTime::parse_from_rfc3339(value).is_err() {
        bail!("PLUGIN_MARKET_INVALID: review {review_id} has an invalid {field} timestamp");
    }
    Ok(())
}

fn validate_cursor(cursor: Option<&str>) -> Result<()> {
    if let Some(cursor) = cursor {
        if cursor.len() > 4096 || cursor.chars().any(char::is_control) {
            bail!("PLUGIN_MARKET_INVALID: the plugin center returned an invalid review cursor");
        }
    }
    Ok(())
}

/// The error a non-2xx review answer becomes.
///
/// A center without the review routes (legacy deployment) is unavailable, not
/// a client mistake; a rate limit is its own state; a malformed request the
/// center rejected stays a market-invalid answer.
fn center_refusal(url: &str, status: u16, payload: &[u8]) -> anyhow::Error {
    let envelope: Option<Value> = serde_json::from_slice(payload).ok();
    let message = envelope
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("no reason given");
    match status {
        429 => anyhow!("PLUGIN_MARKET_RATE_LIMITED: the plugin center asked to wait: {message}"),
        400 => anyhow!(
            "PLUGIN_MARKET_INVALID: the plugin center refused the review request: {message}"
        ),
        // Every review URL is already built against the trusted origin, so a
        // redirect is an answer to reject: following one would move the read
        // to a host the catalog never named.
        301 | 302 | 303 | 307 | 308 => anyhow!(
            "PLUGIN_NETWORK: the plugin center redirected {url}; review reads do not follow redirects"
        ),
        404 | 405 | 501 => {
            anyhow!("PLUGIN_NETWORK: the plugin center does not serve plugin reviews ({status})")
        }
        _ => anyhow!("PLUGIN_NETWORK: the plugin center answered {status} for {url}: {message}"),
    }
}

/// One bounded anonymous GET against the trusted center origin.
///
/// Mirrors the marketplace download path, so proxy settings and TLS handling
/// stay identical to every other plugin-center request. The body lands in a
/// scratch file and the status is read from `--write-out`, so an error answer
/// still yields the center's error envelope instead of a curl diagnostic.
/// Redirects are never followed: the request already targets the trusted
/// origin, and `3xx` answers become refusals.
fn get_json(url: &str) -> Result<(u16, Vec<u8>)> {
    let response_path = super::install::download_scratch_path();
    let mut args: Vec<String> = vec![
        "--silent".into(),
        "--show-error".into(),
        "--max-time".into(),
        REVIEW_TIMEOUT_SECONDS.to_string(),
        "--max-filesize".into(),
        MAX_REVIEW_RESPONSE_BYTES.to_string(),
        "--output".into(),
        response_path.to_string_lossy().into_owned(),
        "--write-out".into(),
        "%{http_code}".into(),
        "--user-agent".into(),
        "pi-desktop-host-core".into(),
    ];
    args.extend(crate::network_proxy::curl_proxy_args());
    args.extend(crate::network_proxy::curl_tls_args());
    if url.starts_with("https://") {
        args.push("--proto".into());
        args.push("=https".into());
    }
    args.push(url.to_string());

    let outcome = std::process::Command::new("curl").args(&args).output();
    match outcome {
        Ok(output) if output.status.success() => {
            let status = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u16>()
                .unwrap_or(0);
            let payload = fs::read(&response_path).unwrap_or_default();
            let _ = fs::remove_file(&response_path);
            if payload.len() > MAX_REVIEW_RESPONSE_BYTES {
                bail!(
                    "PLUGIN_MARKET_INVALID: the plugin center's review answer exceeds the 1MiB limit"
                );
            }
            if status == 0 {
                bail!("PLUGIN_NETWORK: the plugin center gave no http status for {url}");
            }
            Ok((status, payload))
        }
        Ok(output) => {
            let _ = fs::remove_file(&response_path);
            // 63 is curl's `--max-filesize` refusal: a policy limit, not an
            // outage.
            if output.status.code() == Some(63) {
                bail!(
                    "PLUGIN_MARKET_INVALID: the plugin center's review answer exceeds the 1MiB limit"
                );
            }
            bail!(
                "PLUGIN_NETWORK: review request failed for {url}: {}",
                decode_curl_output(&output.stderr)
            )
        }
        Err(error) => Err(anyhow!(
            "PLUGIN_NETWORK: curl is required to reach the plugin center: {error}"
        )),
    }
}

/// Percent-encode one URL component.
///
/// Ids are validated before they get here, but the cursor is opaque center
/// state, so everything outside the unreserved set is encoded.
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_reads_are_bounded() {
        assert_eq!(REVIEW_TIMEOUT_SECONDS, 5);
        assert_eq!(MAX_REVIEW_RESPONSE_BYTES, 1024 * 1024);
        assert_eq!(MAX_SUMMARY_IDS, 100);
    }

    #[test]
    fn the_origin_keeps_only_the_catalogs_host() {
        assert_eq!(
            review_origin_for_catalog("https://plugins.aiuo.net/catalog.json").as_deref(),
            Some("https://plugins.aiuo.net")
        );
        assert_eq!(
            review_origin_for_catalog("http://127.0.0.1:8787/catalog.json").as_deref(),
            Some("http://127.0.0.1:8787"),
            "a fixture deployment on a port keeps it"
        );
        assert_eq!(review_origin_for_catalog("file:///tmp/catalog.json"), None);
        assert_eq!(
            review_origin_for_catalog("https://user:secret@plugins.aiuo.net/catalog.json"),
            None,
            "credentials in a catalog url are not a review origin"
        );
        assert_eq!(
            review_origin_for_catalog("https://plugins.aiuo.net?x=1/catalog.json"),
            None,
            "a query smuggled into the authority is not a host"
        );
    }

    #[test]
    fn summaries_batches_dedupe_and_cap_at_one_hundred() {
        let mut ids: Vec<String> = (0..205).map(|index| format!("demo.p{index}")).collect();
        ids.push("demo.p0".into());
        ids.push("demo.p100".into());
        let chunks = summary_id_chunks(&ids);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), 100);
        assert_eq!(chunks[1].len(), 100);
        assert_eq!(chunks[2].len(), 5);
        assert_eq!(chunks[0].iter().filter(|id| *id == "demo.p0").count(), 1);
        assert_eq!(chunks[1].iter().filter(|id| *id == "demo.p100").count(), 1);
    }

    #[test]
    fn review_urls_stay_on_the_trusted_origin() {
        let query = PluginReviewQuery {
            plugin_id: "demo.hello".into(),
            cursor: Some("a b/c+d=e".into()),
            limit: 10,
            sentiment: ReviewSentiment::Positive,
            sort: ReviewSort::Helpful,
        };
        assert_eq!(
            reviews_url("https://plugins.aiuo.net", &query),
            "https://plugins.aiuo.net/api/v1/plugins/demo.hello/reviews?limit=10&sentiment=positive&sort=helpful&cursor=a%20b%2Fc%2Bd%3De"
        );
        assert_eq!(
            summaries_url("http://127.0.0.1:8787", &["a.b".into(), "c-d".into()]),
            "http://127.0.0.1:8787/api/v1/review-summaries?pluginIds=a.b,c-d"
        );
        assert_eq!(
            review_page_url("https://plugins.aiuo.net", "demo.hello"),
            "https://plugins.aiuo.net/plugins/demo.hello#reviews"
        );
    }

    fn summary_consistent() -> PluginReviewSummary {
        PluginReviewSummary {
            plugin_id: "demo.hello".into(),
            rating_avg: Some(4.5),
            rating_count: 2,
            rating_dist: [0, 0, 0, 1, 1],
            positive_count: 2,
            neutral_count: 0,
            negative_count: 0,
        }
    }

    #[test]
    fn summary_consistency_is_enforced() {
        let valid = summary_consistent();
        assert!(validate_summary(&valid, "demo.hello").is_ok());

        let mut wrong_plugin = valid.clone();
        wrong_plugin.plugin_id = "demo.other".into();
        assert!(validate_summary(&wrong_plugin, "demo.hello").is_err());

        // A zero-count summary must carry no average.
        let zero_with_average = PluginReviewSummary {
            rating_avg: Some(1.0),
            rating_count: 0,
            rating_dist: [0, 0, 0, 0, 0],
            positive_count: 0,
            neutral_count: 0,
            negative_count: 0,
            ..valid.clone()
        };
        assert!(validate_summary(&zero_with_average, "demo.hello").is_err());

        // Ratings without an average are equally inconsistent.
        let missing_average = PluginReviewSummary {
            rating_avg: None,
            ..valid.clone()
        };
        assert!(validate_summary(&missing_average, "demo.hello").is_err());

        // The distribution must add up to the rating count.
        let bad_dist = PluginReviewSummary {
            rating_dist: [0, 0, 0, 1, 0],
            ..valid.clone()
        };
        assert!(validate_summary(&bad_dist, "demo.hello").is_err());

        // So must the sentiment counts.
        let bad_sentiments = PluginReviewSummary {
            positive_count: 1,
            neutral_count: 1,
            negative_count: 1,
            ..valid.clone()
        };
        assert!(validate_summary(&bad_sentiments, "demo.hello").is_err());

        let out_of_range = PluginReviewSummary {
            rating_avg: Some(5.5),
            ..valid.clone()
        };
        assert!(validate_summary(&out_of_range, "demo.hello").is_err());

        let zero = PluginReviewSummary {
            plugin_id: "demo.hello".into(),
            rating_avg: None,
            rating_count: 0,
            rating_dist: [0, 0, 0, 0, 0],
            positive_count: 0,
            neutral_count: 0,
            negative_count: 0,
        };
        assert!(validate_summary(&zero, "demo.hello").is_ok());
    }

    fn review_consistent() -> PluginReview {
        PluginReview {
            id: "r1".into(),
            plugin_id: "demo.hello".into(),
            author_name: "Ada".into(),
            rating_half_stars: 9,
            body: "Works well.".into(),
            status: PluginReviewStatus::Visible,
            plugin_version: "1.2.0".into(),
            helpful_count: 3,
            created_at: "2026-10-01T00:00:00Z".into(),
            updated_at: "2026-10-01T00:00:00Z".into(),
            edited_at: None,
        }
    }

    #[test]
    fn review_contract_is_enforced() {
        let valid = review_consistent();
        assert!(validate_review(&valid, "demo.hello").is_ok());

        let wrong_plugin = PluginReview {
            plugin_id: "demo.other".into(),
            ..valid.clone()
        };
        assert!(validate_review(&wrong_plugin, "demo.hello").is_err());

        let mut pending = valid.clone();
        pending.status = PluginReviewStatus::Pending;
        assert!(validate_review(&pending, "demo.hello").is_err());

        let mut bad_rating = valid.clone();
        bad_rating.rating_half_stars = 1;
        assert!(validate_review(&bad_rating, "demo.hello").is_err());

        let mut bad_created = valid.clone();
        bad_created.created_at = "yesterday".into();
        assert!(validate_review(&bad_created, "demo.hello").is_err());

        let mut bad_edited = valid.clone();
        bad_edited.edited_at = Some("2026-13-45T00:00:00Z".into());
        assert!(validate_review(&bad_edited, "demo.hello").is_err());

        let mut empty_body = valid.clone();
        empty_body.body = "   ".into();
        assert!(validate_review(&empty_body, "demo.hello").is_err());

        let mut long_body = valid.clone();
        long_body.body = "x".repeat(MAX_REVIEW_BODY_CHARS + 1);
        assert!(validate_review(&long_body, "demo.hello").is_err());

        // The empty version the contract permits, and an edit timestamp, both
        // stay acceptable.
        let mut edited = valid.clone();
        edited.plugin_version = String::new();
        edited.edited_at = Some("2026-10-02T00:00:00Z".into());
        assert!(validate_review(&edited, "demo.hello").is_ok());
    }
}
