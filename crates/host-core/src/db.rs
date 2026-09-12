#![allow(unused_imports)]

pub(crate) use anyhow::{anyhow, Context, Result};
pub(crate) use rusqlite::{params, Connection, OptionalExtension};
pub(crate) use serde::Serialize;
pub(crate) use serde_json::Value;
pub(crate) use std::path::{Path, PathBuf};

/// Current SQLite schema version.
pub const SCHEMA_VERSION: i64 = 15;

/// Absolute approval deadline for a newly submitted Plan or Goal proposal.
pub const PLAN_APPROVAL_TIMEOUT_MS: i64 = 30 * 60 * 1000;

/// Durable notification rows kept globally.
pub const NOTIFICATION_KEEP: i64 = 200;

mod migrations;
mod model;
mod repositories;
mod schema;

pub(crate) use migrations::{
    archive_legacy_db, create_migration_backup, migrate_and_validate_top_level_mode,
    migrate_app_settings, migrate_v10_to_v15, migrate_v11_to_v15, migrate_v12_to_v15,
    migrate_v13_to_v15, migrate_v14_to_v15, migrate_v7_to_v8, migrate_v8_to_v15, migrate_v9_to_v15,
    migration_backup_path, validate_session_modes,
};
pub(crate) use model::PlanWorkRow;
pub use model::{Database, ProjectMemoryEntryRecord, ProjectMemoryRecord, ProjectRecord};
pub(crate) use repositories::{
    canonical_project_path, normalize_project_path, project_display_name,
    strip_obsolete_plan_approval_permission_mode, upsert_project_row, MAX_PROJECT_MEMORY_BYTES,
    OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE,
};
pub(crate) use schema::{PLAN_APPROVALS_SCHEMA, SCHEMA_LATEST};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Parse an RFC3339 timestamp into epoch ms, falling back to `now`.
pub fn ts_to_ms(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| now_ms())
}

/// Epoch ms -> RFC3339 (UTC, `Z` suffix) for the wire format.
pub fn ms_to_ts(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
