//! Progress a sync reports while it runs.
//!
//! A sync is one request: it captures the local snapshot, reads the remote
//! revision, merges, uploads every resource object, publishes the head, applies
//! the result and cleans up history. The caller hears back only at the end, and
//! the upload is unbatched — one object per resource, two round trips each — so
//! a vault with a few hundred resources looks like a frozen window unless the
//! work reports itself. That is what a [`SyncProgressObserver`] is for.
//!
//! Nothing here knows about the interface on purpose. An observer is called by
//! the sync; the one that ships is [`ProgressNotifier`], which writes the same
//! NDJSON notification `configSync.changed` already uses, and tests install a
//! recorder.

use super::*;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, Instant};

/// What a sync is doing right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SyncPhase {
    /// Collecting the local snapshot this device would publish.
    Capture,
    /// Reading the remote revision's resource objects.
    Download,
    /// Merging the acknowledged base, the local snapshot and the remote revision.
    Merge,
    /// Uploading the merged revision's resource objects.
    Upload,
    /// Writing the approved result locally.
    Apply,
    /// Deleting revisions the retention window no longer keeps.
    Cleanup,
}

impl SyncPhase {
    /// Wire name, and the name an interface shows.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SyncPhase::Capture => "capture",
            SyncPhase::Download => "download",
            SyncPhase::Merge => "merge",
            SyncPhase::Upload => "upload",
            SyncPhase::Apply => "apply",
            SyncPhase::Cleanup => "cleanup",
        }
    }
}

/// One report from a sync.
///
/// `done`/`total` count this phase's units: resource objects while transferring,
/// entities while capturing, merging or applying. `total == 0` means the phase
/// cannot know its size ahead of time. `bytes_total == 0` means the byte size is
/// unknown, which is the normal case for a download — remote manifests name
/// resources by id, not by length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SyncProgress {
    pub phase: SyncPhase,
    pub done: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

impl SyncProgress {
    /// A phase that started and cannot count itself.
    pub(crate) fn started(phase: SyncPhase) -> Self {
        Self::counted(phase, 0, 0, 0, 0)
    }

    /// A phase with the size it knows about.
    pub(crate) fn counted(
        phase: SyncPhase,
        done: u64,
        total: u64,
        bytes_done: u64,
        bytes_total: u64,
    ) -> Self {
        Self {
            phase,
            done,
            total,
            bytes_done,
            bytes_total,
        }
    }
}

/// Where a sync reports what it is doing.
pub(crate) trait SyncProgressObserver: Send + Sync {
    fn report(&self, progress: SyncProgress);
}

/// A sync nobody is watching: the background scheduler, and every call site
/// that has no interface to feed.
pub(crate) struct NoSyncProgress;

impl SyncProgressObserver for NoSyncProgress {
    fn report(&self, _progress: SyncProgress) {}
}

/// Phase slot meaning "nothing reported yet".
const NO_PHASE: u8 = u8::MAX;
/// Timestamp meaning "nothing reported yet": a real measurement can be 0 ms, so
/// 0 cannot be the sentinel.
const NEVER_MS: u64 = u64::MAX;

/// Reports progress to the renderer as `configSync.progress`.
///
/// Throttled on purpose: a large upload reports every object it writes, and an
/// interface needs a few of those per second rather than thousands. A phase
/// change always goes through, so a progress row never misses the transition it
/// is displaying.
pub(crate) struct ProgressNotifier {
    tx: mpsc::UnboundedSender<String>,
    /// Milliseconds since this process first reported, or [`NEVER_MS`].
    last_ms: AtomicU64,
    last_phase: AtomicU8,
}

impl ProgressNotifier {
    pub(crate) fn new(tx: mpsc::UnboundedSender<String>) -> Self {
        Self {
            tx,
            last_ms: AtomicU64::new(NEVER_MS),
            last_phase: AtomicU8::new(NO_PHASE),
        }
    }

    fn phase_slot(phase: SyncPhase) -> u8 {
        match phase {
            SyncPhase::Capture => 0,
            SyncPhase::Download => 1,
            SyncPhase::Merge => 2,
            SyncPhase::Upload => 3,
            SyncPhase::Apply => 4,
            SyncPhase::Cleanup => 5,
        }
    }

    /// Monotonic milliseconds. A wall clock would let a clock change silence
    /// the reports an interface is waiting for.
    fn now_ms() -> u64 {
        static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        ORIGIN.get_or_init(Instant::now).elapsed().as_millis() as u64
    }
}

impl SyncProgressObserver for ProgressNotifier {
    fn report(&self, progress: SyncProgress) {
        const MIN_INTERVAL: Duration = Duration::from_millis(200);
        let slot = Self::phase_slot(progress.phase);
        let phase_changed = self.last_phase.swap(slot, Ordering::Relaxed) != slot;
        let now = Self::now_ms();
        if !phase_changed {
            let last = self.last_ms.load(Ordering::Relaxed);
            if last != NEVER_MS && now.saturating_sub(last) < MIN_INTERVAL.as_millis() as u64 {
                return;
            }
        }
        self.last_ms.store(now, Ordering::Relaxed);
        let note = json!({
            "jsonrpc": "2.0",
            "method": "configSync.progress",
            "params": {
                "phase": progress.phase.as_str(),
                "done": progress.done,
                "total": progress.total,
                "bytesDone": progress.bytes_done,
                "bytesTotal": progress.bytes_total,
            },
        });
        if let Ok(raw) = serde_json::to_string(&note) {
            let _ = self.tx.send(format!("{raw}\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reports(mut rx: mpsc::UnboundedReceiver<String>) -> Vec<Value> {
        let mut result = Vec::new();
        while let Ok(line) = rx.try_recv() {
            result.push(serde_json::from_str(&line).expect("notification is JSON"));
        }
        result
    }

    #[test]
    fn phase_names_are_the_wire_contract() {
        let phases = [
            (SyncPhase::Capture, "capture"),
            (SyncPhase::Download, "download"),
            (SyncPhase::Merge, "merge"),
            (SyncPhase::Upload, "upload"),
            (SyncPhase::Apply, "apply"),
            (SyncPhase::Cleanup, "cleanup"),
        ];
        for (phase, name) in phases {
            assert_eq!(phase.as_str(), name);
        }
    }

    /// The interval bounds how long a report may sit unsent, so a phase that
    /// runs for minutes still moves. A larger constant would fail here.
    #[test]
    fn a_report_is_never_withheld_longer_than_the_interval() {
        let (tx, rx) = mpsc::unbounded_channel();
        let notifier = ProgressNotifier::new(tx);
        notifier.report(SyncProgress::counted(SyncPhase::Upload, 1, 9, 1024, 9216));
        std::thread::sleep(Duration::from_millis(250));
        notifier.report(SyncProgress::counted(SyncPhase::Upload, 2, 9, 2048, 9216));
        let lines = reports(rx);
        assert_eq!(
            lines.len(),
            2,
            "a phase that keeps working keeps reporting: {lines:?}"
        );
        assert_eq!(lines[1]["params"]["done"], 2);
    }
    #[test]
    fn a_phase_change_always_reports_and_the_rest_is_throttled() {
        let (tx, rx) = mpsc::unbounded_channel();
        let notifier = ProgressNotifier::new(tx);
        notifier.report(SyncProgress::started(SyncPhase::Upload));
        notifier.report(SyncProgress::counted(SyncPhase::Upload, 1, 9, 1024, 9216));
        notifier.report(SyncProgress::counted(SyncPhase::Upload, 2, 9, 2048, 9216));
        notifier.report(SyncProgress::started(SyncPhase::Merge));
        let lines = reports(rx);
        assert_eq!(
            lines.len(),
            2,
            "a phase change is never throttled: {lines:?}"
        );
        assert_eq!(
            lines[0],
            json!({
                "jsonrpc": "2.0",
                "method": "configSync.progress",
                "params": {
                    "phase": "upload",
                    "done": 0,
                    "total": 0,
                    "bytesDone": 0,
                    "bytesTotal": 0,
                },
            })
        );
        assert_eq!(lines[1]["params"]["phase"], "merge");
    }

    #[test]
    fn counted_progress_carries_the_numbers_an_interface_shows() {
        let (tx, rx) = mpsc::unbounded_channel();
        let notifier = ProgressNotifier::new(tx);
        notifier.report(SyncProgress::counted(
            SyncPhase::Upload,
            12,
            45,
            3_145_728,
            16_777_216,
        ));
        let lines = reports(rx);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0]["params"],
            json!({
                "phase": "upload",
                "done": 12,
                "total": 45,
                "bytesDone": 3_145_728,
                "bytesTotal": 16_777_216,
            })
        );
    }

    #[test]
    fn the_unwatched_observer_swallows_everything() {
        let observer = NoSyncProgress;
        observer.report(SyncProgress::started(SyncPhase::Capture));
    }
}
