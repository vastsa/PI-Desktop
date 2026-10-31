use super::super::tests::{fixture, FILE_NAME, ORIGINAL, SESSION, VICTIM};
use super::super::{read_fragment, FragmentReadError};
use super::{directory_components, read_fragment_impl, DirectoryPin};
use std::ffi::{c_void, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{symlink_file, MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, Prefix};
use std::process::Command;
use windows_sys::Win32::Foundation::{ERROR_SHARING_VIOLATION, GENERIC_WRITE};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_APPEND_DATA, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
};

const MUTATION_ACCESS: [u32; 4] = [FILE_WRITE_DATA, FILE_APPEND_DATA, GENERIC_WRITE, DELETE];

fn junction_command_path(path: &Path) -> String {
    // cmd/mklink consume DOS spelling, not the reader's verbatim handle path.
    let native = path.to_str().expect("Unicode test path").replace('/', "\\");
    if let Some(path) = native.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else {
        native.strip_prefix(r"\\?\").unwrap_or(&native).to_owned()
    }
}

fn junction(link: &Path, target: &Path) {
    // Junctions need no symlink privilege. raw_arg preserves cmd quoting:
    // passing the quoted command through arg would introduce CRT backslashes.
    let command = format!(
        "mklink /J \"{}\" \"{}\"",
        junction_command_path(link),
        junction_command_path(target)
    );
    let output = Command::new("cmd.exe")
        .args(["/D", "/V:OFF", "/C"])
        .raw_arg(command)
        .output()
        .expect("create test junction");
    assert!(
        output.status.success(),
        "junction creation failed: {output:?}"
    );
}

fn open_directory_access(path: &Path, access: u32) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

// Test-only synchronous binding: the existing windows-sys features do not
// expose System::IO. No new dependency or production FFI surface is needed.
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "DeviceIoControl"]
    fn device_io_control(
        handle: *mut c_void,
        code: u32,
        input: *const c_void,
        input_size: u32,
        output: *mut c_void,
        output_size: u32,
        returned: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
}

fn set_junction(file: &File, target: &Path) -> io::Result<()> {
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00a4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xa000_0003;
    let canonical = fs::canonicalize(target)?;
    let mut substitute: Vec<u16> = canonical.as_os_str().encode_wide().collect();
    assert!(substitute.starts_with(&[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16]));
    // Convert \\?\C:\... to the mount point's native \??\C:\... name.
    substitute[1] = b'?' as u16;
    let print: Vec<u16> = junction_command_path(&canonical).encode_utf16().collect();
    let substitute_bytes = u16::try_from(substitute.len() * 2).expect("short test target");
    let print_bytes = u16::try_from(print.len() * 2).expect("short test target");
    let data_bytes = u16::try_from(8 + (substitute.len() + print.len() + 2) * 2)
        .expect("short mount point buffer");
    let mut buffer = Vec::new();
    buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    // REPARSE_DATA_BUFFER header, then the mount point offsets and lengths.
    for value in [
        data_bytes,
        0,
        0,
        substitute_bytes,
        substitute_bytes + 2,
        print_bytes,
    ] {
        buffer.extend_from_slice(&value.to_le_bytes());
    }
    for unit in substitute.into_iter().chain([0]).chain(print).chain([0]) {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }
    let mut returned = 0;
    // SAFETY: File owns a live handle; input is an initialized mount-point
    // buffer. Output/OVERLAPPED are null for this synchronous, input-only call.
    let result = unsafe {
        device_io_control(
            file.as_raw_handle(),
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            u32::try_from(buffer.len()).expect("short test buffer"),
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[test]
fn junction_command_paths_convert_verbatim_drive_and_unc_spelling() {
    assert_eq!(
        junction_command_path(Path::new(r"\\?\C:\a folder\data")),
        r"C:\a folder\data"
    );
    assert_eq!(
        junction_command_path(Path::new(r"\\?\UNC\server\share\data")),
        r"\\server\share\data"
    );
    assert_eq!(
        junction_command_path(Path::new("C:/a folder/data")),
        r"C:\a folder\data"
    );
}

#[test]
fn extended_drive_and_unc_paths_keep_their_root_components() {
    let (drive, names) =
        directory_components(Path::new(r"\\?\C:\Users\example\data")).expect("drive components");
    assert_eq!(drive, Path::new(r"\\?\C:\"));
    assert_eq!(
        names,
        [
            OsStr::new("Users"),
            OsStr::new("example"),
            OsStr::new("data")
        ]
    );
    let (share, names) =
        directory_components(Path::new(r"\\?\UNC\server\share\data")).expect("UNC components");
    assert_eq!(share, Path::new(r"\\?\UNC\server\share\"));
    assert_eq!(names, [OsStr::new("data")]);
    for path in [
        r"C:\data",
        r"C:data",
        r"\\.\pipe\data",
        r"\\?\C:\data\..\other",
    ] {
        assert!(directory_components(Path::new(path)).is_err());
    }
}

#[test]
fn reads_canonical_drive_path_and_allows_trusted_data_junction_alias() {
    let fixture = fixture();
    let canonical = fs::canonicalize(&fixture.data).expect("canonical data");
    assert!(matches!(
        canonical.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..))
    ));
    assert_eq!(
        read_fragment(&canonical, SESSION, FILE_NAME),
        Ok(ORIGINAL.to_vec())
    );
    // Exercise both verbatim input and spaces in the actual cmd invocation.
    let alias = canonical.with_file_name("data alias");
    junction(&alias, &canonical);
    assert_eq!(
        read_fragment(&alias, SESSION, FILE_NAME),
        Ok(ORIGINAL.to_vec())
    );
    fs::remove_dir(alias).expect("remove data junction");
}

#[test]
fn rejects_visualization_base_junction_even_to_original_base() {
    let fixture = fixture();
    let base = fixture.data.join("visualizations");
    let held = fixture.data.join("held-base");
    fs::rename(&base, &held).expect("move base");
    junction(&base, &held);
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    fs::remove_dir(base).expect("remove base junction");
}

#[test]
fn rejects_same_root_session_junction_alias() {
    let fixture = fixture();
    let victim = fixture.data.join("visualizations").join("session-B");
    fs::create_dir(&victim).expect("victim session");
    fs::write(victim.join(FILE_NAME), VICTIM).expect("victim fragment");
    let held = fixture.session.with_file_name("held-session");
    fs::rename(&fixture.session, &held).expect("move session");
    junction(&fixture.session, &victim);
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    fs::remove_dir(&fixture.session).expect("remove session junction");
}

#[test]
fn rejects_reparse_leaf_and_file_symlink_when_privilege_is_available() {
    let fixture = fixture();
    let leaf = fixture.session.join(FILE_NAME);
    fs::remove_file(&leaf).expect("remove original leaf");
    junction(&leaf, fixture.temp.path());
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    fs::remove_dir(&leaf).expect("remove leaf junction");
    let victim = fixture.temp.path().join("victim.html");
    fs::write(&victim, VICTIM).expect("victim fragment");
    match symlink_file(&victim, &leaf) {
        Ok(()) => assert_eq!(
            read_fragment(&fixture.data, SESSION, FILE_NAME),
            Err(FragmentReadError::NotFound)
        ),
        Err(error) if error.raw_os_error() == Some(1314) => {
            eprintln!("file symlink assertion skipped: Windows symlink privilege is unavailable");
        }
        Err(error) => panic!("create leaf symlink: {error}"),
    }
}

#[test]
fn pins_data_ancestors_base_and_session_until_read_completes() {
    let fixture = fixture();
    let base = fixture.data.join("visualizations");
    let paths = [
        fixture.temp.path(),
        fixture.data.as_path(),
        base.as_path(),
        fixture.session.as_path(),
    ];
    // Establish that actual data/append/delete rights work without our pins.
    for path in paths {
        for access in MUTATION_ACCESS {
            drop(open_directory_access(path, access).expect("unpinned mutable directory"));
        }
    }
    let result = read_fragment_impl(&fixture.data, SESSION, FILE_NAME, |stage| {
        if stage != DirectoryPin::Session {
            return;
        }
        for path in paths {
            let replacement = path.with_file_name("rename-attempt");
            assert!(
                fs::rename(path, &replacement).is_err(),
                "pinned ancestor cannot be renamed"
            );
            for access in MUTATION_ACCESS {
                let error = open_directory_access(path, access)
                    .expect_err("pinned ancestor cannot acquire mutation rights");
                assert_eq!(error.raw_os_error(), Some(ERROR_SHARING_VIOLATION as i32));
            }
        }
    });
    assert_eq!(result, Ok(ORIGINAL.to_vec()));
    for path in paths {
        for access in MUTATION_ACCESS {
            drop(open_directory_access(path, access).expect("directory pin released"));
        }
    }
    let held = fixture.session.with_file_name("renamed-after-read");
    fs::rename(&fixture.session, &held).expect("session pin released");
    fs::rename(&held, &fixture.session).expect("restore session");
}

#[test]
fn refuses_preexisting_write_or_delete_directory_handles() {
    let fixture = fixture();
    for access in MUTATION_ACCESS {
        let mutable = open_directory_access(&fixture.session, access)
            .expect("existing mutable session handle");
        assert_eq!(
            read_fragment(&fixture.data, SESSION, FILE_NAME),
            Err(FragmentReadError::NotFound)
        );
        drop(mutable);
    }
    let deletion = open_directory_access(&fixture.data, DELETE).expect("existing deletable data");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    drop(deletion);
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Ok(ORIGINAL.to_vec())
    );
}

#[test]
fn relative_leaf_open_survives_attribute_only_session_junction_mutation() {
    let fixture = fixture();
    fs::remove_file(fixture.session.join(FILE_NAME)).expect("empty original session");
    let victim = fixture.data.join("visualizations").join("session-B");
    fs::create_dir(&victim).expect("victim session");
    fs::write(victim.join(FILE_NAME), VICTIM).expect("victim fragment");
    assert_attribute_junction_attack_contained(
        &fixture.data,
        &fixture.session,
        &victim,
        DirectoryPin::Session,
    );
    assert_eq!(
        fs::read(victim.join(FILE_NAME)).expect("intact victim"),
        VICTIM
    );
}

#[test]
fn relative_session_open_survives_attribute_only_base_junction_mutation() {
    let fixture = fixture();
    fs::remove_dir_all(&fixture.session).expect("empty original base");
    let base = fixture.data.join("visualizations");
    let victim = fixture.temp.path().join("victim-base");
    fs::create_dir_all(victim.join(SESSION)).expect("victim base");
    fs::write(victim.join(SESSION).join(FILE_NAME), VICTIM).expect("victim fragment");
    assert_attribute_junction_attack_contained(&fixture.data, &base, &victim, DirectoryPin::Base);
    assert_eq!(
        fs::read(victim.join(SESSION).join(FILE_NAME)).expect("intact victim"),
        VICTIM
    );
}

#[test]
fn relative_base_open_survives_attribute_only_data_ancestor_junction_mutation() {
    let fixture = fixture();
    fs::remove_dir_all(fixture.data.join("visualizations")).expect("empty original data");
    let victim = fixture.temp.path().join("victim-data");
    let victim_session = victim.join("visualizations").join(SESSION);
    fs::create_dir_all(&victim_session).expect("victim data");
    fs::write(victim_session.join(FILE_NAME), VICTIM).expect("victim fragment");
    assert_attribute_junction_attack_contained(
        &fixture.data,
        &fixture.data,
        &victim,
        DirectoryPin::Data,
    );
    assert_eq!(
        fs::read(victim_session.join(FILE_NAME)).expect("intact victim"),
        VICTIM
    );
}

fn assert_attribute_junction_attack_contained(
    data: &Path,
    directory: &Path,
    victim: &Path,
    stage: DirectoryPin,
) {
    let exposed_leaf = data.join("visualizations").join(SESSION).join(FILE_NAME);
    let mut attacked = false;
    let result = read_fragment_impl(data, SESSION, FILE_NAME, |current| {
        if current != stage {
            return;
        }
        let attributes = open_directory_access(directory, FILE_WRITE_ATTRIBUTES)
            .expect("attribute-only attacker handle while read pins are held");
        // Windows CI proves this succeeds despite read/delete share pins.
        // Preserve that mutation as a positive control, not a denial assumption.
        set_junction(&attributes, victim).expect("attribute-only junction mutation succeeds");
        drop(attributes);
        attacked = true;
        let metadata = fs::symlink_metadata(directory).expect("mutated directory metadata");
        assert_ne!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        let old_absolute = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&exposed_leaf)
            .expect("old absolute leaf open, including its no-follow/share flags");
        assert_eq!(
            super::super::read_open_file(old_absolute)
                .expect("old bounded absolute lookup control"),
            VICTIM
        );
    });
    assert!(attacked, "the real filesystem mutation hook must have run");
    // The original pinned directory was empty. A relative open must fail;
    // the old absolute lookup above demonstrably reads the victim instead.
    assert_eq!(result, Err(FragmentReadError::NotFound));
    fs::remove_dir(directory).expect("remove only the attack junction after pins release");
}

#[test]
fn refuses_preexisting_writable_leaf_and_releases_handles_on_error() {
    let fixture = fixture();
    let writable = OpenOptions::new()
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(fixture.session.join(FILE_NAME))
        .expect("existing writable leaf");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    drop(writable);
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Ok(ORIGINAL.to_vec())
    );
    let held = fixture.data.with_file_name("data-after-error");
    fs::rename(&fixture.data, &held).expect("all ancestor pins released");
    fs::rename(&held, &fixture.data).expect("restore data");
}
