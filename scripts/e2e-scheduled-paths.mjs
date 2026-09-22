import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root=await mkdtemp(join(tmpdir(),"pi-scheduled-paths-"));
const a=join(root,"a"),b=join(root,"b");await Promise.all([mkdir(a),mkdir(b)]);
const host=new Host(resolveHostBinary(),join(root,"data"));
const tool=(sessionId,toolName,args)=>host.call("tools.execute",{sessionId,toolName,args,mode:"agent",toolCallId:randomUUID()});
try {
  await host.start();await host.call("settings.set",{defaultPermissionMode:"auto"});
  for(const cadence of ["manual","hourly","daily","weekly"]) {
    await host.call("workspace.set",{path:a});
    const {task}=await host.call("scheduled.create",{title:"UI task",prompt:"Review",cadence,schedule:cadence==="manual"?null:{hour:9,minute:15,weekday:0}});
    const {session:owner}=await host.call("session.create",{mode:"agent",projectPath:a});
    const {session:foreign}=await host.call("session.create",{mode:"agent",projectPath:b});
    await host.restart();await host.call("workspace.set",{path:b});
    const listed=await tool(owner.id,"ScheduledTaskList",{});
    assert.ok(listed.content.tasks.some(item=>item.id===task.id));
    const hidden=await tool(foreign.id,"ScheduledTaskList",{});assert.ok(!hidden.content.tasks.some(item=>item.id===task.id));
    assert.equal((await tool(foreign.id,"ScheduledTaskDelete",{id:task.id})).errorCode,"NOT_FOUND");
    const updated=await tool(owner.id,"ScheduledTaskUpdate",{id:task.id,title:"Renamed"});assert.equal(updated.ok,true);
    const run=await host.call("scheduled.run",{id:task.id});const {session}=await host.call("session.get",{id:run.sessionId});
    assert.equal(session.projectPath,task.workspacePath);
    await host.call("scheduled.finishRun",{runId:run.runId,status:"completed"});
    assert.equal((await tool(owner.id,"ScheduledTaskDelete",{id:task.id})).ok,true);
    console.log(`PASS ${cadence}: UI create, restart, same-project AI CRUD, foreign rejection and Run now`);
  }
} finally {await host.stop();}
