//! Relative, no-follow file operations for an already checked mutation path.
use crate::workspace::simple_canonicalize;
use std::ffi::{CString, OsStr};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

const DIR_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY;

pub(super) struct Parent(File);

impl Parent {
    pub(super) fn open_root(volume: &Path) -> io::Result<Self> {
        OpenOptions::new()
            .read(true)
            .custom_flags(DIR_FLAGS | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(volume)
            .map(Self)
    }

    pub(super) fn open_dir(&mut self, name: &OsStr, may_create: bool) -> io::Result<()> {
        let name = component(name)?;
        let next = match self.open_at(&name, DIR_FLAGS) {
            Ok(next) => next,
            Err(error) if may_create && error.kind() == io::ErrorKind::NotFound => {
                // SAFETY: the directory descriptor is live and the single
                // component name is NUL terminated. The umask still applies.
                if unsafe { libc::mkdirat(self.0.as_raw_fd(), name.as_ptr(), 0o777) } != 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
                self.open_at(&name, DIR_FLAGS)?
            }
            Err(error) => return Err(error),
        };
        self.0 = next;
        Ok(())
    }

    pub(super) fn open_read(&self, name: &OsStr) -> io::Result<File> {
        self.open_at(&component(name)?, libc::O_RDONLY)
    }

    pub(super) fn open_write(&self, name: &OsStr, create: bool) -> io::Result<File> {
        let flags = libc::O_WRONLY
            | if create {
                libc::O_CREAT | libc::O_EXCL
            } else {
                0
            };
        self.open_at(&component(name)?, flags)
    }

    pub(super) fn remove_file(&self, name: &OsStr, expected: &Path) -> io::Result<()> {
        let file = self.open_read(name)?;
        if !is_single_link(&file)? {
            return Err(io::Error::other("not a single-link regular file"));
        }
        verify_file_address(&file, expected)?;
        let name = component(name)?;
        // SAFETY: unlinkat does not follow a leaf symlink and cannot be
        // redirected through a path above the pinned parent.
        if unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn verify_address(&self, expected: &Path) -> io::Result<()> {
        verify_file_address(&self.0, expected)
    }

    fn open_at(&self, name: &CString, flags: libc::c_int) -> io::Result<File> {
        let flags = flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
        // SAFETY: a live parent FD and a single component. The optional mode
        // argument is used only for creation, subject to the effective umask.
        let fd = unsafe { libc::openat(self.0.as_raw_fd(), name.as_ptr(), flags, 0o666) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful openat returns a new, exclusively owned FD.
        Ok(File::from(unsafe { OwnedFd::from_raw_fd(fd) }))
    }
}

fn component(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into())
}

pub(super) fn is_single_link(file: &File) -> io::Result<bool> {
    let metadata = file.metadata()?;
    Ok(metadata.is_file() && metadata.nlink() == 1)
}

pub(super) fn is_single_link_path(_path: &Path, metadata: &std::fs::Metadata) -> io::Result<bool> {
    Ok(metadata.is_file() && metadata.nlink() == 1)
}

pub(super) fn verify_file_address(file: &File, expected: &Path) -> io::Result<()> {
    let opened = file.metadata()?;
    let current = std::fs::symlink_metadata(expected)?;
    if opened.dev() != current.dev()
        || opened.ino() != current.ino()
        || simple_canonicalize(expected)? != expected
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "file address changed",
        ));
    }
    Ok(())
}
