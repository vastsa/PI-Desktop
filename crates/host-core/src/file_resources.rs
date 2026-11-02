//! Host-owned identities for the file tools. Paths are addresses, not identities.
//! Unknown identities and namespace-changing operations use a host-wide fence.
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::workspace::{resolve_tool_path_with_external, ContainedRoots};

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileId(u64, u128);

#[derive(Debug)]
pub struct FileResources {
    pub exclusive: bool,
    identity: Option<FileId>,
    address: Option<PathBuf>,
    // Keep the object alive while its ID is used, including queued admission.
    _file: Option<File>,
}

pub fn is_file_tool(name: &str) -> bool {
    matches!(name, "Read" | "Glob" | "Grep" | "Write" | "Edit")
}

pub fn is_write(name: &str) -> bool {
    matches!(name, "Write" | "Edit")
}

impl FileResources {
    pub fn fence(exclusive: bool) -> Arc<Self> {
        Arc::new(Self {
            exclusive,
            identity: None,
            address: None,
            _file: None,
        })
    }

    pub fn conflicts(&self, other: &Self) -> bool {
        (self.exclusive || other.exclusive)
            && (self.identity.is_none()
                || other.identity.is_none()
                || self.identity == other.identity
                || self.address == other.address)
    }

    /// Called only after the existing permission decision. No contents are read.
    pub fn resolve(
        root: Option<&Path>,
        roots: &ContainedRoots,
        name: &str,
        args: &Value,
        external: bool,
    ) -> Arc<Self> {
        let exclusive = is_write(name);
        let Some(root) = root else {
            return Self::fence(exclusive);
        };
        // Namespace changes and session registers conservatively fence all file
        // tools, including paths approved outside the workspace.
        if matches!(name, "Glob" | "Grep") || (name == "Edit" && structural_edit(args)) {
            return Self::fence(exclusive);
        }
        let Some(path) = args.get("path").and_then(Value::as_str) else {
            return Self::fence(exclusive);
        };
        let Ok((address, _)) = resolve_tool_path_with_external(root, roots, path, external) else {
            // Execution still reports the original permission/path/I/O failure.
            return Self::fence(exclusive);
        };
        // Classification must never wait for a FIFO reader/writer or open a
        // device. Recheck the opened object as the binding can change here.
        if !std::fs::metadata(&address).is_ok_and(|metadata| metadata.is_file()) {
            return Self::fence(exclusive);
        }
        #[cfg(unix)]
        let opened = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&address)
        };
        #[cfg(not(unix))]
        let opened = File::open(&address);
        let Ok(file) = opened else {
            return Self::fence(exclusive);
        };
        let Ok(metadata) = file.metadata() else {
            return Self::fence(exclusive);
        };
        if !metadata.is_file() {
            return Self::fence(exclusive);
        }
        let Some(identity) = file_id(&file, &address) else {
            return Self::fence(exclusive);
        };
        Arc::new(Self {
            exclusive,
            identity: Some(identity),
            address: Some(address),
            _file: Some(file),
        })
    }

    /// Revalidate under the granted lease before snapshotting and in the actual
    /// blocking task. A changed binding fails before mutation; it is never replayed.
    pub fn validate(
        &self,
        root: Option<&Path>,
        roots: &ContainedRoots,
        name: &str,
        args: &Value,
        external: bool,
    ) -> Result<(), String> {
        if self.identity.is_none() {
            return Ok(());
        }
        let current = Self::resolve(root, roots, name, args, external);
        if self.identity == current.identity && self.address == current.address {
            Ok(())
        } else {
            Err("file identity changed while awaiting admission; read the path again before retrying".into())
        }
    }
}

fn structural_edit(args: &Value) -> bool {
    args.get("ops").and_then(Value::as_str).is_some_and(|ops| {
        ops.lines().any(|line| {
            let mut words = line.split_whitespace();
            matches!(words.next(), Some("MV" | "REM"))
                || (matches!(line.split_whitespace().next(), Some("CUT" | "PUT"))
                    && words.any(|word| word.starts_with('@')))
        })
    })
}

#[cfg(unix)]
fn file_id(file: &File, _address: &Path) -> Option<FileId> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    // Only local filesystems with trustworthy object IDs may prove independence.
    let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(file.as_raw_fd(), fs.as_mut_ptr()) } != 0 {
        return None;
    }
    let fs = unsafe { fs.assume_init() };
    #[cfg(target_os = "linux")]
    if !matches!(
        fs.f_type as u64,
        0xEF53 | 0x58465342 | 0x9123683E | 0x01021994 | 0x794C7630
    ) {
        return None;
    }
    #[cfg(target_os = "macos")]
    if fs.f_flags & (libc::MNT_LOCAL as u32) == 0 {
        return None;
    }
    let metadata = file.metadata().ok()?;
    Some(FileId(metadata.dev(), u128::from(metadata.ino())))
}

#[cfg(windows)]
fn file_id(file: &File, address: &Path) -> Option<FileId> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetDriveTypeW, GetFileInformationByHandleEx, FILE_ID_INFO,
    };
    let spelling = address.to_string_lossy();
    let bytes = spelling.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' {
        return None;
    }
    let root: Vec<u16> = format!("{}:\\", bytes[0] as char)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    // DRIVE_FIXED / DRIVE_REMOVABLE only. UNC and mapped network drives fence.
    if !matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3) {
        return None;
    }
    let mut info = std::mem::MaybeUninit::<FILE_ID_INFO>::uninit();
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle().cast(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(FileId(
        info.VolumeSerialNumber,
        u128::from_le_bytes(info.FileId.Identifier),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claims(root: &Path, name: &str, path: &str) -> Arc<FileResources> {
        FileResources::resolve(
            Some(root),
            &ContainedRoots::new(),
            name,
            &json!({"path":path}),
            false,
        )
    }

    #[test]
    fn hard_links_conflict_and_independent_files_overlap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("actual"), "a").unwrap();
        std::fs::hard_link(dir.path().join("actual"), dir.path().join("alias")).unwrap();
        std::fs::write(dir.path().join("other"), "b").unwrap();
        let read = claims(dir.path(), "Read", "alias");
        let write = claims(dir.path(), "Write", "actual");
        assert!(read.conflicts(&write));
        assert!(!read.conflicts(&claims(dir.path(), "Write", "other")));
        assert!(!read.conflicts(&claims(dir.path(), "Read", "actual")));
    }

    #[test]
    fn missing_targets_and_structural_edits_fence() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), "a").unwrap();
        let read = claims(dir.path(), "Read", "a");
        assert!(read.conflicts(&claims(dir.path(), "Write", "missing")));
        for ops in ["MV other", "REM", "CUT 1.=2 @r", "PUT <1 @r"] {
            let edit = FileResources::resolve(
                Some(dir.path()),
                &ContainedRoots::new(),
                "Edit",
                &json!({"path":"a", "ops":ops}),
                false,
            );
            assert!(edit.identity.is_none());
            assert!(read.conflicts(&edit));
        }
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_and_cross_root_hard_links_share_identity() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("root-a");
        let b = dir.path().join("root-b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("actual"), "a").unwrap();
        std::os::unix::fs::symlink("actual", a.join("alias")).unwrap();
        std::fs::hard_link(a.join("actual"), b.join("different")).unwrap();
        assert!(claims(&a, "Read", "alias").conflicts(&claims(&b, "Write", "different")));
    }

    #[test]
    fn replaced_object_is_rejected_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), "a").unwrap();
        let write = claims(dir.path(), "Write", "a");
        std::fs::rename(dir.path().join("a"), dir.path().join("old")).unwrap();
        std::fs::write(dir.path().join("a"), "replacement").unwrap();
        assert!(write
            .validate(
                Some(dir.path()),
                &ContainedRoots::new(),
                "Write",
                &json!({"path":"a"}),
                false
            )
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn fifo_identity_classification_does_not_wait_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let root = dir.path().to_owned();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let resource = claims(&root, "Write", "pipe");
            tx.send(resource.identity.is_none()).unwrap();
        });
        let result = rx.recv_timeout(std::time::Duration::from_secs(2));
        // Unblock a regressed O_RDONLY open before joining, so a failing test
        // cannot strand the test process on a FIFO indefinitely.
        let _unblock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        worker.join().unwrap();
        assert!(result.unwrap());
    }
}
