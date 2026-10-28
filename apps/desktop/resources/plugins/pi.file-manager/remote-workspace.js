"use strict";

const fail = (code, message) => Object.assign(new Error(message), { code });
const isRemoteWorkspace = (workspace) => workspace?.path?.startsWith("remote-project:") === true;

function remoteRelativePath(raw, workspace) {
  if (typeof raw !== "string" || /[\u0000-\u001f]/.test(raw)) throw fail("INVALID_PATH", "invalid remote file path");
  let ref = raw.replace(/\\/g, "/");
  if (ref.startsWith("/") || /^[a-zA-Z]:/.test(ref)) {
    const root = workspace.remote.path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!ref.startsWith(`${root}/`)) throw fail("REMOTE_PATH_FORBIDDEN", "file is outside the remote workspace");
    ref = ref.slice(root.length + 1);
  }
  const parts = ref.split("/").filter(part => part && part !== ".");
  if (parts.includes("..")) throw fail("REMOTE_PATH_FORBIDDEN", "file is outside the remote workspace");
  return parts.join("/");
}

/** No Node filesystem or child-process access: the public Host gateway owns remote reads. */
async function invokeRemote(api, workspace, channel, payload, { isDenied, maxListEntries }) {
  if (!workspace.remote?.path || workspace.remote.readOnly !== true) {
    throw fail("REMOTE_UNSUPPORTED", "Upgrade Desktop and pi-host to browse remote files");
  }
  if (!["fm.list", "fm.read"].includes(channel)) {
    throw fail("REMOTE_READ_ONLY", "Remote workspaces support directory browsing and text/image preview only");
  }
  const ref = remoteRelativePath(payload.path ?? "", workspace);
  if (isDenied(ref, "read")) throw fail("REMOTE_PATH_FORBIDDEN", "credential paths cannot be read");
  const method = channel === "fm.list" ? "list" : "readPreview";
  if (typeof api.fs?.[method] !== "function") throw fail("REMOTE_UNSUPPORTED", "Upgrade Desktop and pi-host to browse remote files");
  const result = await api.fs[method](ref, { workspacePath: workspace.path });
  const current = await api.workspace.get();
  if (current?.path !== workspace.path || current.remote?.path !== workspace.remote.path) {
    throw fail("WORKSPACE_CHANGED", "The workspace changed while the file was loading");
  }
  if (channel === "fm.list") {
    if (!Array.isArray(result)) throw fail("INVALID_RESPONSE", "Host returned an invalid remote directory");
    return { ok: true, path: ref, entries: result.slice(0, maxListEntries),
      truncated: result.length > maxListEntries, ignoreActive: false, git: { available: false } };
  }
  if (!result || !Number.isFinite(result.mtimeMs) || !Number.isSafeInteger(result.size) || result.size < 0) {
    throw fail("INVALID_RESPONSE", "Host returned invalid remote file metadata");
  }
  const base = { ok: true, path: ref, size: result.size, mtimeMs: result.mtimeMs, readOnly: true };
  if (result.kind === "text" && typeof result.content === "string") {
    const bom = result.content.startsWith("\ufeff");
    const text = bom ? result.content.slice(1) : result.content;
    const eol = text.includes("\r\n") ? "crlf" : "lf";
    return { ...base, kind: "text", text: eol === "crlf" ? text.replace(/\r\n/g, "\n") : text, bom, eol, git: null };
  }
  if (result.kind === "image" && typeof result.dataUrl === "string") {
    const mime = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(result.dataUrl)?.[1];
    if (!mime) throw fail("INVALID_RESPONSE", "Host returned an invalid remote image");
    return { ...base, kind: "image", mime, dataUri: result.dataUrl };
  }
  if (result.kind === "tooLarge") {
    return { ...base, kind: "tooLarge", limit: /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(ref) ? 5 * 1024 * 1024 : 512 * 1024 };
  }
  if (result.kind === "binary") return { ...base, kind: "binary" };
  throw fail("INVALID_RESPONSE", "Host returned an invalid remote preview");
}

module.exports = { isRemoteWorkspace, invokeRemote };
