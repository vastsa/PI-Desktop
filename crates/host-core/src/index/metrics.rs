//! In-memory fast-path counters and build progress for the workspace index.
//!
//! Nothing here is persisted: the counters reset with the process, which is
//! exactly what the `metrics` contract in `packages/shared/src/types.ts`
//! promises. Keeping them behind `Arc` lets every clone of [`IndexStore`] (the
//! RPC handlers clone it into `spawn_blocking`) observe one shared snapshot.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

/// How many recent fast-path latencies feed the p50/p95 estimate. A bounded
/// ring is enough for a UI diagnostic; exact quantiles are not required.
const LATENCY_SAMPLES: usize = 512;

/// Why a query did not get served from the index. Each variant maps to one
/// counter in the frozen metrics contract. The "not a literal" case is recorded
/// through [`IndexMetrics::record_not_literal`] because it is decided before any
/// index work, so it has no latency to add to the histogram.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
    /// The root was missing, unknown, or not `fresh`.
    StateGate,
    /// The candidate set exceeded the caller's cap.
    TooWide,
    /// Candidate verification (stat/drift) failed.
    VerifyFailed,
    /// An internal error degraded the fast path to the fallback.
    Internal,
}

/// Shared counters read by `index.status`. All fields are `AtomicU64` so the
/// Grep hot path can record without taking a lock.
#[derive(Debug, Default)]
pub struct IndexMetrics {
    fast_path_served: AtomicU64,
    fallback_count: AtomicU64,
    fallback_not_literal: AtomicU64,
    fallback_state_gate: AtomicU64,
    fallback_too_wide: AtomicU64,
    fallback_verify_failed: AtomicU64,
    /// Sum of per-query candidate/visible ratios, scaled by 1e6.
    candidate_ratio_micros: AtomicU64,
    candidate_ratio_samples: AtomicU64,
    latencies_ms: Mutex<Vec<u64>>,
}

impl IndexMetrics {
    /// A fast path served `candidates` of `visible` files in `elapsed_ms`.
    pub fn record_served(&self, candidates: usize, visible: usize, elapsed_ms: u64) {
        self.fast_path_served.fetch_add(1, Ordering::Relaxed);
        if visible > 0 {
            let micros = (candidates as f64 / visible as f64 * 1_000_000.0) as u64;
            self.candidate_ratio_micros
                .fetch_add(micros, Ordering::Relaxed);
            self.candidate_ratio_samples.fetch_add(1, Ordering::Relaxed);
        }
        self.record_latency(elapsed_ms);
    }

    /// The fast path declined to serve; `elapsed_ms` still feeds the histogram.
    pub fn record_fallback(&self, reason: FallbackReason, elapsed_ms: u64) {
        self.fallback_count.fetch_add(1, Ordering::Relaxed);
        match reason {
            FallbackReason::StateGate => &self.fallback_state_gate,
            FallbackReason::TooWide => &self.fallback_too_wide,
            FallbackReason::VerifyFailed => &self.fallback_verify_failed,
            // Internal errors have no dedicated counter; the total still moves.
            FallbackReason::Internal => {
                self.record_latency(elapsed_ms);
                return;
            }
        }
        .fetch_add(1, Ordering::Relaxed);
        self.record_latency(elapsed_ms);
    }

    /// Admission declined before any index work happened (not a literal), so it
    /// is counted as a fallback without polluting the latency histogram.
    pub fn record_not_literal(&self) {
        self.fallback_count.fetch_add(1, Ordering::Relaxed);
        self.fallback_not_literal.fetch_add(1, Ordering::Relaxed);
    }

    fn record_latency(&self, elapsed_ms: u64) {
        if let Ok(mut samples) = self.latencies_ms.lock() {
            if samples.len() >= LATENCY_SAMPLES {
                samples.remove(0);
            }
            samples.push(elapsed_ms);
        }
    }

    /// The serializable snapshot handed to `index.status`.
    pub fn snapshot(&self) -> WorkspaceIndexMetrics {
        let ratio_samples = self.candidate_ratio_samples.load(Ordering::Relaxed);
        let candidate_ratio_avg = if ratio_samples > 0 {
            self.candidate_ratio_micros.load(Ordering::Relaxed) as f64
                / 1_000_000.0
                / ratio_samples as f64
        } else {
            0.0
        };
        let (p50_ms, p95_ms) = self.percentiles();
        WorkspaceIndexMetrics {
            fast_path_served: self.fast_path_served.load(Ordering::Relaxed),
            fallback_count: self.fallback_count.load(Ordering::Relaxed),
            fallback_not_literal: self.fallback_not_literal.load(Ordering::Relaxed),
            fallback_state_gate: self.fallback_state_gate.load(Ordering::Relaxed),
            fallback_too_wide: self.fallback_too_wide.load(Ordering::Relaxed),
            fallback_verify_failed: self.fallback_verify_failed.load(Ordering::Relaxed),
            candidate_ratio_avg,
            p50_ms,
            p95_ms,
        }
    }

    fn percentiles(&self) -> (f64, f64) {
        let mut samples = match self.latencies_ms.lock() {
            Ok(samples) => samples.clone(),
            Err(_) => return (0.0, 0.0),
        };
        if samples.is_empty() {
            return (0.0, 0.0);
        }
        samples.sort_unstable();
        let pick = |fraction: f64| -> f64 {
            let index = ((samples.len() - 1) as f64 * fraction).round() as usize;
            samples[index.min(samples.len() - 1)] as f64
        };
        (pick(0.50), pick(0.95))
    }
}

/// The frozen `metrics` shape. Field names are camelCase to match
/// `WorkspaceIndexMetrics` in the shared contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexMetrics {
    pub fast_path_served: u64,
    pub fallback_count: u64,
    pub fallback_not_literal: u64,
    pub fallback_state_gate: u64,
    pub fallback_too_wide: u64,
    pub fallback_verify_failed: u64,
    pub candidate_ratio_avg: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
}

/// Live crawl counters for a `building` root. `total` starts as an estimate
/// (the previous visible file count) and `done` advances as files are seen.
#[derive(Debug, Default)]
pub struct BuildProgress {
    done: AtomicU64,
    total: AtomicU64,
}

impl BuildProgress {
    pub fn reset(&self, total_estimate: u64) {
        self.done.store(0, Ordering::Relaxed);
        self.total.store(total_estimate, Ordering::Relaxed);
    }

    pub fn inc_done(&self) {
        self.done.fetch_add(1, Ordering::Relaxed);
    }

    /// `(filesDone, filesTotal)`. The total never reports less than the count
    /// already processed, so a stale estimate cannot show >100%.
    pub fn snapshot(&self) -> (u64, u64) {
        let done = self.done.load(Ordering::Relaxed);
        let total = self.total.load(Ordering::Relaxed).max(done);
        (done, total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_track_served_and_fallback_reasons() {
        let metrics = IndexMetrics::default();
        metrics.record_served(2, 10, 5);
        metrics.record_not_literal();
        metrics.record_fallback(FallbackReason::StateGate, 2);
        metrics.record_fallback(FallbackReason::TooWide, 3);
        metrics.record_fallback(FallbackReason::VerifyFailed, 4);
        metrics.record_fallback(FallbackReason::Internal, 6);
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.fast_path_served, 1);
        assert_eq!(snapshot.fallback_count, 5);
        assert_eq!(snapshot.fallback_not_literal, 1);
        assert_eq!(snapshot.fallback_state_gate, 1);
        assert_eq!(snapshot.fallback_too_wide, 1);
        assert_eq!(snapshot.fallback_verify_failed, 1);
        // candidateRatioAvg = 2 / 10 = 0.2.
        assert!((snapshot.candidate_ratio_avg - 0.2).abs() < 1e-9);
        assert!(snapshot.p50_ms >= 0.0 && snapshot.p95_ms >= snapshot.p50_ms);
    }

    #[test]
    fn empty_metrics_report_zeroes() {
        let snapshot = IndexMetrics::default().snapshot();
        assert_eq!(snapshot.fast_path_served, 0);
        assert_eq!(snapshot.candidate_ratio_avg, 0.0);
        assert_eq!(snapshot.p50_ms, 0.0);
        assert_eq!(snapshot.p95_ms, 0.0);
    }

    #[test]
    fn progress_never_reports_total_below_done() {
        let progress = BuildProgress::default();
        progress.reset(1);
        progress.inc_done();
        progress.inc_done();
        progress.inc_done();
        assert_eq!(progress.snapshot(), (3, 3));
    }
}
