import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneGitRepository,
  parseGitCloneUrl,
} from "../electron/main/git-clone.ts";
import { applyUserEndpointPolicyFromAppSettings } from "../electron/main/endpoint-policy.ts";

/** Mirror `settings.networkPolicy` the way the app's settings write does. */
function setAllowInsecureUserEndpoints(enabled) {
  applyUserEndpointPolicyFromAppSettings({
    networkPolicy: { allowInsecureUserEndpoints: enabled },
  });
}

test("parseGitCloneUrl accepts https, ssh, and scp remotes", () => {
  assert.deepEqual(parseGitCloneUrl("https://github.com/org/pi-desktop.git"), {
    url: "https://github.com/org/pi-desktop.git",
    name: "pi-desktop",
  });
  assert.deepEqual(parseGitCloneUrl("git@github.com:org/plugins.git"), {
    url: "git@github.com:org/plugins.git",
    name: "plugins",
  });
  assert.deepEqual(parseGitCloneUrl("ssh://git@github.com/org/repo"), {
    url: "ssh://git@github.com/org/repo",
    name: "repo",
  });
});

test("parseGitCloneUrl rejects unsafe or incomplete remotes", () => {
  assert.equal(parseGitCloneUrl(""), null);
  assert.equal(parseGitCloneUrl("not a url"), null);
  assert.equal(parseGitCloneUrl("file:///tmp/repo.git"), null);
  assert.equal(parseGitCloneUrl("https://user:pass@github.com/org/repo.git"), null);
  assert.equal(parseGitCloneUrl("git@github.com:org/."), null);
});

test("parseGitCloneUrl accepts a remote on the user's own network", () => {
  // The clone remote is an address the user typed, so a self-hosted GitLab on
  // the LAN — `192.168.1.5`, `10.0.0.7` — or a local `git daemon` is reachable,
  // under the same trust rule as every other user-supplied endpoint.
  assert.deepEqual(parseGitCloneUrl("git@192.168.1.5:team/repo.git"), {
    url: "git@192.168.1.5:team/repo.git",
    name: "repo",
  });
  // A plaintext remote on the user's LAN is reachable once they opted in.
  assert.deepEqual(
    parseGitCloneUrl("http://10.0.0.7/team/repo.git", {
      allowInsecureHttp: true,
    }),
    {
      url: "http://10.0.0.7/team/repo.git",
      name: "repo",
    },
  );
  assert.deepEqual(parseGitCloneUrl("https://127.0.0.1/org/repo.git"), {
    url: "https://127.0.0.1/org/repo.git",
    name: "repo",
  });
  assert.deepEqual(
    parseGitCloneUrl("http://localhost/org/repo.git", {
      allowInsecureHttp: true,
    }),
    {
      url: "http://localhost/org/repo.git",
      name: "repo",
    },
  );
  assert.deepEqual(parseGitCloneUrl("ssh://git@192.168.0.10/org/repo.git"), {
    url: "ssh://git@192.168.0.10/org/repo.git",
    name: "repo",
  });
  assert.deepEqual(parseGitCloneUrl("ssh://git@nas.local/org/repo"), {
    url: "ssh://git@nas.local/org/repo",
    name: "repo",
  });
  // Loopback, ULA and link-local literals are the same trust input.
  assert.deepEqual(parseGitCloneUrl("https://[::1]/org/repo.git")?.name, "repo");
  assert.deepEqual(parseGitCloneUrl("https://[fd00::1]/org/repo.git")?.name, "repo");
  assert.deepEqual(parseGitCloneUrl("https://[fe80::1]/org/repo.git")?.name, "repo");
});

test("parseGitCloneUrl still rejects cloud metadata and non-git URLs", () => {
  // A metadata service answers with the host's own credentials, and a
  // documentation or credential-bearing URL is not a remote at all.
  assert.equal(parseGitCloneUrl("https://169.254.169.254/org/repo.git"), null);
  assert.equal(parseGitCloneUrl("http://169.254.169.254/latest/meta-data/repo.git"), null);
  assert.equal(parseGitCloneUrl("git@169.254.169.254:org/repo.git"), null);
  assert.equal(parseGitCloneUrl("https://metadata.google.internal/org/repo.git"), null);
  assert.equal(parseGitCloneUrl("https://[fd00:ec2::254]/org/repo.git"), null);
  assert.equal(parseGitCloneUrl("https://[2001:db8::1]/org/repo.git"), null);
});

test("parseGitCloneUrl refuses plain http and git until the user opts in", () => {
  // A plaintext hop to a LAN git host carries whatever credentials that host
  // accepts, so it needs `networkPolicy.allowInsecureUserEndpoints` — the same
  // gate every other user-supplied endpoint passes. Default stays deny.
  assert.equal(parseGitCloneUrl("http://10.0.0.7/repo.git"), null);
  assert.equal(parseGitCloneUrl("git://10.0.0.7/repo"), null);
  assert.equal(parseGitCloneUrl("http://10.0.0.7/repo.git", {}), null);
  assert.equal(
    parseGitCloneUrl("http://10.0.0.7/repo.git", { allowInsecureHttp: false }),
    null,
  );
  assert.deepEqual(
    parseGitCloneUrl("http://10.0.0.7/repo.git", { allowInsecureHttp: true }),
    { url: "http://10.0.0.7/repo.git", name: "repo" },
  );
  assert.deepEqual(
    parseGitCloneUrl("git://10.0.0.7/repo", { allowInsecureHttp: true }),
    { url: "git://10.0.0.7/repo", name: "repo" },
  );
});

test("parseGitCloneUrl needs no opt-in for https, ssh, or scp remotes", () => {
  assert.deepEqual(parseGitCloneUrl("https://192.168.1.5/repo.git"), {
    url: "https://192.168.1.5/repo.git",
    name: "repo",
  });
  assert.deepEqual(parseGitCloneUrl("git@192.168.1.5:team/repo.git"), {
    url: "git@192.168.1.5:team/repo.git",
    name: "repo",
  });
  assert.deepEqual(parseGitCloneUrl("ssh://git@10.0.0.7/org/repo.git")?.name, "repo");
});

test("the insecure flag does not unlock cloud metadata or file URLs", () => {
  const optedIn = { allowInsecureHttp: true };
  assert.equal(parseGitCloneUrl("http://169.254.169.254/latest/meta-data/repo.git", optedIn), null);
  assert.equal(parseGitCloneUrl("https://169.254.169.254/org/repo.git", optedIn), null);
  assert.equal(parseGitCloneUrl("file:///tmp/repo.git", optedIn), null);
  assert.equal(parseGitCloneUrl("file://10.0.0.7/repo.git"), null);
});

test("cloneGitRepository refuses an existing destination and path escape", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clone-"));
  try {
    mkdirSync(join(root, "taken"));
    await assert.rejects(
      () =>
        cloneGitRepository({
          url: "https://github.com/org/taken.git",
          parentPath: root,
        }),
      /already exists/,
    );
    await assert.rejects(
      () =>
        cloneGitRepository({
          url: "https://github.com/org/ok.git",
          parentPath: root,
          name: "..",
        }),
      /git repository URL/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneGitRepository runs git clone -- url dest", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clone-"));
  try {
    let captured;
    const dest = await cloneGitRepository({
      url: "https://github.com/org/demo.git",
      parentPath: root,
      run: async (_cwd, args) => {
        captured = { args };
        mkdirSync(join(root, "demo"));
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(dest, join(root, "demo"));
    assert.deepEqual(captured.args, [
      "clone",
      "--",
      "https://github.com/org/demo.git",
      join(root, "demo"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneGitRepository runs git for a LAN remote the user typed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clone-"));
  try {
    let captured;
    const dest = await cloneGitRepository({
      url: "git@192.168.1.5:team/demo.git",
      parentPath: root,
      run: async (_cwd, args) => {
        captured = { args };
        mkdirSync(join(root, "demo"));
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(dest, join(root, "demo"));
    assert.deepEqual(captured.args, [
      "clone",
      "--",
      "git@192.168.1.5:team/demo.git",
      join(root, "demo"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneGitRepository rejects a cloud metadata host before git runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clone-"));
  try {
    let ran = false;
    await assert.rejects(
      () =>
        cloneGitRepository({
          url: "https://169.254.169.254/latest/meta-data/repo.git",
          parentPath: root,
          run: async () => {
            ran = true;
            return { code: 0, stderr: "" };
          },
        }),
      /git repository URL/,
    );
    assert.equal(ran, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneGitRepository gates a plain http remote on the user's endpoint policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clone-"));
  try {
    let ran = false;
    setAllowInsecureUserEndpoints(false);
    await assert.rejects(
      () =>
        cloneGitRepository({
          url: "http://10.0.0.7/team/demo.git",
          parentPath: root,
          run: async () => {
            ran = true;
            return { code: 0, stderr: "" };
          },
        }),
      /git repository URL/,
    );
    assert.equal(ran, false);

    // The opt-in is the main process's, so the same URL clones once it is on.
    setAllowInsecureUserEndpoints(true);
    const dest = await cloneGitRepository({
      url: "http://10.0.0.7/team/demo.git",
      parentPath: root,
      run: async () => {
        mkdirSync(join(root, "demo"));
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(dest, join(root, "demo"));
  } finally {
    setAllowInsecureUserEndpoints(false);
    rmSync(root, { recursive: true, force: true });
  }
});
