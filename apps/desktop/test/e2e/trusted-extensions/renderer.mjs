/** Inspect the real renderer; assertions wait on observable dialog state. */
export async function connectRenderer(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!target) throw new Error("Missing Electron renderer target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(String(data));
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(new Error(reply.error.message));
    else waiter.resolve(reply.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async waitForDialog(present) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const reply = await call("Runtime.evaluate", { expression: "Boolean(document.querySelector('[aria-labelledby^=\"extension-prompt-\"]'))", returnByValue: true });
        if (reply.result?.value === present) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Extension dialog did not become ${present ? "visible" : "absent"}`);
    },
    async screenshot() { return (await call("Page.captureScreenshot", { format: "png" })).data; },
    close() { socket.close(); },
  };
}
