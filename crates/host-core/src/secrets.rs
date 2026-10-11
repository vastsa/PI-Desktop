use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rng, Rng};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub struct SecretStore {
    dir: PathBuf,
    key: [u8; 32],
}

impl SecretStore {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let dir = data_dir.join("secrets");
        fs::create_dir_all(&dir)?;
        let key_path = dir.join(".machine-key");
        let key = if key_path.exists() {
            let bytes = fs::read(&key_path)?;
            if bytes.len() != 32 {
                return Err(anyhow!("invalid machine key length"));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            key
        } else {
            let mut key = [0u8; 32];
            rng().fill_bytes(&mut key);
            // Create the file owner-only from the first byte instead of
            // tightening it afterwards, so no umask-dependent window exists.
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            {
                use std::io::Write;
                let mut file = options.open(&key_path)?;
                file.write_all(&key)?;
                file.sync_all()?;
            }
            key
        };
        Ok(Self { dir, key })
    }

    /// AES-256-GCM under the machine key.
    ///
    /// Infallible on purpose: `Key<Aes256Gcm>` is exactly the 32 bytes `self.key`
    /// holds, so there is no length for `new_from_slice` to reject.
    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(&self.key.into())
    }

    fn path_for(&self, secret_ref: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(secret_ref.as_bytes());
        let hash = hex::encode(hasher.finalize());
        self.dir.join(format!("{hash}.bin"))
    }

    pub fn set(&self, secret_ref: &str, value: &str) -> Result<String> {
        let cipher = self.cipher();
        let mut nonce_bytes = [0u8; 12];
        rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from(nonce_bytes);
        let ciphertext = cipher
            .encrypt(&nonce, value.as_bytes())
            .map_err(|e| anyhow!("encrypt failed: {e}"))?;
        let mut blob = Vec::with_capacity(12 + ciphertext.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        self.write_blob(secret_ref, B64.encode(blob).as_bytes())?;
        Ok("file_fallback".into())
    }

    /// Atomic replacement keeps an earlier credential intact if writing fails.
    fn write_blob(&self, secret_ref: &str, blob: &[u8]) -> Result<()> {
        use std::io::Write;
        let temporary = self.dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| -> Result<()> {
            file.write_all(blob)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, self.path_for(secret_ref))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn set_plugin(&self, plugin_id: &str, key: &str, value: &str) -> Result<()> {
        let secret_ref = secret_ref_for_plugin(plugin_id, key)?;
        if value.len() > MAX_PLUGIN_SECRET_VALUE_BYTES {
            return Err(anyhow!("plugin secret value exceeds 65536 UTF-8 bytes"));
        }
        self.set(&secret_ref, value)?;
        Ok(())
    }

    pub fn get_plugin(&self, plugin_id: &str, key: &str) -> Result<Option<String>> {
        let secret_ref = secret_ref_for_plugin(plugin_id, key)?;
        // Reject oversized ciphertext before allocating/decoding it.
        let max_blob_bytes = (MAX_PLUGIN_SECRET_VALUE_BYTES + 12 + 16).div_ceil(3) * 4;
        match fs::metadata(self.path_for(&secret_ref)) {
            Ok(metadata) if metadata.len() > max_blob_bytes as u64 => {
                return Err(anyhow!("plugin secret blob exceeds size limit"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            _ => {}
        }
        let value = self.get(&secret_ref)?;
        if value
            .as_ref()
            .is_some_and(|value| value.len() > MAX_PLUGIN_SECRET_VALUE_BYTES)
        {
            return Err(anyhow!("plugin secret value exceeds size limit"));
        }
        Ok(value)
    }

    pub fn delete_plugin(&self, plugin_id: &str, key: &str) -> Result<()> {
        self.delete(&secret_ref_for_plugin(plugin_id, key)?)
    }

    pub fn get(&self, secret_ref: &str) -> Result<Option<String>> {
        let path = self.path_for(secret_ref);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(path)?;
        let blob = B64.decode(raw.trim()).context("decode secret blob")?;
        if blob.len() < 13 {
            return Err(anyhow!("secret blob too short"));
        }
        let (nonce_bytes, ciphertext) = blob.split_at(12);
        let cipher = self.cipher();
        let nonce =
            Nonce::try_from(nonce_bytes).map_err(|_| anyhow!("secret nonce is not 12 bytes"))?;
        let plain = cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|e| anyhow!("decrypt failed: {e}"))?;
        Ok(Some(String::from_utf8(plain)?))
    }

    pub fn has(&self, secret_ref: &str) -> bool {
        self.path_for(secret_ref).exists()
    }

    pub fn delete(&self, secret_ref: &str) -> Result<()> {
        let path = self.path_for(secret_ref);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

pub fn secret_ref_for_provider(provider_id: &str) -> String {
    format!("secret:provider:{provider_id}:api_key")
}

/// Where a vendor-account OAuth credential lives. Kept separate from the API
/// key ref so a provider can hold both without one overwriting the other, and
/// so the API-key read path can never hand a refresh token to the runtime.
pub fn secret_ref_for_provider_oauth(provider_id: &str) -> String {
    format!("secret:provider:{provider_id}:oauth")
}

pub const MAX_PLUGIN_SECRET_KEY_LENGTH: usize = 128;
pub const MAX_PLUGIN_SECRET_VALUE_BYTES: usize = 64 * 1024;

/// Keys and identities cannot contain namespace separators or file paths.
fn valid_plugin_secret_component(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Plugin references are constructed by the host; raw references are never accepted.
pub fn secret_ref_for_plugin(plugin_id: &str, key: &str) -> Result<String> {
    if !valid_plugin_secret_component(plugin_id, 256) {
        return Err(anyhow!("invalid plugin identity for secret storage"));
    }
    if !valid_plugin_secret_component(key, MAX_PLUGIN_SECRET_KEY_LENGTH) {
        return Err(anyhow!("invalid plugin secret key"));
    }
    Ok(format!("secret:plugin:{plugin_id}:{key}"))
}

#[derive(Debug, thiserror::Error)]
pub enum PluginSecretRpcError {
    #[error("invalid plugin secret storage parameters")]
    InvalidParams,
    #[error("plugin secret storage operation failed")]
    Storage,
}

/// Internal Main-to-Host RPC only. Main must derive pluginId from the loaded
/// plugin and enforce the declared and granted secrets.store permission.
/// Never register these methods on a renderer or generic plugin RPC surface.
pub fn handle_plugin_secrets_rpc(
    store: &SecretStore,
    method: &str,
    params: &serde_json::Value,
) -> std::result::Result<serde_json::Value, PluginSecretRpcError> {
    use PluginSecretRpcError::{InvalidParams, Storage};
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct KeyParams {
        plugin_id: String,
        key: String,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SetParams {
        plugin_id: String,
        key: String,
        value: String,
    }
    match method {
        "plugins.secrets.get" | "plugins.secrets.delete" => {
            let input: KeyParams =
                serde_json::from_value(params.clone()).map_err(|_| InvalidParams)?;
            secret_ref_for_plugin(&input.plugin_id, &input.key).map_err(|_| InvalidParams)?;
            if method == "plugins.secrets.get" {
                let value = store
                    .get_plugin(&input.plugin_id, &input.key)
                    .map_err(|_| Storage)?;
                Ok(serde_json::json!({ "value": value }))
            } else {
                store
                    .delete_plugin(&input.plugin_id, &input.key)
                    .map_err(|_| Storage)?;
                Ok(serde_json::json!({ "ok": true }))
            }
        }
        "plugins.secrets.set" => {
            let input: SetParams =
                serde_json::from_value(params.clone()).map_err(|_| InvalidParams)?;
            secret_ref_for_plugin(&input.plugin_id, &input.key).map_err(|_| InvalidParams)?;
            if input.value.len() > MAX_PLUGIN_SECRET_VALUE_BYTES {
                return Err(InvalidParams);
            }
            store
                .set_plugin(&input.plugin_id, &input.key, &input.value)
                .map_err(|_| Storage)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        _ => Err(InvalidParams),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_rpc_round_trip_is_encrypted_persistent_and_isolated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("open store");
        let provider = secret_ref_for_provider("room");
        store.set(&provider, "provider-fixture").expect("provider");
        let key = serde_json::json!({ "pluginId": "test.room", "key": "credentials" });
        let set = serde_json::json!({
            "pluginId": "test.room", "key": "credentials", "value": "private-fixture-value"
        });
        assert_eq!(
            handle_plugin_secrets_rpc(&store, "plugins.secrets.get", &key).expect("missing"),
            serde_json::json!({ "value": null }),
        );
        handle_plugin_secrets_rpc(&store, "plugins.secrets.set", &set).expect("set");
        store
            .set_plugin("test.other", "credentials", "other-fixture")
            .expect("other");
        let reference = secret_ref_for_plugin("test.room", "credentials").expect("reference");
        let raw = fs::read_to_string(store.path_for(&reference)).expect("encrypted blob");
        assert!(!raw.contains("private-fixture-value"));
        let decoded = B64.decode(raw).expect("base64");
        assert!(!decoded
            .windows(21)
            .any(|bytes| bytes == b"private-fixture-value"));
        drop(store);
        let store = SecretStore::open(dir.path()).expect("reopen");
        assert_eq!(
            handle_plugin_secrets_rpc(&store, "plugins.secrets.get", &key).expect("get"),
            serde_json::json!({ "value": "private-fixture-value" }),
        );
        handle_plugin_secrets_rpc(&store, "plugins.secrets.delete", &key).expect("delete");
        handle_plugin_secrets_rpc(&store, "plugins.secrets.delete", &key).expect("repeat delete");
        assert_eq!(
            store
                .get_plugin("test.room", "credentials")
                .expect("missing"),
            None
        );
        assert_eq!(
            store.get(&provider).expect("provider"),
            Some("provider-fixture".into())
        );
        assert_eq!(
            store
                .get_plugin("test.other", "credentials")
                .expect("other"),
            Some("other-fixture".into()),
        );
    }

    #[test]
    fn plugin_keys_and_identities_cannot_escape_the_namespace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("store");
        for key in [
            "",
            "../key",
            "/key",
            "a/b",
            "a\\b",
            "secret:provider:room:api_key",
            "a\0b",
            "é",
        ] {
            assert!(store.set_plugin("test.room", key, "fixture").is_err());
            assert!(store.get_plugin("test.room", key).is_err());
            assert!(store.delete_plugin("test.room", key).is_err());
        }
        assert!(store
            .set_plugin("test.room", &"k".repeat(129), "fixture")
            .is_err());
        assert!(store
            .set_plugin("test.room", &"k".repeat(128), "fixture")
            .is_ok());
        for id in ["", "a:b", "a/b", "../test", "é"] {
            assert!(secret_ref_for_plugin(id, "key").is_err());
        }
        assert!(secret_ref_for_plugin(&"a".repeat(257), "key").is_err());
        assert_ne!(
            secret_ref_for_plugin("a.b", "c").expect("reference"),
            secret_ref_for_plugin("a", "b.c").expect("reference"),
        );
        assert!(fs::read_dir(dir.path().join("secrets"))
            .expect("files")
            .all(|entry| {
                !entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            }));
    }

    #[test]
    fn plugin_value_bounds_count_utf8_bytes_and_preserve_prior_value() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("store");
        let boundary = "é".repeat(MAX_PLUGIN_SECRET_VALUE_BYTES / 2);
        store
            .set_plugin("test.room", "key", &boundary)
            .expect("boundary");
        assert!(store
            .set_plugin("test.room", "key", &(boundary.clone() + "a"))
            .is_err());
        assert_eq!(
            store.get_plugin("test.room", "key").expect("read"),
            Some(boundary)
        );
        store.set_plugin("test.room", "key", "").expect("empty");
        assert_eq!(
            store.get_plugin("test.room", "key").expect("read empty"),
            Some("".into())
        );
        // Even a trusted generic writer cannot make a plugin return an oversized value.
        let reference = secret_ref_for_plugin("test.room", "key").expect("reference");
        store
            .set(&reference, &"a".repeat(MAX_PLUGIN_SECRET_VALUE_BYTES + 1))
            .expect("generic set");
        assert!(store.get_plugin("test.room", "key").is_err());
    }

    #[test]
    fn plugin_rpc_rejects_raw_refs_wrong_types_and_extra_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("store");
        for params in [
            serde_json::json!({ "secretRef": "secret:provider:room:api_key" }),
            serde_json::json!({ "pluginId": "test.room", "key": 42 }),
            serde_json::json!({ "pluginId": "test.room", "key": "key", "secretRef": "elsewhere" }),
            serde_json::json!({ "pluginId": "test.room", "key": "key", "value": null }),
        ] {
            assert!(matches!(
                handle_plugin_secrets_rpc(&store, "plugins.secrets.set", &params),
                Err(PluginSecretRpcError::InvalidParams),
            ));
        }
        let params = serde_json::json!({ "pluginId": "test.room", "key": "key" });
        assert!(handle_plugin_secrets_rpc(&store, "secrets.getForRuntime", &params).is_err());
        assert!(handle_plugin_secrets_rpc(
            &store,
            "plugins.secrets.set",
            &serde_json::json!({
                "pluginId": "test.room", "key": "key", "value": "a".repeat(65537)
            })
        )
        .is_err());
    }

    #[test]
    fn plugin_rpc_storage_errors_are_redacted_and_tampering_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("store");
        store
            .set_plugin("test.room", "key", "private-fixture")
            .expect("set");
        let reference = secret_ref_for_plugin("test.room", "key").expect("reference");
        fs::write(store.path_for(&reference), "private-fixture-not-base64").expect("corrupt");
        let error = handle_plugin_secrets_rpc(
            &store,
            "plugins.secrets.get",
            &serde_json::json!({
                "pluginId": "test.room", "key": "key"
            }),
        )
        .expect_err("corruption refused");
        assert_eq!(error.to_string(), "plugin secret storage operation failed");
    }

    #[test]
    fn atomic_secret_write_failure_removes_temporary_blob() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("store");
        let reference = secret_ref_for_plugin("test.room", "key").expect("reference");
        fs::create_dir(store.path_for(&reference)).expect("block destination");
        assert!(store
            .set_plugin("test.room", "key", "private-fixture")
            .is_err());
        assert!(fs::read_dir(dir.path().join("secrets"))
            .expect("files")
            .all(|entry| {
                !entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            }));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_secret_replacements_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("store");
        store
            .set_plugin("test.room", "key", "first")
            .expect("first");
        store
            .set_plugin("test.room", "key", "second")
            .expect("second");
        let reference = secret_ref_for_plugin("test.room", "key").expect("reference");
        let permissions = fs::metadata(store.path_for(&reference))
            .expect("metadata")
            .permissions();
        assert_eq!(permissions.mode() & 0o777, 0o600);
    }

    /// The on-disk layout is `base64(nonce ‖ ciphertext ‖ tag)` under a raw
    /// 32-byte machine key, and the filename is `sha256(secret_ref)`. Users have
    /// live provider API keys stored that way, so a crypto-crate bump that
    /// changed any of it would silently lock every one of them out — a round-trip
    /// test cannot catch that, because it would change both sides at once.
    ///
    /// This vector was produced by an independent implementation (Node's
    /// `crypto`), so it pins the format rather than our own behaviour.
    #[test]
    fn decrypts_a_secret_written_by_an_earlier_build() {
        let key: [u8; 32] = std::array::from_fn(|i| i as u8);
        let dir = tempfile::tempdir().expect("tempdir");
        let secrets_dir = dir.path().join("secrets");
        fs::create_dir_all(&secrets_dir).expect("create secrets dir");
        fs::write(secrets_dir.join(".machine-key"), key).expect("write machine key");
        fs::write(
            secrets_dir
                .join("98c9443fcbc5c60d4da31a04e6cf07028f6144cbfbdb0fd7b86f2e19b463280d.bin"),
            "CwoJCAcGBQQDAgEAU5Z0dF8QGeiN27cNAqFSeAYGwMXktbI1htFNv2eSmf0=",
        )
        .expect("write secret blob");

        let store = SecretStore::open(dir.path()).expect("open store");
        let secret_ref = secret_ref_for_provider("openai");
        assert!(store.has(&secret_ref));
        assert_eq!(
            store.get(&secret_ref).expect("get secret"),
            Some("sk-fixture-value".to_string()),
        );
    }

    #[test]
    fn rejects_a_blob_whose_tag_does_not_authenticate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("open store");
        let secret_ref = secret_ref_for_provider("anthropic");
        store.set(&secret_ref, "sk-real-value").expect("set secret");

        let path = store.path_for(&secret_ref);
        let mut blob = B64
            .decode(fs::read_to_string(&path).expect("read blob").trim())
            .expect("decode blob");
        // Flip a ciphertext bit: GCM must fail authentication rather than hand
        // back a mangled key that would look like a provider auth failure.
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        fs::write(&path, B64.encode(blob)).expect("rewrite blob");

        assert!(store.get(&secret_ref).is_err());
    }

    #[test]
    fn each_write_uses_a_fresh_nonce() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("open store");
        let secret_ref = secret_ref_for_provider("openai");

        store.set(&secret_ref, "same-value").expect("first write");
        let first = fs::read_to_string(store.path_for(&secret_ref)).expect("read first");
        store.set(&secret_ref, "same-value").expect("second write");
        let second = fs::read_to_string(store.path_for(&secret_ref)).expect("read second");

        // Reusing a nonce under one key is the classic GCM break, so identical
        // plaintext must still produce different blobs.
        assert_ne!(first, second);
        assert_eq!(
            store.get(&secret_ref).expect("get secret"),
            Some("same-value".to_string()),
        );
    }

    #[test]
    fn oauth_and_api_key_refs_do_not_collide() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::open(dir.path()).expect("open store");
        let api_key = secret_ref_for_provider("anthropic");
        let oauth = secret_ref_for_provider_oauth("anthropic");

        assert_eq!(oauth, "secret:provider:anthropic:oauth");
        store.set(&api_key, "sk-ant-api").expect("set api key");
        store
            .set(&oauth, "{\"type\":\"oauth\"}")
            .expect("set oauth credential");

        // A provider may hold both credentials at once, so storing one must
        // never clobber the other or leak across the two read paths.
        assert_eq!(
            store.get(&api_key).expect("get api key"),
            Some("sk-ant-api".to_string()),
        );
        assert_eq!(
            store.get(&oauth).expect("get oauth"),
            Some("{\"type\":\"oauth\"}".to_string()),
        );

        store.delete(&oauth).expect("delete oauth");
        assert!(!store.has(&oauth));
        assert!(store.has(&api_key));
    }
}
