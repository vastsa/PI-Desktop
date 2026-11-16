import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const data = mkdtempSync(join(tmpdir(), "pi-plugin-workspace-context-"));
process.env.PI_DESKTOP_DATA_DIR = join(data, "data");
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

async function fixture(t) {
  const root = mkdtempSync(join(data, "fixture-"));
  const { mkdirSync } = await import("node:fs");
  const a = join(root, "alpha"), b = join(root, "beta"), c = join(root, "visible");
  const sibling = join(root, "alpha-sibling"), revealed = [];
  for (const [dir, marker] of [[a,"alpha"],[b,"beta"],[c,"visible"],[sibling,"own-sibling"]]) {
    mkdirSync(dir); writeFileSync(join(dir,"marker.txt"), marker);
  }
  const plugin = join(root,"plugin"); mkdirSync(plugin);
  const permissions = ["agent.tool.register", "fs.read"];
  writeFileSync(join(plugin,"manifest.json"), JSON.stringify({ schemaVersion:1,
    id:"test.workspace.context", name:"Context", version:"0.0.1", main:"main.cjs", permissions,
    fs:{read:{root:"workspace",scope:["marker.txt"]}} }));
  writeFileSync(join(plugin,"main.cjs"), `
    async function inspect(args) { if (args?.reveal) await pi.fs.reveal(args.reveal); const workspace = await pi.workspace.get();
      return { workspace, marker: workspace && !workspace.path.startsWith('remote-project:') ? await pi.fs.readText('marker.txt') : null }; }
    module.exports = { onLoad: async () => pi.agent.registerTool({name:'inspect',description:'Inspect current project',schema:{type:'object'},execute:inspect}),
      onPanelInvoke:inspect };
  `);
  let visible = c, info = path => path == null ? null : ({ path, name:path.split('/').at(-1),
    projectId:path===a?'project-a':path===b?'project-b':'project-c',
    roots:[{path,name:path.split('/').at(-1),primary:true},...(path===a?[{path:sibling,name:'Sibling',primary:false}]:[])] });
  const sessions = new Map([['a',a],['b',b]]);
  const runtime = new PluginRuntime({ hostEntry, getWorkspacePath:()=>visible,
    getWorkspacePathForSession:id=>sessions.get(id) ?? null,
    getWorkspaceInfo:(path=visible)=>info(path),
    revealPath:async path=>{revealed.push(path);},
    spawnProcess({entry}) { const child = fork(entry,[],{stdio:['ignore','pipe','pipe','ipc']});
      return {postMessage:message=>{if(child.connected)child.send(message);},onMessage:handler=>child.on('message',handler),
        onExit:handler=>child.on('exit',code=>handler(code??0)),kill:()=>child.kill()}; },
  });
  t.after(async()=>{await runtime.unload('test.workspace.context');rmSync(root,{recursive:true,force:true});});
  await runtime.loadFromPath(plugin,permissions);
  const tool=runtime.getTools().find(tool=>tool.name==='inspect');assert.ok(tool);
  return {a,b,c,sibling,revealed,sessions,runtime,tool,setVisible:path=>{visible=path;},setInfo:fn=>{info=fn;}};
}

test('workspace metadata and filesystem agree for concurrent background project sessions', async t=>{
  const f=await fixture(t);
  const [a,b]=await Promise.all([f.tool.execute({sessionId:'b'},{sessionId:'a'}),f.tool.execute({sessionId:'a'},{sessionId:'b'})]);
  assert.equal(a.workspace.path,f.a);assert.equal(a.workspace.projectId,'project-a');assert.equal(a.marker,'alpha');
  assert.equal(b.workspace.path,f.b);assert.equal(b.workspace.projectId,'project-b');assert.equal(b.marker,'beta');
  assert.deepEqual(a.workspace.roots.map(root=>root.path),[f.a,f.sibling]);
  assert.deepEqual(b.workspace.roots.map(root=>root.path),[f.b]);
  f.setVisible(f.b);
  const again=await f.tool.execute({},{sessionId:'a'});assert.equal(again.workspace.path,f.a);assert.equal(again.marker,'alpha');
});

test('a tracked background project remains discoverable without a visible project',async t=>{
  const f=await fixture(t);f.setVisible(null);
  const a=await f.tool.execute({},{sessionId:'a'});assert.equal(a.workspace.path,f.a);assert.equal(a.marker,'alpha');
  assert.deepEqual(await f.runtime.invokePanelBridge('test.workspace.context','inspect'),{workspace:null,marker:null});
});

test('panel and unknown-session discovery preserve the visible workspace fallback',async t=>{
  const f=await fixture(t);
  for(const value of [await f.tool.execute({},{sessionId:'unknown'}),await f.runtime.invokePanelBridge('test.workspace.context','inspect')]){
    assert.equal(value.workspace.path,f.c);assert.equal(value.workspace.projectId,'project-c');assert.equal(value.marker,'visible');
  }
});

test('a legacy metadata provider cannot leak another project group into a tool workspace',async t=>{
  const f=await fixture(t);f.setInfo(()=>({path:f.c,name:'Visible',projectId:'wrong',roots:[{path:f.c,name:'Visible',primary:true}]}));
  const a=await f.tool.execute({},{sessionId:'a'});assert.deepEqual(a.workspace,{path:f.a,name:'alpha'});assert.equal(a.marker,'alpha');
});

test('remote session identity never becomes the visible local workspace',async t=>{
  const f=await fixture(t);const remote='remote-project:remote-alpha';f.sessions.set('remote',remote);
  f.setInfo(path=>path===remote?{path:remote,name:'Remote alpha',remote:{path:'/remote/alpha',readOnly:true}}:{path:f.c,name:'Visible'});
  const value=await f.tool.execute({},{sessionId:'remote'});
  assert.equal(value.workspace.path,remote);assert.equal(value.workspace.remote.path,'/remote/alpha');assert.equal(value.marker,null);
});

test('absolute reveal uses only the invoking project registered roots',async t=>{
  const f=await fixture(t);
  await f.tool.execute({reveal:join(f.sibling,'marker.txt')},{sessionId:'a'});
  assert.deepEqual(f.revealed,[realpathSync(join(f.sibling,'marker.txt'))]);
  await assert.rejects(f.tool.execute({reveal:join(f.c,'marker.txt')},{sessionId:'a'}));
  assert.equal(f.revealed.length,1);
});

test.after(()=>rmSync(data,{recursive:true,force:true}));
