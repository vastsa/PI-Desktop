//! Closed, bounded manifest boundary for versioned provider templates.
use super::*;
use serde_json::Map;

fn closed(object: &Map<String, Value>, fields: &[&str]) -> Result<()> {
    if let Some(key) = object.keys().find(|key| !fields.contains(&key.as_str())) {
        bail!("PLUGIN_INVALID: unsupported provider template field {key}");
    }
    Ok(())
}
// ECMAScript trim/\s includes BOM, unlike Rust's Unicode White_Space.
fn trim_text(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
fn text(value: &Value, max: usize) -> Result<&str> {
    value
        .as_str()
        .filter(|s| {
            !trim_text(s).is_empty()
                && s.encode_utf16().count() <= max
                && !s.chars().any(char::is_control)
        })
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: invalid or oversized template string"))
}
fn optional_text(object: &Map<String, Value>, key: &str, max: usize) -> Result<()> {
    if let Some(value) = object.get(key) {
        text(value, max)?;
    }
    Ok(())
}
fn url(value: &Value) -> Result<()> {
    let raw = text(value, 2048)?;
    let (scheme, rest) = raw
        .split_once("://")
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: template URL requires an explicit authority"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if !["http", "https"]
        .iter()
        .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
        || authority.is_empty()
        || authority.contains('@')
        || raw
            .chars()
            .any(|c| c.is_whitespace() || c == '\u{feff}' || c == '\\' || c == '#')
    {
        bail!("PLUGIN_INVALID: invalid raw template URL");
    }
    let parsed =
        reqwest::Url::parse(raw).map_err(|_| anyhow!("PLUGIN_INVALID: invalid template URL"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || raw.trim() != raw
    {
        bail!("PLUGIN_INVALID: template URL must be absolute http(s), without credentials or fragment");
    }
    Ok(())
}
fn oauth_url(value: &Value) -> Result<()> {
    url(value)?;
    if !value.as_str().is_some_and(|raw| {
        raw.get(..8)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
    }) {
        bail!("PLUGIN_INVALID: OAuth template URL must use HTTPS");
    }
    Ok(())
}
fn localized(value: &Value, max: usize) -> Result<()> {
    if let Some(object) = value.as_object() {
        closed(object, &["en", "zh-CN"])?;
        for key in ["en", "zh-CN"] {
            text(
                object
                    .get(key)
                    .ok_or_else(|| anyhow!("PLUGIN_INVALID: missing localized template string"))?,
                max,
            )?;
        }
    } else {
        text(value, max)?;
    }
    Ok(())
}

pub(super) fn validate_templates(manifest: &PluginManifest) -> Result<()> {
    let Some(contributions) = manifest.contributes.as_ref().and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(templates) = contributions.get("providerTemplates") else {
        return Ok(());
    };
    let templates = templates
        .as_array()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: providerTemplates must be an array"))?;
    if !templates.is_empty() {
        validation::require_permission(manifest, "provider.register", "providerTemplates")?;
    }
    let mut ids: Vec<&str> = contributions
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("id").and_then(Value::as_str))
        .collect();
    for template in templates {
        let object = template
            .as_object()
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: template must be an object"))?;
        closed(
            object,
            &[
                "version",
                "id",
                "name",
                "category",
                "description",
                "vendorKey",
                "baseUrl",
                "apiStyle",
                "authKind",
                "models",
                "adapter",
                "oauth",
            ],
        )?;
        if object.get("version").and_then(Value::as_u64) != Some(1) {
            bail!("PLUGIN_INVALID: template version must be 1");
        }
        let id = text(
            object
                .get("id")
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: template id required"))?,
            64,
        )?;
        if !id.as_bytes()[0].is_ascii_alphabetic()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || ids.contains(&id)
        {
            bail!("PLUGIN_INVALID: invalid or duplicate provider template id");
        }
        ids.push(id);
        text(
            object
                .get("name")
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: template name required"))?,
            128,
        )?;
        optional_text(object, "vendorKey", 128)?;
        for (key, max) in [("category", 128), ("description", 280)] {
            if let Some(value) = object.get(key) {
                localized(value, max)?;
            }
        }
        if let Some(value) = object.get("baseUrl") {
            url(value)?;
        }
        if let Some(value) = object.get("apiStyle") {
            if !is_known_api_style(text(value, 64)?) {
                bail!("PLUGIN_INVALID: invalid template apiStyle");
            }
        }
        let auth = object
            .get("authKind")
            .map(|v| text(v, 32))
            .transpose()?
            .unwrap_or("api_key");
        if !is_known_auth_kind(auth) {
            bail!("PLUGIN_INVALID: invalid template authKind");
        }
        if auth == "oauth" && !object.contains_key("baseUrl") {
            bail!("PLUGIN_INVALID: OAuth template requires baseUrl");
        }
        validate_oauth(object, auth, manifest)?;
        let models = object
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: template models required"))?;
        if models.len() > MAX_PLUGIN_PROVIDER_MODELS
            || (models.is_empty() && (auth != "api_key" || !object.contains_key("baseUrl")))
        {
            bail!("PLUGIN_INVALID: invalid template model count");
        }
        let mut seen = Vec::new();
        for model in models {
            let model = model
                .as_object()
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: template model must be an object"))?;
            closed(
                model,
                &[
                    "id",
                    "name",
                    "contextWindow",
                    "maxTokens",
                    "supportsImages",
                    "thinkingLevels",
                    "defaultThinkingLevel",
                    "operations",
                ],
            )?;
            let id = text(
                model
                    .get("id")
                    .ok_or_else(|| anyhow!("PLUGIN_INVALID: model id required"))?,
                256,
            )?;
            let id = trim_text(id);
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate template model id");
            }
            seen.push(id);
            optional_text(model, "name", 128)?;
            optional_text(model, "defaultThinkingLevel", 64)?;
            for key in ["contextWindow", "maxTokens"] {
                if let Some(value) = model.get(key) {
                    if value.as_u64().is_none_or(|n| n == 0 || n > u32::MAX as u64) {
                        bail!("PLUGIN_INVALID: template model limit must be a positive uint32");
                    }
                }
            }
            if model.get("supportsImages").is_some_and(|v| !v.is_boolean()) {
                bail!("PLUGIN_INVALID: supportsImages must be boolean");
            }
            if let Some(levels) = model.get("thinkingLevels") {
                let levels = levels
                    .as_array()
                    .filter(|v| v.len() <= 16)
                    .ok_or_else(|| anyhow!("PLUGIN_INVALID: invalid thinkingLevels"))?;
                for level in levels {
                    text(level, 64)?;
                }
            }
        }
        // The existing adapter/operation contract is shared, but OAuth flow is
        // validated above rather than through the legacy callback-only gate.
        let mut adapter = object.clone();
        adapter.remove("oauth");
        validate_declared_provider_oauth(id, &adapter, "none", manifest)?;
    }
    Ok(())
}

fn validate_oauth(
    object: &Map<String, Value>,
    auth: &str,
    manifest: &PluginManifest,
) -> Result<()> {
    let oauth = object.get("oauth");
    if auth != "oauth" {
        if oauth.is_some() {
            bail!("PLUGIN_INVALID: oauth requires authKind oauth");
        }
        return Ok(());
    }
    let flow = oauth
        .and_then(|v| v.get("flow"))
        .and_then(Value::as_str)
        .unwrap_or("custom");
    if flow == "custom" {
        validation::require_permission(manifest, "provider.oauth", "custom template OAuth")?;
    }
    let Some(oauth) = oauth else {
        return Ok(());
    };
    let oauth = oauth
        .as_object()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: oauth must be an object"))?;
    closed(
        oauth,
        &[
            "flow",
            "loginLabel",
            "isSubscription",
            "clientId",
            "authorizationUrl",
            "tokenUrl",
            "deviceAuthorizationUrl",
            "scopes",
            "redirectPath",
        ],
    )?;
    if !["custom", "authorization_code", "device_code"].contains(&flow)
        || oauth.get("flow").is_some_and(|v| !v.is_string())
    {
        bail!("PLUGIN_INVALID: invalid OAuth flow");
    }
    optional_text(oauth, "loginLabel", 128)?;
    if flow == "custom" {
        closed(oauth, &["loginLabel", "isSubscription", "flow"])?;
        if oauth.get("isSubscription").is_some_and(|v| !v.is_boolean()) {
            bail!("PLUGIN_INVALID: isSubscription must be boolean");
        }
        return Ok(());
    }
    optional_text(oauth, "clientId", 512)?;
    if flow == "authorization_code" {
        if oauth.contains_key("deviceAuthorizationUrl") {
            bail!("PLUGIN_INVALID: authorization_code does not accept deviceAuthorizationUrl");
        }
    } else if oauth.contains_key("authorizationUrl") || oauth.contains_key("redirectPath") {
        bail!("PLUGIN_INVALID: device_code does not accept authorizationUrl or redirectPath");
    }
    if oauth.get("isSubscription").is_some_and(|v| !v.is_boolean()) {
        bail!("PLUGIN_INVALID: isSubscription must be boolean");
    }
    for key in ["authorizationUrl", "tokenUrl", "deviceAuthorizationUrl"] {
        if let Some(value) = oauth.get(key) {
            oauth_url(value)?;
        }
    }
    if flow != "custom" {
        for key in [
            "clientId",
            "tokenUrl",
            if flow == "authorization_code" {
                "authorizationUrl"
            } else {
                "deviceAuthorizationUrl"
            },
        ] {
            if !oauth.contains_key(key) {
                bail!("PLUGIN_INVALID: declarative OAuth requires {key}");
            }
        }
    }
    if let Some(scopes) = oauth.get("scopes") {
        let scopes = scopes
            .as_array()
            .filter(|v| v.len() <= 64)
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: invalid OAuth scopes"))?;
        let mut seen = Vec::new();
        for scope in scopes {
            let scope = text(scope, 256)?;
            if !scope
                .bytes()
                .all(|b| b == 0x21 || (0x23..=0x5b).contains(&b) || (0x5d..=0x7e).contains(&b))
                || seen.contains(&scope)
            {
                bail!("PLUGIN_INVALID: OAuth scopes must be unique RFC 6749 scope tokens");
            }
            seen.push(scope);
        }
    }
    if let Some(path) = oauth.get("redirectPath") {
        let path = text(path, 256)?;
        if !path.starts_with('/')
            || path.starts_with("//")
            || !path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-'))
        {
            bail!("PLUGIN_INVALID: invalid OAuth redirectPath");
        }
    }
    Ok(())
}
