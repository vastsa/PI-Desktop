//! The documented NtCreateFile RootDirectory contract is Windows' native
//! directory-relative open. No DOS child path or reopened ancestor is used.

use super::FragmentReadError;
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{
    HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_READ, SYNCHRONIZE,
};

const FILE_OPEN: u32 = 1;
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

// winternl OBJECT_ATTRIBUTES / IO_STATUS_BLOCK layouts. The existing Cargo
// features expose UNICODE_STRING but not Wdk::Foundation or System::IO. The
// optional security fields really are PVOID in this contract and stay null;
// user-mode opens still enforce the caller's normal access token and ACLs.
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *const UNICODE_STRING,
    attributes: u32,
    security_descriptor: *const c_void,
    security_quality_of_service: *const c_void,
}

#[repr(C)]
union IoStatus {
    status: NTSTATUS,
    pointer: *mut c_void,
}

#[repr(C)]
struct IoStatusBlock {
    result: IoStatus,
    information: usize,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    #[link_name = "NtCreateFile"]
    fn nt_create_file(
        file_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *const ObjectAttributes,
        io_status_block: *mut IoStatusBlock,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> NTSTATUS;
}

pub(super) fn open_child(
    parent: &File,
    name: &OsStr,
    directory: bool,
) -> Result<File, FragmentReadError> {
    let mut wide = component_name(name)?;
    let length = u16::try_from(wide.len() * 2).map_err(|_| FragmentReadError::NotFound)?;
    let maximum_length = length.checked_add(2).ok_or(FragmentReadError::NotFound)?;
    wide.push(0);
    let unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: maximum_length,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle(),
        object_name: &unicode,
        attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        security_descriptor: std::ptr::null(),
        security_quality_of_service: std::ptr::null(),
    };
    let mut io_status = IoStatusBlock {
        result: IoStatus {
            pointer: std::ptr::null_mut(),
        },
        information: 0,
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let desired_access = FILE_READ_ATTRIBUTES
        | SYNCHRONIZE
        | if directory {
            FILE_LIST_DIRECTORY
        } else {
            FILE_READ_DATA
        };
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
    // SAFETY: parent is a live directory File, the single-component UTF-16
    // name and all repr(C) arguments live through the synchronous create.
    // FILE_OPEN never creates/truncates; SYNCHRONIZE is paired with synchronous
    // I/O. OBJ_DONT_REPARSE rejects reparsing and OPEN_REPARSE_POINT forbids
    // following the final entry; the caller also checks opened-handle metadata.
    let status = unsafe {
        nt_create_file(
            &mut handle,
            desired_access,
            &attributes,
            &mut io_status,
            std::ptr::null(),
            0,
            FILE_SHARE_READ,
            FILE_OPEN,
            options,
            std::ptr::null(),
            0,
        )
    };
    // Immediately own any returned handle, even on a failure status, so all
    // later early returns close it. NtCreateFile initializes no handle on
    // failed opens; the output was initialized to null before the call.
    let owned = if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        None
    } else {
        // SAFETY: NtCreateFile returned a new, exclusively owned HANDLE.
        Some(unsafe { OwnedHandle::from_raw_handle(handle) })
    };
    // NT_SUCCESS is status >= 0. Native failures are NTSTATUS, not GetLastError.
    if status < 0 {
        return Err(FragmentReadError::NotFound);
    }
    owned.map(File::from).ok_or(FragmentReadError::NotFound)
}

fn component_name(name: &OsStr) -> Result<Vec<u16>, FragmentReadError> {
    let wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty()
        || name == "."
        || name == ".."
        || wide.iter().any(|unit| matches!(*unit, 0 | 47 | 58 | 92))
        || wide.len() > (u16::MAX as usize - 2) / 2
    {
        return Err(FragmentReadError::NotFound);
    }
    Ok(wide)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{align_of, offset_of};

    #[test]
    fn native_binding_layout_matches_winternl() {
        let pointer = size_of::<HANDLE>();
        assert_eq!(size_of::<UNICODE_STRING>(), pointer * 2);
        assert_eq!(size_of::<ObjectAttributes>(), pointer * 6);
        assert_eq!(align_of::<ObjectAttributes>(), pointer);
        assert_eq!(offset_of!(ObjectAttributes, root_directory), pointer);
        assert_eq!(offset_of!(ObjectAttributes, object_name), pointer * 2);
        assert_eq!(offset_of!(ObjectAttributes, attributes), pointer * 3);
        assert_eq!(
            offset_of!(ObjectAttributes, security_descriptor),
            pointer * 4
        );
        assert_eq!(
            offset_of!(ObjectAttributes, security_quality_of_service),
            pointer * 5
        );
        assert_eq!(size_of::<IoStatusBlock>(), pointer * 2);
        assert_eq!(align_of::<IoStatusBlock>(), pointer);
        assert_eq!(offset_of!(IoStatusBlock, information), pointer);
    }

    #[test]
    fn relative_native_names_cannot_reach_another_directory_or_stream() {
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:child",
            "chart.html:stream",
            "a\0b",
        ] {
            assert_eq!(
                component_name(OsStr::new(name)),
                Err(FragmentReadError::NotFound)
            );
        }
        assert!(component_name(OsStr::new("a folder")).is_ok());
        assert!(component_name(OsStr::new("chart.html")).is_ok());
    }
}
