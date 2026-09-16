use super::*;

pub(crate) fn validate_contributions(root: &Path, manifest: &PluginManifest) -> Result<()> {
    let Some(contributes) = manifest.contributes.as_ref() else {
        return Ok(());
    };
    if contributes.is_null() {
        return Ok(());
    }
    let Some(map) = contributes.as_object() else {
        bail!("PLUGIN_INVALID: contributes must be an object");
    };

    if let Some(settings) = map.get("settings") {
        let entries = array_of(settings, "contributes.settings")?;
        let mut seen: Vec<&str> = Vec::new();
        let command_ids: Vec<&str> = map
            .get("commands")
            .and_then(Value::as_array)
            .map(|commands| {
                commands
                    .iter()
                    .filter_map(|command| command.get("id").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.settings entry must be an object")
            })?;
            let key = obj
                .get("key")
                .and_then(Value::as_str)
                .filter(|key| is_setting_key(key))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: setting key is missing or invalid"))?;
            if seen.contains(&key) {
                bail!("PLUGIN_INVALID: duplicate setting key {key}");
            }
            seen.push(key);
            if obj
                .get("title")
                .and_then(Value::as_str)
                .map(|title| title.trim().is_empty())
                .unwrap_or(true)
            {
                bail!("PLUGIN_INVALID: setting {key} requires a title");
            }
            let setting_type = obj
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: setting {key} requires a type"))?;
            if !matches!(
                setting_type,
                "string" | "number" | "boolean" | "select" | "json" | "shortcut"
            ) {
                bail!("PLUGIN_INVALID: setting {key} has unsupported type {setting_type}");
            }
            if obj.get("secret").and_then(Value::as_bool) == Some(true) {
                bail!("PLUGIN_INVALID: setting {key} cannot be secret in this release");
            }
            if setting_type == "shortcut" {
                if let Some(scope) = obj.get("scope").and_then(Value::as_str) {
                    if scope != "plugin" {
                        bail!(
                            "PLUGIN_INVALID: setting {key} only supports the plugin shortcut scope"
                        );
                    }
                }
                if obj
                    .get("command")
                    .and_then(Value::as_str)
                    .map(|command| command.trim().is_empty())
                    .unwrap_or(true)
                {
                    bail!("PLUGIN_INVALID: shortcut setting {key} requires a command");
                }
                let command = obj
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !command_ids.contains(&command) {
                    bail!(
                        "PLUGIN_INVALID: shortcut setting {key} references an undeclared command"
                    );
                }
                if let Some(default) = obj.get("default") {
                    if !is_shortcut_shape(default) {
                        bail!("PLUGIN_INVALID: shortcut setting {key} has an invalid default");
                    }
                }
            }
            if setting_type == "select" {
                let options = obj
                    .get("enum")
                    .and_then(Value::as_array)
                    .filter(|options| !options.is_empty())
                    .ok_or_else(|| {
                        anyhow!("PLUGIN_INVALID: select setting {key} requires enum options")
                    })?;
                for option in options {
                    let option = option.as_object().ok_or_else(|| {
                        anyhow!("PLUGIN_INVALID: select setting {key} has an invalid enum option")
                    })?;
                    if option.get("label").and_then(Value::as_str).is_none()
                        || !option
                            .get("value")
                            .map(|value| {
                                value.is_string() || value.is_number() || value.is_boolean()
                            })
                            .unwrap_or(false)
                    {
                        bail!("PLUGIN_INVALID: select setting {key} has an invalid enum option");
                    }
                }
            }
        }
    }

    if let Some(shortcuts) = map.get("globalShortcuts") {
        let entries = array_of(shortcuts, "contributes.globalShortcuts")?;
        if entries.len() > 8 {
            bail!("PLUGIN_INVALID: contributes.globalShortcuts allows at most 8 entries");
        }
        // The gate is the permission, not the contribution: a declared shortcut
        // without `keyboard.globalShortcut` would otherwise register silently.
        if !entries.is_empty() {
            require_permission(manifest, "keyboard.globalShortcut", "global shortcuts")?;
        }
        let command_ids: Vec<&str> = map
            .get("commands")
            .and_then(Value::as_array)
            .map(|commands| {
                commands
                    .iter()
                    .filter_map(|command| command.get("id").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.globalShortcuts entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_shortcut_id(id))
                .ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: global shortcut id is missing or invalid")
                })?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate global shortcut id {id}");
            }
            seen.push(id);
            let command = obj
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|command| !command.is_empty())
                .ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: global shortcut {id} requires a command")
                })?;
            if !command_ids.contains(&command) {
                bail!("PLUGIN_INVALID: global shortcut {id} references an undeclared command");
            }
            if let Some(default) = obj.get("default") {
                if !is_shortcut_shape(default) {
                    bail!("PLUGIN_INVALID: global shortcut {id} has an invalid default");
                }
            }
        }
    }
    if let Some(skills) = map.get("skills") {
        let entries = array_of(skills, "contributes.skills")?;
        for entry in entries {
            let path = match entry {
                Value::String(s) => s.as_str(),
                Value::Object(obj) => obj.get("path").and_then(Value::as_str).ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: contributes.skills entry needs path")
                })?,
                _ => bail!("PLUGIN_INVALID: contributes.skills entry must be a string or object"),
            };
            let resolved = safe_join(root, path)?;
            if !resolved.exists() {
                bail!("PLUGIN_INVALID: skill file missing: {path}");
            }
        }
    }

    if let Some(extensions) = map.get("agentExtensions") {
        let entries = array_of(extensions, "contributes.agentExtensions")?;
        if entries.len() > 8 {
            bail!("PLUGIN_INVALID: contributes.agentExtensions allows at most 8 entries");
        }
        if !entries.is_empty() {
            require_permission(manifest, "agent.extension", "agent extensions")?;
        }
        for entry in entries {
            let path = entry.as_str().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.agentExtensions entries must be paths")
            })?;
            if !(path.ends_with(".ts")
                || path.ends_with(".mts")
                || path.ends_with(".js")
                || path.ends_with(".mjs"))
            {
                bail!(
                    "PLUGIN_INVALID: contributes.agentExtensions entries must be .ts or .js files"
                );
            }
            let resolved = safe_join(root, path)?;
            if !resolved.exists() {
                bail!("PLUGIN_INVALID: agent extension file missing: {path}");
            }
        }
    }

    if let Some(providers) = map.get("providers") {
        let entries = array_of(providers, "contributes.providers")?;
        if entries.len() > MAX_PLUGIN_PROVIDERS {
            bail!(
                "PLUGIN_INVALID: contributes.providers allows at most {MAX_PLUGIN_PROVIDERS} entries"
            );
        }
        if !entries.is_empty() {
            require_permission(manifest, "provider.register", "contributes.providers")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.providers entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: provider declaration id is missing or invalid")
                })?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate provider declaration id {id}");
            }
            seen.push(id);
            if obj
                .get("name")
                .and_then(Value::as_str)
                .map(|name| name.trim().is_empty())
                .unwrap_or(true)
            {
                bail!("PLUGIN_INVALID: provider {id} requires a name");
            }
            if let Some(style) = obj.get("apiStyle") {
                let style = style.as_str().ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: provider {id} apiStyle must be a string")
                })?;
                if !is_known_api_style(style) {
                    bail!("PLUGIN_INVALID: provider {id} has unsupported apiStyle {style}");
                }
            }
            // `oauth` declarations arrive with the Host-owned plugin login
            // flow. Until it exists, a manifest that asks for one is refused
            // rather than turned into a row nobody can sign in to.
            if obj.get("oauth").is_some() {
                bail!(
                    "PLUGIN_INVALID: provider {id} declares oauth; plugin OAuth providers are not supported in this release"
                );
            }
            let auth_kind = obj
                .get("authKind")
                .and_then(Value::as_str)
                .unwrap_or("api_key");
            if !is_known_auth_kind(auth_kind) {
                bail!("PLUGIN_INVALID: provider {id} has unsupported authKind {auth_kind}");
            }
            if let Some(base_url) = obj.get("baseUrl").and_then(Value::as_str) {
                // The runtime reaches this endpoint, so a declaration may only
                // name an absolute http(s) URL.
                if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
                    bail!("PLUGIN_INVALID: provider {id} baseUrl must be an http(s) URL");
                }
            }
            let models = match obj.get("models") {
                Some(value) => array_of(value, "contributes.providers.models")?,
                None => bail!("PLUGIN_INVALID: provider {id} requires models"),
            };
            if models.is_empty() || models.len() > MAX_PLUGIN_PROVIDER_MODELS {
                bail!(
                    "PLUGIN_INVALID: provider {id} declares 1 to {MAX_PLUGIN_PROVIDER_MODELS} models"
                );
            }
            let mut seen_models: Vec<&str> = Vec::new();
            for model in models {
                let model = model.as_object().ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: provider {id} model entries must be objects")
                })?;
                let model_id = model
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.len() <= 256)
                    .ok_or_else(|| {
                        anyhow!("PLUGIN_INVALID: provider {id} has a model without a valid id")
                    })?;
                if seen_models.contains(&model_id) {
                    bail!("PLUGIN_INVALID: provider {id} declares model {model_id} twice");
                }
                seen_models.push(model_id);
            }
        }
    }
    if let Some(themes) = map.get("themes") {
        let entries = array_of(themes, "contributes.themes")?;
        if !entries.is_empty() {
            require_permission(manifest, "ui.theme", "themes")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.themes entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: theme id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate theme id {id}");
            }
            seen.push(id);
            if obj
                .get("label")
                .and_then(Value::as_str)
                .map(|l| l.trim().is_empty())
                .unwrap_or(true)
            {
                bail!("PLUGIN_INVALID: theme {id} requires a label");
            }
            let path = obj
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: theme {id} requires a path"))?;
            if !path.to_ascii_lowercase().ends_with(".css") {
                bail!("PLUGIN_INVALID: theme {id} path must be a .css file");
            }
            let resolved = safe_join(root, path)?;
            if !resolved.exists() {
                bail!("PLUGIN_INVALID: theme css missing: {path}");
            }
            match obj.get("base").and_then(Value::as_str) {
                None | Some("light") | Some("dark") => {}
                Some(other) => bail!("PLUGIN_INVALID: theme {id} base {other} is not supported"),
            }
            if let Some(assets) = obj.get("assets") {
                let entries = array_of(assets, "contributes.themes.assets")?;
                let mut seen_assets: Vec<String> = Vec::new();
                let mut asset_total: u64 = 0;
                for asset in entries {
                    let raw = asset.as_str().ok_or_else(|| {
                        anyhow!("PLUGIN_INVALID: theme {id} assets entries must be paths")
                    })?;
                    let normalized = normalize_theme_asset_path(raw).ok_or_else(|| {
                        anyhow!(
                            "PLUGIN_INVALID: theme {id} asset {raw} must be an absolute image or font path"
                        )
                    })?;
                    if seen_assets.contains(&normalized) {
                        bail!("PLUGIN_INVALID: theme {id} declares asset {raw} twice");
                    }
                    // A theme asset is an absolute path: the plugin names the file and the
                    // host serves it, so there is nothing to resolve against the package root.
                    let resolved = std::path::Path::new(&normalized);
                    let metadata = resolved
                        .metadata()
                        .map_err(|_| anyhow!("PLUGIN_INVALID: theme {id} asset missing: {raw}"))?;
                    if !metadata.is_file() {
                        bail!("PLUGIN_INVALID: theme {id} asset missing: {raw}");
                    }
                    asset_total += metadata.len();
                    if asset_total > THEME_ASSET_MAX_BYTES {
                        bail!(
                            "PLUGIN_INVALID: theme {id} assets exceed {THEME_ASSET_MAX_BYTES} bytes"
                        );
                    }
                    seen_assets.push(normalized);
                }
            }
        }
    }

    if let Some(appearance) = map.get("windowAppearance") {
        let obj = appearance.as_object().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: contributes.windowAppearance must be an object")
        })?;
        require_permission(
            manifest,
            "ui.window.appearance",
            "contributes.windowAppearance",
        )?;
        if let Some(background) = obj.get("backgroundColor") {
            let colors = background.as_object().ok_or_else(|| {
                anyhow!(
                    "PLUGIN_INVALID: contributes.windowAppearance.backgroundColor must be an object"
                )
            })?;
            for key in ["light", "dark"] {
                let Some(value) = colors.get(key) else {
                    continue;
                };
                let color = value.as_str().ok_or_else(|| {
                    anyhow!(
                        "PLUGIN_INVALID: windowAppearance.backgroundColor.{key} must be a string"
                    )
                })?;
                if !is_window_background_color(color) {
                    bail!(
                        "PLUGIN_INVALID: windowAppearance.backgroundColor.{key} must be #rrggbb or #rrggbbaa"
                    );
                }
            }
        }
    }

    if let Some(views) = map.get("views") {
        let entries = array_of(views, "contributes.views")?;
        if !entries.is_empty() {
            require_permission(manifest, "ui.view", "views")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.views entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: view id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate view id {id}");
            }
            seen.push(id);
            // A title may be a plain string or a { en, "zh-CN" } object; the
            // per-locale completeness check belongs to the SDK validator, which
            // the packaging tool runs. Here we only require something rendered.
            let has_title = match obj.get("title") {
                Some(Value::String(s)) => !s.trim().is_empty(),
                Some(Value::Object(map)) => map
                    .values()
                    .any(|v| v.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)),
                _ => false,
            };
            if !has_title {
                bail!("PLUGIN_INVALID: view {id} requires a title");
            }
            let entry_path = obj
                .get("entry")
                .and_then(Value::as_str)
                .filter(|entry| !entry.trim().is_empty())
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: view {id} requires an entry"))?;
            let resolved = safe_join(root, entry_path)?;
            if !resolved.exists() {
                bail!("PLUGIN_INVALID: view entry missing: {entry_path}");
            }
        }
    }

    if let Some(servers) = map.get("mcpServers") {
        let entries = array_of(servers, "contributes.mcpServers")?;
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.mcpServers entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: mcp server id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate mcp server id {id}");
            }
            seen.push(id);
            match obj.get("transport").and_then(Value::as_str) {
                Some("stdio") => {
                    require_permission(manifest, "mcp.server.local", "stdio mcp servers")?;
                    if obj.contains_key("url") || obj.contains_key("headers") {
                        bail!("PLUGIN_INVALID: mcp server {id} must not set url or headers");
                    }
                    let command = obj
                        .get("command")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|c| !c.is_empty())
                        .ok_or_else(|| {
                            anyhow!("PLUGIN_INVALID: mcp server {id} requires command")
                        })?;
                    if command.contains('/') || command.contains('\\') {
                        let resolved = safe_join(root, command)?;
                        if !resolved.exists() {
                            bail!("PLUGIN_INVALID: mcp server {id} command missing: {command}");
                        }
                    } else if !command
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
                    {
                        bail!("PLUGIN_INVALID: mcp server {id} command is not an executable name");
                    }
                    if let Some(args) = obj.get("args") {
                        for arg in array_of(args, "mcp server args")? {
                            if !arg.is_string() {
                                bail!("PLUGIN_INVALID: mcp server {id} args must be strings");
                            }
                        }
                    }
                }
                Some("http") => {
                    require_permission(manifest, "mcp.server.remote", "remote mcp servers")?;
                    if obj.contains_key("command")
                        || obj.contains_key("args")
                        || obj.contains_key("env")
                    {
                        bail!("PLUGIN_INVALID: mcp server {id} must not set command, args or env");
                    }
                    let url = obj
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("PLUGIN_INVALID: mcp server {id} requires url"))?;
                    validate_mcp_url(id, url)?;
                }
                _ => bail!("PLUGIN_INVALID: mcp server {id} transport must be stdio or http"),
            }
        }
    }

    if let Some(services) = map.get("services") {
        let entries = array_of(services, "contributes.services")?;
        if !entries.is_empty() {
            require_permission(manifest, "background.service", "background services")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.services entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: service id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate service id {id}");
            }
            seen.push(id);
        }
    }

    if let Some(bus) = map.get("bus") {
        let obj = bus
            .as_object()
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: contributes.bus must be an object"))?;
        let publish = obj
            .get("publish")
            .map(|v| array_of(v, "contributes.bus.publish"))
            .transpose()?;
        let subscribe = obj
            .get("subscribe")
            .map(|v| array_of(v, "contributes.bus.subscribe"))
            .transpose()?;
        if publish.map(|p| !p.is_empty()).unwrap_or(false) {
            require_permission(manifest, "bus.publish", "bus publishing")?;
        }
        if subscribe.map(|s| !s.is_empty()).unwrap_or(false) {
            require_permission(manifest, "bus.subscribe", "bus subscriptions")?;
        }
        for topic in publish.unwrap_or(&[]) {
            let topic = topic
                .as_str()
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: bus publish topics must be strings"))?;
            if !is_bus_topic(topic, false) {
                bail!("PLUGIN_INVALID: bus publish topic {topic} is not a valid topic");
            }
        }
        for pattern in subscribe.unwrap_or(&[]) {
            let pattern = pattern
                .as_str()
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: bus subscribe patterns must be strings"))?;
            if !is_bus_topic(pattern, true) {
                bail!("PLUGIN_INVALID: bus subscribe pattern {pattern} is not valid");
            }
        }
    }

    if let Some(deny) = map.get("permissionDeny") {
        require_permission(manifest, "agent.permission.deny", "permission deny rules")?;
        crate::permission_deny::parse_rules(deny)
            .map_err(|error| anyhow!("PLUGIN_INVALID: contributes.{error}"))?;
    }

    Ok(())
}

fn is_setting_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .next()
            .map(|ch| ch.is_ascii_alphabetic())
            .unwrap_or(false)
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn is_shortcut_shape(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let parts: Vec<&str> = value.split('+').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2
        && !matches!(parts.first(), Some(key) if key.starts_with('F') && key[1..].parse::<u8>().map(|n| (1..=12).contains(&n)).unwrap_or(false))
    {
        return false;
    }
    let Some(key) = parts.last() else {
        return false;
    };
    let named = matches!(
        *key,
        "Enter"
            | "Space"
            | "Tab"
            | "Backspace"
            | "Delete"
            | "Insert"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Comma"
            | "Period"
            | "Equal"
            | "Minus"
            | "Slash"
            | "Backslash"
            | "Semicolon"
            | "Quote"
            | "BracketLeft"
            | "BracketRight"
            | "Backquote"
    );
    let alpha_numeric = key.len() == 1 && key.chars().all(|ch| ch.is_ascii_alphanumeric());
    let function_key = key.starts_with('F')
        && key[1..]
            .parse::<u8>()
            .map(|number| (1..=12).contains(&number))
            .unwrap_or(false);
    if !(named || alpha_numeric || function_key) {
        return false;
    }
    parts[..parts.len().saturating_sub(1)]
        .iter()
        .all(|part| matches!(*part, "Mod" | "Ctrl" | "Alt" | "Shift"))
}

fn array_of<'a>(value: &'a Value, field: &str) -> Result<&'a [Value]> {
    value
        .as_array()
        .map(|a| a.as_slice())
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: {field} must be an array"))
}

fn require_permission(manifest: &PluginManifest, permission: &str, what: &str) -> Result<()> {
    if manifest.permissions.iter().any(|p| p == permission) {
        return Ok(());
    }
    bail!("PLUGIN_INVALID: {what} require the {permission} permission")
}

/// Extensions a theme may reference out of its own package (ADR 0247).
const THEME_ASSET_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "avif", "svg", "woff2"];

/// Declared assets of one theme, summed.
const THEME_ASSET_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Mirrors `normalizeThemeAssetPath` in the plugin SDK: a forward-slash
/// **absolute** path on the extension whitelist, or `None`.
///
/// A theme asset always names a file by absolute path (`C:/art/bg.png`,
/// `/art/bg.png`, or either spelled as a `file:` URL). Relative references are
/// rejected: the host serves theme bytes straight from the filesystem.
fn normalize_theme_asset_path(value: &str) -> Option<String> {
    let raw = value.trim();
    let without_scheme = match raw.strip_prefix("file://") {
        Some(rest) => rest,
        None => raw.strip_prefix("file:").unwrap_or(raw),
    };
    let normalized = without_scheme.replace('\\', "/");
    // `file:///C:/art/bg.png` and `file:///art/bg.png` both lose the extra slash
    // the authority marker leaves behind; a drive letter is written without it.
    let path = match normalized.strip_prefix('/') {
        Some(rest) if is_windows_drive_path(rest) => rest.to_string(),
        _ => normalized,
    };
    if !is_absolute_theme_asset_path(&path) {
        return None;
    }
    if path
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return None;
    }
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    if !THEME_ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    Some(path)
}

/// `C:/…` — a Windows drive path after forward-slash normalization.
fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

/// A POSIX absolute path or a Windows drive path.
fn is_absolute_theme_asset_path(value: &str) -> bool {
    value.starts_with('/') || is_windows_drive_path(value)
}

/// Mirrors `WINDOW_BACKGROUND_COLOR_PATTERN` in the plugin SDK.
fn is_window_background_color(value: &str) -> bool {
    let digits = value.strip_prefix('#').unwrap_or("");
    if digits.len() != 6 && digits.len() != 8 {
        return false;
    }
    digits
        .chars()
        .all(|character| character.is_ascii_hexdigit())
}

fn is_contrib_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
/// Grammar shared with `contributes.globalShortcuts[].id` in the plugin SDK.
/// Dots are allowed here (unlike `is_contrib_id`): a shortcut id names a
/// namespace inside the plugin, e.g. `voice.pushToTalk`.
fn is_shortcut_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Shares the topic grammar with `matchesBusTopic` in the plugin SDK.
fn is_bus_topic(value: &str, allow_wildcards: bool) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let segments: Vec<&str> = value.split('.').collect();
    if segments.len() > 8 {
        return false;
    }
    segments.iter().enumerate().all(|(index, segment)| {
        if allow_wildcards && *segment == "*" {
            return true;
        }
        if allow_wildcards && *segment == "**" {
            return index == segments.len() - 1;
        }
        let mut chars = segment.chars();
        match chars.next() {
            Some(c) if c.is_ascii_alphanumeric() => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

fn validate_mcp_url(id: &str, url: &str) -> Result<()> {
    let lower = url.trim().to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        bail!("PLUGIN_INVALID: mcp server {id} url must use http or https");
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        bail!("PLUGIN_INVALID: mcp server {id} url is missing a host");
    }
    if authority.contains('@') {
        bail!("PLUGIN_INVALID: mcp server {id} url must not embed credentials");
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        match stripped.find(']') {
            Some(close) => &stripped[..close],
            None => bail!("PLUGIN_INVALID: mcp server {id} url host is malformed"),
        }
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.is_empty() {
        bail!("PLUGIN_INVALID: mcp server {id} url is missing a host");
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" || host.starts_with("127.")
}

/// Hosts a marketplace package may be downloaded from.
///
/// A v1 catalog kept every package under one repository, so the checksum was
/// the only control that mattered. Catalog v2 package URLs describe a
/// publisher-influenced release, so the host also has to constrain where the
/// request goes. Matching is exact or dot-suffix, which covers
/// `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
/// and `codeload.github.com` without needing a client release each time
/// GitHub rotates a release-asset host.
const PACKAGE_HOST_ALLOWLIST: &[&str] = &["github.com", "githubusercontent.com", "cnb.cool"];

fn host_matches_allowlist_entry(host: &str, allowed: &str) -> bool {
    host == allowed || host.ends_with(&format!(".{allowed}"))
}

/// Lowercase host of an `http(s)` URL, rejecting embedded credentials.
///
/// Credentials in a package URL would let a catalog entry aim an
/// authenticated request at a host the user never chose, so they are refused
/// rather than stripped.
fn package_url_host(url: &str) -> Result<(String, bool)> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (rest, plain_http) = if let Some(rest) = lower.strip_prefix("https://") {
        (rest, false)
    } else if let Some(rest) = lower.strip_prefix("http://") {
        (rest, true)
    } else {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url must use https");
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url must not embed credentials");
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        match stripped.find(']') {
            Some(close) => &stripped[..close],
            None => bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url host is malformed"),
        }
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.is_empty() {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url is missing a host");
    }
    Ok((host.to_string(), plain_http))
}

/// Whether a package URL is one the host is willing to fetch.
///
/// Allowed: the distribution hosts above, and the host that served the
/// catalog currently in effect — a private or enterprise catalog is trusted
/// for its own packages, and pointing the client at one does not widen the
/// allowlist for third-party hosts. Plain `http` is refused outside loopback,
/// which keeps local development catalogs working.
pub(crate) fn package_host_allowed(package_url: &str, catalog_url: &str) -> Result<()> {
    let (host, plain_http) = package_url_host(package_url)?;
    if plain_http && !is_loopback_host(&host) {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: {host} must be reached over https");
    }
    if PACKAGE_HOST_ALLOWLIST
        .iter()
        .any(|allowed| host_matches_allowlist_entry(&host, allowed))
    {
        return Ok(());
    }
    if let Ok((catalog_host, _)) = package_url_host(catalog_url) {
        if host == catalog_host {
            return Ok(());
        }
    }
    bail!("PLUGIN_MARKET_UNTRUSTED_HOST: {host} is not an allowed package host")
}

/// Whether a package URL needs the network at all.
///
/// `file://` and bare local paths serve the built-in offline catalog and local
/// development catalogs. They cannot reach another host, so the allowlist does
/// not apply to them.
pub(crate) fn is_local_package_url(url: &str) -> bool {
    !url.starts_with("http://") && !url.starts_with("https://")
}
