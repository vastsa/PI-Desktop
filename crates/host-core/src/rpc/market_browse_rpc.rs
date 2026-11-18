//! `market.browse`: one page of the marketplace.
//!
//! The catalog source is captured under the host state lock and the lock is
//! released before the plugin center is asked, so a slow center cannot queue
//! every other host method behind the search deadline. The page is mapped to
//! summaries under the lock again, because installed state and the display
//! locale live there. A remote failure is not an error: the last valid
//! snapshot answers the same query, and the answer says so.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use super::{plugin_err, rpc_err, JsonRpcError};
use crate::plugins::market_browse::{fetch_remote_page, BrowseSource, MarketBrowseQuery};
use crate::state::AppState;

pub(super) async fn browse(
    state: &Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let query = MarketBrowseQuery::from_params(&params);
    let catalog_url = {
        let st = state.lock().await;
        st.plugins.browse_catalog_url()
    };
    let remote = {
        let query = query.clone();
        let catalog_url = catalog_url.clone();
        tokio::task::spawn_blocking(move || fetch_remote_page(&catalog_url, &query))
            .await
            .map_err(|error| rpc_err(1000, format!("browse worker failed: {error}"), "INTERNAL"))?
    };

    let st = state.lock().await;
    // The source can change while the center was being asked; a page from the
    // old source must not be presented as the current one.
    let current_url = st.plugins.browse_catalog_url();
    let (page, source, fallback_reason) = match remote {
        Ok(page) if current_url == catalog_url => (page, BrowseSource::Remote, None),
        Ok(_) => (
            st.plugins.market_browse_local(&query).map_err(plugin_err)?,
            BrowseSource::Local,
            Some(
                "PLUGIN_MARKET_SOURCE_CHANGED: the catalog source changed during the search".into(),
            ),
        ),
        Err(error) => (
            st.plugins.market_browse_local(&query).map_err(plugin_err)?,
            BrowseSource::Local,
            Some(error.to_string()),
        ),
    };
    let result = st
        .plugins
        .market_browse_result(&query, page, source, fallback_reason);
    serde_json::to_value(result).map_err(|error| {
        rpc_err(
            1000,
            format!("browse page is not serializable: {error}"),
            "INTERNAL",
        )
    })
}
