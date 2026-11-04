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

        // The settings row asks the OS on the user's click. It stays readable
        // while the feature is off: the grant is what makes computer use usable
        // at all, and asking for it must not require turning the feature on
        // first — that would make the toggle look broken on a fresh install.
        "computer.requestPermission" => {
            let accessibility = desktop
                .request_permission()
                .map_err(|error| refusal_err(error.into()))?;
            let st = state.lock().await;
            audit_computer(
                &st,
                "computer.permission.requested",
                None,
                json!({ "accessibility": accessibility }),
            );
            let mut capabilities = desktop.capabilities();
            capabilities.accessibility = accessibility;
            Ok(serde_json::to_value(capabilities)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)
        }

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
            // No `targetId` is the normal case since ADR 0344: the grant covers
            // the desktop. An id still pins one window, which keeps the narrower
            // decision expressible for a caller that has one.
            let target_id = string_param(&params, "targetId");
            let session_id = string_param(&params, "sessionId")
                .ok_or_else(|| invalid("sessionId is required"))?;
            // `agent` is a mint the user did not click, so the Stop cooldown
            // applies to it; `user` is a direct desktop-UI decision.
            let agent_origin = match params.get("origin").and_then(Value::as_str) {
                Some("agent") => true,
                Some("user") | None => false,
                Some(_) => return Err(invalid("origin is invalid")),
            };
            let input_policy = match params.get("inputPolicy").and_then(Value::as_str) {
                Some("autonomous-in-scope") | None => InputPolicy::AutonomousInScope,
                Some("confirm-each") => InputPolicy::ConfirmEach,
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
            if agent_origin {
                if let Err(refusal) = policy::agent_mint_allowed(st.computer_stopped_at, now) {
                    audit_computer(
                        &st,
                        "computer.grant.refused",
                        Some(&session_id),
                        json!({ "code": refusal.code() }),
                    );
                    return Err(refusal_err(refusal));
                }
                st.computer_stopped_at = None;
            }
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
                            "scope": view.scope,
                            "origin": if agent_origin { "agent" } else { "user" },
                            "inputPolicy": view.input_policy,
                            "capture": view.capture,
                            "actionBudget": view.remaining_budget,
                        }),
                    );
                    if !agent_origin {
                        // The user asking for it again is the clearest possible
                        // end to their own Stop.
                        st.computer_stopped_at = None;
                    }
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
            if reason == "user" {
                // Recorded even when there is nothing to revoke: Stop has to
                // hold against the next automatic mint either way.
                st.computer_stopped_at = Some(Instant::now());
            }
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
            // Naming a window is how a desktop grant reads the rest of the
            // screen. The bind runs the refusals again and moves the revision,
            // so the elements this call returns are the only ones it describes.
            let target_id = string_param(&params, "targetId");
            let expected_revision = params
                .get("expectedRevision")
                .and_then(Value::as_u64)
                .map(|value| value as u32);
            let now = Instant::now();
            let denylist = denylist_from_settings(&state).await;
            let mut st = state.lock().await;
            let grant = policy::usable_grant(
                st.computer_grant.as_mut(),
                &grant_id,
                session_id.as_deref(),
                now,
            )
            .map_err(refusal_err)?;
            let before = grant.target.target_id.clone();
            if let Some(target_id) = target_id.as_deref() {
                policy::bind_target(desktop.as_ref(), grant, &denylist, target_id)
                    .map_err(refusal_err)?;
            }
            let inspection =
                policy::inspect(desktop.as_ref(), grant, &denylist, expected_revision, now)
                    .map_err(refusal_err)?;
            // Covers both a named rebind and the fallback inside `refresh`:
            // which application the grant moved to is exactly the identity the
            // audit trail is for, and no window text goes with it.
            let rebound = (grant.target.target_id != before)
                .then(|| (grant.grant_id.clone(), grant.target.app_key.clone()));
            if let Some((grant_id, app_key)) = rebound {
                audit_computer(
                    &st,
                    "computer.grant.rebound",
                    session_id.as_deref(),
                    json!({ "grantId": grant_id, "appKey": app_key }),
                );
            }
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
            let denylist = denylist_from_settings(&state).await;
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
            let result = policy::act(
                desktop.as_ref(),
                grant,
                &denylist,
                expected_revision,
                &action,
                now,
            );
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
