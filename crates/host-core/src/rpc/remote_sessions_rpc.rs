use super::*;
use crate::db::{Database, RemoteWorkspace};
use crate::remote_sessions::{self, bindings, environments};
use crate::workspace_git::layout::Repository;
use serde::de::DeserializeOwned;

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(value).map_err(invalid)
}

fn invalid(error: impl ToString) -> JsonRpcError {
    rpc_err(1002, error.to_string(), "INVALID_ARGUMENT")
}

fn field<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{key} is required")))
}

pub(super) fn handle(db: &Database, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    match method {
        "environments.list" => {
            Ok(json!({ "environments": environments::list(db).map_err(invalid)? }))
        }
        "environments.upsert" => {
            Ok(json!({ "environment": environments::upsert(db, parse(params)?).map_err(invalid)? }))
        }
        "environments.remove" => {
            if !environments::remove(db, field(&params, "id")?).map_err(invalid)? {
                return Err(rpc_err(
                    1007,
                    "environment not found",
                    "REMOTE_ENVIRONMENT_NOT_FOUND",
                ));
            }
            Ok(json!({ "ok": true }))
        }
        "environments.removeForHost" => Ok(
            json!({ "removed": environments::remove_for_host(db, field(&params, "hostKey")?).map_err(invalid)? }),
        ),
        "project.group.ensureRepository" => {
            let remote = RemoteWorkspace {
                host_key: field(&params, "hostKey")?.into(),
                path: field(&params, "path")?.into(),
            };
            let repository = parse::<Repository>(params["repository"].clone())?
                .validated()
                .map_err(invalid)?;
            let (group, created) = remote_sessions::ensure_repository(
                db,
                remote,
                repository,
                field(&params, "defaultBranch")?.into(),
            )
            .map_err(invalid)?;
            Ok(json!({ "group": group, "created": created }))
        }
        "sessionWorkspace.bind" => {
            Ok(json!({ "binding": bindings::bind(db, parse(params)?).map_err(invalid)? }))
        }
        "sessionWorkspace.update" => {
            let patch = params["patch"]
                .as_object()
                .ok_or_else(|| invalid("patch is required"))?;
            Ok(
                json!({ "binding": bindings::update(db, field(&params, "sessionId")?, patch).map_err(invalid)? }),
            )
        }
        "sessionWorkspace.get" => Ok(
            json!({ "binding": bindings::get(db, field(&params, "sessionId")?).map_err(invalid)? }),
        ),
        "sessionWorkspace.list" => {
            let states: Vec<bindings::State> = params
                .get("states")
                .map(|value| parse(value.clone()))
                .transpose()?
                .unwrap_or_default();
            Ok(json!({ "bindings": bindings::list(db, &states).map_err(invalid)? }))
        }
        "sessionWorkspace.remove" => {
            bindings::remove(db, field(&params, "sessionId")?).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        "sessionWorkspace.pendingRemoval.add" => {
            bindings::add_pending(db, parse(params)?).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        "sessionWorkspace.pendingRemoval.list" => Ok(
            json!({ "removals": bindings::pending(db, params.get("hostKey").and_then(Value::as_str)).map_err(invalid)? }),
        ),
        "sessionWorkspace.pendingRemoval.remove" => {
            bindings::remove_pending(db, field(&params, "hostKey")?, field(&params, "sessionId")?)
                .map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(-32601, "method not found", "METHOD_NOT_FOUND")),
    }
}
