use super::*;

impl PermissionManager {
    #[cfg(test)]
    pub fn create_request(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        args_preview: serde_json::Value,
        reason: &str,
    ) -> (
        PermissionRequest,
        tokio::sync::oneshot::Receiver<PermissionDecision>,
    ) {
        self.create_request_with_risk_and_shell(PermissionRequestParams {
            session_id,
            tool_call_id,
            tool_name,
            args_preview,
            reason,
            declared_risk: None,
            command_shell_id: None,
            review_state: "user",
            scope_label: None,
            turn_id: None,
            user_message_id: None,
            permission_mode: "ask",
            workspace_path: None,
        })
    }

    pub fn create_request_with_risk_and_shell(
        &mut self,
        params: PermissionRequestParams<'_>,
    ) -> (
        PermissionRequest,
        tokio::sync::oneshot::Receiver<PermissionDecision>,
    ) {
        let PermissionRequestParams {
            session_id,
            tool_call_id,
            tool_name,
            args_preview,
            reason,
            declared_risk,
            command_shell_id,
            review_state,
            scope_label,
            turn_id,
            user_message_id,
            permission_mode,
            workspace_path,
        } = params;
        let request_id = Uuid::new_v4().to_string();
        let request = PermissionRequest {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            risk: Self::tool_risk_with_declared(tool_name, declared_risk),
            args_preview: preview_value(&args_preview),
            reason: reason.to_string(),
            timeout_ms: PERMISSION_TIMEOUT_MS,
            command_shell_id: command_shell_id.map(str::to_string),
            review_state: review_state.to_string(),
            scope_label: scope_label.map(str::to_string),
            permission_mode: permission_mode.to_string(),
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.next_sequence += 1;
        let generation = self.generation(session_id);
        self.pending.insert(
            request_id,
            Pending {
                created_at: Instant::now(),
                created_at_ms: now_ms(),
                sequence: self.next_sequence,
                session_id: session_id.to_string(),
                tool_call_id: tool_call_id.to_string(),
                request: request.clone(),
                review_token: None,
                action_fingerprint: None,
                generation,
                turn_id: turn_id.map(str::to_string),
                user_message_id: user_message_id.map(str::to_string),
                workspace_path: workspace_path.map(str::to_string),
                actor_id: None,
                review_context_complete: false,
                review_started_at: None,
                tx: Some(tx),
            },
        );
        (request, rx)
    }

    /// Open requests, oldest first, optionally scoped to one session. Requests
    /// past the timeout are omitted even before `expire_stale` sweeps them,
    /// so a reader never sees a request that can no longer be answered.
    pub fn pending_requests(&self, session_id: Option<&str>) -> Vec<PendingPermission> {
        let timeout = Duration::from_millis(PERMISSION_TIMEOUT_MS);
        let mut open: Vec<&Pending> = self
            .pending
            .values()
            .filter(|pending| pending.created_at.elapsed() <= timeout)
            .filter(|pending| session_id.is_none_or(|id| pending.session_id == id))
            .collect();
        open.sort_by_key(|pending| (pending.created_at_ms, pending.sequence));
        open.into_iter()
            .map(|pending| {
                let elapsed = pending.created_at.elapsed();
                PendingPermission {
                    request: pending.request.clone(),
                    created_at: ms_to_ts(pending.created_at_ms),
                    expires_at: ms_to_ts(pending.created_at_ms + PERMISSION_TIMEOUT_MS as i64),
                    remaining_ms: timeout.saturating_sub(elapsed).as_millis() as u64,
                }
            })
            .collect()
    }

    pub fn bind_action(&mut self, request_id: &str, fingerprint: &str) {
        if let Some(pending) = self.pending.get_mut(request_id) {
            pending.action_fingerprint = Some(fingerprint.to_string());
        }
    }

    pub fn claim_review(
        &mut self,
        request_id: &str,
    ) -> Result<
        (
            String,
            PermissionRequest,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
        String,
    > {
        let session_id = self
            .pending
            .get(request_id)
            .ok_or("NOT_FOUND")?
            .session_id
            .clone();
        let generation = self.generation(&session_id);
        let pending = self.pending.get_mut(request_id).ok_or("NOT_FOUND")?;
        if pending.created_at.elapsed() >= Duration::from_millis(PERMISSION_TIMEOUT_MS) {
            return Err("PERMISSION_TIMEOUT".into());
        }
        if pending.request.review_state != "awaiting_review" || pending.generation != generation {
            return Err("REVIEW_NOT_AVAILABLE".into());
        }
        let fingerprint = pending
            .action_fingerprint
            .clone()
            .ok_or("REVIEW_NOT_AVAILABLE")?;
        let token = Uuid::new_v4().to_string();
        pending.review_token = Some(token.clone());
        pending.review_started_at = Some(Instant::now());
        pending.request.review_state = "reviewing".to_string();
        Ok((
            token,
            pending.request.clone(),
            fingerprint,
            pending.turn_id.clone(),
            pending.user_message_id.clone(),
            pending.workspace_path.clone(),
        ))
    }

    pub fn set_review_context_complete(&mut self, request_id: &str, token: &str, complete: bool) {
        if let Some(pending) = self.pending.get_mut(request_id) {
            if pending.review_token.as_deref() == Some(token) {
                pending.review_context_complete = complete;
            }
        }
    }

    pub fn resolve_review(
        &mut self,
        request_id: &str,
        token: &str,
        fingerprint: &str,
        decision: &str,
    ) -> Result<String, String> {
        let session_id = self
            .pending
            .get(request_id)
            .ok_or("NOT_FOUND")?
            .session_id
            .clone();
        let generation = self.generation(&session_id);
        let pending = self.pending.get_mut(request_id).ok_or("NOT_FOUND")?;
        if pending.created_at.elapsed() >= Duration::from_millis(PERMISSION_TIMEOUT_MS) {
            return Err("PERMISSION_TIMEOUT".into());
        }
        if pending.generation != generation
            || pending.request.review_state != "reviewing"
            || pending.review_token.as_deref() != Some(token)
            || pending.action_fingerprint.as_deref() != Some(fingerprint)
        {
            return Err("REVIEW_STALE".into());
        }
        let decision = if decision == "allow_once"
            && (!pending.review_context_complete
                || pending.review_started_at.is_none_or(|started| {
                    started.elapsed() > Duration::from_millis(REVIEW_TIMEOUT_MS)
                })) {
            "needs_user"
        } else {
            decision
        };
        match decision {
            "needs_user" => {
                pending.review_token = None;
                pending.request.review_state = "user".to_string();
                Ok("needs_user".to_string())
            }
            "allow_once" => self
                .resolve(request_id, PermissionDecision::AllowOnce)
                .map(|_| "allow_once".to_string()),
            "deny" => self
                .resolve(request_id, PermissionDecision::Deny)
                .map(|_| "deny".to_string()),
            _ => Err("INVALID_REVIEW_DECISION".into()),
        }
    }

    pub fn takeover_review(&mut self, request_id: &str) -> Result<(), String> {
        let pending = self.pending.get_mut(request_id).ok_or("NOT_FOUND")?;
        if pending.created_at.elapsed() >= Duration::from_millis(PERMISSION_TIMEOUT_MS) {
            return Err("PERMISSION_TIMEOUT".into());
        }
        pending.review_token = None;
        pending.request.review_state = "user".to_string();
        Ok(())
    }

    pub fn review_state(&self, request_id: &str) -> Option<&str> {
        self.pending
            .get(request_id)
            .map(|pending| pending.request.review_state.as_str())
    }

    pub fn review_session_id(&self, request_id: &str) -> Option<&str> {
        self.pending
            .get(request_id)
            .map(|pending| pending.session_id.as_str())
    }

    pub fn review_turn_id(&self, request_id: &str) -> Option<&str> {
        self.pending
            .get(request_id)
            .and_then(|pending| pending.turn_id.as_deref())
    }

    pub fn bind_actor(&mut self, request_id: &str, actor_id: &str) {
        if let Some(pending) = self.pending.get_mut(request_id) {
            pending.actor_id = Some(actor_id.to_string());
        }
    }

    pub fn review_details(
        &self,
        request_id: &str,
    ) -> Option<(PermissionRequest, u64, Option<String>)> {
        let pending = self.pending.get(request_id)?;
        Some((
            pending.request.clone(),
            pending
                .review_started_at?
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            pending.actor_id.clone(),
        ))
    }

    pub fn invalidate_session(&mut self, session_id: &str) {
        let generation = self
            .session_generations
            .entry(session_id.to_string())
            .or_default();
        *generation = generation.wrapping_add(1);
        let request_ids: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for request_id in request_ids {
            self.cancel(&request_id);
        }
    }

    pub fn generation(&self, session_id: &str) -> PermissionGeneration {
        PermissionGeneration {
            session: *self.session_generations.get(session_id).unwrap_or(&0),
        }
    }

    pub fn fallback_reviews(&mut self) -> Vec<String> {
        self.pending
            .iter_mut()
            .filter_map(|(request_id, pending)| {
                if matches!(
                    pending.request.review_state.as_str(),
                    "awaiting_review" | "reviewing"
                ) {
                    pending.request.review_state = "user".to_string();
                    pending.review_token = None;
                    pending.review_context_complete = false;
                    return Some(request_id.clone());
                }
                None
            })
            .collect()
    }

    pub fn resolve(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        let Some(mut pending) = self.pending.remove(request_id) else {
            return Err("NOT_FOUND".into());
        };
        if pending.created_at.elapsed() > Duration::from_millis(PERMISSION_TIMEOUT_MS) {
            let _ = pending
                .tx
                .take()
                .map(|tx| tx.send(PermissionDecision::Deny));
            return Err("PERMISSION_TIMEOUT".into());
        }
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send(decision);
        }
        Ok(())
    }

    /// Remove a request because its tool call was aborted. Sending deny also
    /// wakes a waiter that raced the cancellation signal; the caller still
    /// returns TOOL_ABORTED because cancellation is authoritative.
    pub fn cancel(&mut self, request_id: &str) -> bool {
        let Some(mut pending) = self.pending.remove(request_id) else {
            return false;
        };
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send(PermissionDecision::Deny);
        }
        true
    }

    pub fn cancel_for_tool(&mut self, session_id: &str, tool_call_id: &str) -> bool {
        let request_id = self
            .pending
            .iter()
            .find(|(_, pending)| {
                pending.session_id == session_id && pending.tool_call_id == tool_call_id
            })
            .map(|(request_id, _)| request_id.clone());
        request_id.is_some_and(|request_id| self.cancel(&request_id))
    }

    pub fn expire_stale(&mut self) {
        let timeout = Duration::from_millis(PERMISSION_TIMEOUT_MS);
        let stale: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| p.created_at.elapsed() > timeout)
            .map(|(k, _)| k.clone())
            .collect();
        for id in stale {
            if let Some(mut p) = self.pending.remove(&id) {
                if let Some(tx) = p.tx.take() {
                    let _ = tx.send(PermissionDecision::Deny);
                }
            }
        }
    }
}
