use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::{rng, RngExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const FORMAT_VERSION: u32 = 2;
const MIN_MEMORY_KIB: u32 = 19_456;
const MAX_MEMORY_KIB: u32 = 1_048_576;
const MIN_ITERATIONS: u32 = 2;
const MAX_ITERATIONS: u32 = 12;
const MIN_PARALLELISM: u32 = 1;
const MAX_PARALLELISM: u32 = 8;

/// Parameters are part of the authenticated vault header, but are bounded
/// before Argon2 is invoked so an attacker-controlled remote header cannot
/// turn unlocking into an unbounded memory or CPU allocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParameters {
    pub algorithm: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultHeader {
    pub format: String,
    pub version: u32,
    pub vault_id: String,
    pub cipher: String,
    pub kdf: KdfParameters,
    pub wrap_nonce: String,
    pub wrapped_key: String,
}

#[derive(Debug, Clone)]
pub struct VaultKey(pub [u8; KEY_BYTES]);

impl VaultKey {
    pub fn as_bytes(&self) -> &[u8; KEY_BYTES] {
        &self.0
    }
}

fn default_kdf() -> KdfParameters {
    KdfParameters {
        algorithm: "argon2id".to_string(),
        memory_kib: 64 * 1024,
        iterations: 3,
        parallelism: 1,
        salt: random_b64(16),
    }
}

fn random_b64(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rng().fill(value.as_mut_slice());
    B64.encode(value)
}

fn checked_kdf(kdf: &KdfParameters) -> Result<Params> {
    if kdf.algorithm != "argon2id" {
        bail!("CONFIG_SYNC_UNSUPPORTED: vault KDF is not Argon2id");
    }
    if !(MIN_MEMORY_KIB..=MAX_MEMORY_KIB).contains(&kdf.memory_kib)
        || !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&kdf.iterations)
        || !(MIN_PARALLELISM..=MAX_PARALLELISM).contains(&kdf.parallelism)
    {
        bail!("CONFIG_SYNC_INVALID: vault KDF parameters are outside the supported bounds");
    }
    let salt = B64.decode(&kdf.salt).context("decode vault KDF salt")?;
    if !(16..=64).contains(&salt.len()) {
        bail!("CONFIG_SYNC_INVALID: vault KDF salt has an invalid length");
    }
    Params::new(
        kdf.memory_kib,
        kdf.iterations,
        kdf.parallelism,
        Some(KEY_BYTES),
    )
    .map_err(|error| anyhow!("invalid vault KDF parameters: {error}"))
}

fn derive_wrapping_key(password: &str, kdf: &KdfParameters) -> Result<[u8; KEY_BYTES]> {
    if password.is_empty() {
        bail!("CONFIG_SYNC_INVALID: backup password is required");
    }
    let params = checked_kdf(kdf)?;
    let salt = B64.decode(&kdf.salt).context("decode vault KDF salt")?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_BYTES];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|error| anyhow!("derive vault wrapping key: {error}"))?;
    Ok(key)
}

fn aad(purpose: &str, vault_id: &str) -> Vec<u8> {
    format!("pi-desktop/config-sync/v{FORMAT_VERSION}/{purpose}/{vault_id}").into_bytes()
}

fn domain_key(key: &[u8; KEY_BYTES], purpose: &str, vault_id: &str) -> [u8; KEY_BYTES] {
    let mut hasher = Sha256::new();
    hasher.update(b"pi-desktop/config-sync/key/v2/");
    hasher.update((purpose.len() as u64).to_be_bytes());
    hasher.update(purpose.as_bytes());
    hasher.update((vault_id.len() as u64).to_be_bytes());
    hasher.update(vault_id.as_bytes());
    hasher.update(key);
    hasher.finalize().into()
}

fn validate_vault_id(vault_id: &str) -> Result<()> {
    if vault_id.is_empty()
        || vault_id.len() > 128
        || vault_id.contains('/')
        || vault_id.contains('\\')
        || vault_id.contains("..")
        || !vault_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        bail!("CONFIG_SYNC_INVALID: vault id is unsafe");
    }
    Ok(())
}

fn encrypt_with_key(
    key: &[u8; KEY_BYTES],
    purpose: &str,
    vault_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let object_key = domain_key(key, purpose, vault_id);
    let cipher = Aes256Gcm::new_from_slice(&object_key).map_err(|_| anyhow!("invalid AES key"))?;
    let mut nonce_bytes = [0u8; NONCE_BYTES];
    rng().fill(&mut nonce_bytes);
    let nonce =
        Nonce::try_from(nonce_bytes.as_slice()).map_err(|_| anyhow!("invalid AES-GCM nonce"))?;
    let ciphertext = cipher
        .encrypt(
            &nonce,
            aes_gcm::aead::Payload {
                msg: plaintext,
                aad: &aad(purpose, vault_id),
            },
        )
        .map_err(|_| anyhow!("CONFIG_SYNC_CRYPTO: encryption failed"))?;
    let mut result = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

fn decrypt_with_key(
    key: &[u8; KEY_BYTES],
    purpose: &str,
    vault_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    if ciphertext.len() <= NONCE_BYTES {
        bail!("CONFIG_SYNC_CRYPTO: encrypted object is truncated");
    }
    let object_key = domain_key(key, purpose, vault_id);
    let cipher = Aes256Gcm::new_from_slice(&object_key).map_err(|_| anyhow!("invalid AES key"))?;
    let nonce = Nonce::try_from(&ciphertext[..NONCE_BYTES])
        .map_err(|_| anyhow!("invalid AES-GCM nonce"))?;
    cipher
        .decrypt(
            &nonce,
            aes_gcm::aead::Payload {
                msg: &ciphertext[NONCE_BYTES..],
                aad: &aad(purpose, vault_id),
            },
        )
        .map_err(|_| anyhow!("CONFIG_SYNC_CRYPTO: authentication failed"))
}

pub fn create_vault(password: &str, vault_id: &str) -> Result<(VaultHeader, VaultKey)> {
    validate_vault_id(vault_id)?;
    let kdf = default_kdf();
    let wrapping_key = derive_wrapping_key(password, &kdf)?;
    let mut raw_key = [0u8; KEY_BYTES];
    rng().fill(&mut raw_key);
    let wrapped = encrypt_with_key(&wrapping_key, "vault-key", vault_id, &raw_key)?;
    let nonce = B64.encode(&wrapped[..NONCE_BYTES]);
    let ciphertext = B64.encode(&wrapped[NONCE_BYTES..]);
    Ok((
        VaultHeader {
            format: "pi-desktop-config-vault".to_string(),
            version: FORMAT_VERSION,
            vault_id: vault_id.to_string(),
            cipher: "AES-256-GCM".to_string(),
            kdf,
            wrap_nonce: nonce,
            wrapped_key: ciphertext,
        },
        VaultKey(raw_key),
    ))
}

pub fn rewrap_vault(
    header: &VaultHeader,
    key: &VaultKey,
    new_password: &str,
) -> Result<VaultHeader> {
    if header.format != "pi-desktop-config-vault"
        || header.version != FORMAT_VERSION
        || header.cipher != "AES-256-GCM"
    {
        bail!("CONFIG_SYNC_UNSUPPORTED: unsupported vault format");
    }
    validate_vault_id(&header.vault_id)?;
    let kdf = default_kdf();
    let wrapping_key = derive_wrapping_key(new_password, &kdf)?;
    let wrapped = encrypt_with_key(&wrapping_key, "vault-key", &header.vault_id, &key.0)?;
    Ok(VaultHeader {
        format: header.format.clone(),
        version: header.version,
        vault_id: header.vault_id.clone(),
        cipher: header.cipher.clone(),
        kdf,
        wrap_nonce: B64.encode(&wrapped[..NONCE_BYTES]),
        wrapped_key: B64.encode(&wrapped[NONCE_BYTES..]),
    })
}

pub fn unlock_vault(header: &VaultHeader, password: &str) -> Result<VaultKey> {
    if header.format != "pi-desktop-config-vault"
        || header.version != FORMAT_VERSION
        || header.cipher != "AES-256-GCM"
    {
        bail!("CONFIG_SYNC_UNSUPPORTED: unsupported vault format");
    }
    validate_vault_id(&header.vault_id)?;
    let wrapping_key = derive_wrapping_key(password, &header.kdf)?;
    let nonce = B64
        .decode(&header.wrap_nonce)
        .context("decode vault wrap nonce")?;
    let ciphertext = B64
        .decode(&header.wrapped_key)
        .context("decode wrapped vault key")?;
    if nonce.len() != NONCE_BYTES || ciphertext.is_empty() {
        bail!("CONFIG_SYNC_CRYPTO: wrapped vault key is malformed");
    }
    let mut encrypted = Vec::with_capacity(nonce.len() + ciphertext.len());
    encrypted.extend_from_slice(&nonce);
    encrypted.extend_from_slice(&ciphertext);
    let plaintext = decrypt_with_key(&wrapping_key, "vault-key", &header.vault_id, &encrypted)
        .map_err(|_| anyhow!("CONFIG_SYNC_CRYPTO: backup password did not open this vault"))?;
    let raw: [u8; KEY_BYTES] = plaintext
        .try_into()
        .map_err(|_| anyhow!("CONFIG_SYNC_CRYPTO: vault key has an invalid length"))?;
    Ok(VaultKey(raw))
}

pub fn encrypt_object(
    key: &VaultKey,
    purpose: &str,
    vault_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    encrypt_with_key(key.as_bytes(), purpose, vault_id, plaintext)
}

pub fn decrypt_object(
    key: &VaultKey,
    purpose: &str,
    vault_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    decrypt_with_key(key.as_bytes(), purpose, vault_id, ciphertext)
}

pub fn object_id(key: &VaultKey, bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"pi-desktop/config-sync/resource/v1/");
    hasher.update(key.as_bytes());
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn vault_key_b64(key: &VaultKey) -> String {
    B64.encode(key.as_bytes())
}

pub fn vault_key_from_b64(value: &str) -> Result<VaultKey> {
    let raw = B64.decode(value).context("decode local vault key")?;
    let key = raw
        .try_into()
        .map_err(|_| anyhow!("local vault key has an invalid length"))?;
    Ok(VaultKey(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_round_trip_rejects_wrong_password_and_tampering() {
        let (header, key) =
            create_vault("correct horse battery staple", "vault-a").expect("create vault");
        let unlocked = unlock_vault(&header, "correct horse battery staple").expect("unlock");
        assert_eq!(unlocked.as_bytes(), key.as_bytes());
        let wrong = unlock_vault(&header, "wrong password").expect_err("wrong password");
        assert!(wrong.to_string().starts_with("CONFIG_SYNC_CRYPTO:"));

        let mut ciphertext =
            encrypt_object(&key, "test", "vault-a", b"portable settings").expect("encrypt");
        assert_eq!(
            decrypt_object(&key, "test", "vault-a", &ciphertext).expect("decrypt"),
            b"portable settings"
        );
        let last = ciphertext.len() - 1;
        ciphertext[last] ^= 1;
        assert!(decrypt_object(&key, "test", "vault-a", &ciphertext).is_err());
    }

    #[test]
    fn untrusted_kdf_parameters_are_bounded() {
        let mut kdf = default_kdf();
        kdf.memory_kib = MAX_MEMORY_KIB + 1;
        assert!(checked_kdf(&kdf).is_err());
        kdf.memory_kib = MIN_MEMORY_KIB;
        kdf.iterations = MAX_ITERATIONS + 1;
        assert!(checked_kdf(&kdf).is_err());
    }

    #[test]
    fn rewrap_preserves_the_vault_key_and_changes_the_password() {
        let (header, key) = create_vault("old-password", "vault-rewrap").expect("create");
        let rewrapped = rewrap_vault(&header, &key, "new-password").expect("rewrap");
        assert_eq!(
            unlock_vault(&rewrapped, "new-password").unwrap().as_bytes(),
            key.as_bytes()
        );
        assert!(unlock_vault(&rewrapped, "old-password").is_err());
    }

    #[test]
    fn vault_ids_cannot_escape_the_remote_object_namespace() {
        assert!(create_vault("password", "../other").is_err());
        let (header, _) = create_vault("password", "vault-safe").unwrap();
        let mut unsafe_header = header;
        unsafe_header.vault_id = "vault/other".into();
        assert!(unlock_vault(&unsafe_header, "password").is_err());
    }
}
