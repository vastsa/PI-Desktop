//! In-memory per-session snapshot store (spec 18 §4).

use super::tag::{NormalizedFile, split_lines};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const MAX_PATHS_PER_SESSION: usize = 64;
const MAX_VERSIONS_PER_PATH: usize = 4;
const MAX_RETAINED_BYTES: usize = 8 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_NAMED_REGISTERS: usize = 16;

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub text: String,
    pub tag: String,
    pub recorded_at: Instant,
    pub seen_lines: Option<BTreeSet<u32>>,
    pub retained: bool,
}

#[derive(Debug, Clone)]
pub struct Register {
    pub lines: Vec<String>,
}

struct PathHistory {
    versions: VecDeque<Snapshot>,
}

struct SessionData {
    paths: HashMap<String, PathHistory>,
    lru: VecDeque<String>,
    registers: HashMap<String, Register>,
    register_lru: VecDeque<String>,
    retained_bytes: usize,
}

impl SessionData {
    fn new() -> Self {
        Self {
            paths: HashMap::new(),
            lru: VecDeque::new(),
            registers: HashMap::new(),
            register_lru: VecDeque::new(),
            retained_bytes: 0,
        }
    }

    fn touch_path(&mut self, key: &str) {
        self.lru.retain(|p| p != key);
        self.lru.push_back(key.to_string());
    }

    fn evict_while_over(&mut self) {
        while self.paths.len() > MAX_PATHS_PER_SESSION || self.retained_bytes > MAX_RETAINED_BYTES {
            let Some(cold) = self.lru.pop_front() else {
                break;
            };
            if let Some(history) = self.paths.remove(&cold) {
                for snap in history.versions {
                    if snap.retained {
                        self.retained_bytes = self.retained_bytes.saturating_sub(snap.text.len());
                    }
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct HashlineStore {
    inner: Arc<Mutex<HashMap<String, SessionData>>>,
}

impl Default for HashlineStore {
    fn default() -> Self {
        Self::new()
    }
}

impl HashlineStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn drop_session(&self, session_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(session_id);
        }
    }

    pub fn drop_all(&self) {
        if let Ok(mut map) = self.inner.lock() {
            map.clear();
        }
    }

    pub fn invalidate_path(&self, session_id: &str, canonical_path: &str) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let Some(session) = map.get_mut(session_id) else {
            return;
        };
        if let Some(history) = session.paths.remove(canonical_path) {
            for snap in history.versions {
                if snap.retained {
                    session.retained_bytes = session.retained_bytes.saturating_sub(snap.text.len());
                }
            }
            session.lru.retain(|p| p != canonical_path);
        }
    }

    /// Record a version. Returns the tag. `seen_lines == None` means unknown
    /// (skip provenance). `Some(empty)` means nothing seen.
    pub fn record(
        &self,
        session_id: &str,
        canonical_path: &str,
        file: &NormalizedFile,
        tag: &str,
        seen_lines: Option<BTreeSet<u32>>,
    ) -> String {
        let Ok(mut map) = self.inner.lock() else {
            return tag.to_string();
        };
        let session = map
            .entry(session_id.to_string())
            .or_insert_with(SessionData::new);
        session.touch_path(canonical_path);

        let retain = file.text.len() <= MAX_SINGLE_FILE_BYTES;
        let history = session
            .paths
            .entry(canonical_path.to_string())
            .or_insert_with(|| PathHistory {
                versions: VecDeque::new(),
            });

        if let Some(existing) = history
            .versions
            .iter_mut()
            .find(|snap| snap.tag == tag && snap.text == file.text)
        {
            existing.recorded_at = Instant::now();
            match (&mut existing.seen_lines, seen_lines) {
                (Some(set), Some(extra)) => {
                    set.extend(extra);
                }
                (None, Some(extra)) => existing.seen_lines = Some(extra),
                _ => {}
            }
            return tag.to_string();
        }

        let stored_text = if retain {
            file.text.clone()
        } else {
            String::new()
        };
        if retain {
            session.retained_bytes = session.retained_bytes.saturating_add(stored_text.len());
        }
        history.versions.push_front(Snapshot {
            text: stored_text,
            tag: tag.to_string(),
            recorded_at: Instant::now(),
            seen_lines,
            retained: retain,
        });
        while history.versions.len() > MAX_VERSIONS_PER_PATH {
            if let Some(dropped) = history.versions.pop_back() {
                if dropped.retained {
                    session.retained_bytes =
                        session.retained_bytes.saturating_sub(dropped.text.len());
                }
            }
        }
        session.evict_while_over();
        tag.to_string()
    }

    pub fn latest_matching_text(
        &self,
        session_id: &str,
        canonical_path: &str,
        text: &str,
    ) -> Option<Snapshot> {
        let map = self.inner.lock().ok()?;
        let session = map.get(session_id)?;
        let history = session.paths.get(canonical_path)?;
        history
            .versions
            .iter()
            .find(|snap| snap.retained && snap.text == text)
            .cloned()
    }

    pub fn lookup_tag(
        &self,
        session_id: &str,
        canonical_path: &str,
        tag: &str,
    ) -> Option<Snapshot> {
        let map = self.inner.lock().ok()?;
        let session = map.get(session_id)?;
        let history = session.paths.get(canonical_path)?;
        history
            .versions
            .iter()
            .find(|snap| snap.tag.eq_ignore_ascii_case(tag))
            .cloned()
    }

    pub fn merge_seen_lines(
        &self,
        session_id: &str,
        canonical_path: &str,
        text: &str,
        extra: &BTreeSet<u32>,
    ) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let Some(session) = map.get_mut(session_id) else {
            return;
        };
        let Some(history) = session.paths.get_mut(canonical_path) else {
            return;
        };
        if let Some(snap) = history
            .versions
            .iter_mut()
            .find(|snap| snap.retained && snap.text == text)
        {
            match &mut snap.seen_lines {
                Some(set) => set.extend(extra.iter().copied()),
                None => snap.seen_lines = Some(extra.clone()),
            }
        }
    }

    pub fn put_register(&self, session_id: &str, name: &str, lines: Vec<String>) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let session = map
            .entry(session_id.to_string())
            .or_insert_with(SessionData::new);
        session.register_lru.retain(|n| n != name);
        session.register_lru.push_back(name.to_string());
        session
            .registers
            .insert(name.to_string(), Register { lines });
        while session.registers.len() > MAX_NAMED_REGISTERS {
            if let Some(cold) = session.register_lru.pop_front() {
                session.registers.remove(&cold);
            } else {
                break;
            }
        }
    }

    pub fn get_register(&self, session_id: &str, name: &str) -> Option<Register> {
        let map = self.inner.lock().ok()?;
        map.get(session_id)?.registers.get(name).cloned()
    }

    #[allow(dead_code)]
    pub fn find_unique_basename_tag(
        &self,
        session_id: &str,
        basename: &str,
        tag: &str,
        exclude_path: &str,
    ) -> Option<String> {
        let map = self.inner.lock().ok()?;
        let session = map.get(session_id)?;
        let mut hits: Vec<&String> = session
            .paths
            .keys()
            .filter(|path| {
                path.as_str() != exclude_path
                    && path.rsplit('/').next() == Some(basename)
                    && session.paths[*path]
                        .versions
                        .iter()
                        .any(|snap| snap.tag.eq_ignore_ascii_case(tag))
            })
            .collect();
        if hits.len() == 1 {
            hits.pop().cloned()
        } else {
            None
        }
    }

    #[allow(dead_code)]
    pub fn line_count(text: &str) -> usize {
        split_lines(text).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::hashline::tag::{normalize_file, tag_of_lf_text};

    #[test]
    fn record_unions_seen_lines_on_same_text() {
        let store = HashlineStore::new();
        let file = normalize_file(b"a\nb\nc\n");
        let tag = tag_of_lf_text(&file.text);
        store.record("s", "/ws/f.txt", &file, &tag, Some(BTreeSet::from([1, 2])));
        store.record("s", "/ws/f.txt", &file, &tag, Some(BTreeSet::from([2, 3])));
        let snap = store
            .latest_matching_text("s", "/ws/f.txt", &file.text)
            .unwrap();
        assert_eq!(snap.seen_lines.unwrap(), BTreeSet::from([1, 2, 3]));
    }

    #[test]
    fn drop_session_forgets_snapshots() {
        let store = HashlineStore::new();
        let file = normalize_file(b"x\n");
        let tag = tag_of_lf_text(&file.text);
        store.record("s", "/ws/f.txt", &file, &tag, Some(BTreeSet::from([1])));
        store.drop_session("s");
        assert!(store.lookup_tag("s", "/ws/f.txt", &tag).is_none());
    }
}
