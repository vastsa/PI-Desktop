import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
const host=new Host(resolveHostBinary(),await mkdtemp(join(tmpdir(),"pi-scheduled-legacy-")));
try {
  await host.start();await host.call("settings.set",{defaultPermissionMode:"auto"});
  const {session}=await host.call("session.create",{mode:"agent"});
  const tool=(toolName,args)=>host.call("tools.execute",{sessionId:session.id,toolName,args,mode:"agent",toolCallId:randomUUID()});
  for(const cadence of ["hourly","daily","weekly"]) {
    const id=randomUUID();await host.call("scheduled.import",{tasks:[{id,title:"Legacy",prompt:"Old",cadence}]});
    for(const fields of [{title:"Renamed"},{prompt:"Updated"},{enabled:false},{cadence,enabled:false}]) assert.equal((await tool("scheduled_task_update",{id,...fields})).ok,true);
    await host.restart();const saved=(await host.call("scheduled.list")).tasks.find(task=>task.id===id);
    assert.equal(saved.title,"Renamed");assert.equal(saved.prompt,"Updated");assert.equal(saved.enabled,false);assert.equal(saved.schedule,undefined);assert.equal(saved.nextRunAt,undefined);
    assert.equal((await tool("scheduled_task_update",{id,enabled:true})).errorCode,"INVALID_PARAMS");
    assert.equal((await tool("scheduled_task_update",{id,cadence,enabled:true,schedule:{hour:9,minute:15,weekday:0}})).ok,true);
    assert.equal((await tool("scheduled_task_delete",{id})).ok,true);
    console.log(`PASS ${cadence}: import, AI rename/prompt/pause, restart, guarded resume, configure and delete`);
  }
} finally {await host.stop();}
