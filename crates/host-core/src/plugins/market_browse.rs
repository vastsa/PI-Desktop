//! Paged marketplace browsing (`market.browse`).
//!
//! The plugin center answers one page of its catalog at
//! `/api/v1/catalog/search`, so the Extensions surface does not have to hold
//! the whole marketplace to show a page of it. The entries it returns are the
//! same shape `catalog.json` carries; the host resolves their package URLs
//! against the catalog source and maps them to summaries exactly as it does
//! for the full document, so trust, install and update rules stay in one place.
//!
//! A center that predates the route, an unreachable one, or a source that is
//! not an http(s) center (a git mirror or a local file) falls back to paging
//! the last valid catalog snapshot with the same query semantics. Remote pages
//! are cached in-process for a minute, and a center that does not serve the
//! route is remembered for five, so browsing an older center does not cost a
//! failed request per keystroke.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use super::marketplace::category_label;
use super::reviews::{encode_component, get_json_limited, review_origin_for_catalog};
use super::*;

pub(crate) const DEFAULT_PAGE_SIZE: u32 = 24;
pub(crate) const MAX_PAGE_SIZE: u32 = 60;
const MAX_QUERY_CHARS: usize = 200;
const MAX_CATEGORY_CHARS: usize = 100;
/// A page carries complete entries including readmes; larger is broken.
pub(crate) const MAX_BROWSE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const BROWSE_CACHE_TTL: Duration = Duration::from_secs(60);
const BROWSE_UNSUPPORTED_TTL: Duration = Duration::from_secs(300);
/// An unreachable center is not asked again for this long, so typing offline
/// answers from the snapshot at once instead of waiting out each timeout.
const BROWSE_UNREACHABLE_TTL: Duration = Duration::from_secs(30);
const BROWSE_CACHE_ENTRIES: usize = 64;

/// Orders a browse can ask for. The names are the center's wire values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrowseSort {
    Recommended,
    Popular,
    Updated,
    Name,
}

impl BrowseSort {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Recommended => "recommended",
            Self::Popular => "popular",
            Self::Updated => "updated",
            Self::Name => "name",
        }
    }

    fn parse(value: &str) -> Self {
        match value.trim() {
            "popular" => Self::Popular,
            "updated" => Self::Updated,
            "name" => Self::Name,
            _ => Self::Recommended,
        }
    }
}

/// One normalized browse request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MarketBrowseQuery {
    pub(crate) query: String,
    pub(crate) category: String,
    pub(crate) sort: BrowseSort,
    pub(crate) seed: u32,
    pub(crate) page: u32,
    pub(crate) page_size: u32,
}

impl MarketBrowseQuery {
    /// Read RPC params leniently: a browse is never worth an error, so a
    /// malformed field falls back to its default and an oversized one is
    /// clamped.
    pub(crate) fn from_params(params: &Value) -> Self {
        let text = |key: &str, max: usize| -> String {
            let raw = params.get(key).and_then(Value::as_str).unwrap_or("");
            // Control characters are never meaningful in a search and would
            // collide with the cache-key separator.
            raw.replace(|c: char| c.is_control(), " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(max)
                .collect()
        };
        let number = |key: &str| params.get(key).and_then(Value::as_u64);
        Self {
            query: text("query", MAX_QUERY_CHARS),
            category: text("category", MAX_CATEGORY_CHARS),
            sort: BrowseSort::parse(params.get("sort").and_then(Value::as_str).unwrap_or("")),
            seed: number("seed")
                .and_then(|seed| u32::try_from(seed).ok())
                .unwrap_or(0),
            page: number("page")
                .and_then(|page| u32::try_from(page).ok())
                .filter(|page| *page >= 1)
                .unwrap_or(1),
            page_size: number("pageSize")
                .and_then(|size| u32::try_from(size).ok())
                .filter(|size| *size >= 1)
                .map(|size| size.min(MAX_PAGE_SIZE))
                .unwrap_or(DEFAULT_PAGE_SIZE),
        }
    }

    fn cache_key(&self, catalog_url: &str) -> String {
        format!(
            "{catalog_url}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            self.query.to_lowercase(),
            self.category.to_lowercase(),
            self.sort.as_str(),
            self.seed,
            self.page,
            self.page_size
        )
    }
}

/// One category and how many of the query's matches carry it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCategoryFacet {
    pub id: String,
    /// The label for the app's language, when the source published one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub count: u64,
}

/// Entries of one page, before the host maps them to summaries.
#[derive(Clone, Debug, Default)]
pub(crate) struct BrowsePage {
    pub(crate) entries: Vec<MarketCatalogEntry>,
    pub(crate) total: u64,
    pub(crate) categories: Vec<MarketCategoryFacet>,
    /// Labels for the page's category ids, from the center or the snapshot.
    pub(crate) labels: CategoryLabels,
}

/// Where a page came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrowseSource {
    Remote,
    Local,
}

/// The `market.browse` answer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketBrowseResult {
    pub plugins: Vec<MarketPluginSummary>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub page_count: u32,
    pub sort: &'static str,
    pub categories: Vec<MarketCategoryFacet>,
    /// `remote` for a page the center answered, `local` for the snapshot.
    pub source: &'static str,
    /// Why the remote page was not used, when the snapshot answered instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    pub provider_id: String,
    pub source_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseWire {
    total: u64,
    #[serde(default)]
    categories: Vec<MarketCategoryFacet>,
    plugins: Vec<MarketCatalogEntry>,
    #[serde(default)]
    artifact_base_url: Option<String>,
    #[serde(default)]
    category_labels: CategoryLabels,
}

#[derive(Default)]
struct BrowseCache {
    pages: HashMap<String, (Instant, BrowsePage)>,
    /// Catalog sources whose center does not serve the route, and since when.
    unsupported: HashMap<String, Instant>,
    /// Catalog sources whose center could not be reached, and since when.
    unreachable: HashMap<String, Instant>,
}

fn browse_cache() -> &'static Mutex<BrowseCache> {
    static CACHE: OnceLock<Mutex<BrowseCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BrowseCache::default()))
}

fn with_cache<T>(f: impl FnOnce(&mut BrowseCache) -> T) -> T {
    let mut guard = browse_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

/// Forget every cached page. An explicit marketplace refresh calls this, so
/// "refresh" never answers with a page from before it.
pub(crate) fn clear_browse_cache() {
    with_cache(|cache| {
        cache.pages.clear();
        cache.unsupported.clear();
        cache.unreachable.clear();
    });
}

/// An entry a fresh remote page carried for this source.
///
/// The detail sheet opens from a card, and a card may come from a remote page
/// newer than the local snapshot; this keeps the detail readable offline of
/// the snapshot until the next refresh catches up.
pub(crate) fn cached_browse_entry(
    catalog_url: &str,
    plugin_id: &str,
) -> Option<MarketCatalogEntry> {
    let prefix = format!("{catalog_url}\u{1f}");
    with_cache(|cache| {
        cache
            .pages
            .iter()
            .filter(|(key, (at, _))| key.starts_with(&prefix) && at.elapsed() < BROWSE_CACHE_TTL)
            .filter_map(|(_, (at, page))| {
                page.entries
                    .iter()
                    .find(|e| e.id == plugin_id)
                    .map(|entry| (*at, entry))
            })
            // Several pages may carry the plugin; the newest answer wins.
            .max_by_key(|(at, _)| *at)
            .map(|(_, entry)| entry.clone())
    })
}

/// Search URL for one query on the trusted origin.
pub(crate) fn browse_url(origin: &str, query: &MarketBrowseQuery) -> String {
    let mut url = format!(
        "{origin}/api/v1/catalog/search?sort={}&page={}&pageSize={}",
        query.sort.as_str(),
        query.page,
        query.page_size
    );
    if query.seed != 0 {
        url.push_str(&format!("&seed={}", query.seed));
    }
    if !query.query.is_empty() {
        url.push_str("&q=");
        url.push_str(&encode_component(&query.query));
    }
    if !query.category.is_empty() {
        url.push_str("&category=");
        url.push_str(&encode_component(&query.category));
    }
    url
}

/// Read one page from the center, through the in-process cache.
///
/// `catalog_url` is the effective catalog source: the origin is derived from
/// it, and relative package URLs resolve against it exactly as the full
/// catalog's do.
pub(crate) fn fetch_remote_page(
    catalog_url: &str,
    query: &MarketBrowseQuery,
) -> Result<BrowsePage> {
    let origin = review_origin_for_catalog(catalog_url).ok_or_else(|| {
        anyhow!("PLUGIN_MARKET_UNSUPPORTED: the catalog source is not a plugin center")
    })?;
    let key = query.cache_key(catalog_url);
    let cached = with_cache(|cache| {
        if let Some(since) = cache.unsupported.get(catalog_url) {
            if since.elapsed() < BROWSE_UNSUPPORTED_TTL {
                return Some(Err(anyhow!(
                    "PLUGIN_MARKET_UNSUPPORTED: the plugin center does not serve paged search"
                )));
            }
        }
        if let Some(since) = cache.unreachable.get(catalog_url) {
            if since.elapsed() < BROWSE_UNREACHABLE_TTL {
                return Some(Err(anyhow!(
                    "PLUGIN_NETWORK: the plugin center was unreachable moments ago"
                )));
            }
        }
        cache
            .pages
            .get(&key)
            .filter(|(at, _)| at.elapsed() < BROWSE_CACHE_TTL)
            .map(|(_, page)| Ok(page.clone()))
    });
    if let Some(answer) = cached {
        return answer;
    }

    let url = browse_url(&origin, query);
    let (status, payload) =
        match get_json_limited(&url, MAX_BROWSE_RESPONSE_BYTES, "marketplace search") {
            Ok(answer) => answer,
            Err(error) => {
                with_cache(|cache| {
                    cache
                        .unreachable
                        .insert(catalog_url.to_string(), Instant::now());
                });
                return Err(error);
            }
        };
    if status == 404 || status == 405 {
        with_cache(|cache| {
            cache
                .unsupported
                .insert(catalog_url.to_string(), Instant::now());
        });
        bail!("PLUGIN_MARKET_UNSUPPORTED: the plugin center does not serve paged search");
    }
    if status != 200 {
        with_cache(|cache| {
            cache
                .unreachable
                .insert(catalog_url.to_string(), Instant::now());
        });
        bail!("PLUGIN_NETWORK: the plugin center answered marketplace search with http {status}");
    }
    let page = parse_remote_page(catalog_url, query, &payload)?;
    with_cache(|cache| {
        if cache.pages.len() >= BROWSE_CACHE_ENTRIES {
            cache
                .pages
                .retain(|_, (at, _)| at.elapsed() < BROWSE_CACHE_TTL);
            if cache.pages.len() >= BROWSE_CACHE_ENTRIES {
                cache.pages.clear();
            }
        }
        cache.pages.insert(key, (Instant::now(), page.clone()));
    });
    Ok(page)
}

/// Validate a center answer and resolve its package URLs.
pub(crate) fn parse_remote_page(
    catalog_url: &str,
    query: &MarketBrowseQuery,
    payload: &[u8],
) -> Result<BrowsePage> {
    let wire: BrowseWire = serde_json::from_slice(payload).map_err(|error| {
        anyhow!("PLUGIN_MARKET_INVALID: the plugin center's search answer is not readable: {error}")
    })?;
    if wire.plugins.len() > query.page_size as usize {
        bail!("PLUGIN_MARKET_INVALID: the plugin center returned more plugins than the page size");
    }
    if (wire.plugins.len() as u64) > wire.total {
        bail!("PLUGIN_MARKET_INVALID: the plugin center's search total is smaller than its page");
    }
    let base = wire.artifact_base_url;
    let mut entries = Vec::with_capacity(wire.plugins.len());
    for mut entry in wire.plugins {
        if entry.id.trim().is_empty() {
            bail!("PLUGIN_MARKET_INVALID: the plugin center returned a plugin without an id");
        }
        for version in &mut entry.versions {
            version.url =
                PluginManager::resolve_package_url(catalog_url, base.as_deref(), &version.url);
        }
        entries.push(entry);
    }
    Ok(BrowsePage {
        entries,
        labels: wire.category_labels,
        total: wire.total,
        categories: wire
            .categories
            .into_iter()
            .filter(|facet| !facet.id.trim().is_empty())
            .collect(),
    })
}

/// Page a catalog snapshot with the center's query semantics.
///
/// The order of a seeded shuffle differs from the center's — only its
/// stability across pages matters — while filtering, facets, the other sorts
/// and paging agree.
pub(crate) fn local_browse(catalog: &MarketCatalogFile, query: &MarketBrowseQuery) -> BrowsePage {
    let tokens: Vec<String> = query
        .query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let mut facets: BTreeMap<String, MarketCategoryFacet> = BTreeMap::new();
    let mut hits: Vec<(u32, &MarketCatalogEntry)> = Vec::new();
    for entry in &catalog.plugins {
        if entry.id.starts_with("demo.") {
            continue;
        }
        let Some(score) = match_score(entry, &tokens) else {
            continue;
        };
        let mut seen = Vec::new();
        for category in &entry.categories {
            let category = category.trim();
            let key = category.to_lowercase();
            if category.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            facets
                .entry(key)
                .and_modify(|facet| facet.count += 1)
                .or_insert_with(|| MarketCategoryFacet {
                    id: category.to_string(),
                    name: None,
                    count: 1,
                });
        }
        if !query.category.is_empty()
            && !entry
                .categories
                .iter()
                .any(|c| c.trim().eq_ignore_ascii_case(&query.category))
        {
            continue;
        }
        hits.push((score, entry));
    }

    hits.sort_by(|a, b| a.1.id.cmp(&b.1.id));
    let by_name = |a: &MarketCatalogEntry, b: &MarketCatalogEntry| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    };
    match query.sort {
        BrowseSort::Popular => hits.sort_by(|a, b| {
            b.1.downloads
                .unwrap_or(0)
                .cmp(&a.1.downloads.unwrap_or(0))
                .then_with(|| by_name(a.1, b.1))
        }),
        BrowseSort::Updated => hits.sort_by(|a, b| {
            latest_published(b.1)
                .cmp(latest_published(a.1))
                .then_with(|| by_name(a.1, b.1))
        }),
        BrowseSort::Name => hits.sort_by(|a, b| by_name(a.1, b.1)),
        BrowseSort::Recommended => {
            seeded_shuffle(
                &mut hits,
                if query.seed == 0 {
                    0x9e37_79b9
                } else {
                    query.seed
                },
            );
            if !tokens.is_empty() {
                hits.sort_by_key(|hit| std::cmp::Reverse(hit.0));
            }
        }
    }

    let total = hits.len() as u64;
    let start = (query.page.saturating_sub(1) as usize).saturating_mul(query.page_size as usize);
    let entries = hits
        .into_iter()
        .skip(start)
        .take(query.page_size as usize)
        .map(|(_, entry)| entry.clone())
        .collect();
    let mut categories: Vec<MarketCategoryFacet> = facets.into_values().collect();
    categories.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.id.cmp(&b.id)));
    BrowsePage {
        entries,
        labels: catalog.category_labels.clone(),
        total,
        categories,
    }
}

/// Every token must match; a name or id hit outranks a description hit.
fn match_score(entry: &MarketCatalogEntry, tokens: &[String]) -> Option<u32> {
    if tokens.is_empty() {
        return Some(0);
    }
    let mut names = vec![entry.id.to_lowercase(), entry.name.to_lowercase()];
    let mut rest = vec![
        entry.description.to_lowercase(),
        entry.author.to_lowercase(),
    ];
    rest.extend(entry.categories.iter().map(|c| c.to_lowercase()));
    if let Some(map) = entry.i18n.as_ref() {
        for text in map.values() {
            if let Some(name) = &text.name {
                names.push(name.to_lowercase());
            }
            if let Some(description) = &text.description {
                rest.push(description.to_lowercase());
            }
        }
    }
    let mut score = 0;
    for token in tokens {
        let best = names
            .iter()
            .map(|name| {
                if name == token {
                    100
                } else if name.starts_with(token.as_str()) {
                    60
                } else if name.contains(token.as_str()) {
                    40
                } else {
                    0
                }
            })
            .max()
            .unwrap_or(0);
        let best = if best == 0 && rest.iter().any(|text| text.contains(token.as_str())) {
            10
        } else {
            best
        };
        if best == 0 {
            return None;
        }
        score += best;
    }
    Some(score)
}

fn latest_published(entry: &MarketCatalogEntry) -> &str {
    entry
        .versions
        .iter()
        .filter(|version| !version.yanked)
        .map(|version| version.published_at.as_str())
        .max()
        .unwrap_or("")
}

/// Fisher–Yates driven by xorshift32: deterministic for a seed, no RNG crate.
fn seeded_shuffle<T>(items: &mut [T], seed: u32) {
    let mut state = seed.max(1);
    for i in (1..items.len()).rev() {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let j = (state as usize) % (i + 1);
        items.swap(i, j);
    }
}

impl PluginManager {
    /// The effective catalog source, for a browse that runs off the state lock.
    pub(crate) fn browse_catalog_url(&self) -> String {
        self.market_source_url()
    }

    /// Page the last valid catalog snapshot. Never touches the network.
    pub(crate) fn market_browse_local(&self, query: &MarketBrowseQuery) -> Result<BrowsePage> {
        let catalog = self.load_cached_catalog()?;
        Ok(local_browse(&catalog, query))
    }

    /// Map a page to the answer the renderer renders.
    pub(crate) fn market_browse_result(
        &self,
        query: &MarketBrowseQuery,
        page: BrowsePage,
        source: BrowseSource,
        fallback_reason: Option<String>,
    ) -> MarketBrowseResult {
        let page_size = query.page_size.max(1);
        let page_count =
            u32::try_from(page.total.div_ceil(u64::from(page_size))).unwrap_or(u32::MAX);
        MarketBrowseResult {
            plugins: page
                .entries
                .iter()
                .map(|entry| {
                    let mut summary = self.to_market_summary(entry);
                    self.localize_categories(entry, &mut summary, &page.labels);
                    summary
                })
                .collect(),
            total: page.total,
            page: query.page,
            page_size,
            page_count,
            sort: query.sort.as_str(),
            categories: page
                .categories
                .into_iter()
                .map(|mut facet| {
                    facet.name = Some(category_label(&page.labels, &facet.id, &self.locale));
                    facet
                })
                .collect(),
            source: match source {
                BrowseSource::Remote => "remote",
                BrowseSource::Local => "local",
            },
            fallback_reason,
            provider_id: self.channel().as_str().to_string(),
            source_url: self.market_source_url(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        id: &str,
        name: &str,
        description: &str,
        downloads: u64,
        published: &str,
        categories: &[&str],
    ) -> MarketCatalogEntry {
        MarketCatalogEntry {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            author: "acme".into(),
            categories: categories.iter().map(|c| c.to_string()).collect(),
            downloads: Some(downloads),
            versions: vec![MarketVersion {
                version: "1.0.0".into(),
                published_at: published.into(),
                url: "packages/x.piplug".into(),
                shasum: "ab".repeat(32),
                ..MarketVersion::default()
            }],
            ..MarketCatalogEntry::default()
        }
    }

    fn fixture() -> MarketCatalogFile {
        MarketCatalogFile {
            plugins: vec![
                entry(
                    "pi.todo",
                    "Todo",
                    "Task list",
                    50,
                    "2026-01-03T00:00:00Z",
                    &["Productivity"],
                ),
                entry(
                    "pi.notes",
                    "Notes",
                    "Write notes and todo lists",
                    80,
                    "2026-01-01T00:00:00Z",
                    &["productivity", "Writing"],
                ),
                entry(
                    "pi.browser",
                    "Browser",
                    "Drive a browser",
                    10,
                    "2026-01-05T00:00:00Z",
                    &["Tools"],
                ),
                entry(
                    "pi.git",
                    "Git",
                    "Repository tools",
                    30,
                    "2026-01-02T00:00:00Z",
                    &["Tools"],
                ),
                entry(
                    "demo.hello",
                    "Hello",
                    "Sample",
                    999,
                    "2026-01-09T00:00:00Z",
                    &["Tools"],
                ),
            ],
            ..MarketCatalogFile::default()
        }
    }

    fn query(params: Value) -> MarketBrowseQuery {
        MarketBrowseQuery::from_params(&params)
    }

    fn ids(page: &BrowsePage) -> Vec<&str> {
        page.entries.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn params_are_normalized_and_clamped() {
        let q = query(
            json!({ "query": "  a   b ", "sort": "bogus", "page": 0, "pageSize": 9999, "seed": -1 }),
        );
        assert_eq!(q.query, "a b");
        assert_eq!(q.sort, BrowseSort::Recommended);
        assert_eq!((q.page, q.page_size, q.seed), (1, MAX_PAGE_SIZE, 0));
        let q = query(json!({}));
        assert_eq!((q.page, q.page_size), (1, DEFAULT_PAGE_SIZE));
    }

    #[test]
    fn local_pages_cover_every_plugin_once_and_skip_samples() {
        let catalog = fixture();
        let mut seen = Vec::new();
        for page in 1..=3 {
            let got = local_browse(
                &catalog,
                &query(json!({ "seed": 7, "page": page, "pageSize": 2 })),
            );
            assert_eq!(got.total, 4);
            seen.extend(ids(&got).into_iter().map(str::to_string));
        }
        seen.sort();
        assert_eq!(seen, ["pi.browser", "pi.git", "pi.notes", "pi.todo"]);
    }

    #[test]
    fn local_search_filters_ranks_and_counts_facets() {
        let catalog = fixture();
        let got = local_browse(&catalog, &query(json!({ "query": "todo" })));
        assert_eq!(ids(&got), ["pi.todo", "pi.notes"]);
        let got = local_browse(
            &catalog,
            &query(json!({ "category": "PRODUCTIVITY", "sort": "name" })),
        );
        assert_eq!(ids(&got), ["pi.notes", "pi.todo"]);
        assert_eq!(
            got.categories,
            vec![
                MarketCategoryFacet {
                    name: None,
                    id: "Productivity".into(),
                    count: 2
                },
                MarketCategoryFacet {
                    name: None,
                    id: "Tools".into(),
                    count: 2
                },
                MarketCategoryFacet {
                    name: None,
                    id: "Writing".into(),
                    count: 1
                },
            ]
        );
        let got = local_browse(&catalog, &query(json!({ "sort": "popular" })));
        assert_eq!(ids(&got), ["pi.notes", "pi.todo", "pi.git", "pi.browser"]);
        let got = local_browse(&catalog, &query(json!({ "sort": "updated" })));
        assert_eq!(ids(&got), ["pi.browser", "pi.todo", "pi.git", "pi.notes"]);
    }

    #[test]
    fn category_labels_fall_back_in_a_defined_order() {
        let mut labels = CategoryLabels::new();
        let mut zh = std::collections::BTreeMap::new();
        zh.insert("en".to_string(), "Productivity".to_string());
        zh.insert("zh-CN".to_string(), "效率工具".to_string());
        labels.insert("productivity".to_string(), zh);

        assert_eq!(category_label(&labels, "productivity", "zh-CN"), "效率工具");
        // Traditional Chinese reads the Simplified label rather than English.
        assert_eq!(category_label(&labels, "productivity", "zh-TW"), "效率工具");
        assert_eq!(
            category_label(&labels, "productivity", "de"),
            "Productivity"
        );
        // A catalog that predates the vocabulary names nothing; the id stands.
        assert_eq!(category_label(&labels, "themes", "zh-CN"), "themes");
    }

    #[test]
    fn a_page_carries_the_labels_of_its_categories() {
        let q = query(json!({ "pageSize": 2 }));
        let payload = json!({
            "total": 1,
            "categoryLabels": {
                "themes": { "en": "Themes", "zh-CN": "外观主题" }
            },
            "categories": [{ "id": "themes", "count": 1 }],
            "plugins": [{
                "id": "pi.parchment", "name": "Parchment", "description": "", "author": "acme",
                "categories": ["themes"],
                "versions": [{ "version": "1.0.0", "publishedAt": "2026-01-01T00:00:00Z",
                    "shasum": "ab", "url": "packages/x.piplug", "sizeBytes": 1, "permissions": [] }]
            }]
        });
        let page = parse_remote_page(
            "https://plugins.example/catalog.json",
            &q,
            payload.to_string().as_bytes(),
        )
        .unwrap();
        assert_eq!(page.labels["themes"]["zh-CN"], "外观主题");
        assert_eq!(category_label(&page.labels, "themes", "en"), "Themes");
        assert_eq!(page.entries[0].categories, ["themes"]);
    }

    #[test]
    fn browse_url_encodes_the_query() {
        let q = query(json!({ "query": "待办 a&b", "category": "AI Tools", "seed": 9, "page": 2 }));
        assert_eq!(
            browse_url("https://plugins.example", &q),
            "https://plugins.example/api/v1/catalog/search?sort=recommended&page=2&pageSize=24&seed=9&q=%E5%BE%85%E5%8A%9E%20a%26b&category=AI%20Tools"
        );
    }

    #[test]
    fn remote_pages_resolve_package_urls_and_reject_oversized_pages() {
        let q = query(json!({ "pageSize": 1 }));
        let payload = json!({
            "total": 3,
            "artifactBaseUrl": "https://cdn.example/dl",
            "categories": [{ "id": "Tools", "count": 3 }, { "id": " ", "count": 1 }],
            "plugins": [{
                "id": "pi.git", "name": "Git", "description": "", "author": "acme",
                "versions": [{ "version": "1.0.0", "publishedAt": "2026-01-01T00:00:00Z",
                    "shasum": "ab", "url": "packages/pi.git-1.0.0.piplug", "sizeBytes": 1, "permissions": [] }]
            }]
        });
        let page = parse_remote_page(
            "https://plugins.example/catalog.json",
            &q,
            payload.to_string().as_bytes(),
        )
        .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.categories.len(), 1);
        assert_eq!(
            page.entries[0].versions[0].url,
            "https://cdn.example/dl/packages/pi.git-1.0.0.piplug"
        );

        let mut too_many = payload.clone();
        too_many["plugins"] = json!([payload["plugins"][0], payload["plugins"][0]]);
        assert!(parse_remote_page(
            "https://plugins.example/catalog.json",
            &q,
            too_many.to_string().as_bytes()
        )
        .is_err());
        assert!(
            parse_remote_page("https://plugins.example/catalog.json", &q, b"not json").is_err()
        );
    }
}
