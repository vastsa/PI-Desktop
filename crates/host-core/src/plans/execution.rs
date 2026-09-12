use super::*;

pub(crate) fn execution_from_proposal(proposal: &PlanProposal) -> Result<Option<PlanExecution>> {
    let (Some(id), Some(state), Some(artifact), Some(target_permission_mode)) = (
        proposal.execution_id.clone(),
        proposal.execution_state.clone(),
        proposal.artifact.clone(),
        proposal.target_permission_mode.clone(),
    ) else {
        return Ok(None);
    };
    Ok(Some(PlanExecution {
        id,
        proposal_id: proposal.id.clone(),
        session_id: proposal.session_id.clone(),
        kind: proposal.kind.clone(),
        plan: proposal.plan.clone(),
        title: proposal.title.clone(),
        question: proposal.question.clone(),
        artifact,
        target_permission_mode,
        state,
    }))
}

pub(crate) fn resolution_from_proposal(proposal: PlanProposal) -> Result<PlanResolution> {
    let execution = execution_from_proposal(&proposal)?;
    Ok(PlanResolution {
        status: proposal.status.clone(),
        action: proposal.action.clone(),
        target_permission_mode: proposal.target_permission_mode.clone(),
        execution,
        proposal,
    })
}

/// Prevent renderer configuration calls from bypassing durable Plan work.
/// Every persisted configuration change is blocked while its session has

impl PlanManager {
    pub fn queued_executions(
        &self,
        db: &Database,
        session_id: Option<&str>,
    ) -> Result<Vec<PlanExecution>> {
        let sql = format!(
            "SELECT {PROPOSAL_COLUMNS}
         FROM plan_approvals
         WHERE execution_state = 'queued'
           AND (?1 IS NULL OR session_id = ?1)
         ORDER BY created_at ASC"
        );
        let mut stmt = db.conn().prepare_cached(&sql)?;
        let rows = stmt.query_map(params![session_id], proposal_from_row)?;
        let mut executions = Vec::new();
        for row in rows {
            let proposal = row?;
            if let Some(execution) = execution_from_proposal(&proposal)? {
                executions.push(execution);
            }
        }
        Ok(executions)
    }

    pub fn claim_execution(&self, db: &Database, execution_id: &str) -> Result<PlanExecution> {
        let Some(current) = self.proposal_for_execution(db, execution_id)? else {
            return Err(plan_error("PLAN_EXECUTION_NOT_FOUND"));
        };
        if current.execution_state.as_deref() != Some(EXECUTION_QUEUED) {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        let now = now_ms();
        let tx = db.conn().unchecked_transaction()?;
        let changed = tx
            .prepare_cached(
                "UPDATE plan_approvals
             SET execution_state = 'running', updated_at = ?1, version = version + 1
             WHERE execution_id = ?2 AND execution_state = 'queued' AND version = ?3",
            )?
            .execute(params![now, execution_id, current.version])?;
        if changed != 1 {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_execution_claimed",
            Some(&current.session_id),
            json!({
                "proposalId": current.id,
                "sessionId": current.session_id,
                "executionId": execution_id,
                "state": EXECUTION_RUNNING,
            }),
        )?;
        tx.commit()?;
        let proposal =
            get_proposal(db, &current.id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))?;
        execution_from_proposal(&proposal)?.ok_or_else(|| plan_error("PLAN_EXECUTION_NOT_FOUND"))
    }

    pub fn finish_execution(
        &self,
        db: &Database,
        execution_id: &str,
        status: &str,
        error_code: Option<&str>,
    ) -> Result<PlanExecution> {
        if !matches!(status, EXECUTION_COMPLETED | EXECUTION_INTERRUPTED) {
            return Err(plan_error("PLAN_EXECUTION_STATUS_INVALID"));
        }
        let Some(current) = self.proposal_for_execution(db, execution_id)? else {
            return Err(plan_error("PLAN_EXECUTION_NOT_FOUND"));
        };
        if matches!(
            current.execution_state.as_deref(),
            Some(EXECUTION_COMPLETED) | Some(EXECUTION_INTERRUPTED)
        ) {
            if current.execution_state.as_deref() == Some(status) {
                return execution_from_proposal(&current)?
                    .ok_or_else(|| plan_error("PLAN_EXECUTION_NOT_FOUND"));
            }
            return Err(plan_error("PLAN_EXECUTION_CONFLICT"));
        }
        if !matches!(
            current.execution_state.as_deref(),
            Some(EXECUTION_QUEUED) | Some(EXECUTION_RUNNING)
        ) {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        let now = now_ms();
        let stored_error = (status == EXECUTION_INTERRUPTED)
            .then(|| error_code.unwrap_or("PLAN_EXECUTION_INTERRUPTED"));
        let tx = db.conn().unchecked_transaction()?;
        let changed = tx
            .prepare_cached(
                "UPDATE plan_approvals
             SET execution_state = ?1, updated_at = ?2, version = version + 1,
                 error_code = ?3
             WHERE execution_id = ?4
               AND execution_state IN ('queued', 'running') AND version = ?5",
            )?
            .execute(params![
                status,
                now,
                stored_error,
                execution_id,
                current.version
            ])?;
        if changed != 1 {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_execution_finished",
            Some(&current.session_id),
            json!({
                "proposalId": current.id,
                "sessionId": current.session_id,
                "executionId": execution_id,
                "state": status,
                "errorCode": stored_error,
            }),
        )?;
        tx.commit()?;
        let proposal =
            get_proposal(db, &current.id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))?;
        execution_from_proposal(&proposal)?.ok_or_else(|| plan_error("PLAN_EXECUTION_NOT_FOUND"))
    }

    fn proposal_for_execution(
        &self,
        db: &Database,
        execution_id: &str,
    ) -> Result<Option<PlanProposal>> {
        let sql = format!("SELECT {PROPOSAL_COLUMNS} FROM plan_approvals WHERE execution_id = ?1");
        Ok(db
            .conn()
            .prepare_cached(&sql)?
            .query_row(params![execution_id], proposal_from_row)
            .optional()?)
    }
}
