/**
 * Real-device acceptance probe for computer use (ADR 0342, ADR 0344).
 *
 * The accessibility tree, the window enumeration, and event synthesis are
 * platform work that fixtures cannot prove, so this script drives the real
 * host-core binary against the machine it runs on: capabilities, the window
 * list and its front-to-back order, the automatic desktop grant, one real
 * inspection, a rebind, the refusals, and the Stop cooldown.
 *
 * It is opt-in because it reads the operator's own screen and, with `--act`,
 * types into one of their windows. `PI_DESKTOP_COMPUTER_USE_DEVICE=1` is the
 * authorization; nothing here runs in CI.
 *
 *   PI_DESKTOP_COMPUTER_USE_DEVICE=1 node scripts/e2e-computer-use-device.mjs
 *   ... --titles                 also print window titles (off by default)
 *   ... --deny "<app name>"      prove a user denylist entry refuses a bind
 *   ... --act-app "<app name>"   dispatch ONE action into that app's window
 *   ... --act <targetId>         the same, by an id from a previous listing
 *
 * Window titles are withheld unless `--titles` is passed, so a pasted log
 * carries app identity without the contents of the operator's screen.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
void root;

if (process.env.PI_DESKTOP_COMPUTER_USE_DEVICE !== "1") {
  console.error(
    "refusing to run: this probe reads the operator's screen and may type into a window.\n"
      + "Set PI_DESKTOP_COMPUTER_USE_DEVICE=1 to authorize it.",
  );
  process.exit(2);
}
if (process.platform !== "darwin") {
  console.error(`no backend on ${process.platform} yet (stage 2); nothing to probe.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? true) : undefined;
};
const showTitles = args.includes("--titles");
const title = (value) => (showTitles ? value || "(no title)" : "(title withheld)");

const SESSION = "computer-use-device-probe";
const dataDir = await mkdtemp(join(tmpdir(), "cu-device-"));
const host = new Host(resolveHostBinary(), dataDir, { quiet: true });
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Expect a refusal, and name the code that came back. */
const expectRefusal = async (name, code, method, params) => {
  try {
    await host.call(method, params);
    record(name, false, "the call resolved instead of refusing");
  } catch (error) {
    record(name, error.errorCode === code, `${error.errorCode ?? "(no code)"}`);
  }
};

try {
  await host.start();
  await host.call("settings.set", { computerUse: { enabled: true } });

  const capabilities = await host.call("computer.capabilities", {});
  console.log("capabilities", JSON.stringify(capabilities));
  if (capabilities.accessibility !== "granted") {
    console.error(
      "\nAccessibility is not granted for the process running this probe, so inspection and input\n"
        + "cannot be proven here. Grant it to this terminal in System Settings > Privacy & Security >\n"
        + "Accessibility and run the probe again.",
    );
    process.exit(3);
  }

  const { targets } = await host.call("computer.listTargets", {});
  console.log(`windows: ${targets.length}`);
  for (const [index, target] of targets.entries()) {
    console.log(
      `  ${index}. ${target.appName} | ${title(target.title)} | ${target.refusedReason ?? "usable"} | ${target.targetId}`,
    );
  }
  const firstUsable = targets.findIndex((target) => !target.refusedReason);
  record(
    "the window list carries refusals instead of dropping windows",
    targets.length > 0 && firstUsable >= 0,
    `${targets.filter((target) => target.refusedReason).length} refused`,
  );

  const grant = await host.call("computer.grantCreate", { sessionId: SESSION, origin: "agent" });
  record(
    "an automatic grant covers the desktop and binds the frontmost usable window",
    grant.scope === "desktop" && grant.targetId === targets[firstUsable].targetId,
    `scope=${grant.scope} bound=${grant.appKey} skipped=${firstUsable}`,
  );
  record(
    "the grant takes the settings defaults, not a narrower unbuilt policy",
    grant.inputPolicy === "autonomous-in-scope" && grant.capture === "a11y-only",
    `${grant.inputPolicy} / ${grant.capture}`,
  );

  const inspection = await host.call("computer.inspect", { grantId: grant.grantId, sessionId: SESSION });
  record(
    "the real accessibility tree comes back with roles and actions",
    inspection.nodes.length > 0 && inspection.fidelity === "full",
    `${inspection.nodes.length} nodes, fidelity=${inspection.fidelity}`,
  );
  record(
    "inspection reports whether a value exists, never the value",
    inspection.nodes.every((node) => !("value" in node)),
    "no node carries a value field",
  );

  // Re-listed immediately before the bind: overlay windows (Stage Manager, the
  // Dock's helpers) come and go, and a vanished id is a scope violation rather
  // than the rebind this step is trying to prove.
  const fresh = (await host.call("computer.listTargets", {})).targets;
  const candidates = fresh.filter(
    (target) => !target.refusedReason && target.targetId !== grant.targetId,
  );
  if (candidates.length > 0) {
    let rebound;
    let lastCode;
    for (const candidate of candidates) {
      try {
        rebound = await host.call("computer.inspect", {
          grantId: grant.grantId,
          sessionId: SESSION,
          targetId: candidate.targetId,
        });
        break;
      } catch (error) {
        // Overlay windows vanish between two enumerations; that is the scope
        // violation working, not the rebind failing. Try the next one.
        lastCode = error.errorCode;
      }
    }
    if (!rebound) console.log(`SKIP rebind — every candidate window went away mid-probe (${lastCode})`);
    if (rebound) {
      record(
        "a rebind moves the revision, so every earlier uid stops validating",
        rebound.revision > inspection.revision,
        `revision ${inspection.revision} -> ${rebound.revision}`,
      );
      await expectRefusal(
        "an action holding the pre-rebind revision is refused",
        "COMPUTER_STALE_REVISION",
        "computer.act",
        {
          grantId: grant.grantId,
          sessionId: SESSION,
          expectedRevision: inspection.revision,
          action: { kind: "click", uid: rebound.nodes[0]?.uid ?? "0" },
        },
      );
    }
  } else {
    console.log("SKIP rebind — no second usable window on screen");
  }

  const own = targets.find((target) => target.refusedReason === "self");
  if (own) {
    await expectRefusal(
      "binding one of our own windows is refused",
      "COMPUTER_SELF_TARGET_REFUSED",
      "computer.inspect",
      { grantId: grant.grantId, sessionId: SESSION, targetId: own.targetId },
    );
  } else {
    console.log("SKIP self-target bind — no PI-Desktop window on screen");
  }
  await expectRefusal(
    "binding a window that is not in the host's list is refused",
    "COMPUTER_SCOPE_VIOLATION",
    "computer.inspect",
    { grantId: grant.grantId, sessionId: SESSION, targetId: "no-such-window" },
  );

  // `--act-app` resolves inside this run, because window ids change between
  // runs and a stale id would read as a refusal rather than a missed target.
  const actApp = flag("--act-app");
  const actTarget = typeof actApp === "string"
    ? (await host.call("computer.listTargets", {})).targets.find(
        (target) => !target.refusedReason && target.appName.includes(actApp),
      )?.targetId
    : flag("--act");
  if (typeof actApp === "string" && !actTarget) {
    console.log(`SKIP act — no usable window from an app matching "${actApp}"`);
  }
  if (typeof actTarget === "string") {
    const bound = await host.call("computer.inspect", {
      grantId: grant.grantId,
      sessionId: SESSION,
      targetId: actTarget,
    });
    const editable = bound.nodes.find((node) => node.actions.includes("set_value"));
    const clickable = bound.nodes.find((node) => node.actions.includes("click"));
    const node = editable ?? clickable;
    if (!node) {
      console.log("SKIP act — that window exposes no actionable element");
    } else {
      const action = editable
        ? { kind: "set_value", uid: node.uid, text: "PI-Desktop computer-use device probe" }
        : { kind: "click", uid: node.uid };
      const result = await host.call("computer.act", {
        grantId: grant.grantId,
        sessionId: SESSION,
        expectedRevision: bound.revision,
        action,
      });
      record(
        "one action reaches the window through the platform accessibility action",
        result.dispatched === "accessibility-action" && result.remainingBudget === grant.remainingBudget - 1,
        `${action.kind} on ${node.role}, dispatched=${result.dispatched}, budget ${grant.remainingBudget} -> ${result.remainingBudget}`,
      );
    }
  } else {
    console.log("SKIP act — pass --act <targetId> to dispatch one real action");
  }

  const denyApp = flag("--deny");
  if (typeof denyApp === "string") {
    await host.call("computer.grantRevoke", { reason: "probe-denylist-setup" });
    await host.call("settings.set", { computerUse: { enabled: true, denylist: [denyApp] } });
    const listed = (await host.call("computer.listTargets", {})).targets.find((target) =>
      target.appName.includes(denyApp),
    );
    record(
      "a denylisted window is listed with its reason",
      listed?.refusedReason === "denylisted",
      `${listed?.appName ?? "not found"} -> ${listed?.refusedReason ?? "none"}`,
    );
    const denyGrant = await host.call("computer.grantCreate", { sessionId: SESSION, origin: "user" });
    record(
      "the automatic grant does not bind a denylisted window",
      denyGrant.targetId !== listed?.targetId,
      `bound ${denyGrant.appKey}`,
    );
    if (listed) {
      await expectRefusal(
        "binding a denylisted window is refused",
        "COMPUTER_TARGET_DENYLISTED",
        "computer.inspect",
        { grantId: denyGrant.grantId, sessionId: SESSION, targetId: listed.targetId },
      );
    }
    await host.call("settings.set", { computerUse: { enabled: true, denylist: [] } });
  } else {
    console.log("SKIP denylist — pass --deny \"<app name>\" to prove it on a real window");
  }

  await host.call("computer.grantRevoke", { reason: "user" });
  await expectRefusal(
    "the agent cannot re-grant itself inside the Stop cooldown",
    "COMPUTER_STOPPED_BY_USER",
    "computer.grantCreate",
    { sessionId: SESSION, origin: "agent" },
  );
  const userGrant = await host.call("computer.grantCreate", { sessionId: SESSION, origin: "user" });
  record(
    "the user's own request clears the cooldown immediately",
    userGrant.scope === "desktop",
    `scope=${userGrant.scope}`,
  );
  await host.call("computer.grantRevoke", { reason: "probe-cleanup" });

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} / ${results.length} device checks passed`);
  if (failed.length > 0) {
    console.error("failed: " + failed.map((result) => result.name).join("; "));
    process.exitCode = 1;
  }
} finally {
  await host.stop().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}
