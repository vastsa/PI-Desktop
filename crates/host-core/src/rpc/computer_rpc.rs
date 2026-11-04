//! `computer.*` RPC: the only way into the computer-use capability.
//!
//! Every method re-reads the live grant and the denylist from settings rather
//! than trusting anything in the request. The request may name a `grantId` and
//! a `sessionId`, and both are checked against the grant the host minted — a
//! caller cannot describe itself into authority it was not given.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::audit;
use crate::computer::{self, backend, policy, Action, CaptureMode, InputPolicy, Refusal};
use crate::state::AppState;

use super::{rpc_err, JsonRpcError};

fn refusal_err(refusal: Refusal) -> JsonRpcError {
    // 1006 is the host's "tool denied by policy" family; the public code is
    // what the caller branches on, and the message carries no window content.
    rpc_err(1006, refusal.message(), refusal.code())
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message.to_string(), "INVALID_PARAMS")
}

fn string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Settings are the user's; the built-in credential denylist is not, so it is
/// added inside `Denylist` and cannot be removed by a settings write.
async fn denylist_from_settings(state: &Arc<Mutex<AppState>>) -> policy::Denylist {
    let st = state.lock().await;
    let stored = st.db.get_setting("app").ok().flatten();
    let entries = stored
        .as_ref()
        .and_then(|value| value.get("computerUse"))
        .and_then(|value| value.get("denylist"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    policy::Denylist::new(&entries)
}

async fn settings_enabled(state: &Arc<Mutex<AppState>>) -> bool {
    let st = state.lock().await;
    st.db
        .get_setting("app")
        .ok()
        .flatten()
        .as_ref()
        .and_then(|value| value.get("computerUse"))
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn audit_computer(state: &AppState, kind: &str, session_id: Option<&str>, payload: Value) {
    if let Err(error) = audit::append(&state.db, kind, session_id, payload) {
        tracing::warn!(%error, "computer-use audit append failed");
    }
}

pub(crate) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let desktop = backend::active();
    match method {
        // Capabilities are readable while the feature is off: the settings page
        // has to be able to say "unsupported here" before anything is enabled.
        "computer.capabilities" => Ok(serde_json::to_value(desktop.capabilities())
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?),

        "computer.listTargets" => {
            if !settings_enabled(&state).await {
                return Err(refusal_err(Refusal::Disabled));
            }
            let denylist = denylist_from_settings(&state).await;
            let targets = policy::list_targets(desktop.as_ref(), &denylist).map_err(refusal_err)?;
            Ok(json!({ "targets": targets }))
        }

        "computer.grantCreate" => {
            if !settings_enabled(&state).await {
                return Err(refusal_err(Refusal::Disabled));
            }
            let target_id =
                string_param(&params, "targetId").ok_or_else(|| invalid("targetId is required"))?;
            let session_id = string_param(&params, "sessionId")
                .ok_or_else(|| invalid("sessionId is required"))?;
            let input_policy = match params.get("inputPolicy").and_then(Value::as_str) {
                Some("autonomous-in-scope") => InputPolicy::AutonomousInScope,
                Some("confirm-each") | None => InputPolicy::ConfirmEach,
                Some(_) => return Err(invalid("inputPolicy is invalid")),
            };
            let capture = match params.get("capture").and_then(Value::as_str) {
                Some("a11y-and-pixels") => CaptureMode::A11yAndPixels,
                Some("a11y-only") | None => CaptureMode::A11yOnly,
                Some(_) => return Err(invalid("capture is invalid")),
            };
            let action_budget = params
                .get("actionBudget")
                .and_then(Value::as_u64)
                .unwrap_or(computer::DEFAULT_ACTION_BUDGET as u64)
                .min(computer::MAX_ACTION_BUDGET as u64) as u32;
            let idle_expiry = params
                .get("idleExpiryMs")
                .and_then(Value::as_u64)
                .map(Duration::from_millis)
                .unwrap_or(computer::DEFAULT_IDLE_EXPIRY);
            let denylist = denylist_from_settings(&state).await;
            let now = Instant::now();

            let mut st = state.lock().await;
            let grant = policy::create_grant(
                desktop.as_ref(),
                st.computer_grant.as_ref(),
                &denylist,
                policy::GrantRequest {
                    target_id,
                    session_id: session_id.clone(),
                    input_policy,
                    capture,
                    action_budget,
                    idle_expiry,
                },
                now,
            );
            match grant {
                Ok(grant) => {
                    let view = grant.view(now);
                    audit_computer(
                        &st,
                        "computer.grant.created",
                        Some(&session_id),
                        json!({
                            "grantId": view.grant_id,
                            "appKey": view.app_key,
                            "inputPolicy": view.input_policy,
                            "capture": view.capture,
                            "actionBudget": view.remaining_budget,
                        }),
                    );
                    st.computer_grant = Some(grant);
                    Ok(serde_json::to_value(view)
                        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)
                }
                Err(refusal) => {
                    audit_computer(
                        &st,
                        "computer.grant.refused",
                        Some(&session_id),
                        json!({ "code": refusal.code() }),
                    );
                    Err(refusal_err(refusal))
                }
            }
        }

        "computer.grantRevoke" => {
            let mut st = state.lock().await;
            let reason = string_param(&params, "reason").unwrap_or_else(|| "user".into());
            let Some(grant) = st.computer_grant.as_mut() else {
                // Revoking nothing is success: the caller's intent is satisfied.
                return Ok(json!({ "revoked": false }));
            };
            let grant_id = grant.grant_id.clone();
            let session_id = grant.session_id.clone();
            policy::revoke(grant, false);
            audit_computer(
                &st,
                "computer.grant.revoked",
                Some(&session_id),
                json!({ "grantId": grant_id, "reason": reason }),
            );
            st.computer_grant = None;
            Ok(json!({ "revoked": true }))
        }

        "computer.grantDescribe" => {
            let now = Instant::now();
            let mut st = state.lock().await;
            let Some(grant) = st.computer_grant.as_mut() else {
                return Ok(json!({ "grant": Value::Null }));
            };
            if grant.expired_at(now) {
                let view = grant.view(now);
                st.computer_grant = None;
                return Ok(json!({ "grant": view }));
            }
            Ok(json!({ "grant": grant.view(now) }))
        }

        "computer.inspect" => {
            let grant_id =
                string_param(&params, "grantId").ok_or_else(|| invalid("grantId is required"))?;
            let session_id = string_param(&params, "sessionId");
            let expected_revision = params
                .get("expectedRevision")
                .and_then(Value::as_u64)
                .map(|value| value as u32);
            let now = Instant::now();
            let mut st = state.lock().await;
            let grant = policy::usable_grant(
                st.computer_grant.as_mut(),
                &grant_id,
                session_id.as_deref(),
                now,
            )
            .map_err(refusal_err)?;
            let inspection = policy::inspect(desktop.as_ref(), grant, expected_revision, now)
                .map_err(refusal_err)?;
            Ok(serde_json::to_value(inspection)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)
        }

        "computer.act" => {
            let grant_id =
                string_param(&params, "grantId").ok_or_else(|| invalid("grantId is required"))?;
            let session_id = string_param(&params, "sessionId");
            let expected_revision = params
                .get("expectedRevision")
                .and_then(Value::as_u64)
                .map(|value| value as u32);
            let action: Action = serde_json::from_value(
                params
                    .get("action")
                    .cloned()
                    .ok_or_else(|| invalid("action is required"))?,
            )
            .map_err(|error| invalid(&format!("action is invalid: {error}")))?;
            let now = Instant::now();
            let mut st = state.lock().await;
            let grant = policy::usable_grant(
                st.computer_grant.as_mut(),
                &grant_id,
                session_id.as_deref(),
                now,
            )
            .map_err(refusal_err)?;
            let owner = grant.session_id.clone();
            let app_key = grant.target.app_key.clone();
            let result = policy::act(desktop.as_ref(), grant, expected_revision, &action, now);
            match result {
                Ok(outcome) => {
                    // The audit line records identity and shape, never content:
                    // typed text appears as a length, and no pixels are stored.
                    audit_computer(
                        &st,
                        "computer.act",
                        Some(&owner),
                        json!({
                            "grantId": outcome.grant_id,
                            "appKey": app_key,
                            "action": action.kind.map(|kind| kind.as_str()),
                            "uid": action.uid,
                            "textLength": action.text.as_ref().map(|text| text.chars().count()),
                            "dispatched": outcome.dispatched,
                            "remainingBudget": outcome.remaining_budget,
                        }),
                    );
                    if outcome.remaining_budget == 0 {
                        st.computer_grant = None;
                    }
                    Ok(serde_json::to_value(outcome)
                        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)
                }
                Err(refusal) => {
                    audit_computer(
                        &st,
                        "computer.act.refused",
                        Some(&owner),
                        json!({
                            "grantId": grant_id,
                            "appKey": app_key,
                            "action": action.kind.map(|kind| kind.as_str()),
                            "code": refusal.code(),
                        }),
                    );
                    // A refusal that ended the grant must not leave a dead one
                    // behind for the next caller to trip over.
                    if matches!(refusal, Refusal::ScopeViolation | Refusal::GrantExpired) {
                        st.computer_grant = None;
                    }
                    Err(refusal_err(refusal))
                }
            }
        }

        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
