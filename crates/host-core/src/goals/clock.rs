//! Lifecycle time, not a sum of turn durations. Checkpoint only on committed
//! mutations; recovery deliberately drops the uncheckpointed crash tail rather
//! than billing downtime. Reading never resets the running interval.
use super::{GoalStatus, SessionGoal, MAX_SAFE_INTEGER};
use rusqlite::{functions::FunctionFlags, Connection};

pub(super) fn now_ms() -> i64 {
    #[cfg(test)]
    if let Some(now) = TEST_NOW.with(|clock| clock.get()) {
        return now.clamp(0, MAX_SAFE_INTEGER);
    }
    crate::db::now_ms().clamp(0, MAX_SAFE_INTEGER)
}

pub(crate) fn register(conn: &Connection) -> rusqlite::Result<()> {
    // Not deterministic: SQL mode fences use the same host clock as saves.
    conn.create_scalar_function("goal_now_ms", 0, FunctionFlags::SQLITE_UTF8, |_| {
        Ok(now_ms())
    })
}

pub(super) fn checkpoint(goal: &mut SessionGoal, now: i64) {
    let now = now.clamp(0, MAX_SAFE_INTEGER);
    // A backwards wall-clock adjustment must not count the same interval twice.
    let checkpoint = goal.active_since_ms.map_or(now, |since| since.max(now));
    if let Some(since) = goal.active_since_ms {
        goal.elapsed_ms = goal
            .elapsed_ms
            .saturating_add(checkpoint - since)
            .min(MAX_SAFE_INTEGER);
    }
    goal.active_since_ms =
        (goal.status == GoalStatus::Active && !goal.deleted).then_some(checkpoint);
}

#[cfg(test)]
thread_local! {
    static TEST_NOW: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(super) fn at<T>(now: i64, action: impl FnOnce() -> T) -> T {
    struct Reset(Option<i64>);
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_NOW.with(|clock| clock.set(self.0));
        }
    }
    let _reset = Reset(TEST_NOW.with(|clock| clock.replace(Some(now))));
    action()
}
