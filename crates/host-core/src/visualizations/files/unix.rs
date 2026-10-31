use super::{read_open_file, FragmentReadError};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub(super) fn read_fragment(
    data_dir: &Path,
    session_id: &str,
    file_name: &str,
) -> Result<Vec<u8>, FragmentReadError> {
    read_fragment_impl(data_dir, session_id, file_name, || {})
}

// Private seam for deterministic filesystem races. Production supplies no hook.
fn read_fragment_impl(
    data_dir: &Path,
    session_id: &str,
    file_name: &str,
    after_directory_pin: impl FnOnce(),
) -> Result<Vec<u8>, FragmentReadError> {
    // Canonical aliases are allowed only for the trusted data directory.
    let canonical = fs::canonicalize(data_dir).map_err(|_| FragmentReadError::NotFound)?;
    let data = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(canonical)
        .map_err(|_| FragmentReadError::NotFound)?;
    require_directory(&data)?;
    let base = open_relative(&data, "visualizations", true)?;
    let session = open_relative(&base, session_id, true)?;
    after_directory_pin();

    // Never resolve the leaf through an absolute path again. Renaming any
    // opened ancestor cannot redirect this directory capability to a victim.
    let leaf = open_relative(&session, file_name, false)?;
    read_open_file(leaf)
}

fn open_relative(parent: &File, name: &str, directory: bool) -> Result<File, FragmentReadError> {
    let name = CString::new(name).map_err(|_| FragmentReadError::NotFound)?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if directory {
            libc::O_DIRECTORY
        } else {
            // A FIFO with no writer must not block the filesystem worker.
            libc::O_NONBLOCK
        };
    // SAFETY: parent owns a live descriptor, name is NUL-terminated, and no
    // creation flag is set, so openat requires no variadic mode argument.
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(FragmentReadError::NotFound);
    }
    // SAFETY: openat returned a new, exclusively owned descriptor. OwnedFd
    // closes it on every return path, including failed metadata checks.
    let file = File::from(unsafe { OwnedFd::from_raw_fd(descriptor) });
    if directory {
        require_directory(&file)?;
    }
    Ok(file)
}

fn require_directory(file: &File) -> Result<(), FragmentReadError> {
    if file
        .metadata()
        .map_err(|_| FragmentReadError::NotFound)?
        .is_dir()
    {
        Ok(())
    } else {
        Err(FragmentReadError::NotFound)
    }
}

#[cfg(test)]
#[path = "unix_tests.rs"]
mod tests;
