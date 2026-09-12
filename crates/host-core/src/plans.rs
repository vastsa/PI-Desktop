#![allow(unused_imports)]

pub(crate) use anyhow::{anyhow, Result};
pub(crate) use chrono::{DateTime, Local};
pub(crate) use rusqlite::{params, OptionalExtension};
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use serde_json::json;
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use std::fs::{self, OpenOptions};
pub(crate) use std::io::Write;
pub(crate) use std::path::{Component, Path, PathBuf};
pub(crate) use uuid::Uuid;

pub(crate) use crate::artifacts;
pub(crate) use crate::audit;
pub(crate) use crate::db::{ms_to_ts, now_ms, Database, PLAN_APPROVAL_TIMEOUT_MS};
pub(crate) use crate::sessions;

mod approval;
mod artifact;
mod execution;
mod model;
mod repository;

pub use approval::{expire_pending_approvals, gate_session_configure};
pub use model::{
    kind_for_mode, normalize_kind, PlanArtifact, PlanExecution, PlanManager, PlanProposal,
    PlanResolution, PlanResolveParams, PlanSubmitParams, EXECUTION_COMPLETED,
    EXECUTION_INTERRUPTED, EXECUTION_QUEUED, EXECUTION_RUNNING, KIND_GOAL, KIND_PLAN,
    PLAN_MAX_MARKDOWN_BYTES, STATUS_APPROVED, STATUS_EXPIRED, STATUS_INTERRUPTED, STATUS_PENDING,
    STATUS_REJECTED,
};

pub(crate) use approval::plan_error;
pub(crate) use artifact::{
    plan_filename, publish_artifact, safe_artifact_path, title_slug, verify_artifact,
};
pub(crate) use execution::{execution_from_proposal, resolution_from_proposal};
pub(crate) use repository::{
    get_proposal, live_turn_belongs_to_session, proposal_from_row, session_submit_kind,
    PROPOSAL_COLUMNS,
};

#[cfg(test)]
mod tests;
