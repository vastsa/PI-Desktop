import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { parsePlatformMediaInput } = await import("../electron/main/services/platform-media-service.ts");

const { platformMediaEnvironment } = await import("../electron/main/services/platform-media-process.ts");
const { fixture, key, png, video } = await import("../resources/skills/ai-aggregation-platform/tests/platform-media-fixture.mjs");

test("the native CLI uses the same account's image default, with explicit request overrides", async (t) => {
  const f = await fixture(t, { settings: {
    imageGeneration: { providerId: "selected", modelId: "gpt-image-2.5-sunburst" },
  } });
  const defaults = await f.call({ operation: "image", prompt: "Starry ocean" });
  assert.equal(defaults.ok, true, JSON.stringify(defaults));
  assert.equal(JSON.parse(f.posts()[0].body).model, "gpt-image-2.5-sunburst");
  const explicit = await f.call({ operation: "image", prompt: "Ocean", model: "gpt-image-2.5-flare" });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  assert.equal(JSON.parse(f.posts()[1].body).model, "gpt-image-2.5-flare");
  const other = await fixture(t, { settings: {
    imageGeneration: { providerId: "other-account", modelId: "custom-other-account-only" },
  } });
  assert.equal((await other.call({ operation: "image", prompt: "Ocean" })).ok, true);
  assert.equal(JSON.parse(other.posts()[0].body).model, "gpt-image-2.5-flare");
});

test("image generation, editing, partial batch recovery and billing use the selected row and real CLI", async (t) => {
  const f = await fixture(t);
  const ref = join(f.project, "参考 image.png");
  await writeFile(ref, png);
  f.setMode("partial");
  const result = await f.call({ operation: "image", prompt: '--a "blue" boat\nsecond line', images: [ref, `data:image/png;base64,${png.toString("base64")}`, "https://example.com/reference.png"], count: 2, model: "gpt-image-2.5-sunburst" });
  assert.equal(result.ok, false);
  assert.equal(result.content.result.status, "partial_failed");
  assert.equal(result.content.result.images.length, 1);
  const output = result.content.result.images[0].file;
  assert.deepEqual(await readFile(output), png);
  assert.ok(output.startsWith(f.scratch));
  assert.equal(f.posts().length, 2);
  for (const row of f.posts()) {
    assert.equal(row.url, "/v1/images/edits");
    assert.equal(row.headers.authorization, `Bearer ${key}`);
    const payload = JSON.parse(row.body);
    assert.equal(payload.n, 1);
    assert.equal(payload.images.length, 3);
    assert.equal(payload.prompt, '--a "blue" boat\nsecond line');
    assert.equal(payload.model, "gpt-image-2.5-sunburst");
  }
  const receipt = result.content.result.receipt;
  const recovered = await f.call({ operation: "image-download", receipt });
  assert.equal(recovered.content.result.completed, 1);
  assert.deepEqual(await readFile(recovered.content.result.images[0].file), png);
  const bill = await f.call({ operation: "billing", receipt });
  assert.equal(bill.ok, true);
  assert.equal(bill.content.result.verified, false);
  assert.equal(f.posts().length, 2, "Recovery and billing cannot generate images");
  assert.ok(f.calls.filter(([method]) => method === "providers.getSecret").every(([, args]) => args.id === "selected"));
  assert.ok(!JSON.stringify(result).includes(key));
});

test("video multimodal create, status, download and billing preserve the same task", async (t) => {
  const f = await fixture(t);
  const image = join(f.project, "boat.png");
  const clip = join(f.project, "motion.mp4");
  const audio = join(f.project, "audio.wav");
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32000, 40);
  await Promise.all([writeFile(image, png), writeFile(clip, video), writeFile(audio, wav)]);
  const created = await f.call({ operation: "video-create", prompt: "Make the boat move", images: [image, "https://example.com/reference.png"], videos: [clip], audios: [audio], seconds: 4, resolution: "2K", ratio: "16:9" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.content.result.task_id, "task_fixture");
  assert.equal(created.content.result.status, "queued");
  const body = f.posts()[0].body.toString();
  assert.match(f.posts()[0].headers["content-type"], /multipart\/form-data/);
  for (const field of ["reference_image", "reference_video", "reference_audio", "metaso_content", "metaso_resolution", "https://example.com/reference.png"]) assert.ok(body.includes(field));
  const receipt = created.content.result.receipt;
  const status = await f.call({ operation: "video-status", receipt });
  assert.equal(status.content.result.status, "completed");
  assert.equal(status.content.result.response, undefined);
  const downloaded = await f.call({ operation: "video-download", receipt });
  assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
  assert.deepEqual(await readFile(downloaded.content.result.file), video);
  assert.equal(downloaded.content.result.billing.verified, true);
  const billed = await f.call({ operation: "billing", taskId: "task_fixture" });
  assert.equal(billed.content.result.net_usd, 0.2);
  assert.equal(f.posts().length, 1);
});

test("the provider boundary rejects foreign credentials and header overrides before reading a secret", async (t) => {
  for (const provider of [
    { vendorKey: "openai" }, { baseUrl: "https://other.example/v1" }, { authKind: "oauth" },
    { headers: { Authorization: "another-key" } }, { headers: { "X-API-Key": "another-key" } }, { enabled: false },
  ]) {
    const f = await fixture(t, { provider });
    const result = await f.call({ operation: "image", prompt: "boat" });
    assert.equal(result.ok, false);
    assert.equal(f.calls.some(([method]) => method === "providers.getSecret"), false);
    assert.equal(f.requests.length, 0);
  }
  const f = await fixture(t, { session: { providerId: undefined } });
  assert.equal((await f.call({ operation: "image", prompt: "boat" })).errorCode, "PLATFORM_PROVIDER_REQUIRED");
  assert.equal(f.calls.some(([method]) => method.startsWith("providers.")), false);
});

test("inherited keys, independent credentials and Python injection cannot replace the session credential", async (t) => {
  const f = await fixture(t);
  const saved = {};
  const env = { OPENAI_API_KEY: "wrong-provider", AI_AGG_API_KEY: "wrong-platform", AI_AGG_BASE_URL: "http://attacker.invalid", AI_AGG_CONFIG_DIR: join(f.root, "bad-config"), PYTHONPATH: f.root, PYTHONSTARTUP: "attack.py" };
  for (const [name, value] of Object.entries(env)) { saved[name] = process.env[name]; process.env[name] = value; }
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  await mkdir(env.AI_AGG_CONFIG_DIR);
  await writeFile(join(env.AI_AGG_CONFIG_DIR, "credentials"), "API_KEY=wrong-key\nBASE_URL=http://attacker.invalid\n");
  const child = platformMediaEnvironment(key);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.PYTHONPATH, undefined);
  assert.equal(child.AI_AGG_BASE_URL, "https://ai.yykkj.com/v1");
  const result = await f.call({ operation: "image", prompt: "boat" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.posts()[0].headers.authorization, `Bearer ${key}`);
});

test("an unpinned session uses only the configured default platform row", async (t) => {
  const f = await fixture(t, { session: { providerId: undefined }, settings: { defaultProviderId: "selected" } });
  const result = await f.call({ operation: "image", prompt: "boat" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(f.calls.some(([method]) => method === "settings.get"));
  assert.deepEqual(f.calls.filter(([method]) => method === "providers.getSecret").map(([, args]) => args.id), ["selected"]);
  const foreign = await fixture(t, { provider: { vendorKey: "another-provider" }, settings: { defaultProviderId: "good-platform" } });
  assert.equal((await foreign.call({ operation: "image", prompt: "boat" })).errorCode, "PLATFORM_PROVIDER_REQUIRED");
  assert.equal(foreign.calls.some(([method]) => method === "settings.get" || method === "providers.getSecret"), false);
});

test("path, scalar and CLI flag validation fail without a network call", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "private.png");
  await writeFile(outside, png);
  await symlink(outside, join(f.project, "escape.png"));
  for (const input of [
    { operation: "image", prompt: "x", count: 0 }, { operation: "image", prompt: "x", count: 11 },
    { operation: "image", prompt: "x", out: outside }, { operation: "image", prompt: "x", flags: ["--dry-run"] },
    { operation: "video-create", prompt: "x", seconds: 3 }, { operation: "video-create", prompt: "x", seconds: 4.5 },
    { operation: "video-create", prompt: "x", model: "other" }, { operation: "video-create", prompt: "x", resolution: "4K" },
    { operation: "video-status", taskId: "../../other" }, { operation: "image-download" },
    { operation: "image", prompt: "x", images: [outside] }, { operation: "image", prompt: "x", images: ["escape.png"] },
    { operation: "image", prompt: "x", images: ["http://example.com/x.png"] },
    { operation: "image", prompt: "x", images: ["https://key:secret@example.com/x.png"] },
    { operation: "image", prompt: "x", images: ["data:image/png;base64,broken!"] },
  ]) {
    const result = await f.call(input);
    assert.equal(result.ok, false, JSON.stringify(input));
  }
  assert.equal(f.requests.length, 0);
  assert.throws(() => parsePlatformMediaInput({ operation: "video-create", prompt: "x", images: Array(9).fill("x"), audios: Array(8).fill("x") }), /Too many/);
  assert.deepEqual(await readFile(outside), png);
});

test("receipt recovery ignores embedded output paths, rejects cross-session and cross-provider receipts", async (t) => {
  const f = await fixture(t);
  const created = await f.call({ operation: "image", prompt: "boat" });
  const receipt = created.content.result.receipt;
  const journal = JSON.parse(await readFile(receipt, "utf8"));
  const target = join(f.root, "must-not-overwrite.txt");
  await writeFile(target, "keep me");
  journal.out = target;
  await writeFile(receipt, JSON.stringify(journal));
  const recovered = await f.call({ operation: "image-download", receipt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(await readFile(target, "utf8"), "keep me");
  assert.ok(recovered.content.result.images[0].file.startsWith(f.scratch));
  const other = join(f.dataDir, "scratch", "session-b", "platform-media", "forged");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "image.png.request.json"), JSON.stringify(journal));
  assert.equal((await f.call({ operation: "image-download", receipt: join(other, "image.png.request.json") })).errorCode, "INVALID_RECEIPT");
  await writeFile(join(dirname(receipt), "invocation.json"), JSON.stringify({ providerId: "other-row" }));
  assert.equal((await f.call({ operation: "image-download", receipt })).errorCode, "INVALID_RECEIPT");
  assert.equal(f.posts().length, 1);
});

test("attachments are usable but scratch and receipt symlinks cannot cross the session boundary", async (t) => {
  const f = await fixture(t, { options: { scriptsDir: undefined } });
  const attachment = `attachments/${"a".repeat(64)}`;
  await writeFile(join(f.dataDir, attachment), png);
  const image = await f.call({ operation: "image", prompt: "boat", images: [attachment] });
  assert.equal(image.ok, true, JSON.stringify(image));
  const outside = join(f.root, "outside.request.json");
  await writeFile(outside, JSON.stringify({ kind: "image", out: join(f.root, "outside.png") }));
  const receiptLink = join(dirname(image.content.result.receipt), "link.request.json");
  await symlink(outside, receiptLink);
  assert.equal((await f.call({ operation: "image-download", receipt: receiptLink })).errorCode, "INVALID_RECEIPT");
  const otherSession = join(f.dataDir, "scratch", "session-b");
  await mkdir(otherSession);
  await rm(f.scratch, { recursive: true });
  await symlink(otherSession, f.scratch);
  assert.equal((await f.call({ operation: "image", prompt: "must not run" })).errorCode, "INVALID_ARGUMENT");
  assert.equal(f.posts().length, 1);
});

test("desktop recovery rejects insecure download URLs stored in an otherwise owned receipt", async (t) => {
  const f = await fixture(t);
  const generated = await f.call({ operation: "image", prompt: "boat" });
  const receipt = generated.content.result.receipt;
  const journal = JSON.parse(await readFile(receipt, "utf8"));
  journal.response.data = [{ url: "http://127.0.0.1/private.png" }];
  await writeFile(receipt, JSON.stringify(journal));
  const requestCount = f.requests.length;
  const recovered = await f.call({ operation: "image-download", receipt });
  assert.equal(recovered.ok, false);
  assert.match(recovered.content.message, /HTTPS/);
  assert.equal(f.requests.length, requestCount);
});

test("dropped generation, duplicate calls and secret-bearing upstream errors never retry a POST", async (t) => {
  const f = await fixture(t);
  f.setMode("drop");
  const input = { operation: "video-create", prompt: "boat" };
  const failed = await f.call(input, { toolCallId: "same-call" });
  assert.equal(failed.ok, false);
  assert.equal(failed.content.recovery.submissionState, "error_or_unknown");
  const duplicate = await f.call(input, { toolCallId: "same-call" });
  assert.equal(duplicate.errorCode, "MEDIA_ALREADY_STARTED");
  assert.equal(f.posts().length, 1);
  f.setMode("secret-error");
  const secretError = await f.call({ operation: "image", prompt: "boat" });
  assert.equal(secretError.ok, false);
  assert.ok(!JSON.stringify(secretError).includes("fixture-platform-key"));
  assert.ok(!(await readFile(secretError.content.recovery.receipt, "utf8")).includes("fixture-platform-key"));
  assert.equal(f.posts().length, 2);
});

test("cancel before submission performs no work; cancelling an in-flight download preserves task recovery", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.call({ operation: "image", prompt: "boat" }, { signal: controller.signal })).errorCode, "CANCELLED");
  assert.equal(f.calls.length, 0);
  const created = await f.call({ operation: "video-create", prompt: "boat" });
  f.setMode("hold-content");
  const started = f.nextRequest((row) => row.url.endsWith("/content"));
  const abort = new AbortController();
  const running = f.call({ operation: "video-download", receipt: created.content.result.receipt }, { signal: abort.signal });
  await started;
  abort.abort();
  const cancelled = await running;
  assert.equal(cancelled.errorCode, "CANCELLED");
  assert.equal(cancelled.content.recovery.taskId, "task_fixture");
  f.setMode("normal");
  const resumed = await f.call({ operation: "video-download", receipt: cancelled.content.recovery.receipt });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(f.posts().length, 1);
});

test("process timeout retains an unknown submission receipt and never retries", async (t) => {
  const f = await fixture(t, { options: { timeoutMs: 1500 } });
  f.setMode("hold-post");
  const result = await f.call({ operation: "video-create", prompt: "boat" });
  assert.equal(result.errorCode, "TIMEOUT");
  assert.equal(result.content.recovery.submissionState, "submitting");
  assert.equal(result.content.recovery.noAutomaticResubmit, true);
  assert.equal(f.posts().length, 1);
});

test("missing Python gives installation guidance without installing or making HTTP calls", async (t) => {
  const f = await fixture(t, { options: { python: { command: "/nonexistent-platform-media-python" } } });
  const result = await f.call({ operation: "image", prompt: "boat" });
  assert.equal(result.errorCode, "PYTHON_REQUIRED");
  assert.match(result.content.message, /Python 3\.9/);
  assert.match(result.content.message, /python\.org/);
  assert.equal(f.requests.length, 0);
});

test("failed and corrupt video results never claim artifact delivery", async (t) => {
  const f = await fixture(t);
  f.setMode("failed");
  const failed = await f.call({ operation: "video-download", taskId: "task_fixture" });
  assert.equal(failed.ok, false);
  const journal = JSON.parse(await readFile(failed.content.recovery.receipt, "utf8"));
  assert.equal(journal.billing.verified, true);
  assert.equal(journal.billing.net_usd, 0);
  f.setMode("corrupt-video");
  const corrupt = await f.call({ operation: "video-download", taskId: "task_fixture" });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.content.result, undefined);
  assert.equal(f.posts().length, 0);
});
