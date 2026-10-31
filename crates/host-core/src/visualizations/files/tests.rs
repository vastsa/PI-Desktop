use super::*;
use std::fs;
use std::io::{self, Cursor};
use std::path::PathBuf;
use tempfile::{tempdir, TempDir};

pub(super) const SESSION: &str = "session-A";
pub(super) const FILE_NAME: &str = "chart.html";
pub(super) const ORIGINAL: &[u8] = "<p>Original \u{1f4ca}</p>\n".as_bytes();
pub(super) const VICTIM: &[u8] = b"private-marker";

pub(super) struct Fixture {
    pub temp: TempDir,
    pub data: PathBuf,
    pub session: PathBuf,
}

pub(super) fn fixture() -> Fixture {
    let temp = tempdir().expect("test directory");
    let data = temp.path().join("data");
    let session = data.join("visualizations").join(SESSION);
    fs::create_dir_all(&session).expect("test session");
    fs::write(session.join(FILE_NAME), ORIGINAL).expect("test fragment");
    Fixture {
        temp,
        data,
        session,
    }
}

#[test]
fn reads_regular_fragment_without_decoding_bytes() {
    let fixture = fixture();
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Ok(ORIGINAL.to_vec())
    );
    let bytes = b"<p>raw</p>\0\xff";
    fs::write(fixture.session.join(FILE_NAME), bytes).expect("raw fragment");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Ok(bytes.to_vec())
    );
}

#[test]
fn accepts_empty_and_exactly_two_mib_fragments() {
    let fixture = fixture();
    let path = fixture.session.join(FILE_NAME);
    fs::write(&path, []).expect("empty fragment");
    assert_eq!(read_fragment(&fixture.data, SESSION, FILE_NAME), Ok(vec![]));
    let bytes = vec![b'x'; MAX_FRAGMENT_BYTES];
    fs::write(&path, &bytes).expect("maximum fragment");
    assert_eq!(read_fragment(&fixture.data, SESSION, FILE_NAME), Ok(bytes));
}

#[test]
fn reports_too_large_above_two_mib() {
    let fixture = fixture();
    fs::write(
        fixture.session.join(FILE_NAME),
        vec![b'x'; MAX_FRAGMENT_BYTES + 1],
    )
    .expect("oversized fragment");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, FILE_NAME),
        Err(FragmentReadError::TooLarge)
    );
}

#[test]
fn bounded_read_detects_growth_after_metadata_and_never_reads_past_cap_plus_one() {
    let mut reader = Cursor::new(vec![b'x'; MAX_FRAGMENT_BYTES + 100]);
    assert_eq!(
        read_bounded(&mut reader, 1),
        Err(FragmentReadError::TooLarge)
    );
    assert_eq!(reader.position(), (MAX_FRAGMENT_BYTES + 1) as u64);
    assert_eq!(
        read_bounded(Cursor::new([]), u64::MAX),
        Err(FragmentReadError::TooLarge)
    );
}

#[test]
fn rejects_invalid_sessions_and_direct_file_names() {
    let fixture = fixture();
    for session in [
        "",
        ".",
        "..",
        "../victim",
        "a/b",
        "a\\b",
        "a b",
        "\u{e9}",
        "a\0b",
    ] {
        assert!(
            !valid_names(session, FILE_NAME),
            "session validation {session:?}"
        );
        assert_eq!(
            read_fragment(&fixture.data, session, FILE_NAME),
            Err(FragmentReadError::NotFound),
            "session {session:?}"
        );
    }
    assert!(!valid_names(&"a".repeat(129), FILE_NAME));
    assert_eq!(
        read_fragment(&fixture.data, &"a".repeat(129), FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    for name in [
        "",
        ".html",
        "..",
        "../chart.html",
        "a/chart.html",
        "a\\chart.html",
        "/chart.html",
        "C:chart.html",
        "\\\\?\\C:\\chart.html",
        "chart.html/",
        "chart.html\\",
        ".hidden.html",
        "a..b.html",
        "chart.HTML",
        "chart.htm",
        "chart.html:stream",
        "*.html",
        "%2e%2e.html",
        "a\0.html",
    ] {
        assert!(!valid_names(SESSION, name), "filename validation {name:?}");
        assert_eq!(
            read_fragment(&fixture.data, SESSION, name),
            Err(FragmentReadError::NotFound),
            "filename {name:?}"
        );
    }
    let name = format!("{}.html", "a".repeat(129));
    assert!(!valid_names(SESSION, &name));
    assert_eq!(
        read_fragment(&fixture.data, SESSION, &name),
        Err(FragmentReadError::NotFound)
    );
}

#[test]
fn valid_direct_names_and_session_length_match_contract() {
    let fixture = fixture();
    for name in ["chart.html", "a-v2_final.html", "a.b.html", "1.html"] {
        assert!(super::super::is_fragment_path(Path::new(name)));
        fs::write(fixture.session.join(name), ORIGINAL).expect("valid fragment");
        assert_eq!(
            read_fragment(&fixture.data, SESSION, name),
            Ok(ORIGINAL.to_vec())
        );
    }
    let session = "a".repeat(128);
    let name = format!("{}.html", "a".repeat(128));
    let path = fixture.data.join("visualizations").join(&session);
    fs::create_dir(&path).expect("maximum session id");
    fs::write(path.join(&name), ORIGINAL).expect("maximum filename");
    assert_eq!(
        read_fragment(&fixture.data, &session, &name),
        Ok(ORIGINAL.to_vec())
    );
}

#[test]
fn missing_entries_and_nonregular_roots_or_leaf_fail_closed() {
    let fixture = fixture();
    assert_eq!(
        read_fragment(&fixture.data, SESSION, "missing.html"),
        Err(FragmentReadError::NotFound)
    );
    fs::create_dir(fixture.session.join("directory.html")).expect("directory leaf");
    assert_eq!(
        read_fragment(&fixture.data, SESSION, "directory.html"),
        Err(FragmentReadError::NotFound)
    );
    assert_eq!(
        read_fragment(&fixture.data, "missing", FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    let plain = fixture.temp.path().join("plain");
    fs::write(&plain, []).expect("non-directory data");
    assert_eq!(
        read_fragment(&plain, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    let base = plain.with_file_name("other-data");
    fs::create_dir(&base).expect("other data");
    fs::write(base.join("visualizations"), []).expect("non-directory base");
    assert_eq!(
        read_fragment(&base, SESSION, FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
    let bad_session = fixture.data.join("visualizations").join("plain-session");
    fs::write(&bad_session, []).expect("non-directory session");
    assert_eq!(
        read_fragment(&fixture.data, "plain-session", FILE_NAME),
        Err(FragmentReadError::NotFound)
    );
}

#[test]
fn read_failures_have_only_fixed_error_codes() {
    struct BrokenReader;
    impl Read for BrokenReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("private path must not escape"))
        }
    }
    assert_eq!(
        read_bounded(BrokenReader, 0),
        Err(FragmentReadError::NotFound)
    );
    assert_eq!(FragmentReadError::NotFound.to_string(), "not-found");
    assert_eq!(FragmentReadError::TooLarge.to_string(), "too-large");
}
