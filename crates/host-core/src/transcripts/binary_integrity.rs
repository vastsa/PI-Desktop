//! Decoder-verified generations for transcript mutations. Layout offsets and
//! their disk sidecars never prove storage integrity. The Host state lock owns
//! file writes; this mutex only protects the process-local proof registry.
use super::*;
use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard, OnceLock},
    time::SystemTime,
};

#[derive(Clone, PartialEq, Eq)]
struct Generation {
    identity: layout::FileIdentity,
    length: u64,
    modified: SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
}

impl Generation {
    fn from_file(file: &File) -> Result<Self> {
        let metadata = file.metadata()?;
        Ok(Self {
            identity: layout::opened_file_identity(file, &metadata),
            length: metadata.len(),
            modified: metadata.modified()?,
            #[cfg(unix)]
            changed: {
                use std::os::unix::fs::MetadataExt;
                (metadata.ctime(), metadata.ctime_nsec())
            },
            #[cfg(windows)]
            changed: change_time(file)?,
        })
    }

    fn can_cache(&self) -> bool {
        matches!(self.identity, layout::FileIdentity::Available { .. })
    }

    fn ensure_current(&self, file: &File, path: &Path) -> Result<()> {
        anyhow::ensure!(
            *self == Self::from_file(file)? && *self == Self::from_file(&File::open(path)?)?,
            "transcript changed while checking storage integrity: {}",
            path.display()
        );
        Ok(())
    }
}

#[cfg(windows)]
pub(super) fn change_time(file: &File) -> Result<i64> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO},
    };
    let mut info = FILE_BASIC_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error()).context("read transcript change time");
    }
    Ok(info.ChangeTime)
}

fn proofs() -> MutexGuard<'static, HashMap<PathBuf, Generation>> {
    static PROOFS: OnceLock<Mutex<HashMap<PathBuf, Generation>>> = OnceLock::new();
    PROOFS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("transcript storage integrity proof lock poisoned")
}

pub(super) fn invalidate(path: &Path) {
    proofs().remove(path);
}

/// The prefix was verified by prepare and the new line came from tagged().
/// Close the synced writer before reading its final metadata: Windows may
/// publish the last-write timestamp only when the write handle closes.
pub(super) fn appended(path: &Path, file: File) -> Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(());
    }
    let identity = layout::opened_file_identity(&file, &metadata);
    drop(file);
    let generation = Generation::from_file(&File::open(path)?)?;
    anyhow::ensure!(
        identity == generation.identity && metadata.len() == generation.length,
        "transcript changed after append: {}",
        path.display()
    );
    if generation.can_cache() {
        proofs().insert(path.to_path_buf(), generation);
    }
    Ok(())
}

/// A first mutation after restart or an outside rewrite checks every existing
/// line. Ordinary mutations reuse only a proof for this exact file generation.
pub(super) fn verify(path: &Path, reader: &mut BufReader<File>) -> Result<()> {
    let generation = Generation::from_file(reader.get_ref())?;
    generation.ensure_current(reader.get_ref(), path)?;
    let cached = proofs().get(path).cloned();
    if generation.can_cache() && cached.as_ref() == Some(&generation) {
        return Ok(());
    }
    invalidate(path);
    reader.seek(SeekFrom::Start(0))?;
    #[cfg(test)]
    SCANS.with(|scans| *scans.borrow_mut().entry(path.to_path_buf()).or_default() += 1);
    let mut raw = Vec::new();
    let mut line = String::new();
    loop {
        let (read, _) = read_line_tolerant(reader, &mut raw, &mut line)?;
        if read == 0 {
            break;
        }
        if let Err(error) = binary_storage::validate_line(line.trim()) {
            if binary_storage::is_error(&error) {
                return Err(error).with_context(|| format!("validate storage {}", path.display()));
            }
        }
        line.clear();
    }
    generation.ensure_current(reader.get_ref(), path)?;
    if generation.can_cache() {
        proofs().insert(path.to_path_buf(), generation);
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    // Count real full scans so the O(1) owned-append contract is reproducible
    // without wall-clock thresholds or depending on another test's activity.
    static SCANS: std::cell::RefCell<HashMap<PathBuf, usize>> = Default::default();
}

#[cfg(test)]
pub(super) fn scan_count(path: &Path) -> usize {
    SCANS.with(|scans| scans.borrow().get(path).copied().unwrap_or_default())
}
