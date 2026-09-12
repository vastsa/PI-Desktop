use super::*;

pub(crate) fn plan_error(code: &str) -> anyhow::Error {
    anyhow!(code.to_string())
}

fn valid_permission_mode(value: &str) -> bool {
    matches!(value, "ask" | "accept-edits" | "auto")
}

/// Expire approvals at the first read or mutation boundary that observes
/// them. The state transition and audit record share one transaction so a
/// timed-out approval can never remain actionable after its error is visible.
pub fn expire_pending_approvals(db: &Database) -> Result<()> {
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    let expired: Vec<(String, String, String, String)> = {
        let mut stmt = tx.prepare_cached(
            "SELECT request_id, session_id, turn_id, tool_call_id
             FROM plan_approvals
             WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    tx.execute(
        "UPDATE plan_approvals
         SET status = 'expired', resolved_at = ?1, updated_at = ?1,
             error_code = 'PLAN_APPROVAL_TIMEOUT', version = version + 1
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?1",
        params![now],
    )?;
    for (proposal_id, session_id, turn_id, tool_call_id) in expired {
        audit::append_tx(
            &tx,
            "plan_approval_expired",
            Some(&session_id),
            json!({
                "proposalId": proposal_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "status": STATUS_EXPIRED,
                "errorCode": "PLAN_APPROVAL_TIMEOUT"
            }),
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn gate_session_configure(
    db: &Database,
    session_id: &str,
    requested_mode: &str,
    requested_provider_id: Option<&str>,
    requested_model_id: Option<&str>,
    requested_thinking_level: Option<&str>,
    requested_permission_mode: Option<&str>,
) -> Result<()> {
    expire_pending_approvals(db)?;
    let Some((
        current_mode,
        current_provider_id,
        current_model_id,
        current_thinking_level,
        current_permission_mode,
    )) = db
        .conn()
        .query_row(
            "SELECT mode, provider_id, model_id, thinking_level, permission_mode
             FROM sessions WHERE id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(());
    };
    let requested_mode = sessions::normalize_mode(Some(requested_mode));
    let mode_changes = current_mode != requested_mode;
    let provider_changes = requested_provider_id
        .is_some_and(|provider| current_provider_id.as_deref() != Some(provider));
    let model_changes =
        requested_model_id.is_some_and(|model| current_model_id.as_deref() != Some(model));
    let thinking_changes =
        requested_thinking_level.is_some_and(|level| level != current_thinking_level);
    let permission_changes =
        requested_permission_mode.is_some_and(|permission| permission != current_permission_mode);
    if !mode_changes
        && !provider_changes
        && !model_changes
        && !thinking_changes
        && !permission_changes
    {
        return Ok(());
    }
    let blocked: bool = db.conn().query_row(
        "SELECT EXISTS(
             SELECT 1 FROM plan_approvals
             WHERE session_id = ?1 AND status = 'pending'
          ) OR EXISTS(
              SELECT 1 FROM plan_approvals
              WHERE session_id = ?1 AND execution_state IN ('queued', 'running')
          ) OR EXISTS(
              SELECT 1 FROM turns
              WHERE session_id = ?1 AND status = 'running'
          )",
        params![session_id],
        |row| row.get(0),
    )?;
    if blocked {
        return Err(plan_error("PLAN_CONFIGURATION_BLOCKED"));
    }
    Ok(())
}

impl PlanManager {
    pub fn enter(
        &self,
        db: &Database,
        session_id: &str,
        turn_id: &str,
        tool_call_id: &str,
        kind: &str,
    ) -> Result<()> {
        if session_id.trim().is_empty()
            || turn_id.trim().is_empty()
            || tool_call_id.trim().is_empty()
        {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        }
        let Some(kind) = normalize_kind(kind) else {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        };
        let Some(mode) = sessions::session_mode(db, session_id)? else {
            return Err(plan_error("PLAN_SESSION_NOT_FOUND"));
        };
        if mode != "agent" {
            return Err(plan_error("PLAN_ALREADY_ACTIVE"));
        }
        let now = now_ms();
        let tx = db.conn().unchecked_transaction()?;
        let changed = tx
            .prepare_cached(
                "UPDATE sessions SET mode = ?4, updated_at = ?1
             WHERE id = ?2 AND mode = 'agent'
               AND EXISTS (
                 SELECT 1 FROM turns
                 WHERE id = ?3 AND session_id = ?2 AND status = 'running'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM plan_approvals
                 WHERE session_id = ?2 AND execution_state IN ('queued', 'running')
               )",
            )?
            .execute(params![now, session_id, turn_id, kind])?;
        if changed == 0 {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_entered",
            Some(session_id),
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "kind": kind,
                "mode": kind
            }),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn submit(&self, db: &Database, params: PlanSubmitParams<'_>) -> Result<PlanProposal> {
        let PlanSubmitParams {
            workspace_root,
            session_id,
            turn_id,
            tool_call_id,
            kind,
            title,
            markdown,
            question,
        } = params;
        if session_id.trim().is_empty()
            || turn_id.trim().is_empty()
            || tool_call_id.trim().is_empty()
            || title.trim().is_empty()
            || markdown.trim().is_empty()
            || question.trim().is_empty()
        {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        }
        let Some(kind) = normalize_kind(kind) else {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        };
        if markdown.len() > PLAN_MAX_MARKDOWN_BYTES {
            return Err(plan_error("PLAN_MARKDOWN_TOO_LARGE"));
        }
        expire_pending_approvals(db)?;
        // Agent mode has no contract to submit; the other contract mode does,
        // but not this one — those are different failures for the model.
        match session_submit_kind(db, session_id)? {
            None => return Err(plan_error("PLAN_NOT_ACTIVE")),
            Some(active) if active != kind => return Err(plan_error("PLAN_KIND_MISMATCH")),
            Some(_) => {}
        }
        if !live_turn_belongs_to_session(db, session_id, turn_id)? {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        let has_pending: bool = db.conn().query_row(
            "SELECT EXISTS(
             SELECT 1 FROM plan_approvals
             WHERE session_id = ?1 AND status = 'pending'
         )",
            params![session_id],
            |row| row.get(0),
        )?;
        if has_pending {
            return Err(plan_error("PLAN_ALREADY_PENDING"));
        }

        let (artifact, path) = publish_artifact(workspace_root, kind, title, markdown)?;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let insert_result = (|| -> Result<()> {
            let tx = db.conn().unchecked_transaction()?;
            tx.prepare_cached(
                "INSERT INTO plan_approvals (
                 request_id, session_id, turn_id, tool_call_id, kind, plan_json,
                 title, question, status, created_at, updated_at, expires_at,
                 artifact_relative_path, artifact_sha256, artifact_size_bytes,
                 version
             ) VALUES (?1, ?2, ?3, ?4, ?13, ?5, ?6, ?7, 'pending', ?8, ?8,
                       ?9, ?10, ?11, ?12, 1)",
            )?
            .execute(params![
                id,
                session_id,
                turn_id,
                tool_call_id,
                markdown,
                title.trim(),
                question.trim(),
                now,
                now + PLAN_APPROVAL_TIMEOUT_MS,
                artifact.relative_path,
                artifact.sha256,
                artifact.size_bytes as i64,
                kind,
            ])?;
            artifacts::record_tx(
                &tx,
                session_id,
                &artifact.relative_path,
                "write",
                Some(turn_id),
            )?;
            audit::append_tx(
                &tx,
                "plan_submitted",
                Some(session_id),
                json!({
                    "proposalId": id,
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "toolCallId": tool_call_id,
                    "kind": kind,
                    "title": title.trim(),
                    "question": question.trim(),
                    "artifact": artifact,
                }),
            )?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = insert_result {
            let _ = fs::remove_file(path);
            return Err(error);
        }
        get_proposal(db, &id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))
    }

    pub fn pending_for_session(
        &self,
        db: &Database,
        session_id: Option<&str>,
    ) -> Result<Vec<PlanProposal>> {
        expire_pending_approvals(db)?;
        let sql = format!(
            "SELECT {PROPOSAL_COLUMNS}
         FROM plan_approvals
         WHERE status = 'pending'
           AND (?1 IS NULL OR session_id = ?1)
         ORDER BY created_at DESC"
        );
        let mut stmt = db.conn().prepare_cached(&sql)?;
        let rows = stmt.query_map(params![session_id], proposal_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn state_for_session(&self, db: &Database, session_id: &str) -> Result<String> {
        expire_pending_approvals(db)?;
        let Some(mode) = sessions::session_mode(db, session_id)? else {
            return Err(plan_error("PLAN_SESSION_NOT_FOUND"));
        };
        if mode == "agent" {
            return Ok("inactive".into());
        }
        if !self.pending_for_session(db, Some(session_id))?.is_empty() {
            return Ok("awaiting_approval".into());
        }
        Ok("planning".into())
    }

    /// The contract kind the session is currently authoring (`plan`/`goal`), or
    /// `None` in Agent mode. Renderers need this to label a planning state.
    pub fn active_kind(&self, db: &Database, session_id: &str) -> Result<Option<&'static str>> {
        session_submit_kind(db, session_id)
    }

    #[cfg(test)]
    pub fn resolution_for(
        &self,
        db: &Database,
        proposal_id: &str,
    ) -> Result<Option<PlanResolution>> {
        expire_pending_approvals(db)?;
        let Some(proposal) = get_proposal(db, proposal_id)? else {
            return Ok(None);
        };
        if proposal.status == STATUS_PENDING {
            return Ok(None);
        }
        Ok(Some(resolution_from_proposal(proposal)?))
    }

    pub fn resolve(&self, db: &Database, params: PlanResolveParams<'_>) -> Result<PlanResolution> {
        let PlanResolveParams {
            workspace_root,
            proposal_id,
            session_id,
            turn_id,
            tool_call_id,
            version,
            action,
            target_permission_mode,
        } = params;
        expire_pending_approvals(db)?;
        let Some(current) = get_proposal(db, proposal_id)? else {
            return Err(plan_error("PLAN_NOT_FOUND"));
        };
        // The stored kind is authoritative: it decides both the artifact
        // directory to verify and the mode the approval must leave behind.
        let kind = normalize_kind(&current.kind).unwrap_or(KIND_PLAN);
        if current.session_id != session_id
            || current.turn_id != turn_id
            || current.tool_call_id != tool_call_id
        {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        if !matches!(action, "approve" | "reject") {
            return Err(plan_error("PLAN_INVALID_ACTION"));
        }
        if current.status == STATUS_EXPIRED {
            return Err(plan_error("PLAN_APPROVAL_TIMEOUT"));
        }
        let selected = if action == "approve" {
            let Some(selected) = target_permission_mode else {
                return Err(plan_error("PLAN_PERMISSION_MODE_REQUIRED"));
            };
            if !valid_permission_mode(selected) {
                return Err(plan_error("PLAN_PERMISSION_MODE_INVALID"));
            }
            Some(selected)
        } else {
            None
        };
        if current.status != STATUS_PENDING {
            let same_resolution = current.action.as_deref() == Some(action)
                && (action != "approve" || current.target_permission_mode.as_deref() == selected);
            if same_resolution {
                return resolution_from_proposal(current);
            }
            return Err(plan_error("PLAN_APPROVAL_CONFLICT"));
        }
        if version.is_some_and(|version| version != current.version) {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }

        if action == "approve" {
            let workspace_root =
                workspace_root.ok_or_else(|| plan_error("PLAN_WORKSPACE_REQUIRED"))?;
            let artifact = current
                .artifact
                .clone()
                .ok_or_else(|| plan_error("PLAN_ARTIFACT_NOT_READY"))?;
            verify_artifact(workspace_root, kind, &artifact)?;
        }
        let now = now_ms();
        let status = match action {
            "approve" => STATUS_APPROVED,
            _ => STATUS_REJECTED,
        };
        let execution_id = (action == "approve").then(|| Uuid::new_v4().to_string());
        let tx = db.conn().unchecked_transaction()?;
        if action == "approve" {
            let active_execution: bool = tx.query_row(
                "SELECT EXISTS(
                 SELECT 1 FROM plan_approvals
                 WHERE session_id = ?1 AND execution_state IN ('queued', 'running')
             )",
                params![session_id],
                |row| row.get(0),
            )?;
            if active_execution {
                return Err(plan_error("PLAN_EXECUTION_ACTIVE"));
            }
            let changed = tx
                .prepare_cached(
                    "UPDATE sessions
                 SET mode = 'agent', permission_mode = ?1, updated_at = ?2
                 WHERE id = ?3 AND mode = ?4",
                )?
                .execute(params![selected, now, session_id, kind])?;
            if changed == 0 {
                return Err(plan_error("PLAN_NOT_ACTIVE"));
            }
        }
        let changed = tx
            .prepare_cached(
                "UPDATE plan_approvals
              SET status = ?1, action = ?2, target_permission_mode = ?3,
                  resolved_at = ?4, updated_at = ?4,
                  error_code = NULL, version = version + 1,
                  execution_id = ?5, execution_state = ?6
              WHERE request_id = ?7 AND session_id = ?8 AND turn_id = ?9
                AND tool_call_id = ?10 AND status = 'pending' AND version = ?11
                 AND expires_at > ?12",
            )?
            .execute(params![
                status,
                action,
                selected,
                now,
                execution_id,
                (action == "approve").then_some(EXECUTION_QUEUED),
                proposal_id,
                session_id,
                turn_id,
                tool_call_id,
                current.version,
                now,
            ])?;
        if changed != 1 {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_approval_resolved",
            Some(session_id),
            json!({
                "proposalId": proposal_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "kind": kind,
                "action": action,
                "status": status,
                "targetPermissionMode": selected,
                "executionId": execution_id,
                "executionState": (action == "approve").then_some(EXECUTION_QUEUED),
            }),
        )?;
        tx.commit()?;
        let proposal =
            get_proposal(db, proposal_id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))?;
        resolution_from_proposal(proposal)
    }

    pub fn abort_session(&self, db: &Database, session_id: &str) -> Result<bool> {
        expire_pending_approvals(db)?;
        let ids: Vec<String> = {
            let mut stmt = db.conn().prepare_cached(
                "SELECT request_id FROM plan_approvals
             WHERE session_id = ?1 AND status = 'pending'",
            )?;
            let rows = stmt.query_map(params![session_id], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if ids.is_empty() {
            return Ok(false);
        }
        let now = now_ms();
        let tx = db.conn().unchecked_transaction()?;
        for id in &ids {
            let changed = tx
                .prepare_cached(
                    "UPDATE plan_approvals
                 SET status = 'interrupted', resolved_at = ?1, updated_at = ?1,
                     error_code = 'PLAN_APPROVAL_INTERRUPTED', version = version + 1
                 WHERE request_id = ?2 AND status = 'pending'",
                )?
                .execute(params![now, id])?;
            if changed == 1 {
                let session_id_for_audit: String = tx.query_row(
                    "SELECT session_id FROM plan_approvals WHERE request_id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                audit::append_tx(
                    &tx,
                    "plan_approval_terminal",
                    Some(&session_id_for_audit),
                    json!({
                        "proposalId": id,
                        "status": STATUS_INTERRUPTED,
                        "errorCode": "PLAN_APPROVAL_INTERRUPTED"
                    }),
                )?;
            }
        }
        tx.commit()?;
        Ok(true)
    }
}
