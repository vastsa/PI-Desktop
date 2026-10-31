use super::{read_open_file, FragmentReadError};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileType, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FILE_TYPE_DISK, SYNCHRONIZE,
};

#[path = "windows_native.rs"]
mod native;

pub(super) fn read_fragment(
    data_dir: &Path,
    session_id: &str,
    file_name: &str,
) -> Result<Vec<u8>, FragmentReadError> {
    read_fragment_impl(data_dir, session_id, file_name, |_| {})
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectoryPin {
    Data,
    Base,
    Session,
}

// Private deterministic race seam; no hook can be supplied through the RPC.
fn read_fragment_impl(
    data_dir: &Path,
    session_id: &str,
    file_name: &str,
    mut after_directory_pin: impl FnMut(DirectoryPin),
) -> Result<Vec<u8>, FragmentReadError> {
    // Resolve aliases only for the trusted data root. From the drive/share
    // root onwards, every component is opened relative to its parent HANDLE.
    let canonical = fs::canonicalize(data_dir).map_err(|_| FragmentReadError::NotFound)?;
    let (volume, components) = directory_components(&canonical)?;
    let mut pins = vec![open_volume(&volume)?];
    for component in components {
        pin_directory(&mut pins, component)?;
    }
    after_directory_pin(DirectoryPin::Data);
    pin_directory(&mut pins, OsStr::new("visualizations"))?;
    after_directory_pin(DirectoryPin::Base);
    pin_directory(&mut pins, OsStr::new(session_id))?;
    after_directory_pin(DirectoryPin::Session);

    // Share masks alone are not capabilities: FILE_WRITE_ATTRIBUTES can set
    // reparse data even while read pins are held. Never reopen an absolute
    // child path; RootDirectory binds the leaf to the actual session object.
    let session = pins.last().ok_or(FragmentReadError::NotFound)?;
    let leaf = native::open_child(session, OsStr::new(file_name), false)?;
    validate_entry(&leaf, false)?;
    let result = read_open_file(leaf);
    drop(pins);
    result
}

fn pin_directory(pins: &mut Vec<File>, name: &OsStr) -> Result<(), FragmentReadError> {
    let parent = pins.last().ok_or(FragmentReadError::NotFound)?;
    let child = native::open_child(parent, name, true)?;
    validate_entry(&child, true)?;
    pins.push(child);
    Ok(())
}

// The sole absolute open is the trusted canonical drive/share root, not any
// mutable directory entry below it. Owned entries are all native-relative.
fn open_volume(path: &Path) -> Result<File, FragmentReadError> {
    let file = OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| FragmentReadError::NotFound)?;
    validate_entry(&file, true)?;
    Ok(file)
}

fn validate_entry(file: &File, directory: bool) -> Result<(), FragmentReadError> {
    let metadata = file.metadata().map_err(|_| FragmentReadError::NotFound)?;
    // SAFETY: File owns a live Windows handle for the duration of this call.
    let disk = unsafe { GetFileType(file.as_raw_handle()) == FILE_TYPE_DISK };
    if !disk
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(FragmentReadError::NotFound);
    }
    Ok(())
}

fn directory_components(canonical: &Path) -> Result<(PathBuf, Vec<&OsStr>), FragmentReadError> {
    let mut components = canonical.components();
    let prefix = match components.next() {
        Some(Component::Prefix(prefix))
            if matches!(
                prefix.kind(),
                Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..)
            ) =>
        {
            prefix
        }
        _ => return Err(FragmentReadError::NotFound),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(FragmentReadError::NotFound);
    }
    let mut volume = PathBuf::from(prefix.as_os_str());
    volume.push(Component::RootDir.as_os_str());
    let mut names = Vec::new();
    for component in components {
        let Component::Normal(name) = component else {
            return Err(FragmentReadError::NotFound);
        };
        names.push(name);
    }
    Ok((volume, names))
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
