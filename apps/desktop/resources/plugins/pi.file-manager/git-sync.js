"use strict";
// Fixed Git operations for the host-selected local folder. No shell, caller URL,
// raw Git diagnostics, interactive authentication or repository-supplied helpers.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const error = (code, message) => Object.assign(new Error(message), { code });
const layout = () => error("GIT_LAYOUT", "Select an ordinary repository root. Use Git directly for nested repositories, linked metadata or ongoing operations.");
const config = () => error("GIT_CONFIG", "Unsupported Git configuration. Use Git directly or configure a standard HTTPS/SSH remote without credentials, includes, custom helpers or refspecs.");
const stale = () => error("GIT_STALE", "The project, branch, remote or reviewed commit changed. Refresh and review again.");
const limit = () => error("GIT_LIMIT", "Git exceeded the panel’s size or time limit. Use Git directly for this repository.");
const protectedPath = () => error("GIT_PROTECTED", "History includes a protected path, link, submodule or nested workspace. Review it and sync in Git directly.");
const oid = s => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
const branchName = s => typeof s === "string" && s.length <= 240 && s !== "HEAD" && s.split("/").every(p => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && !p.includes("..") && !p.endsWith(".") && !p.endsWith(".lock"));
const remoteName = s => branchName(s) && !s.includes("/");
const inside = (dir, file) => { const rel = path.relative(dir, file); return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep); };
const stat = f => fs.lstat(f).catch(e => { if (e.code === "ENOENT") return null; throw layout(); });
const actionNames = new Set(["init", "fetch", "pull", "pullRebase", "push", "forcePush"]);

// A deliberately small URL grammar: no helper syntax, option-like SSH hosts,
// userinfo over HTTPS, passwords, escaping, query strings or shell metacharacters.
function safeUrl(s) {
  if (s.length > 2048) return false;
  const host = "[A-Za-z0-9][A-Za-z0-9.-]*", user = "(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?";
  const m = new RegExp(`^(?:https://${host}(?::[0-9]{1,5})?/|ssh://${user}${host}(?::[0-9]{1,5})?/|${user}${host}:/?)([A-Za-z0-9_][A-Za-z0-9._/-]*)$`).exec(s);
  return !!m && !/^[A-Za-z]:/.test(s) && m[1].split("/").every(p => p && p !== "." && p !== "..");
}

// Positive list, not a blacklist of today's command-executing config keys. Git
// parses its own config syntax with includes OFF; reject duplicate/unknown keys.
function parseConfig(raw) {
  const values = new Map(), remotes = new Set();
  for (const row of raw.split("\0").filter(Boolean)) {
    const split = row.indexOf("\n"), key = row.slice(0, split), v = row.slice(split + 1);
    if (split < 1 || values.has(key) || /[\x00-\x1f\x7f]/.test(v)) throw config();
    let m;
    if (key === "core.repositoryformatversion" && v === "0" || key === "core.bare" && v === "false" ||
        /^core\.(?:filemode|logallrefupdates|symlinks|ignorecase|precomposeunicode)$/.test(key) && /^(true|false)$/i.test(v) ||
        /^(?:user\.(?:name|email)|branch\..+\.vscode-merge-base)$/.test(key)) { /* inert */ }
    else if ((m = /^remote\.(.+)\.(url|pushurl|fetch)$/.exec(key)) && remoteName(m[1])) {
      if (m[2] === "fetch" ? v !== `+refs/heads/*:refs/remotes/${m[1]}/*` : !safeUrl(v)) throw config();
      remotes.add(m[1]);
    } else if ((m = /^branch\.(.+)\.(remote|pushremote|merge|rebase)$/.exec(key)) && branchName(m[1])) {
      if (m[2] === "merge" ? !(v.startsWith("refs/heads/") && branchName(v.slice(11))) : m[2] === "rebase" ? !/^(true|false)$/.test(v) : !remoteName(v)) throw config();
    } else if (!(key === "remote.pushdefault" && remoteName(v))) throw config();
    values.set(key, v);
  }
  if (remotes.size > 32 || [...remotes].some(r => !values.has(`remote.${r}.url`))) throw config();
  return { values, remotes: [...remotes].sort() };
}

async function runner(root) {
  const win = process.platform === "win32", exe = win ? "git.exe" : "git";
  const dirs = [...new Set([...(process.env.PATH || "").split(path.delimiter), ...(win ? ["C:\\Program Files\\Git\\cmd"] : ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"])])];
  const safeDirs = [];
  for (const dir of dirs.slice(0, 128)) {
    if (!path.isAbsolute(dir)) continue;
    const real = await fs.realpath(dir).catch(() => null);
    if (real && !inside(root, real)) safeDirs.push(real);
  }
  let binary;
  for (const dir of safeDirs) {
    const candidate = await fs.realpath(path.join(dir, exe)).catch(() => null);
    if (candidate && !inside(root, candidate) && (await stat(candidate))?.isFile()) { binary = candidate; break; }
  }
  if (!binary) throw error("GIT_UNAVAILABLE", "Install Git on the desktop host and reopen the panel.");
  const env = { PATH: safeDirs.join(path.delimiter), LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
    HOME: "/dev/null", USERPROFILE: "/dev/null", XDG_CONFIG_HOME: "/dev/null", SSH_ASKPASS_REQUIRE: "never", GIT_SSH_VARIANT: "ssh", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false",
    NoDefaultCurrentDirectoryInExePath: "1" };
  for (const k of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "SSH_AUTH_SOCK"]) if (process.env[k]) env[k] = process.env[k];
  // A fixed OpenSSH invocation. Do not interpret a project's host as an SSH
  // config alias/Match exec; require an already known host and noninteractive key.
  const ssh = win ? `${process.env.SystemRoot || "C:\\Windows"}/System32/OpenSSH/ssh.exe`.replaceAll("\\", "/") : "/usr/bin/ssh";
  env.GIT_SSH_COMMAND = `'${ssh.replaceAll("'", "'\\''")}' -F none -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no -o ConnectTimeout=10`;
  const flags = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "credential.helper=", "http.followRedirects=false", "gc.auto=0", "maintenance.auto=false", "submodule.recurse=false", "protocol.version=2", "fetch.negotiationAlgorithm=noop", "fetch.fsckObjects=true", "transfer.fsckObjects=true"].flatMap(v => ["-c", v]);
  return (args, { network = false, allowed = [0], message = "Git could not complete this operation. Inspect the repository in Git directly." } = {}) => new Promise((resolve, reject) => {
    const { spawn } = require("node:child_process");
    const child = spawn(binary, [...flags, ...args], { cwd: path.dirname(binary), env: { ...env, GIT_ALLOW_PROTOCOL: network ? "https:ssh" : "" }, detached: !win, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let bytes = 0, done = false; const chunks = [];
    const stop = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (child.pid && win) {
        const killer = spawn(path.join(env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill()); killer.unref();
      } else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
      child.stdout.destroy(); reject(limit());
    };
    const timer = setTimeout(stop, network ? 45000 : 8000);
    child.stdout.on("data", b => { if ((bytes += b.length) > 2 * 1024 * 1024) stop(); else chunks.push(b); });
    child.on("error", () => { clearTimeout(timer); done = true; reject(error("GIT_UNAVAILABLE", "Git could not start on this host.")); });
    child.on("close", code => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (!allowed.includes(code)) return reject(error("GIT_FAILED", message));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

// Walk without following links. Fail closed on an expensive tree. Plain init
// must not wrap an existing nested repository; sync must not write via external
// metadata (linked worktrees, symlinks, alternates or a pre-existing sequencer).
async function inspectTree(dir, metadata) {
  const dirRoot = dir, dirs = [dir], deadline = Date.now() + 6000; let count = 0;
  while (dirs.length) {
    const parent = dirs.pop();
    for await (const e of await fs.opendir(parent)) {
      if (++count > 50000 || Date.now() > deadline) throw limit();
      const file = path.join(parent, e.name), rel = path.relative(dir, file).split(path.sep).join("/").toLowerCase();
      if (!metadata && (e.name.toLowerCase() === ".git" || e.name === "HEAD" && await stat(path.join(parent, "objects")))) throw layout();
      if (metadata && (!e.isFile() && !e.isDirectory() || /^(?:commondir|config\.worktree|shallow|worktrees|remotes|branches\/.+|modules|rebase-merge|rebase-apply|sequencer|merge_head|cherry_pick_head|revert_head|info\/grafts|objects\/info\/(?:http-)?alternates)$/.test(rel))) throw layout();
      if (metadata && e.isFile()) {
        const st = await stat(file);
        if (!st?.isFile() || st.nlink !== 1) throw layout();
        // Only a remote's ordinary HEAD alias may be symbolic. Other loose
        // symbolic refs can redirect a tracking update into a local branch.
        if (rel.startsWith("refs/")) {
          if (st.size > 1024) throw layout();
          const v = (await fs.readFile(file, "utf8")).trimEnd(), dir = path.relative(dirRoot, parent).split(path.sep).join("/");
          if (!oid(v) && !(e.name === "HEAD" && /^refs\/remotes\/[^/]+$/.test(dir) && v.startsWith(`ref: ${dir}/`) && branchName(v.slice(dir.length + 6)))) throw layout();
        }
      }
      if (e.isDirectory()) dirs.push(file);
    }
  }
}

async function inspectRoot(ctx) {
  const { root } = ctx;
  if (!path.isAbsolute(root) || !(await stat(root))?.isDirectory() || root === path.parse(root).root) throw layout();
  for (let p = root; p !== path.dirname(p); p = path.dirname(p)) if ((await stat(p))?.isSymbolicLink()) throw layout();
  for (let d = root; ; d = path.dirname(d)) {
    if (d !== root && await stat(path.join(d, ".git")) || await stat(path.join(d, "HEAD")) && await stat(path.join(d, "objects"))) throw layout();
    if (d === path.dirname(d)) break;
  }
  const gd = await stat(path.join(root, ".git"));
  if (gd && !gd.isDirectory()) throw layout();
  return gd ? "repository" : "plain";
}

function createGitSync({ gitContext, gitBusy, invalidateGitSnapshots, isDenied, audit, makeRunner = runner }) {
  const secret = crypto.randomBytes(32);
  async function execute(p, mutate) {
    const ctx = await gitContext(p), a = p.action;
    await inspectRoot(ctx);
    const root = await fs.realpath(ctx.root); // Git prints the long spelling of Windows 8.3 aliases.
    const check = async () => { if ((await gitContext(p)).key !== ctx.key) throw stale(); };
    if (isDenied(root.split(path.sep).join("/"), "write")) throw protectedPath();
    if (mutate && (!actionNames.has(a) || p.remote !== undefined && (!remoteName(p.remote) || !["fetch", "push"].includes(a)) || p.branch !== undefined && !branchName(p.branch))) throw error("INVALID_ARGUMENT", "Select a listed Git action, branch or remote.");
    if (gitBusy.has(ctx.root)) throw error("GIT_BUSY", "Another Git operation is running. Refresh and retry.");
    if (mutate) gitBusy.add(ctx.root);
    let lock;
    const cfg = path.join(root, ".git", "config");
    try {
      const state = await inspectRoot(ctx);
      let run;
      try { run = await makeRunner(root); await run(["--version"]); }
      catch (e) { if (mutate || e.code !== "GIT_UNAVAILABLE") throw e; await check(); return { ok: true, state: "missing", branch: "", remotes: [] }; }
      if (state === "plain") {
        if (!mutate) { await check(); return { ok: true, state, branch: "", remotes: [] }; }
        if (a !== "init" || ctx.nested.length) throw layout();
        await inspectTree(root, false); await check();
        if (await inspectRoot(ctx) !== "plain") throw stale();
        await run(["init", "--template=", ...(p.branch ? [`--initial-branch=${p.branch}`] : []), "--", root]);
      } else {
        if (mutate && a === "init") throw layout();
        // Serialize conventional config writers across validation and Git's use
        // of the file. No sync command here should change repository config.
        if (mutate) lock = await fs.open(cfg + ".lock", "wx", 0o600).catch(() => { throw error("GIT_BUSY", "Git config is locked. Close other Git operations and retry."); });
        const st = await stat(cfg);
        if (!st?.isFile() || st.size > 65536 || st.nlink !== 1) throw config();
        if (mutate) await inspectTree(path.dirname(cfg), true);
        for (const file of ["commondir", "config.worktree"]) if (await stat(path.join(root, ".git", file))) throw layout();
        const raw = await run(["config", "--no-includes", "--null", "--file", cfg, "--list"]), { values, remotes } = parseConfig(raw);
        const git = (args, opts) => run(["-C", root, ...args], opts);
        const gd = path.join(root, ".git"), dirs = (await git(["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"])).trimEnd().split(/\r?\n/);
        if (dirs.length !== 2) throw layout();
        for (const d of dirs) if (!path.isAbsolute(d) || path.relative(gd, await fs.realpath(d))) throw layout();
        if (path.relative(root, await fs.realpath((await git(["rev-parse", "--show-toplevel"])).trimEnd()))) throw layout();
        const currentBranch = async () => {
          const ref = (await git(["symbolic-ref", "--quiet", "HEAD"], { allowed: [0, 1] })).trimEnd();
          if (ref && (!ref.startsWith("refs/heads/") || !branchName(ref.slice(11)))) throw layout();
          return ref.slice(11);
        };
        const resolve = async ref => { const v = (await git(["rev-parse", "--quiet", "--verify", `${ref}^{commit}`], { allowed: [0, 1] })).trimEnd(); if (v && !oid(v)) throw layout(); return v; };
        const branch = await currentBranch(), head = await resolve("HEAD");
        const get = key => values.get(`branch.${branch}.${key}`), upstreamRemote = get("remote"), upstreamBranch = get("merge")?.slice(11);
        const upstream = remotes.includes(upstreamRemote) && upstreamBranch ? `${upstreamRemote}/${upstreamBranch}` : undefined;
        const defaultRemote = upstreamRemote || (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined);
        const pushRemote = get("pushremote") || values.get("remote.pushdefault") || defaultRemote;
        const target = remote => remote === upstreamRemote && upstreamBranch ? upstreamBranch : branch;
        const tracking = remote => `refs/remotes/${remote}/${target(remote)}`;
        async function lease() {
          if (!head || !branch || !remotes.includes(pushRemote) || values.has(`remote.${pushRemote}.pushurl`) || !values.has(`remote.${pushRemote}.fetch`)) return;
          const expectedOid = await resolve(tracking(pushRemote)); if (!expectedOid) return;
          const token = crypto.createHmac("sha256", secret).update(JSON.stringify([ctx.key, st.dev, st.ino, raw, branch, head, pushRemote, target(pushRemote), expectedOid])).digest("hex");
          return { remote: pushRemote, branch: target(pushRemote), expectedOid, token };
        }
        if (!mutate) {
          const forceLease = await lease(); await check();
          return { ok: true, state, branch, remotes, ...(upstream && { upstream }), ...(forceLease && { forceLease }),
            ...(remotes.includes(defaultRemote) && { defaultRemote }), ...(remotes.includes(pushRemote) && { pushRemote }) };
        }
        if (p.branch !== undefined && p.branch !== branch) throw stale();
        const pull = a === "pull" || a === "pullRebase", push = a === "push" || a === "forcePush";
        const remote = p.remote || (push ? pushRemote : defaultRemote);
        if (!remotes.includes(remote)) throw error("GIT_REMOTE", "Configure a default remote in Git, or choose an existing remote.");
        if ((push || pull) && (!branch || !head)) throw error("GIT_BRANCH", "Check out a local branch with a commit first.");
        if (pull && !upstream) throw error("GIT_UPSTREAM", "Set the current branch’s upstream in Git before pulling.");
        const ref = `refs/heads/${target(remote)}`;
        const beforeWrite = async () => {
          await check();
          const current = await stat(cfg);
          if (!current?.isFile() || current.ino !== st.ino || current.dev !== st.dev || current.ctimeMs !== st.ctimeMs || current.size !== st.size ||
              await inspectRoot(ctx) !== "repository" || await currentBranch() !== branch || await resolve("HEAD") !== head) throw stale();
        };
        const network = { network: true, message: "Remote operation failed. Check connectivity, access, SSH agent and known host keys, or fetch and review divergent changes. Interactive authentication requires Git outside the panel." };
        // Inspect all reachable commits, not just HEAD: pushing can disclose a
        // credential file deleted in an earlier commit. No filename goes to UI.
        async function checkHistory(revisions) {
          const raw = await git(["log", "--format=", "--raw", "-z", "-m", "--root", "--full-history", "--no-renames", "--no-ext-diff", "--no-textconv", ...revisions, "--"]);
          const records = raw.split("\0"), touched = new Set();
          for (let i = 0; i < records.length;) {
            const header = records[i++].trimStart(); if (!header) continue;
            const file = records[i++];
            if (!/^:(?:000000|100644|100755) (?:000000|100644|100755) [0-9a-f.]+ [0-9a-f.]+ [AMDT]$/.test(header) || !file || /[\\:\x00-\x1f\ufffd]/.test(file) || file.split("/").some(s => !s || s === "." || s === ".." || /[ .]$/.test(s)) || isDenied(file, "write") || ctx.nested.some(d => inside(d, path.join(root, file)))) throw protectedPath();
            touched.add(file);
          }
          return touched;
        }
        if (push) {
          await checkHistory([head]);
          const force = a === "forcePush", reviewed = force && await lease();
          if (force && !(p.confirm === true && p.branch === branch && reviewed && p.leaseToken === reviewed.token)) throw error("GIT_LEASE", "Fetch, refresh and explicitly confirm the reviewed remote commit before force-pushing.");
          await beforeWrite();
          await git(["push", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", ...(force ? [`--force-with-lease=${ref}:${reviewed.expectedOid}`] : []), "--", remote, `${head}:${ref}`], network);
        } else {
          await beforeWrite();
          await git(["fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--refmap=", "--", remote, pull ? `+${ref}:${tracking(remote)}` : `+refs/heads/*:refs/remotes/${remote}/*`], network);
          if (pull) {
            const tip = await resolve(tracking(remote)); if (!tip) throw stale();
            const touched = await checkHistory([head, tip]);
            const dirty = await git(["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=all"]);
            // Include ignored files: rebase/checkout can otherwise overwrite them.
            const others = (await git(["ls-files", "--others", "--directory", "-z"])).split("\0").filter(Boolean);
            if (others.some(f => f.length > 4096 || f.split("/").length > 128) || [...touched].some(f => f.length > 4096 || f.split("/").length > 128)) throw limit();
            const blocked = new Set(others.map(f => f.replace(/\/$/, "").toLowerCase()));
            const ancestors = new Set();
            for (const f of blocked) for (let i = f.indexOf("/"); i >= 0; i = f.indexOf("/", i + 1)) ancestors.add(f.slice(0, i));
            for (const file of touched) { const f = file.toLowerCase(); if (ancestors.has(f) || blocked.has(f)) throw protectedPath(); for (let i = f.indexOf("/"); i >= 0; i = f.indexOf("/", i + 1)) if (blocked.has(f.slice(0, i))) throw protectedPath(); }
            if (dirty) throw error("GIT_DIRTY", "Commit or stash tracked changes before pulling.");
            await beforeWrite();
            await git(a === "pull" ? ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", tip] : ["rebase", "--no-autostash", "--no-update-refs", "--no-gpg-sign", tip], { message: "Integration failed. Check divergence, identity or conflicts and finish or abort the operation in Git." });
          }
        }
      }
      await audit({ op: `git.${a}`, root }); return { ok: true };
    } finally {
      try { if (lock) { await lock.close(); await fs.unlink(cfg + ".lock"); } }
      finally { if (mutate) { invalidateGitSnapshots(); gitBusy.delete(ctx.root); } }
    }
  }
  return { "fm.git.syncInfo": p => execute(p, false), "fm.git.syncAction": p => execute(p, true) };
}

module.exports = { createGitSync, runner };
