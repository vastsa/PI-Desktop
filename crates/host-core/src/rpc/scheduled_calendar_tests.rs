use super::*;

fn invoke(st: &AppState, session: &str, name: &str, args: Value) -> Value {
    let params = serde_json::from_value(json!({"sessionId":session,"toolCallId":"calendar-test","toolName":name,"args":args,"mode":"agent"})).unwrap();
    serde_json::to_value(execute(st, &params)).unwrap()
}

fn session(st: &AppState) -> String {
    sessions::create_session(&st.db, None, Some("agent".into()), None, None, None)
        .unwrap()
        .id
}

#[test]
fn hourly_calendar_conversion_requires_calendar_intent_after_restart() {
    for target in ["daily", "weekly"] {
        for creator in ["tool", "ui", "legacy"] {
            let dir = tempfile::tempdir().unwrap();
            let st = AppState::open(dir.path()).unwrap();
            let sid = session(&st);
            let created = match creator {
                "tool" => invoke(&st, &sid, "scheduled_task_create", json!({"title":"Review","prompt":"Reply OK","cadence":"hourly","enabled":false}))["content"].clone(),
                "ui" => scheduled_rpc::handle(&st,"scheduled.create",json!({"title":"Review","prompt":"Reply OK","cadence":"hourly","enabled":false,"schedule":{"hour":0,"minute":0,"weekday":0}})).unwrap(),
                _ => {
                    scheduled::import_tasks(&st.db, &[json!({"id":"legacy","title":"Review","prompt":"Reply OK","cadence":"hourly","enabled":false,"configJson":{"schedule":{"hour":0,"minute":0,"weekday":0}}})]).unwrap();
                    json!({"task":scheduled::get_task(&st.db,"legacy").unwrap().unwrap()})
                }
            };
            let id = created["task"]["id"].as_str().unwrap().to_string();
            drop(st);
            let st = AppState::open(dir.path()).unwrap();
            let before =
                serde_json::to_value(scheduled::get_task(&st.db, &id).unwrap().unwrap()).unwrap();
            let rejected = invoke(
                &st,
                &sid,
                "scheduled_task_update",
                json!({"id":id,"cadence":target}),
            );
            assert_eq!(
                rejected["errorCode"], "INVALID_PARAMS",
                "{creator} -> {target}: {rejected}"
            );
            assert_eq!(
                serde_json::to_value(scheduled::get_task(&st.db, &id).unwrap().unwrap()).unwrap(),
                before
            );
            let schedule = json!({"hour":0,"minute":0,"weekday":2,"weekdays":[2,4]});
            let accepted = invoke(
                &st,
                &sid,
                "scheduled_task_update",
                json!({"id":id,"cadence":target,"schedule":schedule}),
            );
            assert_eq!(accepted["ok"], true, "{accepted}");
            assert_eq!(accepted["content"]["task"]["enabled"], false);
            assert_eq!(accepted["content"]["task"]["schedule"], schedule);
        }
    }
}

#[test]
fn saved_calendar_survives_hourly_and_restart_including_midnight() {
    for hour in [0, 15] {
        for legacy in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let st = AppState::open(dir.path()).unwrap();
            let sid = session(&st);
            let schedule = json!({"hour":hour,"minute":0,"weekday":0,"weekdays":[0,2]});
            let created = if legacy {
                scheduled::import_tasks(&st.db,&[json!({"id":"old","prompt":"Review","cadence":"weekly","enabled":false,"configJson":{"schedule":schedule}})]).unwrap();
                json!({"content":{"task":scheduled::get_task(&st.db,"old").unwrap().unwrap()}})
            } else {
                invoke(
                    &st,
                    &sid,
                    "scheduled_task_create",
                    json!({"title":"Review","prompt":"Review","cadence":"weekly","enabled":false,"schedule":schedule}),
                )
            };
            let id = created["content"]["task"]["id"].as_str().unwrap();
            assert_eq!(
                invoke(
                    &st,
                    &sid,
                    "scheduled_task_update",
                    json!({"id":id,"cadence":"hourly"})
                )["ok"],
                true
            );
            drop(st);
            let st = AppState::open(dir.path()).unwrap();
            let restored = invoke(
                &st,
                &sid,
                "scheduled_task_update",
                json!({"id":id,"cadence":"weekly"}),
            );
            assert_eq!(restored["ok"], true, "{restored}");
            assert_eq!(restored["content"]["task"]["schedule"], schedule);
            assert_eq!(restored["content"]["task"]["enabled"], false);
        }
    }
}
