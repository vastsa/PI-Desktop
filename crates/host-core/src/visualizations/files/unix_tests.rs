use super::super::tests::{fixture, FILE_NAME, ORIGINAL, SESSION, VICTIM};
use super::super::{read_fragment, FragmentReadError};
use super::read_fragment_impl;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::symlink;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn allows_canonical_alias_for_trusted_data_directory() {
    let fixture = fixture();
    let alias = fixture.temp.path().join("data-alias");
    symlink(&fixture.data, &alias).expect("data alias");
    assert_eq!(
        read_fragment(&alias, SESSION, FILE_NAME),
        Ok(ORIGINAL.to_vec())
    );
}

#[test]
fn rejects_symlinked_visualization_base() {
    let fixture = fixture();
    let base = fixture.data.join("visualizations");
    let original_base = fixture.data.join("held-visualizations");
    fs::rename(&base, &original_base).expect("move original base");
    symlink(&original_base, &base).expect("base alias");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
}

#[test]
fn rejects_session_symlinks_including_same_root_session_alias() {
    let fixture = fixture();
    let victim = fixture.data.join("visualizations").join("session-B");
    fs::create_dir(&victim).expect("victim session");
    fs::write(victim.join(FILE_NAME), VICTIM).expect("victim fragment");
    let held = fixture.session.with_file_name("held-session");
    fs::rename(&fixture.session, &held).expect("move original session");
    symlink(&victim, &fixture.session).expect("same-root session alias");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    fs::remove_file(&fixture.session).expect("unlink alias");
    symlink(&held, &fixture.session).expect("alias to original session");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
}

#[test]
fn rejects_symlinked_leaf_even_when_target_is_owned() {
    let fixture = fixture();
    let leaf = fixture.session.join(FILE_NAME);
    let target = fixture.session.join("original.html");
    fs::rename(&leaf, &target).expect("move fragment");
    symlink(&target, &leaf).expect("leaf alias");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
}

#[test]
fn fifo_with_no_writer_is_rejected_without_blocking() {
    let fixture = fixture();
    let path = fixture.session.join("fifo.html");
    let name = CString::new(path.as_os_str().as_bytes()).expect("FIFO name");
    // SAFETY: the name is NUL-terminated and lives through mkfifo.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let (sender, receiver) = mpsc::channel();
    let data = fixture.data.clone();
    let worker = std::thread::spawn(move || {
        sender
            .send(read_fragment(&data, SESSION, "fifo.html"))
            .expect("FIFO result");
    });
    assert_eq!(
        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("FIFO read must finish without a writer"),
        Err(FragmentReadError::NotFound)
    );
    worker.join().expect("FIFO worker");
}

#[test]
fn pinned_session_cannot_be_redirected_by_rename_and_symlink() {
    let fixture = fixture();
    let victim = fixture.data.join("visualizations").join("session-B");
    fs::create_dir(&victim).expect("victim session");
    fs::write(victim.join(FILE_NAME), VICTIM).expect("victim fragment");
    let held = fixture.session.with_file_name("held-session");
    let result = read_fragment_impl(&fixture.data, SESSION, FILE_NAME, || {
        fs::rename(&fixture.session, &held).expect("rename pinned session");
        symlink(&victim, &fixture.session).expect("replace visible session with victim alias");
        assert_eq!(
            fs::read(fixture.session.join(FILE_NAME)).expect("path-based attack control"),
            VICTIM
        );
    });
    // Leave the victim alias active during the actual leaf open/read: a
    // path-based leaf open, even O_NOFOLLOW, would return the victim here.
    fs::remove_file(&fixture.session).expect("unlink victim alias");
    fs::rename(&held, &fixture.session).expect("restore session");
    assert_eq!(result, Ok(ORIGINAL.to_vec()));
}

#[test]
fn pinned_session_survives_aba_restore_before_leaf_open() {
    let fixture = fixture();
    let victim = fixture.data.join("visualizations").join("session-B");
    fs::create_dir(&victim).expect("victim session");
    fs::write(victim.join(FILE_NAME), VICTIM).expect("victim fragment");
    let held = fixture.session.with_file_name("held-session");
    let result = read_fragment_impl(&fixture.data, SESSION, FILE_NAME, || {
        fs::rename(&fixture.session, &held).expect("rename pinned session");
        symlink(&victim, &fixture.session).expect("ABA victim alias");
        assert_eq!(
            fs::read(fixture.session.join(FILE_NAME)).expect("ABA attack control"),
            VICTIM
        );
        fs::remove_file(&fixture.session).expect("unlink ABA alias");
        fs::rename(&held, &fixture.session).expect("restore before leaf open");
    });
    assert_eq!(result, Ok(ORIGINAL.to_vec()));
}

#[test]
fn pinned_session_survives_visualization_base_replacement() {
    let fixture = fixture();
    let victim = fixture.temp.path().join("victim-base");
    fs::create_dir_all(victim.join(SESSION)).expect("victim base");
    fs::write(victim.join(SESSION).join(FILE_NAME), VICTIM).expect("victim fragment");
    let base = fixture.data.join("visualizations");
    let held = fixture.data.join("held-base");
    let result = read_fragment_impl(&fixture.data, SESSION, FILE_NAME, || {
        fs::rename(&base, &held).expect("rename pinned base");
        symlink(&victim, &base).expect("redirect visible base");
        assert_eq!(
            fs::read(base.join(SESSION).join(FILE_NAME)).expect("path-based attack control"),
            VICTIM
        );
    });
    fs::remove_file(&base).expect("unlink base alias");
    fs::rename(&held, &base).expect("restore base");
    assert_eq!(result, Ok(ORIGINAL.to_vec()));
}

#[test]
fn leaf_replaced_with_symlink_after_directory_pin_is_rejected() {
    let fixture = fixture();
    let victim = fixture.temp.path().join("victim.html");
    fs::write(&victim, VICTIM).expect("victim fragment");
    let leaf = fixture.session.join(FILE_NAME);
    let result = read_fragment_impl(&fixture.data, SESSION, FILE_NAME, || {
        fs::remove_file(&leaf).expect("remove original leaf");
        symlink(&victim, &leaf).expect("replace leaf with victim alias");
    });
    assert_eq!(result, Err(FragmentReadError::NotFound));
}
