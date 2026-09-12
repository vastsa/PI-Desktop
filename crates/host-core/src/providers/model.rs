use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPublic {
    pub id: String,
    pub name: String,
    pub vendor_key: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub protocol: String,
    pub enabled: bool,
    pub base_url: Option<String>,
    pub auth_kind: String,
    /// True when the provider holds any usable credential — a stored API key
    /// **or** a vendor-account OAuth credential. Readiness checks across the
    /// app key off this, so both auth channels light up the same way.
    pub has_secret: bool,
    /// True when a vendor-account OAuth credential is stored. Distinguishes the
    /// two channels for UI that must hide the API key field or badge the row.
    pub has_oauth: bool,
    /// Non-secret label for the signed-in vendor account (e.g. an email or plan
    /// name). Never carries a token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_account_label: Option<String>,
    /// Optional outbound HTTP headers. Empty/absent keeps adapter defaults
    /// (pi-ai / `claude-cli` / OpenCode). Not a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    pub models: Vec<ModelBinding>,
    /// Legacy default retained so older renderer/runtime clients can continue
    /// reading a provider while they migrate to `models`.
    pub default_model_id: Option<String>,
    pub api_style: Option<String>,
    /// Explicit provider-level reasoning override.  `None` means the model
    /// catalog resolver should infer capability from the selected model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_reasoning: Option<bool>,
    /// Optional sparse thinking-level override for custom/compatible models.
    /// `None` keeps catalog/default level resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_thinking_levels: Option<Vec<String>>,
    /// Model context window override in tokens. `None` uses the runtime default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    /// Max output tokens override. `None` uses the runtime default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// Sampling temperature override. `None` leaves the provider default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCreateInput {
    pub name: String,
    pub vendor_key: Option<String>,
    #[serde(rename = "type")]
    pub provider_type: Option<String>,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub auth_kind: Option<String>,
    #[serde(default)]
    pub models: Option<Vec<ModelBinding>>,
    pub default_model_id: Option<String>,
    pub secret_value: Option<String>,
    pub api_style: Option<String>,
    pub oauth_account_label: Option<String>,
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    pub supports_reasoning: Option<bool>,
    pub supported_thinking_levels: Option<Vec<String>>,
    /// Zero (or negative temperature) clears a stored override.
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpdateInput {
    pub id: String,
    pub name: Option<String>,
    pub vendor_key: Option<String>,
    #[serde(rename = "type")]
    pub provider_type: Option<String>,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub auth_kind: Option<String>,
    #[serde(default)]
    pub models: Option<Vec<ModelBinding>>,
    pub default_model_id: Option<String>,
    pub secret_value: Option<String>,
    pub api_style: Option<String>,
    pub oauth_account_label: Option<String>,
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    pub supports_reasoning: Option<bool>,
    pub supported_thinking_levels: Option<Vec<String>>,
    /// Zero (or negative temperature) clears a stored override.
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelBinding {
    pub id: String,
    /// Optional display alias. A blank or absent alias falls back to the catalog's
    /// published name; `id` remains the wire identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub context_window: u32,
    pub max_tokens: u32,
    #[serde(default)]
    pub thinking_levels: Vec<String>,
    pub default_thinking_level: Option<String>,
    /// Attachment capability overrides. `None` follows the published catalog
    /// capability, so a models.dev correction still reaches a saved binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_documents: Option<bool>,
    /// Whether this model may be selected for AI-driven subagent delegation.
    /// None/false keeps the opt-in disabled for existing provider records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_for_subagents: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogItem {
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub source: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModelInput {
    pub model_id: String,
    pub display_name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub context_window: Option<u32>,
}
