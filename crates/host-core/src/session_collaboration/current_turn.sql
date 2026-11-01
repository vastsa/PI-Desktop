CREATE TABLE IF NOT EXISTS session_collaboration_current_turn (
  message_id TEXT PRIMARY KEY REFERENCES session_collaboration_messages(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('offered', 'accepted', 'fallback')),
  request_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((state = 'accepted') = (request_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_collaboration_current_turn
  ON session_collaboration_current_turn(turn_id, state, request_id);
