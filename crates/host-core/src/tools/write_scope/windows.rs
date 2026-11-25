//! Handle-relative writes: a reparse point introduced after path resolution
//! must not redirect creation, truncation, or deletion.
use crate::windows_relative as native;
use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, GetDriveTypeW, GetFileInformationByHandle, GetFileType,
    GetFinalPathNameByHandleW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
    FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_TYPE_DISK, FILE_WRITE_DATA, SYNCHRONIZE, VOLUME_NAME_DOS,
};

const DIR_ACCESS: u32 = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
// Allow unrelated tools to work in this directory, but do not share deletion
// while a namespace operation is using it.
const DIR_SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;

pub(super) struct Parent(Vec<File>);

impl Parent {
    pub(super) fn open_root(volume: &Path) -> io::Result<Self> {
        let wide: Vec<_> = volume.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: the root string is NUL terminated. Mapped/network drives
        // are not covered by the local directory/identity checks.
        if !matches!(unsafe { GetDriveTypeW(wide.as_ptr()) }, 2 | 3) {
            return Err(io::ErrorKind::Unsupported.into());
        }
        let file = OpenOptions::new()
            .access_mode(DIR_ACCESS)
            .share_mode(DIR_SHARE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(volume)?;
        require_directory(&file)?;
        Ok(Self(vec![file]))
    }

    pub(super) fn open_dir(&mut self, name: &OsStr, may_create: bool) -> io::Result<()> {
        let directory = match self.open(name, true, DIR_ACCESS, DIR_SHARE, native::OPEN) {
            Ok(directory) => directory,
            Err(error) if may_create && error.kind() == io::ErrorKind::NotFound => {
                match self.open(name, true, DIR_ACCESS, DIR_SHARE, native::CREATE) {
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        self.open(name, true, DIR_ACCESS, DIR_SHARE, native::OPEN)?
                    }
                    result => result?,
                }
            }
            Err(error) => return Err(error),
        };
        require_directory(&directory)?;
        self.0.push(directory);
        Ok(())
    }

    pub(super) fn open_read(&self, name: &OsStr) -> io::Result<File> {
        self.open(name, false, FILE_READ_DATA, FILE_SHARE_READ, native::OPEN)
    }

    pub(super) fn open_write(&self, name: &OsStr, create: bool) -> io::Result<File> {
        self.open(
            name,
            false,
            FILE_READ_DATA | FILE_WRITE_DATA,
            FILE_SHARE_READ,
            if create { native::CREATE } else { native::OPEN },
        )
    }

    pub(super) fn remove_file(&self, name: &OsStr, expected: &Path) -> io::Result<()> {
        let file = self.open(name, false, DELETE, FILE_SHARE_READ, native::OPEN)?;
        if !is_single_link(&file)? {
            return Err(io::Error::other("not a single-link regular file"));
        }
        verify_file_address(&file, expected)?;
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: file owns a live DELETE handle and the info buffer is valid
        // through the call. Disposition applies to that file, not a fresh path.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn verify_address(&self, expected: &Path) -> io::Result<()> {
        verify_file_address(self.0.last().ok_or(io::ErrorKind::NotFound)?, expected)
    }

    fn open(
        &self,
        name: &OsStr,
        directory: bool,
        access: u32,
        share: u32,
        disposition: u32,
    ) -> io::Result<File> {
        let parent = self.0.last().ok_or(io::ErrorKind::NotFound)?;
        native::open_child(
            parent,
            name,
            directory,
            access | FILE_READ_ATTRIBUTES,
            share,
            disposition,
            false,
        )
    }
}

fn require_directory(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("not an ordinary directory"));
    }
    Ok(())
}

pub(super) fn is_single_link_path(path: &Path, _metadata: &Metadata) -> io::Result<bool> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    is_single_link(&file)
}

pub(super) fn is_single_link(file: &File) -> io::Result<bool> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the File owns a live handle and the result buffer is writable.
    unsafe {
        if GetFileType(file.as_raw_handle()) != FILE_TYPE_DISK {
            return Ok(false);
        }
        if GetFileInformationByHandle(file.as_raw_handle(), &mut info) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(
        info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) == 0
            && info.nNumberOfLinks == 1,
    )
}

pub(super) fn verify_file_address(file: &File, expected: &Path) -> io::Result<()> {
    let mut buffer = vec![0_u16; 512];
    loop {
        // SAFETY: the handle and the writable buffer are valid for this call.
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        if len >= buffer.len() {
            buffer.resize(len + 1, 0);
            continue;
        }
        let prefix = [92, 92, 63, 92]; // \\?\
        if buffer[..len]
            .strip_prefix(&prefix)
            .is_some_and(|path| Path::new(&OsString::from_wide(path)) == expected)
        {
            return Ok(());
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "file address changed",
        ));
    }
}
