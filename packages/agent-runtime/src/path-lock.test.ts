import { describe, expect, it } from "vitest";
import { normalizeLockPath, PathMutex } from "./path-lock.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("normalizeLockPath", () => {
  it("compares spellings of the same path equal", () => {
    expect(normalizeLockPath("./src/App.tsx")).toBe("src/app.tsx");
    expect(normalizeLockPath("src\\App.tsx")).toBe("src/app.tsx");
    expect(normalizeLockPath("src/app.tsx/")).toBe("src/app.tsx");
    expect(normalizeLockPath(undefined)).toBe("");
  });

  it("collapses dot, duplicate, and parent segments", () => {
    for (const spelling of [
      "src/a.ts",
      "././src/a.ts",
      "src/./a.ts",
      "src//a.ts",
      "src/foo/../a.ts",
      "src\\.\\a.ts",
    ]) {
      expect(normalizeLockPath(spelling)).toBe("src/a.ts");
    }
    // Drive letters stay, including when `..` would otherwise pop them.
    expect(normalizeLockPath("C:\\Src\\.\\A.ts")).toBe("c:/src/a.ts");
    expect(normalizeLockPath("C:/src/foo/../A.ts")).toBe("c:/src/a.ts");
    expect(normalizeLockPath("C:/../src/a.ts")).toBe("c:/src/a.ts");
    // Delegate lock keys are `${worktreeKey}\0${path}` (see pathLockKey).
    // `..` must not climb out of the path half into the worktree id.
    expect(normalizeLockPath("Wt\0src/foo/../A.ts")).toBe("wt\0src/a.ts");
    expect(normalizeLockPath("wt\0foo/../../a.ts")).toBe("wt\0../a.ts");
  });

  it("keeps a relative parent and an absolute root", () => {
    expect(normalizeLockPath("../x.ts")).toBe("../x.ts");
    expect(normalizeLockPath("../X.ts")).toBe("../x.ts");
    expect(normalizeLockPath("/abs/a.ts")).toBe("/abs/a.ts");
    expect(normalizeLockPath("/Abs/A.ts")).toBe("/abs/a.ts");
    expect(normalizeLockPath("/../src/a.ts")).toBe("/src/a.ts");
  });
});

describe("PathMutex", () => {
  it("serializes the same path and keeps other paths concurrent", async () => {
    const mutex = new PathMutex();
    const order: string[] = [];
    const first = deferred();
    const other = deferred();

    const a = mutex.run("src/app.ts", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = mutex.run("./src/app.ts", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    const c = mutex.run("src/other.ts", async () => {
      order.push("c:start");
      await other.promise;
      order.push("c:end");
    });

    // `b` waits on `a`; `c` does not wait on either.
    expect(order).toEqual(["a:start", "c:start"]);
    other.resolve();
    await c;
    expect(order).toEqual(["a:start", "c:start", "c:end"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual([
      "a:start",
      "c:start",
      "c:end",
      "a:end",
      "b:start",
      "b:end",
    ]);
    expect(mutex.busy).toBe(false);
  });

  it("lets the queue continue after a holder throws", async () => {
    const mutex = new PathMutex();
    const failing = mutex.run("a.ts", async () => {
      throw new Error("write failed");
    });
    const next = mutex.run("a.ts", async () => "ok");

    await expect(failing).rejects.toThrow("write failed");
    await expect(next).resolves.toBe("ok");
    expect(mutex.busy).toBe(false);
  });

  it("does not lock an empty path", async () => {
    const mutex = new PathMutex();
    const held = deferred();
    const first = mutex.run("", async () => {
      await held.promise;
      return 1;
    });
    await expect(mutex.run("", async () => 2)).resolves.toBe(2);
    held.resolve();
    await expect(first).resolves.toBe(1);
  });

  it("queues a write behind another spelling of the same path", async () => {
    const mutex = new PathMutex();
    const gate = deferred();
    let secondStarted = false;

    const first = mutex.run("src/./a.ts", async () => {
      await gate.promise;
    });
    const second = mutex.run("src/a.ts", async () => {
      secondStarted = true;
    });

    expect(secondStarted).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
    expect(mutex.busy).toBe(false);
  });

  it("does not overlap a read with a write of an equivalent path", async () => {
    const mutex = new PathMutex();
    const gate = deferred();
    let readStarted = false;

    const write = mutex.run("src/foo/../a.ts", async () => {
      await gate.promise;
    });
    const read = mutex.read("src//a.ts", async () => {
      readStarted = true;
    });

    expect(readStarted).toBe(false);
    gate.resolve();
    await Promise.all([write, read]);
    expect(readStarted).toBe(true);
    expect(mutex.busy).toBe(false);
  });

  it("does not create a second lock when an absolute path climbs above root", async () => {
    const mutex = new PathMutex();
    const gate = deferred();
    let secondStarted = false;

    const first = mutex.run("/../src/a.ts", async () => {
      await gate.promise;
    });
    const second = mutex.run("/src/a.ts", async () => {
      secondStarted = true;
    });

    expect(secondStarted).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
    expect(mutex.busy).toBe(false);
  });

  it("allows concurrent reads on the same path while serializing reads against writes", async () => {
    const mutex = new PathMutex();
    const order: string[] = [];
    const r1Gate = deferred();
    const r2Gate = deferred();
    const wGate = deferred();
    const r3Gate = deferred();

    const r1 = mutex.read("src/app.ts", async () => {
      order.push("r1:start");
      await r1Gate.promise;
      order.push("r1:end");
    });
    const r2 = mutex.read("./src/App.ts", async () => {
      order.push("r2:start");
      await r2Gate.promise;
      order.push("r2:end");
    });
    const w = mutex.run("src/app.ts", async () => {
      order.push("w:start");
      await wGate.promise;
      order.push("w:end");
    });
    const r3 = mutex.read("src/app.ts", async () => {
      order.push("r3:start");
      await r3Gate.promise;
      order.push("r3:end");
    });
    const r4 = mutex.read("src/app.ts", async () => {
      order.push("r4:start");
      await r3Gate.promise;
      order.push("r4:end");
    });

    // `r1` and `r2` overlap; `w` waits for both; `r3` and `r4` wait for `w`.
    expect(order).toEqual(["r1:start", "r2:start"]);
    r1Gate.resolve();
    await r1;
    expect(order).toEqual(["r1:start", "r2:start", "r1:end"]);

    r2Gate.resolve();
    await r2;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["r1:start", "r2:start", "r1:end", "r2:end", "w:start"]);

    wGate.resolve();
    await w;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([
      "r1:start",
      "r2:start",
      "r1:end",
      "r2:end",
      "w:start",
      "w:end",
      "r3:start",
      "r4:start",
    ]);

    r3Gate.resolve();
    await Promise.all([r3, r4]);
    expect(order).toEqual([
      "r1:start",
      "r2:start",
      "r1:end",
      "r2:end",
      "w:start",
      "w:end",
      "r3:start",
      "r4:start",
      "r3:end",
      "r4:end",
    ]);
    expect(mutex.busy).toBe(false);
  });
});
