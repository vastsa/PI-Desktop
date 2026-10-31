//! Bounded, process-local source-order records. Used under ToolBudget's mutex;
//! no filesystem access or asynchronous work is allowed in this module.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::file_resources::{is_file_tool, is_write, FileResources};

const MAX_CALLS: usize = 512;
const MAX_BATCH_CALLS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 32 * 1024 * 1024;
const UNUSED_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchCall {
    pub session_id: String,
    pub delegation_id: Option<String>,
    pub batch_id: String,
    pub ordinal: u32,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Value,
}

struct Slot {
    call: BatchCall,
    argument_bytes: usize,
    submitted: bool,
    running: bool,
    terminal: bool,
    resources: Option<Arc<FileResources>>,
}

struct Batch {
    session: String,
    delegation: Option<String>,
    tickets: Vec<String>,
    sealed: bool,
    closed: bool,
    created: Instant,
}

#[derive(Default)]
pub struct FileBatches {
    batches: HashMap<String, Batch>,
    slots: HashMap<String, Slot>,
    argument_bytes: usize,
}

impl FileBatches {
    pub fn register(&mut self, call: BatchCall) -> Result<String, &'static str> {
        self.sweep();
        if !is_file_tool(&call.tool_name)
            || call.ordinal > 100_000
            || [&call.session_id, &call.batch_id, &call.tool_call_id]
                .iter()
                .any(|s| s.is_empty() || s.len() > 256)
            || call
                .delegation_id
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 256)
            || !call.args.is_object()
        {
            return Err("invalid file batch call");
        }
        let bytes = serde_json::to_vec(&call.args)
            .map_err(|_| "invalid arguments")?
            .len();
        if self.slots.len() >= MAX_CALLS
            || self.argument_bytes.saturating_add(bytes) > MAX_ARGUMENT_BYTES
        {
            return Err("file batch registry is full");
        }
        let batch = self
            .batches
            .entry(call.batch_id.clone())
            .or_insert_with(|| Batch {
                session: call.session_id.clone(),
                delegation: call.delegation_id.clone(),
                tickets: Vec::new(),
                sealed: false,
                closed: false,
                created: Instant::now(),
            });
        if batch.session != call.session_id
            || batch.delegation != call.delegation_id
            || batch.sealed
            || batch.closed
            || batch.tickets.len() >= MAX_BATCH_CALLS
            || batch
                .tickets
                .last()
                .and_then(|t| self.slots.get(t))
                .is_some_and(|s| s.call.ordinal >= call.ordinal)
            || batch
                .tickets
                .iter()
                .filter_map(|t| self.slots.get(t))
                .any(|s| s.call.tool_call_id == call.tool_call_id)
        {
            return Err("file batch ownership or source order mismatch");
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        batch.tickets.push(ticket.clone());
        self.argument_bytes += bytes;
        self.slots.insert(
            ticket.clone(),
            Slot {
                call,
                argument_bytes: bytes,
                submitted: false,
                running: false,
                terminal: false,
                resources: None,
            },
        );
        Ok(ticket)
    }

    pub fn seal(&mut self, batch_id: &str, session: &str) -> Result<(), &'static str> {
        let batch = self
            .batches
            .get_mut(batch_id)
            .ok_or("file batch not found")?;
        if batch.session != session || batch.closed {
            return Err("file batch ownership mismatch");
        }
        batch.sealed = true;
        Ok(())
    }

    pub fn begin(
        &mut self,
        ticket: &str,
        session: &str,
        delegation: Option<&str>,
        id: &str,
        name: &str,
        args: &Value,
    ) -> Result<(), &'static str> {
        let slot = self
            .slots
            .get_mut(ticket)
            .ok_or("file batch ticket not found")?;
        let batch = self
            .batches
            .get(&slot.call.batch_id)
            .ok_or("file batch not found")?;
        if !batch.sealed
            || batch.closed
            || slot.submitted
            || slot.terminal
            || slot.call.session_id != session
            || slot.call.delegation_id.as_deref() != delegation
            || slot.call.tool_call_id != id
            || slot.call.tool_name != name
            || slot.call.args != *args
        {
            return Err("invalid, changed or already consumed file batch ticket");
        }
        slot.submitted = true;
        Ok(())
    }

    pub fn classify(&mut self, ticket: &str, resources: Arc<FileResources>) {
        if let Some(slot) = self.slots.get_mut(ticket) {
            slot.resources = Some(resources);
        }
    }

    pub fn can_run(&self, ticket: &str, claims: &FileResources) -> bool {
        let Some(slot) = self.slots.get(ticket) else {
            return false;
        };
        let Some(batch) = self.batches.get(&slot.call.batch_id) else {
            return false;
        };
        if slot.terminal || !slot.submitted {
            return false;
        }
        batch
            .tickets
            .iter()
            .take_while(|t| t.as_str() != ticket)
            .all(|t| {
                self.slots.get(t).is_none_or(|prior| {
                    prior.terminal
                        || match &prior.resources {
                            Some(resources) => !resources.conflicts(claims),
                            None => !is_write(&prior.call.tool_name) && !claims.exclusive,
                        }
                })
            })
    }

    pub fn precedes(&self, first: &str, second: &str) -> bool {
        match (self.slots.get(first), self.slots.get(second)) {
            (Some(a), Some(b)) => {
                a.call.batch_id == b.call.batch_id && a.call.ordinal < b.call.ordinal
            }
            _ => false,
        }
    }

    pub fn start(&mut self, ticket: &str) {
        if let Some(slot) = self.slots.get_mut(ticket) {
            slot.running = true;
        }
    }

    /// The execution permit alone can complete a running slot. Dropping the
    /// transport waiter or closing a batch never releases active disk work.
    pub fn finish(&mut self, ticket: &str, execution_finished: bool) {
        if let Some(slot) = self.slots.get_mut(ticket) {
            if !slot.running || execution_finished {
                slot.terminal = true;
                slot.resources = None;
            }
        }
        self.collect_closed();
    }

    pub fn abandon(&mut self, ticket: &str, session: &str) -> Result<(), &'static str> {
        let slot = self
            .slots
            .get(ticket)
            .ok_or("file batch ticket not found")?;
        if slot.call.session_id != session {
            return Err("file batch ownership mismatch");
        }
        if !slot.submitted {
            self.finish(ticket, false);
        }
        Ok(())
    }

    pub fn close(&mut self, batch_id: &str, session: &str) -> Result<(), &'static str> {
        let Some(batch) = self.batches.get_mut(batch_id) else {
            return Ok(());
        };
        if batch.session != session {
            return Err("file batch ownership mismatch");
        }
        batch.closed = true;
        for ticket in &batch.tickets {
            if let Some(slot) = self.slots.get_mut(ticket) {
                if !slot.submitted {
                    slot.terminal = true;
                    slot.resources = None;
                }
            }
        }
        self.collect_closed();
        Ok(())
    }

    fn collect_closed(&mut self) {
        self.batches.retain(|_, batch| {
            let collect = batch.closed
                && batch
                    .tickets
                    .iter()
                    .all(|t| self.slots.get(t).is_none_or(|s| s.terminal));
            if collect {
                for t in &batch.tickets {
                    if let Some(slot) = self.slots.remove(t) {
                        self.argument_bytes -= slot.argument_bytes;
                    }
                }
            }
            !collect
        });
    }

    fn sweep(&mut self) {
        for batch in self.batches.values_mut() {
            if batch.created.elapsed() > UNUSED_TTL
                && batch
                    .tickets
                    .iter()
                    .all(|t| self.slots.get(t).is_none_or(|s| !s.submitted || s.terminal))
            {
                batch.closed = true;
                for ticket in &batch.tickets {
                    if let Some(slot) = self.slots.get_mut(ticket) {
                        slot.terminal = true;
                        slot.resources = None;
                    }
                }
            }
        }
        self.collect_closed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn call(ordinal: u32, name: &str) -> BatchCall {
        BatchCall {
            session_id: "s".into(),
            delegation_id: None,
            batch_id: "b".into(),
            ordinal,
            tool_call_id: ordinal.to_string(),
            tool_name: name.into(),
            args: json!({"path":"a"}),
        }
    }
    #[test]
    fn unknown_predecessor_and_reversed_execution_cannot_reorder_writes() {
        let mut registry = FileBatches::default();
        let first = registry.register(call(0, "Read")).unwrap();
        let second_call = call(1, "Write");
        let second = registry.register(second_call.clone()).unwrap();
        registry.seal("b", "s").unwrap();
        registry
            .begin(&second, "s", None, "1", "Write", &second_call.args)
            .unwrap();
        assert!(!registry.can_run(&second, &FileResources::fence(true)));
        registry.finish(&first, false);
        assert!(registry.can_run(&second, &FileResources::fence(true)));
    }
    #[test]
    fn validates_binding_sealing_replay_and_running_cleanup() {
        let mut r = FileBatches::default();
        let c = call(0, "Write");
        let t = r.register(c.clone()).unwrap();
        assert!(r.begin(&t, "s", None, "0", "Write", &c.args).is_err());
        r.seal("b", "s").unwrap();
        assert!(r.begin(&t, "other", None, "0", "Write", &c.args).is_err());
        assert!(r
            .begin(&t, "s", Some("other-delegate"), "0", "Write", &c.args)
            .is_err());
        assert!(r
            .begin(&t, "s", None, "other-call", "Write", &c.args)
            .is_err());
        assert!(r.begin(&t, "s", None, "0", "Read", &c.args).is_err());
        assert!(r
            .begin(&t, "s", None, "0", "Write", &json!({"path":"changed"}))
            .is_err());
        r.begin(&t, "s", None, "0", "Write", &c.args).unwrap();
        assert!(r.begin(&t, "s", None, "0", "Write", &c.args).is_err());
        r.start(&t);
        r.close("b", "s").unwrap();
        r.finish(&t, false);
        assert!(!r.slots[&t].terminal);
        r.finish(&t, true);
        assert!(r.slots.is_empty());
    }

    #[test]
    fn bounded_registry_reclaims_closed_calls_and_preserves_live_approvals() {
        let mut r = FileBatches::default();
        for index in 0..MAX_BATCH_CALLS {
            r.register(call(index as u32, "Read")).unwrap();
        }
        assert!(r.register(call(MAX_BATCH_CALLS as u32, "Read")).is_err());
        r.close("b", "s").unwrap();
        assert!(r.slots.is_empty());
        assert_eq!(r.argument_bytes, 0);
        let c = call(0, "Write");
        let t = r.register(c.clone()).unwrap();
        r.seal("b", "s").unwrap();
        r.begin(&t, "s", None, "0", "Write", &c.args).unwrap();
        r.batches.get_mut("b").unwrap().created =
            Instant::now() - UNUSED_TTL - Duration::from_secs(1);
        r.sweep();
        assert!(
            !r.slots[&t].terminal,
            "an indefinite permission wait must not expire"
        );
        r.finish(&t, false);
        r.close("b", "s").unwrap();
        assert!(r.slots.is_empty());
    }

    #[test]
    fn source_registration_rejects_unknown_tools_and_duplicate_ordinals() {
        let mut r = FileBatches::default();
        assert!(r.register(call(0, "plugin_Read")).is_err());
        r.register(call(0, "Read")).unwrap();
        assert!(r.register(call(0, "Write")).is_err());
        r.seal("b", "s").unwrap();
        assert!(r.register(call(1, "Write")).is_err());
    }
}
