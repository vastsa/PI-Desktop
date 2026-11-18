import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadModeDefinitions } from "../packages/agent-runtime/dist/mode-definitions.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch, "Set PI_SCRATCH_DIR to an isolated test-artifact directory");
const source = `---
name: goal-3
label: Goal 3
permission: agent
budget:
  maxTurns: 20
stages:
  work:
    permission: agent
    loop: true
    prompt: Verify the objective with evidence before completing the stage.
---
Work only within the current authorized goal.
`;
const loaded = loadModeDefinitions({ userDocuments: [{ dirName: "goal-3", filePath: "goal-3/mode.md", source, templates: {} }] });
assert.deepEqual(loaded.diagnostics, []);
const modeSnapshot = loaded.definitions.find((mode) => mode.id === "goal-3");
assert.ok(modeSnapshot?.stages[0]?.loop);
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

for (const [version, constrained] of [[31, true], [32, false], [32, true]]) {
  const scenario = fs.mkdtempSync(path.join(scratch, "legacy-goal-upgrade-"));
  const data = path.join(scenario, "data");
  const workspace = path.join(scenario, "workspace");
  const agents = path.join(scenario, "agents");
  for (const dir of [data, workspace, agents]) fs.mkdirSync(dir);
  const host = new Host(resolveHostBinary(), data, { env: { PI_DESKTOP_AGENTS_DIR: agents }, quiet: true });
  const file = path.join(data, "pi.sqlite");
  let db;
  try {
    await host.start();
    await host.call("workspace.set", { path: workspace });
    const { session } = await host.call("session.create", { mode: "agent", title: "Saved fixture" });
    const { turnId: savedTurn } = await host.call("session.beginTurn", { sessionId: session.id });
    await host.call("session.endTurn", { turnId: savedTurn, status: "completed", createNotification: false });
    await host.stop();
    db = new DatabaseSync(file);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 33);
    db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN;");
    if (constrained) {
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql;
      const column = "mode        TEXT NOT NULL DEFAULT 'agent'";
      assert.equal(sql.split(column).length, 2);
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='sessions' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      const legacy = sql.replace(column, `${column} CHECK(mode IN ('agent','plan','goal'))`);
      db.exec("CREATE TABLE sessions_legacy " + legacy.slice(legacy.indexOf("(")));
      db.exec("INSERT INTO sessions_legacy SELECT * FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_legacy RENAME TO sessions;");
      for (const object of objects) db.exec(object.sql);
    }
    db.exec(`
      CREATE TABLE goal_turns(turn_id TEXT PRIMARY KEY);
      CREATE TABLE turn_execution(
        turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('agent','plan','goal')),
        goal_claim_id TEXT UNIQUE REFERENCES goal_turns(turn_id),
        provenance TEXT CHECK(provenance IN ('user-goal','goal-continuation')),
        CHECK((goal_claim_id IS NULL AND provenance IS NULL) OR
              (goal_claim_id IS NOT NULL AND provenance IS NOT NULL AND mode='goal'))
      );
      CREATE TRIGGER turn_execution_snapshot AFTER INSERT ON turns
      BEGIN
        INSERT INTO turn_execution(turn_id,mode)
        SELECT NEW.id,mode FROM sessions WHERE id=NEW.session_id;
      END;
    `);
    db.prepare("INSERT INTO turn_execution(turn_id,mode) VALUES(?,'agent')").run(savedTurn);
    db.exec(`PRAGMA user_version=${version}; COMMIT;`);
    const retained = db.prepare("SELECT * FROM turn_execution").all();
    db.close(); db = undefined;

    await host.start();
    const selected = await host.call("session.configure", { id: session.id, mode: "goal-3", modeSnapshot });
    assert.equal(selected.session.mode, "goal-3");
    const { turnId } = await host.call("session.beginTurn", { sessionId: session.id });
    const ended = await host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
    assert.equal(ended.ok, true);
    const created = await host.call("session.create", { mode: "goal-3", modeSnapshot });
    assert.equal(created.session.mode, "goal-3");
    await host.stop();
    db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 33);
    assert.deepEqual(db.prepare("SELECT * FROM turn_execution").all(), retained);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='turn_execution_snapshot'").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close(); db = undefined;
    const backup = file + ".v32.bak";
    db = new DatabaseSync(backup, { readOnly: true });
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 32);
    assert.deepEqual(db.prepare("SELECT * FROM turn_execution").all(), retained);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='turn_execution_snapshot'").get().n, 1);
    db.close(); db = undefined;
    const backupHash = digest(backup);
    await host.start();
    assert.equal((await host.call("session.get", { id: session.id, messageLimit: 1 })).session.mode, "goal-3");
    await host.stop();
    assert.equal(digest(backup), backupHash);
    console.log(`PASS schema ${version}, sessions CHECK ${constrained}: upgrade, staged custom mode turn, historical ledger, backup and restart. Artifacts: ${scenario}`);
  } finally {
    db?.close();
    await host.stop();
  }
}
