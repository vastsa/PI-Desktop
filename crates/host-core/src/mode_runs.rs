//! Staged mode runs (ADR mode-definitions).
//!
//! host-core is the authority for user-definable modes: it validates and
//! stores the definition snapshot a session uses, derives the tool policy from
//! that snapshot (never from the mode a runtime claims), and owns the run state
//! machine and every gate decision. The runtime only reports turns and stage
//! completions; Electron main only dispatches the turns the Host allows.
//!
//! The claim / revision-CAS / budget / settlement design is ported from PR
//! #2141 by new-Beginner (`goals/*`), generalized from one autonomous goal to
//! staged definitions with gates.

mod artifacts;
mod engine;
mod gates;
mod model;
mod policy;
mod repository;
mod snapshot;

pub use engine::{
    claim_turn, configure_session_mode, control, open_run, prepare_session_mode, recover,
    resolve, settle_turn, start, store_session_snapshot, verify_gate_command, PreparedMode,
};
pub use gates::{complete_stage, gate_result, GateExecution, GateExecutions};
pub use model::{
    CompleteStageParams, GateResultParams, ModeRun, SessionParams, StartParams,
};
pub use policy::{authorization, tool_policy, tool_policy_conn, ToolPolicy};

/// Mode ids are `^[a-z][a-z0-9-]{0,39}$`, shared with `MODE_ID_RE` in
/// `packages/shared/src/mode-definition.ts`.
pub fn is_mode_id(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 40
        && chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

/// Every mode-run failure is `CODE` or `CODE: detail`; the RPC adapter maps
/// the code onto the wire `errorCode`.
pub(crate) fn mode_error(code: &str) -> anyhow::Error {
    anyhow::anyhow!(code.to_string())
}

pub(crate) fn mode_error_detail(code: &str, detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{code}: {detail}")
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod snapshot_tests;
