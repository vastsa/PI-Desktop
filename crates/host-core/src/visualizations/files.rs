//! Bounded native reads for the private GenUI protocol bridge.
//!
//! Only the data directory is trusted. Owned directories and the leaf are
//! opened without following redirects, and stay bound to native handles.

use std::fs::File;
use std::io::Read;
use std::path::Path;

#[cfg(unix)]
#[path = "files/unix.rs"]
mod unix;
#[cfg(windows)]
#[path = "files/windows.rs"]
mod windows;

pub(crate) const MAX_FRAGMENT_BYTES: usize = 2_097_152;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FragmentReadError {
    NotFound,
    TooLarge,
}

impl std::fmt::Display for FragmentReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::NotFound => "not-found",
            Self::TooLarge => "too-large",
        })
    }
}

impl std::error::Error for FragmentReadError {}

/// Read one direct HTML fragment, preserving its bytes without decoding.
/// Missing, redirected, non-regular, invalid, and inaccessible entries all
/// fail closed without exposing paths through the private RPC error contract.
pub fn read_fragment(
    data_dir: &Path,
    session_id: &str,
    file_name: &str,
) -> Result<Vec<u8>, FragmentReadError> {
    if !valid_names(session_id, file_name) {
        return Err(FragmentReadError::NotFound);
    }
    #[cfg(unix)]
    {
        unix::read_fragment(data_dir, session_id, file_name)
    }
    #[cfg(windows)]
    {
        windows::read_fragment(data_dir, session_id, file_name)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = data_dir;
        Err(FragmentReadError::NotFound)
    }
}

fn valid_names(session_id: &str, file_name: &str) -> bool {
    let path = Path::new(file_name);
    !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        && !file_name.contains(['/', '\\'])
        && path.file_name().is_some_and(|name| name == file_name)
        && super::is_fragment_path(path)
}

fn read_open_file(file: File) -> Result<Vec<u8>, FragmentReadError> {
    let metadata = file.metadata().map_err(|_| FragmentReadError::NotFound)?;
    if !metadata.is_file() {
        return Err(FragmentReadError::NotFound);
    }
    read_bounded(file, metadata.len())
}

fn read_bounded(reader: impl Read, size: u64) -> Result<Vec<u8>, FragmentReadError> {
    if size > MAX_FRAGMENT_BYTES as u64 {
        return Err(FragmentReadError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(size as usize);
    reader
        .take((MAX_FRAGMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| FragmentReadError::NotFound)?;
    if bytes.len() > MAX_FRAGMENT_BYTES {
        return Err(FragmentReadError::TooLarge);
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "files/tests.rs"]
mod tests;
