import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
const host=new Host(resolveHostBinary(),await mkdtemp(join(tmpdir(),"pi-scheduled-calendar-")));
try {
  await host.start();await host.call("settings.set",{defaultPermissionMode:"auto"});
  const {session}=await host.call("session.create",{mode:"agent"});
  const tool=(toolName,args)=>host.call("tools.execute",{sessionId:session.id,toolName,args,mode:"agent",toolCallId:randomUUID()});
  for(const cadence of ["daily","weekly"]) {
    const created=await tool("scheduled_task_create",{title:"Review",prompt:"Reply OK",cadence:"manual",enabled:false});
    const id=created.content.task.id;
    assert.equal((await tool("scheduled_task_update",{id,cadence:"hourly"})).ok,true);
    await host.restart();
    const before=(await host.call("scheduled.list")).tasks.find(task=>task.id===id);
    assert.equal((await tool("scheduled_task_update",{id,cadence})).errorCode,"INVALID_PARAMS");
    assert.deepEqual((await host.call("scheduled.list")).tasks.find(task=>task.id===id),before);
    const schedule={hour:0,minute:0,weekday:0,weekdays:[0,2]};
    const explicit=await tool("scheduled_task_update",{id,cadence,schedule});assert.equal(explicit.ok,true);assert.equal(explicit.content.task.enabled,false);
    await tool("scheduled_task_update",{id,cadence:"hourly"});await host.restart();
    const restored=await tool("scheduled_task_update",{id,cadence});assert.equal(restored.ok,true);assert.deepEqual(restored.content.task.schedule,schedule);
    console.log(`PASS ${cadence}: reject implicit placeholder, accept explicit midnight, preserve calendar through Hourly/restart`);
  }
} finally {await host.stop();}
