//! Stable device identity for the plugin center's download interface.
//!
//! The platform resolves a download once per install and deduplicates the
//! statistic per (identity, plugin, version, UTC day). Its contract asks the
//! client for a value that is stable per installation, so this module derives
//! one from the machine and falls back to a value generated once and kept.
//!
//! What leaves the machine is a digest, never the machine code itself. The
//! platform only ever counts, so it has no use for the raw value, and a digest
//! keeps a hardware identifier out of a third party's request log.

use super::*;
use std::sync::OnceLock;

/// Namespace folded into the digest.
///
/// It carries the derivation version, so a future change to how the identifier
/// is derived cannot silently keep matching identities derived the old way.
const DEVICE_ID_NAMESPACE: &str = "pi-desktop.device.v1:";

/// Where a machine without a readable identifier keeps the value it generated.
const DEVICE_ID_FILE: &str = "plugins/market/device.json";

/// The device id for this installation, computed once per process.
pub(crate) fn device_id(data_dir: &Path) -> String {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| derive_device_id(raw_machine_id().as_deref(), data_dir))
        .clone()
}

/// Derive the identifier the platform is told about.
///
/// Split out from [`device_id`] so both arms can be exercised without depending
/// on the machine a test runs on.
pub(crate) fn derive_device_id(machine_id: Option<&str>, data_dir: &Path) -> String {
    if let Some(machine) = machine_id.map(str::trim).filter(|value| !value.is_empty()) {
        return digest(machine);
    }

    let path = data_dir.join(DEVICE_ID_FILE);
    if let Some(existing) = fs::read_to_string(&path)
        .ok()
        .as_deref()
        .and_then(parse_stored)
    {
        return existing;
    }

    let generated = generated_id();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // A failure to persist it must not fail an install: the value is still
    // stable for this run, and the next run generates another one.
    let _ = fs::write(&path, format!("{{\"deviceId\":\"{generated}\"}}\n"));
    generated
}

fn digest(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(DEVICE_ID_NAMESPACE.as_bytes());
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

/// 64 hex characters, from two v4 UUIDs so no extra random source is needed.
fn generated_id() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// A stored value, when it is a device id this module wrote.
fn parse_stored(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let id = value.get("deviceId")?.as_str()?.trim();
    if id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(id.to_ascii_lowercase());
    }
    None
}

/// The machine's own identifier, when this platform has a readable one.
///
/// Windows reads `MachineGuid`, macOS the platform UUID, and Linux the machine
/// id the distribution writes. All three survive a reinstall of PI-Desktop and
/// change when the operating system is installed again, which is the stability
/// the platform's deduplication wants.
#[cfg(windows)]
fn raw_machine_id() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    const SUBKEY: &str = "SOFTWARE\\Microsoft\\Cryptography";
    const VALUE: &str = "MachineGuid";

    let subkey: Vec<u16> = SUBKEY.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = VALUE.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buffer = [0u16; 64];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    // The size is in bytes and includes the terminating NUL.
    let len = (size as usize / 2).saturating_sub(1).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..len]);
    Some(text).filter(|value| !value.trim().is_empty())
}

/// macOS: the platform UUID, through libc so no Objective-C runtime is needed.
#[cfg(target_os = "macos")]
fn raw_machine_id() -> Option<String> {
    let mut uuid = [0u8; 16];
    let timeout = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    let status = unsafe { libc::gethostuuid(uuid.as_mut_ptr(), &timeout) };
    if status != 0 {
        return None;
    }
    Some(hex::encode(uuid))
}

/// Linux and the other unices: the machine id file the distribution maintains.
#[cfg(all(unix, not(target_os = "macos")))]
fn raw_machine_id() -> Option<String> {
    for path in [
        "/etc/machine-id",
        "/var/lib/dbus/machine-id",
        "/sys/class/dmi/id/product_uuid",
    ] {
        if let Ok(text) = fs::read_to_string(path) {
            let value = text.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(not(any(windows, unix)))]
fn raw_machine_id() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_identifier_is_reported_as_a_digest() {
        let id = derive_device_id(Some("machine-guid-1234"), Path::new("."));
        assert_eq!(id.len(), 64, "the id is a sha256 digest: {id}");
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, "machine-guid-1234", "the raw value must not be sent");
        assert_eq!(
            id,
            derive_device_id(Some("machine-guid-1234"), Path::new(".")),
            "the same machine keeps the same id"
        );
        assert_ne!(
            id,
            derive_device_id(Some("another-machine"), Path::new(".")),
            "two machines do not share an id"
        );
    }

    #[test]
    fn a_machine_without_an_identifier_keeps_what_it_generated() {
        let dir = tempfile::tempdir().unwrap();
        let first = derive_device_id(None, dir.path());
        assert_eq!(first.len(), 64);
        assert_eq!(
            derive_device_id(None, dir.path()),
            first,
            "a relaunch must reuse the stored value"
        );
    }

    #[test]
    fn an_unusable_stored_value_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DEVICE_ID_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{\"deviceId\":\"too-short\"}\n").unwrap();
        let id = derive_device_id(None, dir.path());
        assert_eq!(id.len(), 64);
        assert_ne!(id, "too-short");
        // The replacement is written back, so the next run reads a usable one.
        let stored = fs::read_to_string(&path).unwrap();
        assert!(stored.contains(&id), "the new value is stored: {stored}");
    }
}
