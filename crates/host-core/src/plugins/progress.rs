//! Progress an install reports while it runs, and the way a user cancels one.
//!
//! The install path is a single request: it resolves where the package is,
//! downloads it from one mirror after another, verifies it, extracts it and
//! registers it. Only the last step answers the caller, so a download that takes
//! a minute looks like a frozen window unless the work reports itself. That is
//! what an [`InstallObserver`] is for: the install calls it, and whoever owns
//! the interface decides what to do with it.
//!
//! Nothing here knows about JSON, RPC or the renderer on purpose: the caller
//! that emits an event is the RPC layer, and the tests use a recorder.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// What an install is doing right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallPhase {
    /// Asking the plugin center where the package is (official channel).
    Resolve,
    /// Downloading from a mirror.
    Download,
    /// Checking the bytes against the digest the catalog or the platform named.
    Verify,
    /// Unpacking the package and writing the plugin's row.
    Install,
    /// Loading the plugin so it is live.
    Enable,
}

impl InstallPhase {
    /// Wire name, and the name the dialog shows.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            InstallPhase::Resolve => "resolve",
            InstallPhase::Download => "download",
            InstallPhase::Verify => "verify",
            InstallPhase::Install => "install",
            InstallPhase::Enable => "enable",
        }
    }
}

/// A mirror that was tried, and what it answered.
#[derive(Clone, Debug)]
pub(crate) struct TriedMirror {
    pub source: String,
    pub url: String,
    /// `None` while this mirror is the one being tried.
    pub error: Option<String>,
}

/// One report from an install.
#[derive(Clone, Debug)]
pub(crate) struct InstallProgress {
    pub plugin_id: String,
    pub version: String,
    pub phase: InstallPhase,
    /// Mirror the download is coming from, when one is in use.
    pub source: Option<String>,
    /// 1-based index of the mirror being tried, within `attempts`.
    pub attempt: u32,
    pub attempts: u32,
    pub received_bytes: u64,
    pub total_bytes: u64,
    /// Every mirror tried so far, in order, with what each answered.
    pub tried: Vec<TriedMirror>,
    /// Set on the report that ends the install with a failure.
    pub error: Option<String>,
}

impl InstallProgress {
    /// The report that starts a phase for a plugin.
    pub(crate) fn phase(plugin_id: &str, version: &str, phase: InstallPhase) -> Self {
        Self {
            plugin_id: plugin_id.to_string(),
            version: version.to_string(),
            phase,
            source: None,
            attempt: 0,
            attempts: 0,
            received_bytes: 0,
            total_bytes: 0,
            tried: Vec::new(),
            error: None,
        }
    }
}

/// Receives progress from an install, and answers whether it should stop.
pub(crate) trait InstallObserver {
    /// Report progress. Called often while bytes arrive, so an implementation
    /// that talks to an interface has to throttle.
    fn progress(&mut self, event: InstallProgress);

    /// Whether the user asked to cancel. Checked between chunks, before every
    /// mirror, and before anything is written to disk.
    fn cancelled(&self) -> bool {
        false
    }
}

/// An observer for a caller with no interface to report to.
pub(crate) struct NoProgress;

impl InstallObserver for NoProgress {
    fn progress(&mut self, _event: InstallProgress) {}
}

/// A one-way flag the cancel action flips and the download loop reads.
#[derive(Clone, Default, Debug)]
pub(crate) struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Slot the cancel RPC flips without taking the AppState lock.
///
/// `market.install` holds that lock for the whole download, so a cancel that
/// waited on it would only run after the install finished. The token is an
/// `Arc`, so this is a second handle to the same flag.
static ACTIVE_CANCEL: OnceLock<Mutex<Option<CancelToken>>> = OnceLock::new();

fn active_cancel_slot() -> &'static Mutex<Option<CancelToken>> {
    ACTIVE_CANCEL.get_or_init(|| Mutex::new(None))
}

pub(crate) fn arm_active_cancel(token: &CancelToken) {
    *active_cancel_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(token.clone());
}

pub(crate) fn disarm_active_cancel() {
    *active_cancel_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
}

/// Flip the running install's cancel flag. Does not take AppState.
pub(crate) fn cancel_active_install() -> bool {
    let guard = active_cancel_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(token) => {
            token.cancel();
            true
        }
        None => false,
    }
}

/// The error a cancelled install ends with.
///
/// Its own marker, so the RPC layer can answer "you cancelled this" instead of
/// an integrity or network failure, and the surface can close quietly.
pub(crate) const CANCELLED: &str = "PLUGIN_CANCELLED: the install was cancelled";

/// Whether an error is the user's own cancellation.
pub(crate) fn is_cancelled(error: &anyhow::Error) -> bool {
    error.to_string().starts_with("PLUGIN_CANCELLED")
}

/// Everything one download reports against.
///
/// Bundled so the download call sites stay readable: a package is fetched by
/// mirror `attempt` of `attempts`, for a plugin, on behalf of an observer.
pub(crate) struct DownloadReport<'a> {
    pub observer: &'a mut dyn InstallObserver,
    pub plugin_id: String,
    pub version: String,
    pub source: Option<String>,
    pub attempt: u32,
    pub attempts: u32,
}

impl<'a> DownloadReport<'a> {
    pub(crate) fn new(
        observer: &'a mut dyn InstallObserver,
        plugin_id: &str,
        version: &str,
    ) -> Self {
        Self {
            observer,
            plugin_id: plugin_id.to_string(),
            version: version.to_string(),
            source: None,
            attempt: 0,
            attempts: 0,
        }
    }

    /// Point the report at one mirror of a list.
    pub(crate) fn mirror(&mut self, source: Option<&str>, attempt: u32, attempts: u32) {
        self.source = source.map(str::to_string);
        self.attempt = attempt;
        self.attempts = attempts;
    }

    /// A phase with no bytes to report.
    pub(crate) fn phase(&mut self, phase: InstallPhase) {
        let mut event = InstallProgress::phase(&self.plugin_id, &self.version, phase);
        event.source = self.source.clone();
        event.attempt = self.attempt;
        event.attempts = self.attempts;
        self.observer.progress(event);
    }

    /// Bytes received so far, out of the announced total (0 when unknown).
    pub(crate) fn bytes(&mut self, received: u64, total: u64) {
        let mut event =
            InstallProgress::phase(&self.plugin_id, &self.version, InstallPhase::Download);
        event.source = self.source.clone();
        event.attempt = self.attempt;
        event.attempts = self.attempts;
        event.received_bytes = received;
        event.total_bytes = total;
        self.observer.progress(event);
    }
    /// Report the failure that ends the install, and hand it back.
    ///
    /// Exactly one terminal report per install: whoever knows the final error
    /// reports it, so a surface showing progress is never told twice — or never
    /// told at all.
    pub(crate) fn failed(
        &mut self,
        tried: Vec<TriedMirror>,
        error: anyhow::Error,
    ) -> anyhow::Error {
        let mut event =
            InstallProgress::phase(&self.plugin_id, &self.version, InstallPhase::Download);
        event.source = self.source.clone();
        event.attempt = self.attempt;
        event.attempts = self.attempts;
        event.tried = tried;
        event.error = Some(error.to_string());
        self.observer.progress(event);
        error
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.observer.cancelled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        events: Vec<InstallProgress>,
        cancel_after: Option<usize>,
    }

    impl InstallObserver for Recorder {
        fn progress(&mut self, event: InstallProgress) {
            self.events.push(event);
        }

        fn cancelled(&self) -> bool {
            self.cancel_after
                .is_some_and(|after| self.events.len() >= after)
        }
    }

    #[test]
    fn a_report_carries_the_mirror_it_is_about() {
        let mut recorder = Recorder::default();
        {
            let mut report = DownloadReport::new(&mut recorder, "acme.todo", "1.2.0");
            report.mirror(Some("cnb"), 2, 3);
            report.bytes(120, 480);
            report.phase(InstallPhase::Verify);
        }
        assert_eq!(recorder.events.len(), 2);
        let bytes = &recorder.events[0];
        assert_eq!(bytes.plugin_id, "acme.todo");
        assert_eq!(bytes.phase, InstallPhase::Download);
        assert_eq!(bytes.source.as_deref(), Some("cnb"));
        assert_eq!((bytes.attempt, bytes.attempts), (2, 3));
        assert_eq!((bytes.received_bytes, bytes.total_bytes), (120, 480));
        assert_eq!(recorder.events[1].phase, InstallPhase::Verify);
    }

    #[test]
    fn a_cancel_after_the_first_report_is_visible_to_the_install() {
        let mut recorder = Recorder {
            cancel_after: Some(1),
            ..Recorder::default()
        };
        {
            let mut report = DownloadReport::new(&mut recorder, "acme.todo", "1.2.0");
            assert!(!report.cancelled(), "nothing reported yet");
            report.bytes(1, 10);
            assert!(
                report.cancelled(),
                "the user asked to stop after one report"
            );
        }
    }

    #[test]
    fn only_a_cancellation_reads_as_one() {
        let cancelled = anyhow!(CANCELLED);
        assert!(is_cancelled(&cancelled));
        assert!(!is_cancelled(&anyhow!(
            "PLUGIN_INTEGRITY: checksum mismatch"
        )));
    }

    #[test]
    fn cancel_active_install_flips_the_armed_token() {
        disarm_active_cancel();
        assert!(!cancel_active_install(), "nothing is running");
        let token = CancelToken::default();
        arm_active_cancel(&token);
        assert!(cancel_active_install());
        assert!(token.is_cancelled());
        disarm_active_cancel();
        assert!(!cancel_active_install());
    }
}
