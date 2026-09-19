import { expect, it, vi } from "vitest";
import { ExtensionModelCompletions } from "./model-complete-client.js";

const model = { provider: "other", id: "reviewer" };
const context = { messages: [{ role: "user" as const, content: "Review", timestamp: 1 }] };

it("forwards caller cancellation, runtime abort and disposal to the host and releases listeners", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host = { call: async <T>(method: string, params: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "extensions.model.complete") return new Promise<T>(() => {});
    return {} as T;
  } };
  const client = new ExtensionModelCompletions(host, "s");
  for (const action of ["caller", "runtime", "dispose"]) {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = client.complete("ext", model, context, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "TURN_ABORTED" });
    if (action === "caller") controller.abort();
    if (action === "runtime") client.abort();
    if (action === "dispose") client.dispose();
    await rejected;
    expect(remove).toHaveBeenCalled();
  }
  expect(calls.filter((call) => call.method === "extensions.model.cancel")).toHaveLength(3);
  await expect(client.complete("ext", model, context)).rejects.toMatchObject({ errorCode: "TURN_ABORTED" });
});

it("rejects a pre-aborted signal without starting a provider request", async () => {
  const call = vi.fn();
  const client = new ExtensionModelCompletions({ call }, "s");
  await expect(client.complete("ext", model, context, { signal: AbortSignal.abort() })).rejects.toMatchObject({ errorCode: "TURN_ABORTED" });
  expect(call).not.toHaveBeenCalled();
});

it("rejects malformed JavaScript arguments before acquiring request resources", async () => {
  const call = vi.fn();
  const client = new ExtensionModelCompletions({ call }, "s");
  // Reflect invokes the same boundary that an untyped JavaScript extension uses.
  await expect(Reflect.apply(client.complete, client, ["ext", undefined, context])).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  await expect(Reflect.apply(client.complete, client, ["ext", model, context, { signal: "invalid" }])).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  client.abort();
  expect(call).not.toHaveBeenCalled();
});

it("image requests use the same runtime cancellation ownership", async () => {
  const methods: string[] = [];
  const client = new ExtensionModelCompletions({ async call<T>(method: string): Promise<T> {
    methods.push(method);
    if (method === "extensions.model.generateImages") return new Promise<T>(() => {});
    return {} as T;
  } }, "s");
  const pending = client.generateImages("ext", model, { input: [{ type: "text", text: "A circle" }] });
  const rejected = expect(pending).rejects.toMatchObject({ errorCode: "TURN_ABORTED" });
  client.dispose();
  await rejected;
  expect(methods).toEqual(["extensions.model.generateImages", "extensions.model.cancel"]);
});
