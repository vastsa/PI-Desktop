import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openReviewedFile } from "../electron/main/reviewed-file-open.ts";

async function fixture(t) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "review-open-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir,"outside.txt"); await writeFile(path,"controlled test\n");
  const calls = { opened: [], revealed: [], targets: [] };
  let current = true;
  const deps = { target: async (...args) => { calls.targets.push(args); return {path}; }, isCurrent: () => current,
    stripPrefix: path => path.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/,""),
    openPath: async path => { calls.opened.push(path); return ""; }, reveal: path => calls.revealed.push(path) };
  return {path,calls,deps,setCurrent:value=>{current=value;}};
}
test("review external open and folder reveal use only host-authenticated snapshot target",async t=>{
  const f=await fixture(t);
  await openReviewedFile({sessionId:"s",snapshotId:"snapshot",action:"external"},f.deps);
  await openReviewedFile({sessionId:"s",snapshotId:"snapshot",action:"folder"},f.deps);
  assert.deepEqual(f.calls.targets,[["s","snapshot"],["s","snapshot"]]);
  assert.deepEqual(f.calls.opened,[f.path]);assert.deepEqual(f.calls.revealed,[f.path]);
});
test("raw paths, invalid actions, missing snapshots and replaced hosts cannot reach the shell",async t=>{
  const f=await fixture(t);
  for(const value of [{sessionId:"s",snapshotId:"x",action:"external",path:f.path},{sessionId:"s",snapshotId:"x",action:"internal"},{sessionId:"s",action:"folder"}]) await assert.rejects(openReviewedFile(value,f.deps));
  f.setCurrent(false);await assert.rejects(openReviewedFile({sessionId:"s",snapshotId:"x",action:"external"},f.deps),/replaced/);
  assert.deepEqual(f.calls.opened,[]);assert.deepEqual(f.calls.revealed,[]);
});
test("removed files and directories are not openable review files",async t=>{
  const f=await fixture(t);await rm(f.path);await mkdir(f.path);
  await assert.rejects(openReviewedFile({sessionId:"s",snapshotId:"x",action:"folder"},f.deps));
  await rm(f.path,{recursive:true});await assert.rejects(openReviewedFile({sessionId:"s",snapshotId:"x",action:"external"},f.deps));
  assert.deepEqual(f.calls.opened,[]);assert.deepEqual(f.calls.revealed,[]);
});
test("OS open failure is observable",async t=>{
  const f=await fixture(t);f.deps.openPath=async()=>"No default application";
  await assert.rejects(openReviewedFile({sessionId:"s",snapshotId:"x",action:"external"},f.deps),/No default application/);
});
