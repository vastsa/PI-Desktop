use super::*;

fn assert_aborted<T: std::fmt::Debug>(result: Result<T, (String, String)>) {
    let (code, _) = result.expect_err("an interrupted search must not return partial success");
    assert_eq!(code, "TOOL_ABORTED");
}

#[test]
fn traversal_cancels_even_when_no_entry_matches_the_include() {
    let dir = tempfile::tempdir().unwrap();
    for index in 0..64 {
        let nested = dir.path().join(format!("folder-{index}"));
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("source.txt"), "needle\n").unwrap();
    }
    let include = build_glob_set("*.rs").unwrap();
    assert_aborted(candidate_files(
        dir.path(),
        dir.path(),
        false,
        Some(&include),
        100,
        &ToolCancellation::cancel_after(8),
    ));
}

#[test]
fn glob_cancels_during_traversal_instead_of_returning_empty_success() {
    let dir = tempfile::tempdir().unwrap();
    for index in 0..64 {
        std::fs::create_dir(dir.path().join(format!("empty-{index}"))).unwrap();
    }
    assert_aborted(tool_glob(
        Some(dir.path()),
        None,
        &json!({ "pattern": "*.rs" }),
        false,
        &ToolCancellation::cancel_after(8),
    ));
}

#[test]
fn giant_line_checks_cancellation_between_read_chunks() {
    let content = vec![b'x'; 1024 * 1024];
    let cancellation = ToolCancellation::cancel_after(4);
    let mut reader = LineReader {
        reader: BufReader::with_capacity(64, std::io::Cursor::new(content)),
        cancellation: None,
    }
    .with_cancellation(&cancellation);
    let error = match reader.next_line(MAX_LINE_CHARS) {
        Err(error) => error,
        Ok(_) => panic!("a giant line must stop before reaching its newline"),
    };
    assert!(error
        .get_ref()
        .is_some_and(|cause| cause.is::<cancel::Cancelled>()));
}

#[tokio::test]
async fn grep_does_not_swallow_cancellation_as_an_unreadable_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("large.txt"), vec![b'x'; 4 * 1024 * 1024]).unwrap();
    assert_aborted(tool_grep(
        Some(dir.path()),
        None,
        &json!({ "path": "large.txt", "pattern": "x", "outputMode": "count" }),
        false,
        None,
        &ToolCancellation::cancel_after(8),
    ));
}

#[test]
fn grep_tag_read_is_cancellable_before_publishing_a_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.txt");
    std::fs::write(&path, vec![b'x'; 4 * 1024 * 1024]).unwrap();
    let store = HashlineStore::new();
    let ctx = HashlineContext {
        session_id: "cancelled-search",
        store: &store,
    };
    let result = hashline::record_grep_file(
        Some(&ctx),
        &path,
        "large.txt",
        Some(&[1]),
        &ToolCancellation::cancel_after(2),
    );
    assert_eq!(result, Err(cancel::Cancelled));
    let tag = hashline::tag_of_lf_text(&"x".repeat(4 * 1024 * 1024));
    assert!(store
        .lookup_tag(ctx.session_id, &hashline::canonical_key(&path), &tag)
        .is_none());
}

#[test]
fn grep_tags_keep_encoding_newline_and_provenance_contracts() {
    let dir = tempfile::tempdir().unwrap();
    let text = "α😀\r\nb  \rc\t\n";
    let mut samples = vec![
        Vec::new(),
        text.as_bytes().to_vec(),
        [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat(),
        b"lossy \xE2\x82\n".to_vec(),
        format!("{}\r\nend\t", "x".repeat(64 * 1024 - 1)).into_bytes(),
    ];
    for little_endian in [true, false] {
        let mut bytes = if little_endian {
            vec![0xFF, 0xFE]
        } else {
            vec![0xFE, 0xFF]
        };
        for unit in text.encode_utf16() {
            bytes.extend(if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        samples.push(bytes);
    }
    for (index, bytes) in samples.iter().enumerate() {
        let path = dir.path().join(format!("encoding-{index}.txt"));
        std::fs::write(&path, bytes).unwrap();
        let expected = hashline::normalize_file(bytes);
        let expected_tag = hashline::tag_of_lf_text(&expected.text);
        let store = HashlineStore::new();
        let ctx = HashlineContext {
            session_id: "encoding-contract",
            store: &store,
        };
        let result = hashline::record_grep_file(
            Some(&ctx),
            &path,
            "fixture.txt",
            Some(&[1]),
            &ToolCancellation::from_receiver(None),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result, ("fixture.txt".into(), expected_tag.clone()));
        let snapshot = store
            .lookup_tag(
                ctx.session_id,
                &hashline::canonical_key(&path),
                &expected_tag,
            )
            .unwrap();
        assert_eq!(snapshot.text, expected.text);
        assert_eq!(snapshot.seen_lines, Some([1].into_iter().collect()));
    }
}

/// Invoked only by the fake rg wrapper in a separate test process. A socket
/// handshake, not a sleep, holds the child open until Stop or the stdout cap.
#[test]
fn rg_process_fixture() {
    use std::io::{Read, Write};
    let Ok(address) = std::env::var("PI_DESKTOP_SEARCH_TEST_SOCKET") else {
        return;
    };
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    writeln!(socket, "{}", std::process::id()).unwrap();
    let mut mode = [0];
    socket.read_exact(&mut mode).unwrap();
    socket.write_all(b"R").unwrap();
    match mode[0] {
        b'c' => {
            let mut stdout = std::io::stdout().lock();
            for _ in 0..140 {
                if stdout.write_all(&[b'x'; 64 * 1024]).is_err() {
                    break;
                }
            }
            let _ = stdout.flush();
        }
        b'n' => std::process::exit(1),
        b'f' => std::process::exit(2),
        _ => {}
    }
    // Cancellation/capping must terminate the process while this read and its
    // stdout remain open. Dropping the test socket also cleans up on failure.
    let _ = socket.read_exact(&mut mode);
}

async fn assert_rg_fixture_settles(mode: u8, abort: bool) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("source.txt"), "needle\n").unwrap();
    let fake = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let executable = std::env::current_exe().unwrap();
    #[cfg(windows)]
    let rg = {
        let path = fake.path().join("rg.cmd");
        std::fs::write(&path, format!("@echo off\r\nset \"PI_DESKTOP_SEARCH_TEST_SOCKET={address}\"\r\n\"{}\" --exact tools::search_cancellation_tests::rg_process_fixture --nocapture\r\nexit /b %errorlevel%\r\n", executable.display())).unwrap();
        path
    };
    #[cfg(not(windows))]
    let rg = {
        use std::os::unix::fs::PermissionsExt;
        let path = fake.path().join("rg");
        let escaped = executable.to_string_lossy().replace('\'', "'\\''");
        std::fs::write(&path, format!("#!/bin/sh\nexport PI_DESKTOP_SEARCH_TEST_SOCKET='{address}'\nexec '{escaped}' --exact tools::search_cancellation_tests::rg_process_fixture --nocapture\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    let guard = grep_rg::install_test_rg(rg);
    let (sender, receiver) = watch::channel(false);
    let root = workspace.path().to_path_buf();
    let search = tokio::spawn(async move {
        execute_tool_with_path_access(
            Some(&root),
            None,
            "Grep",
            &json!({ "pattern": "needle" }),
            ToolExecutionOptions {
                timeout_ms: None,
                bash_options: None,
                allow_external_paths: false,
                hashline: None,
                cancellation: Some(receiver),
            },
        )
        .await
    });
    let (socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .expect("rg did not start")
        .unwrap();
    let mut socket = tokio::io::BufReader::new(socket);
    let mut pid = String::new();
    socket.read_line(&mut pid).await.unwrap();
    assert!(pid.trim().parse::<u32>().unwrap() > 0);
    socket.get_mut().write_all(&[mode]).await.unwrap();
    let mut ready = [0];
    socket.read_exact(&mut ready).await.unwrap();
    assert_eq!(ready, *b"R");
    if abort {
        assert!(
            !search.is_finished(),
            "quiet rg must still own the tool call"
        );
        sender.send(true).unwrap();
        sender.send(true).unwrap();
    }
    let result = tokio::time::timeout(Duration::from_secs(10), search)
        .await
        .expect("search did not settle")
        .unwrap();
    let disconnected = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut ready))
        .await
        .expect("child socket is still alive after tool settlement");
    assert!(
        matches!(disconnected, Ok(0))
            || disconnected.is_err_and(|error| error.kind() == io::ErrorKind::ConnectionReset),
        "child must have exited before tool settlement"
    );
    if abort {
        assert_eq!(result.error_code.as_deref(), Some("TOOL_ABORTED"));
        assert!(!result.ok, "Stop must not fall back to a successful scan");
    } else {
        assert!(result.ok, "{:?}", result.content);
        match mode {
            b'c' => {
                assert_eq!(result.content["truncated"], true);
                assert_eq!(result.content["count"], 0);
            }
            b'n' => assert_eq!(result.content["count"], 0, "rg exit 1 is not a fallback"),
            b'f' => assert_eq!(
                result.content["count"], 1,
                "broken rg retains the normal fallback"
            ),
            _ => panic!("unsupported fixture mode"),
        }
    }
    drop(guard);
    let next = execute_tool(
        Some(workspace.path()),
        None,
        "Grep",
        &json!({ "pattern": "needle" }),
        5_000,
    )
    .await;
    assert!(
        next.ok,
        "a stopped/capped child must not poison the next call"
    );
    assert_eq!(next.content["count"], 1);
}

#[tokio::test]
async fn quiet_rg_is_terminated_and_reaped_before_stop_settles() {
    assert_rg_fixture_settles(b'q', true).await;
}

#[tokio::test]
async fn rg_stdout_cap_terminates_and_reaps_a_child_without_newlines() {
    assert_rg_fixture_settles(b'c', false).await;
}

#[tokio::test]
async fn rg_exit_one_and_broken_install_keep_distinct_fallback_semantics() {
    assert_rg_fixture_settles(b'n', false).await;
    assert_rg_fixture_settles(b'f', false).await;
}
