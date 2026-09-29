use anyhow::{bail, Result};
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};

/// Hourly schedules advance by elapsed time, so the newest occurrence is a
/// division away instead of a walk.
const HOURLY_MS: i64 = 3_600_000;
/// Hard bound on the calendar walk, on top of the bound the window implies.
const MAX_CATCH_UP_WALK_STEPS: usize = 512;

/// Daily/weekly schedules use local time; hourly schedules use elapsed time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    pub hour: u32,
    pub minute: u32,
    /// Monday = 0, Sunday = 6.
    pub weekday: u32,
    /// When present, replaces the legacy single weekday. Monday = 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekdays: Option<Vec<u32>>,
}

impl Schedule {
    pub fn validate(&self) -> Result<()> {
        if self.hour > 23 || self.minute > 59 || self.weekday > 6 {
            bail!("invalid schedule time or weekday");
        }
        if let Some(days) = &self.weekdays {
            if days.is_empty()
                || days.len() > 7
                || days.iter().any(|day| *day > 6)
                || days
                    .iter()
                    .enumerate()
                    .any(|(index, day)| days[..index].contains(day))
            {
                bail!("weekdays must contain unique days from 0 to 6");
            }
        }
        Ok(())
    }

    pub fn next(&self, cadence: &str, after: i64) -> Option<i64> {
        self.next_in(cadence, after, &Local)
    }

    fn next_in<T: TimeZone>(&self, cadence: &str, after: i64, zone: &T) -> Option<i64> {
        if self.validate().is_err() || !matches!(cadence, "hourly" | "daily" | "weekly") {
            return None;
        }
        if cadence == "hourly" {
            return after.checked_add(3_600_000);
        }
        let first = after
            .div_euclid(60_000)
            .checked_add(1)?
            .checked_mul(60_000)?;
        let current = zone.timestamp_millis_opt(after).single()?;
        let passed_today = (current.hour(), current.minute()) >= (self.hour, self.minute);
        // Walk instants rather than constructing nonexistent local DST times.
        for offset in 0..(8 * 24 * 60) {
            let timestamp = first.checked_add(offset * 60_000)?;
            let local = zone.timestamp_millis_opt(timestamp).single()?;
            if local.minute() == self.minute
                && (!passed_today || local.date_naive() != current.date_naive())
                && local.hour() == self.hour
                && (cadence != "weekly"
                    || self.weekdays.as_ref().map_or_else(
                        || local.weekday().num_days_from_monday() == self.weekday,
                        |days| days.contains(&local.weekday().num_days_from_monday()),
                    ))
            {
                return Some(timestamp);
            }
        }
        None
    }

    /// The newest occurrence at or before `now` that may still be caught up.
    ///
    /// `armed` is the stored `nextRunAt` — the earliest occurrence this client
    /// has not consumed yet. Only occurrences at or after `armed` are
    /// candidates, the result is the single newest candidate, and a candidate
    /// older than `window_ms` is rejected. A long downtime therefore yields at
    /// most one catch-up instead of a replay of every missed occurrence.
    pub fn latest_missed(
        &self,
        cadence: &str,
        armed: i64,
        now: i64,
        window_ms: i64,
    ) -> Option<i64> {
        self.latest_missed_in(cadence, armed, now, window_ms, &Local)
    }

    fn latest_missed_in<T: TimeZone>(
        &self,
        cadence: &str,
        armed: i64,
        now: i64,
        window_ms: i64,
        zone: &T,
    ) -> Option<i64> {
        if window_ms <= 0 || armed > now || self.validate().is_err() {
            return None;
        }
        if cadence == "hourly" {
            // Elapsed-time cadence anchored at the armed instant: the newest
            // occurrence is one division away, however long the downtime was.
            let elapsed = now.checked_sub(armed)?;
            let candidate = armed.checked_add((elapsed / HOURLY_MS).checked_mul(HOURLY_MS)?)?;
            return (now.checked_sub(candidate)? <= window_ms).then_some(candidate);
        }
        if !matches!(cadence, "daily" | "weekly") {
            return None;
        }
        // Calendar cadences: start at the later of the armed instant and the
        // window floor, then walk forward to the newest occurrence at or before
        // `now`. The walk is bounded by the window rather than by the downtime,
        // so a year offline costs the same as a day.
        let start = armed.max(now.checked_sub(window_ms)?);
        let mut candidate = self.next_in(cadence, start.checked_sub(1)?, zone)?;
        if candidate > now {
            return None;
        }
        for _ in 0..MAX_CATCH_UP_WALK_STEPS {
            let Some(step) = self.next_in(cadence, candidate, zone) else {
                break;
            };
            if step > now {
                break;
            }
            candidate = step;
        }
        (now.checked_sub(candidate)? <= window_ms).then_some(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn daily_and_weekly_misses_reduce_to_the_newest_occurrence_in_the_window() {
        let schedule = Schedule {
            hour: 8,
            minute: 0,
            weekday: 0,
            weekdays: None,
        };
        let day = 86_400_000;
        let monday = Utc
            .with_ymd_and_hms(2026, 9, 21, 8, 0, 0)
            .unwrap()
            .timestamp_millis();
        // Three days offline with a one-day window: the newest miss, not three.
        let now = monday + 3 * day + 90 * 60_000;
        assert_eq!(
            schedule.latest_missed_in("daily", monday, now, day, &Utc),
            Some(monday + 3 * day)
        );
        // A miss that aged past the window is dropped instead of replayed.
        assert_eq!(
            schedule.latest_missed_in("daily", monday, now, 60 * 60_000, &Utc),
            None
        );
        // Weekly misses collapse the same way and never replay a backlog.
        let weekly = Schedule {
            hour: 9,
            minute: 0,
            weekday: 0,
            weekdays: None,
        };
        let monday9 = Utc
            .with_ymd_and_hms(2026, 9, 21, 9, 0, 0)
            .unwrap()
            .timestamp_millis();
        // Two hours late with a one-day window: the armed Monday is still the
        // newest miss and nothing newer exists yet.
        assert_eq!(
            weekly.latest_missed_in("weekly", monday9, monday9 + 2 * 3_600_000, day, &Utc),
            Some(monday9)
        );
        // Two days late with a one-day window: the miss aged out, and the next
        // Monday is still ahead, so nothing is replayed.
        assert_eq!(
            weekly.latest_missed_in("weekly", monday9, monday9 + 2 * day, day, &Utc),
            None
        );
    }

    #[test]
    fn hourly_misses_are_anchored_to_the_armed_instant() {
        let schedule = Schedule {
            hour: 9,
            minute: 0,
            weekday: 0,
            weekdays: None,
        };
        let armed = Utc
            .with_ymd_and_hms(2026, 9, 21, 10, 0, 0)
            .unwrap()
            .timestamp_millis();
        // Ten hours late with a three-hour window: only the newest miss.
        let now = armed + 10 * 3_600_000;
        assert_eq!(
            schedule.latest_missed_in("hourly", armed, now, 3 * 3_600_000, &Utc),
            Some(armed + 10 * 3_600_000)
        );
        // The next occurrence is still in the future, so nothing is missed yet.
        assert_eq!(
            schedule.latest_missed_in("hourly", armed, armed - 1, 3 * 3_600_000, &Utc),
            None
        );
        // A window smaller than one period cannot reach the newest miss.
        assert_eq!(
            schedule.latest_missed_in("hourly", armed, armed + 90_000, 60_000, &Utc),
            None
        );
    }

    #[test]
    fn latest_missed_requires_an_armed_calendar_cadence() {
        let schedule = Schedule {
            hour: 8,
            minute: 0,
            weekday: 0,
            weekdays: None,
        };
        let day = 86_400_000;
        assert!(schedule
            .latest_missed_in("manual", day * 10, day * 12, day, &Utc)
            .is_none());
        assert!(schedule
            .latest_missed_in("daily", day * 10, day * 12, 0, &Utc)
            .is_none());
        let invalid = Schedule {
            hour: 99,
            minute: 0,
            weekday: 0,
            weekdays: None,
        };
        assert!(invalid
            .latest_missed_in("daily", day * 10, day * 12, day, &Utc)
            .is_none());
    }

    #[test]
    fn weekly_selection_skips_unselected_days_and_wraps_the_week() {
        let mut schedule = Schedule {
            hour: 9,
            minute: 15,
            weekday: 0,
            weekdays: Some(vec![0, 2, 4]),
        };
        let monday = Utc
            .with_ymd_and_hms(2026, 9, 21, 9, 15, 0)
            .unwrap()
            .timestamp_millis();
        let day = 86_400_000;
        assert_eq!(schedule.next_in("weekly", monday - 1, &Utc), Some(monday));
        assert_eq!(
            schedule.next_in("weekly", monday, &Utc),
            Some(monday + 2 * day)
        );
        assert_eq!(
            schedule.next_in("weekly", monday + 4 * day, &Utc),
            Some(monday + 7 * day)
        );
        schedule.weekdays = Some(vec![5, 6]);
        assert_eq!(
            schedule.next_in("weekly", monday, &Utc),
            Some(monday + 5 * day)
        );
        assert_eq!(
            schedule.next_in("weekly", monday + 5 * day, &Utc),
            Some(monday + 6 * day)
        );
        schedule.weekdays = Some(vec![0, 1, 2, 3, 4]);
        assert_eq!(
            schedule.next_in("weekly", monday + 4 * day, &Utc),
            Some(monday + 7 * day)
        );
        schedule.weekdays = Some((0..7).collect());
        assert_eq!(schedule.next_in("weekly", monday, &Utc), Some(monday + day));
    }

    #[test]
    fn legacy_weekday_survives_and_invalid_day_selections_are_rejected() {
        let raw = serde_json::json!({"hour":9,"minute":15,"weekday":4});
        let legacy: Schedule = serde_json::from_value(raw.clone()).unwrap();
        assert!(legacy.weekdays.is_none());
        let monday = Utc
            .with_ymd_and_hms(2026, 9, 21, 9, 15, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            legacy.next_in("weekly", monday, &Utc),
            Some(monday + 4 * 86_400_000)
        );
        for days in [vec![], vec![0, 0], vec![7], vec![0, 1, 2, 3, 4, 5, 6, 0]] {
            let mut input = raw.clone();
            input["weekdays"] = serde_json::json!(days);
            let schedule: Schedule = serde_json::from_value(input).unwrap();
            assert!(schedule.validate().is_err());
            assert_eq!(schedule.next_in("weekly", monday, &Utc), None);
        }
    }

    #[test]
    fn hourly_waits_a_full_hour_independent_of_calendar_fields() {
        let schedule = Schedule {
            hour: 9,
            minute: 15,
            weekday: 0,
            weekdays: None,
        };
        let start = Utc
            .with_ymd_and_hms(2026, 9, 21, 10, 42, 37)
            .unwrap()
            .timestamp_millis()
            + 123;
        assert_eq!(
            schedule.next_in("hourly", start, &Utc),
            Some(start + 3_600_000)
        );
        assert_eq!(
            schedule.next_in("hourly", start + 3_600_000, &Utc),
            Some(start + 7_200_000)
        );
        assert_eq!(schedule.next_in("hourly", i64::MAX, &Utc), None);
    }

    #[cfg(unix)]
    #[test]
    fn daylight_saving_skips_missing_and_duplicate_daily_times() {
        // Isolate TZ in a child; changing the process environment during
        // parallel Rust tests would race chrono and unrelated filesystem tests.
        if std::env::var("PI_SCHEDULE_TZ_TEST").as_deref() != Ok("1") {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "scheduled::timing::tests::daylight_saving_skips_missing_and_duplicate_daily_times"])
                .env("TZ", "America/New_York")
                .env("PI_SCHEDULE_TZ_TEST", "1")
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            return;
        }
        let timestamp = |value: &str| {
            chrono::DateTime::parse_from_rfc3339(value)
                .unwrap()
                .timestamp_millis()
        };
        let spring = Schedule {
            hour: 2,
            minute: 30,
            weekday: 0,
            weekdays: None,
        };
        assert_eq!(
            spring.next("daily", timestamp("2026-03-08T06:00:00Z")),
            Some(timestamp("2026-03-09T06:30:00Z"))
        );
        let fall = Schedule {
            hour: 1,
            minute: 30,
            weekday: 0,
            weekdays: None,
        };
        assert_eq!(
            fall.next("daily", timestamp("2026-11-01T05:30:00Z")),
            Some(timestamp("2026-11-02T06:30:00Z"))
        );
        assert_eq!(
            fall.next("hourly", timestamp("2026-11-01T05:30:00Z")),
            Some(timestamp("2026-11-01T06:30:00Z"))
        );
    }

    #[test]
    fn next_occurrence_is_strictly_future_and_obeys_cadence() {
        let schedule = Schedule {
            hour: 9,
            minute: 15,
            weekday: 0,
            weekdays: None,
        };
        let monday = Utc
            .with_ymd_and_hms(2026, 9, 21, 9, 15, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            schedule.next_in("hourly", monday, &Utc),
            Some(monday + 3_600_000)
        );
        assert_eq!(
            schedule.next_in("daily", monday, &Utc),
            Some(monday + 86_400_000)
        );
        assert_eq!(
            schedule.next_in("weekly", monday, &Utc),
            Some(monday + 7 * 86_400_000)
        );
        assert_eq!(schedule.next_in("manual", monday, &Utc), None);
    }

    #[test]
    fn rejects_invalid_times_instead_of_silently_running() {
        assert!(Schedule {
            hour: 24,
            minute: 0,
            weekday: 0,
            weekdays: None,
        }
        .validate()
        .is_err());
        assert!(Schedule {
            hour: 9,
            minute: 60,
            weekday: 0,
            weekdays: None,
        }
        .validate()
        .is_err());
        assert!(Schedule {
            hour: 9,
            minute: 0,
            weekday: 7,
            weekdays: None,
        }
        .validate()
        .is_err());
    }
}
