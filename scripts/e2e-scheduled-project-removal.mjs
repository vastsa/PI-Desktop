import assert from "node:assert/strict";
import { mkdtemp,mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
const root=await mkdtemp(join(tmpdir(),"pi-scheduled-project-"));
const project=join(root,"project");await mkdir(project);
const host=new Host(resolveHostBinary(),join(root,"data"));
try {
  await host.start();await host.call("workspace.set",{path:project});
  const {task}=await host.call("scheduled.create",{title:"Review",prompt:"Reply OK",cadence:"hourly",schedule:{hour:0,minute:0,weekday:0}});
  const run=await host.call("scheduled.run",{id:task.id});
  await assert.rejects(host.call("projects.remove",{path:project}),error=>error.errorCode==="CONFLICT");
  await host.call("scheduled.finishRun",{runId:run.runId,status:"completed"});
  assert.equal((await host.call("projects.remove",{path:project})).removed,true);
  await host.restart();const saved=(await host.call("scheduled.list")).tasks.find(item=>item.id===task.id);
  assert.equal(saved.enabled,false);assert.equal(saved.workspacePath,task.workspacePath);assert.equal(saved.prompt,task.prompt);
  await host.call("scheduled.update",{id:task.id,configJson:{nextRunAt:Date.now()}});
  assert.ok(!(await host.call("scheduled.due")).ids.includes(task.id));
  await assert.rejects(host.call("scheduled.run",{id:task.id,automatic:true}),error=>error.errorCode==="SCHEDULE_NOT_DUE");
  const {runs}=await host.call("scheduled.listRuns",{taskId:task.id});assert.equal(runs[0].status,"completed");
  await host.call("scheduled.update",{id:task.id,enabled:true});
  assert.ok(Date.parse((await host.call("scheduled.list")).tasks.find(item=>item.id===task.id).nextRunAt)>Date.now());
  console.log("PASS admission blocks project removal; completed task survives paused with history; explicit resume rearms future only");
} finally {await host.stop();}
