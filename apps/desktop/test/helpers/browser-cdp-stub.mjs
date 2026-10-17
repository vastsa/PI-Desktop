/**
 * Controllable stand-in for `./browser-cdp`, loaded in place of the real
 * module by helpers/browser-cdp-stub-hook.mjs. Tests install per-method
 * behavior: methods named in `hang` never settle (the "page opened a native
 * dialog" case), everything else resolves with a fixture value. Every call
 * is recorded, and `detached` collects the WebContents the deadline handler
 * detached.
 */
export class BrowserCdp {
  static current = null;

  constructor() {
    this.hang = new Set();
    this.calls = [];
    this.detached = [];
    BrowserCdp.current = this;
  }

  run(method, result) {
    this.calls.push(method);
    if (this.hang.has(method)) return new Promise(() => {});
    return Promise.resolve(result);
  }

  snapshot() {
    return this.run("snapshot", { tree: "fixture-tree", url: "fixture://page", title: "Fixture" });
  }

  screenshot(_wc, input) {
    return this.run("screenshot", { mimeType: "image/jpeg", data: `shot:${JSON.stringify(input ?? {})}` });
  }

  click(_wc, uid) {
    return this.run("click", { uid });
  }

  fill(_wc, uid, text) {
    return this.run("fill", { uid, text });
  }

  evaluate(_wc, expression) {
    return this.run("evaluate", { expression });
  }

  send(_wc, method, params) {
    return this.run(method, { method, params });
  }

  attach() {
    this.calls.push("attach");
  }

  detach(wc) {
    this.calls.push("detach");
    this.detached.push(wc);
  }

  console() {
    return [];
  }
}
