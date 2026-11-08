use std::io;

/// Returns false only when the kernel reports that the group does not exist.
#[cfg(unix)]
pub(super) fn signal(pid: u32, signal: libc::c_int) -> io::Result<bool> {
    let pgid = libc::pid_t::try_from(pid)
        .ok()
        .filter(|pgid| *pgid > 0)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid shell process group")
        })?;
    if unsafe { libc::killpg(pgid, signal) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) async fn confirm_cleanup(
    cleanup: io::Result<bool>,
    mut probe: impl FnMut() -> io::Result<bool>,
) -> io::Result<()> {
    let denial = match cleanup {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => error,
        Err(error) => return Err(error),
    };
    // Darwin can deny exit cleanup briefly after a successful group stop.
    // Probe with signal 0 only: a PGID that outlives this window could be reused.
    for delay_ms in [10, 40, 100, 250] {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        match probe() {
            Ok(false) => return Ok(()),
            Ok(true) => {}
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {}
            Err(error) => return Err(error),
        }
    }
    Err(denial)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied() -> io::Error {
        io::ErrorKind::PermissionDenied.into()
    }

    #[tokio::test]
    async fn stopped_group_disappears_after_cleanup_denial() {
        let mut probes = [Err(denied()), Ok(false)].into_iter();
        confirm_cleanup(Err(denied()), || probes.next().unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stopped_group_must_disappear_before_denial_can_be_cleared() {
        for accessible in [false, true] {
            let error = confirm_cleanup(Err(denied()), || {
                if accessible {
                    Ok(true)
                } else {
                    Err(denied())
                }
            })
            .await
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        }
    }

    #[tokio::test]
    async fn other_cleanup_errors_are_not_retried() {
        let error = confirm_cleanup(Err(io::ErrorKind::InvalidInput.into()), || {
            panic!("unexpected process group probe")
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
