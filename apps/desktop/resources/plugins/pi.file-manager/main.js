"use strict";

/**
 * 文件管理器 — PI-Desktop 插件主进程
 *
 * 插件 id: pi.file-manager
 * 视图:    contributes.views[0] → views/index.html（右侧工作面板）
 *
 * 为什么用原生 node:fs：
 *   宿主的 pi.fs.* 网关做不到本插件的核心诉求——manifest.fs 的 write/delete
 *   在语法上就禁止整树通配（plugin-sdk fs-policy.ts isWholeTreePattern），任何
 *   一个能通过校验的窄 scope 都会让「保存」变成每次都弹权限确认；而 fs.list /
 *   fs.glob 还有条数上限、跳过 node_modules、屏蔽凭据路径，并且没有创建 /
 *   重命名 / 移动。官方文档也承认这个边界：brokered gate「约束不了插件进程里
 *   的直接 Node 访问」（docs/spec/05-security/01-security.md）。
 *
 * 因此本插件自己承担全部安全责任：
 *   ① 路径包含：规范化 + realpath 双重校验，拒绝 .. 与符号链接 / junction 逃逸
 *   ② 敏感路径黑名单：.env* / .ssh / *.pem / .git/** 等读写全拒
 *   ③ 原子写：临时文件 → fsync → chmod → rename，中断不留半写文件
 *   ④ 冲突检测：mtimeMs + size 作为乐观锁，外部改动过的文件不静默覆盖
 *   ⑤ 写入审计：追加到插件数据目录 write-audit.jsonl（宿主审计不到这条路径）
 *   ⑥ 上限：文本预览 2 MiB / 图片 8 MiB / 音视频与 PDF 24 MiB / 写入 8 MiB /
 *      单目录 3000 条 / 搜索分页（二进制预览走 base64，所以单独设限）
 *   ⑦ 宿主请求打开：宿主可以要求视图打开项目之外的文件（会话临时目录 / 附件，
 *      路径由宿主自己选定）。视图带 external: true 时才放行绝对路径，这条路径
 *      不做根内包含校验（它本来就在根外），黑名单与 realpath 检查照旧全量生效。
 *   ⑧ 项目组（0.5.0）：宿主可以把一个项目注册成多个本地文件夹（roots）。本插件
 *      同一时刻**只认一个** root 作为包含基点——当前选中的那个（记忆在
 *      prefs.projectRoots，按 projectId 记忆、缺 projectId 时按主根路径）。基点
 *      绝不放大成「整个组的并集」：换基点只是换一扇门，门后的规则一条不变。
 *   ⑨ git 联动（0.7.0）：状态与差异来自工作区里真实存在的 git（只读子命令
 *      status / diff / rev-parse，见下面「git 状态」一节），不是自己解析 .git/**。
 *      git 缺失 / 非仓库 / 超时都只是「没有状态」，绝不牵连列目录与读写。
 *
 * 通道：视图 window.pluginBridge.invoke("fm.*", payload) → onPanelInvoke。
 *   宿主对自定义通道的转发超时是 30s（plugin-runtime.ts PLUGIN_PANEL_TIMEOUT_MS），
 *   所以任何遍历类操作都必须分页，绝不整树递归返回。
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { isRemoteWorkspace, invokeRemote } = require("./remote-workspace.js");

// ── 上限 ────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 3000;
/** prefs.projectRoots 最多记多少个项目；超出按最久没用过的淘汰。 */
const MAX_PROJECT_ROOTS = 20;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_SCANNED = 200000;
const SEARCH_BUDGET_MS = 3000;
const MAX_SEARCH_SESSIONS = 4;
const AUDIT_MAX_BYTES = 1024 * 1024;

/**
 * 图片 / 音视频走 data URI 交给视图：面板是 file:// 的沙箱页，没有文件系统，
 * 相对路径只会指向视图自身，所以字节必须随响应带过去（base64 会膨胀约 1/3，
 * 这也是这两类各有独立上限的原因）。
 *
 * 只列 Chromium 真能解码的格式。TIFF 故意不在列——浏览器放不出来，硬认成
 * 图片只会得到一张破图，让它落到二进制分支、明确说「不支持预览」更诚实。
 * SVG 走 <img>，脚本不会执行（图片上下文是只读渲染，不是文档上下文）。
 */
const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
]);

const MEDIA_MIME = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".ogv", "video/ogg"],
  [".mkv", "video/x-matroska"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/opus"],
  [".weba", "audio/webm"],
]);

// ── 敏感路径黑名单（读与写都拒绝） ──────────────────────────────────────────

const DENY_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  "_netrc",
]);
const DENY_EXACT_NAMES = new Set([".env"]);
const DENY_NAME_PREFIXES = [".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const DENY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

/** 写入额外拒绝：依赖目录体量巨大且几乎不可能手改。 */
const WRITE_DENY_SEGMENTS = new Set(["node_modules"]);

/** 忽略规则文件名；项目里一个都没有时不过滤任何条目。 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore"];

// ── 模块状态 ────────────────────────────────────────────────────────────────

/**
 * mdPreview / csvTable / jsonTree 的默认值不同，是刻意的：
 * CSV 基本是纯数据，打开就想看表格；JSON 多半是 package.json / tsconfig.json
 * 这类配置，打开就想改文本。两边都只需点一下切换器换到另一侧。
 */
let dataPath = null;
let prefs = {
  splitRatio: 0.32,
  /** 左侧文件列表是否收起；宿主请求打开文件时视图会强制收起并持久化。 */
  treeCollapsed: false,
  showIgnored: false,
  /**
   * 监听外部改动并自动刷新（0.8.0）。默认开；用户可以随时关掉回到「只手动刷新」。
   * 主进程那边的 fs.watch 与视图的轮询都跟着这个偏好走。
   */
  watchFiles: true,
  mdPreview: false,
  csvTable: true,
  jsonTree: false,
  tablePageSize: 1000,
  /**
   * 项目组里「当前在看哪个 folder root」的记忆：projectKey → 绝对路径。
   * projectKey = `p:<projectId>`（宿主给了 projectId）或 `r:<主根路径>`；
   * 值必须命中宿主当前给的 roots 才被信任（否则退回主根），最多
   * MAX_PROJECT_ROOTS 条，按最近写入做 LRU 淘汰。见下面「项目组与基点」。
   */
  projectRoots: {},
};
const searchSessions = new Map();

// ── 错误 ────────────────────────────────────────────────────────────────────

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function toFailure(error) {
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : "INTERNAL",
    message: String(error?.message ?? error),
  };
}

// ── 路径安全 ────────────────────────────────────────────────────────────────

/**
 * child 是否严格位于 parent 之内（child === parent 返回 false）。
 * Windows 下 path.relative 已按大小写不敏感比较公共前缀。
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function segmentsOf(relPath) {
  return String(relPath)
    .split("/")
    .filter((part) => part && part !== ".");
}

function isDenied(relPath, mode) {
  for (const segment of segmentsOf(relPath)) {
    const lower = segment.toLowerCase();
    if (DENY_SEGMENTS.has(lower)) return true;
    if (DENY_EXACT_NAMES.has(lower)) return true;
    if (DENY_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
    if (DENY_EXTENSIONS.has(path.extname(lower))) return true;
    if (mode === "write" && WRITE_DENY_SEGMENTS.has(lower)) return true;
  }
  return false;
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前基点：宿主给的组里**被选中**的那个 folder root。所有按相对路径解析的通道
 * （列表 / 读 / 写 / 新建 / 重命名 / 移动 / 搜索 / sqlite）都以它为包含基点。
 *
 * path / name 在 0.5.0 之前就是 workspace.path/name——那时只有一个根，也就是
 * 主根；现在多根时它是「当前选中的那个」。视图需要的组身份不在这里，见下面
 * projectGroup()：两者刻意分开，免得视图把「基点」当成「组的身份」来记忆。
 */
async function currentRoot() {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) return null;
  if (isRemoteWorkspace(workspace)) throw fail("REMOTE_UNSUPPORTED", "Remote files must use the Host read gateway");
  return rootPayload(workspace, selectedRootOf(workspace));
}

/**
 * 组形状：path / name 是组的**主根**（与 pi.workspace.get 完全一致），projectId
 * 与 roots 原样透传给视图（宿主没给就一个都不带）。视图只从这里认「这是哪个组、
 * 一共有哪些 folder」，当前看的是哪个由 prefs.projectRoots 推导。
 */
async function projectGroup() {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) return null;
  return rootPayload(workspace, primaryRootOf(rootsOf(workspace)));
}

/** 把一个 root 包成发给视图的形状（基点路径 + 名字 + 组信息）。 */
function rootPayload(workspace, root) {
  const group = groupRoots(workspace);
  return {
    path: root.path,
    name: root.name,
    ...(workspace.remote ? { remote: workspace.remote } : {}),
    ...(typeof workspace.projectId === "string" && workspace.projectId
      ? { projectId: workspace.projectId }
      : {}),
    ...(group ? { roots: group } : {}),
  };
}

/** 把相对根目录的正斜杠路径规范化；拒绝绝对路径与 `..` 段。 */
function normalizeRelative(relPath) {
  if (typeof relPath !== "string") throw fail("INVALID_PATH", "path must be a string");
  if (path.isAbsolute(relPath)) throw fail("ABSOLUTE_PATH", "absolute paths are not accepted");
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (segmentsOf(rel).some((part) => part === "..")) {
    throw fail("ESCAPE", "path escapes the project root");
  }
  return rel;
}

/**
 * 所有通道的唯一入口守卫。返回 { root, rootPath, abs, rel, isRoot }。
 */
async function resolveInsideRoot(relPath, { mode = "read", allowRoot = false } = {}) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;
  const rel = normalizeRelative(relPath);

  if (!rel) {
    if (!allowRoot) throw fail("INVALID_PATH", "the project root is not a valid target here");
    return { root, rootPath, abs: rootPath, rel: "", isRoot: true };
  }

  if (isDenied(rel, mode)) throw fail("DENIED_PATH", `refused path: ${rel}`);

  const abs = path.resolve(rootPath, rel);
  if (!isInside(rootPath, abs)) throw fail("ESCAPE", "path escapes the project root");

  let realRoot;
  try {
    realRoot = await fs.realpath(rootPath);
  } catch {
    realRoot = rootPath;
  }

  // 父目录必须真实存在且落在根内：这是符号链接 / junction 逃逸的主闸门。
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(abs));
  } catch {
    throw fail("NOT_FOUND", "parent directory does not exist");
  }
  if (realParent !== realRoot && !isInside(realRoot, realParent)) {
    throw fail("SYMLINK_ESCAPE", "parent directory resolves outside the project root");
  }

  if (await exists(abs)) {
    let realAbs;
    try {
      realAbs = await fs.realpath(abs);
    } catch {
      realAbs = abs;
    }
    if (realAbs !== realRoot && !isInside(realRoot, realAbs)) {
      throw fail("SYMLINK_ESCAPE", "path resolves outside the project root");
    }
  }

  return { root, rootPath, abs, rel, isRoot: false };
}

/** 绝对路径判定：POSIX 根、Windows 盘符、UNC（`\\server\share`）。 */
function isAbsolutePath(target) {
  return /^\//.test(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\");
}

/** 黑名单按 POSIX 段切分，所以外部路径里的 `\` 先统一成 `/`。 */
function denyPathOf(target) {
  return String(target).replace(/\\/g, "/");
}

/**
 * 项目之外的绝对路径——宿主请求视图打开的文件（会话临时目录 / 附件），路径由
 * 宿主自己选定，本来就在项目根外。
 *
 * 与 resolveInsideRoot 的唯一区别是不做根内包含校验：对这条路径做包含校验没有
 * 意义。黑名单照旧全量生效，而且「原始字符串 / 规范化后 / realpath 之后」各查
 * 一遍，免得 `..` 折叠或符号链接把 .ssh 这类段藏起来。
 */
async function resolveExternal(rawPath, mode) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw fail("INVALID_PATH", "path must be a non-empty string");
  }
  if (!isAbsolutePath(rawPath)) {
    throw fail("INVALID_PATH", "external mode requires an absolute path");
  }

  const abs = path.resolve(rawPath);
  if (isDenied(denyPathOf(rawPath), mode) || isDenied(denyPathOf(abs), mode)) {
    throw fail("DENIED_PATH", `refused path: ${abs}`);
  }

  // 父目录必须真实存在（写新文件也一样），且真实路径不在黑名单里。
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(abs));
  } catch {
    throw fail("NOT_FOUND", "parent directory does not exist");
  }
  if (isDenied(denyPathOf(realParent), mode)) {
    throw fail("DENIED_PATH", `refused path: ${realParent}`);
  }

  if (await exists(abs)) {
    let realAbs;
    try {
      realAbs = await fs.realpath(abs);
    } catch {
      realAbs = abs;
    }
    if (isDenied(denyPathOf(realAbs), mode)) {
      throw fail("DENIED_PATH", `refused path: ${realAbs}`);
    }
  }

  // rel 直接取绝对路径：外部路径没有「相对根」的形态，响应里的 path 就是它，
  // 视图把这个字符串原样带回来读写。
  return { abs, rel: abs };
}

/**
 * 读 / 写共用的目标解析。三种形态：
 *   payload 带 `external: true` → 项目外绝对路径（宿主请求打开它自己选定的文件）
 *   绝对路径                    → 组内某个 root 下的绝对路径（0.5.0，可跨 folder）
 *   其余                        → 相对「当前选中的 root」的路径
 */
async function resolveTarget(payload, mode) {
  const rawPath = payload?.path ?? "";
  if (payload?.external === true) return resolveExternal(rawPath, mode);
  if (isAbsolutePath(rawPath)) return resolveGroupAbsolute(rawPath, mode);
  return resolveInsideRoot(rawPath, { mode });
}

/**
 * 绝对路径的「组内」形态：宿主给的绝对路径可能落在同一个项目的另一个 folder
 * root 里。找到包含它的 root 就切过去，再按「相对那个 root」的路径走原有守卫——
 * 绝对路径本身绝不当基点用，包含基仍然是单独一个 root。
 *
 * 落在组外的一律拒绝。组外只有一条合法入口：视图显式带 `external: true` 的
 * 项目外路径，那条路仍归 resolveExternal 管。
 */
async function resolveGroupAbsolute(rawPath, mode) {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) throw fail("NO_WORKSPACE", "no project is open");

  const abs = path.resolve(rawPath);
  const roots = rootsOf(workspace);
  const exact = matchRoot(roots, abs);
  const hit = exact ?? roots.find((entry) => isInside(entry.path, abs)) ?? null;
  if (!hit) {
    throw fail("ABSOLUTE_PATH", "absolute paths are only accepted under a registered folder root");
  }

  await selectRoot(workspace, hit.path);
  if (exact) return resolveInsideRoot("", { mode, allowRoot: true });
  return resolveInsideRoot(relativeToRoot(hit.path, abs), { mode });
}

// ── 项目组与基点（0.5.0） ────────────────────────────────────────────────────
//
// 宿主可以把一个项目注册成多个本地文件夹（roots）。本插件同一时刻只以「当前
// 选中的那个 root」为包含基点：.. / 符号链接 / 凭据黑名单这些规则一条都没放松，
// 只是换了扇门（绝不放大成「整个组的并集」）。
//
// 选中的是哪个：prefs.projectRoots 是**唯一**真相 —— projectKey → 绝对路径。
// projectKey 是 `p:<projectId>`（宿主给了 projectId 时）或 `r:<主根路径>`。视图
// 与主进程都按它推导基点，所以切基点必须先把这份记忆落盘，再发下一个通道请求。
//
/**
 * 去尾部分隔符、把反斜杠统一成正斜杠后的比较形态。
 *
 * 宿主给的目录是正斜杠（`C:/Users/me/Docs`），而这里（`sanitizePrefs`）会用 Node 的
 * `path.resolve()` 把记忆里的值写成反斜杠（`C:\Users\me\Docs`）。同一个目录的这两种
 * 写法必须算同一个目录，否则「切到 B 之后记住」在写盘那一刻就自己失效了：视图用原样
 * 字符串还能匹配（头部名字会换），这里匹配不上就退回主目录（列表不换）。
 */
function canonicalPath(target) {
  const trimmed = String(target).replace(/[\\/]+$/, "");
  return (trimmed || String(target)).replace(/\\/g, "/");
}

/** 同一个目录的两种写法（Windows 盘符 / 路径大小写、末尾斜杠）。 */
function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** roots 里按路径命中一个 root：先精确比，再忽略大小写比一次。 */
function matchRoot(roots, target) {
  return (
    roots.find((entry) => entry.path === target) ??
    roots.find((entry) => samePath(entry.path, target)) ??
    null
  );
}

/** 相对某个 root 的 POSIX 相对路径（调用前必须已确认落在该 root 内）。 */
function relativeToRoot(rootPath, abs) {
  return path.relative(rootPath, abs).split(path.sep).join("/");
}

/**
 * 宿主给的 roots 规整结果；宿主没送（或送来的全是垃圾）时返回 null —— 绝不自己
 * 造一个假的 roots 去骗视图。名字缺失时退回目录名。
 */
function groupRoots(workspace) {
  const raw = workspace?.roots;
  if (!Array.isArray(raw)) return null;
  const roots = [];
  for (const entry of raw) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue;
    roots.push({
      path: entry.path,
      name:
        typeof entry.name === "string" && entry.name
          ? entry.name
          : path.posix.basename(entry.path.replace(/\\/g, "/")),
      primary: entry.primary === true,
    });
  }
  return roots.length > 0 ? roots : null;
}

/** 内部的 root 列表：宿主没给 roots 时退化成一个根（主根 = workspace.path）。 */
function rootsOf(workspace) {
  const roots = groupRoots(workspace);
  if (roots) return roots;
  return [
    {
      path: workspace.path,
      name:
        typeof workspace.name === "string" && workspace.name
          ? workspace.name
          : path.posix.basename(workspace.path.replace(/\\/g, "/")),
      primary: true,
    },
  ];
}

function primaryRootOf(roots) {
  return roots.find((entry) => entry.primary === true) ?? roots[0];
}

/** 记忆键：优先 projectId；宿主没给就退回主根路径（前缀让两种键不会互相撞上）。 */
function projectKeyOf(workspace) {
  return typeof workspace.projectId === "string" && workspace.projectId
    ? `p:${workspace.projectId}`
    : `r:${workspace.path}`;
}

/**
 * 记忆一条「这个项目在看哪个 root」：重写一次就把这条挪到末尾，超过
 * MAX_PROJECT_ROOTS 条时丢最旧的。JS 对象保持字符串键的插入顺序，所以插入顺序
 * 本身就是最近使用顺序。
 */
function rememberProjectRoot(map, key, value) {
  const next = {};
  for (const [entryKey, entryValue] of Object.entries(map ?? {})) {
    if (entryKey === key || typeof entryValue !== "string") continue;
    next[entryKey] = entryValue;
  }
  next[key] = value;

  const keys = Object.keys(next);
  if (keys.length <= MAX_PROJECT_ROOTS) return next;
  const bounded = {};
  for (const entryKey of keys.slice(keys.length - MAX_PROJECT_ROOTS)) {
    bounded[entryKey] = next[entryKey];
  }
  return bounded;
}

/** 记忆里的 root 必须命中宿主当前给的 roots 才被信任，否则退回主根。 */
function selectedRootOf(workspace) {
  const roots = rootsOf(workspace);
  const remembered = (prefs.projectRoots ?? {})[projectKeyOf(workspace)];
  return (
    (typeof remembered === "string" ? matchRoot(roots, remembered) : null) ?? primaryRootOf(roots)
  );
}

/**
 * 换基点（绝对路径落在组里另一个 root 时用）。落盘是必须的：视图那边也按这份
 * 记忆推导基点，不写就会各说各话。返回基点是否真的变了。
 */
async function selectRoot(workspace, rootPath) {
  const key = projectKeyOf(workspace);
  const changed = !samePath((prefs.projectRoots ?? {})[key] ?? "", rootPath);
  prefs = { ...prefs, projectRoots: rememberProjectRoot(prefs.projectRoots, key, rootPath) };
  if (changed) dropRootScopedCaches();
  try {
    await pi.plugin.setSettings({ fmPrefs: prefs });
  } catch {
    /* 设置写不进去不影响本次请求：内存里的基点已经换了 */
  }
  return changed;
}

/**
 * 换基点后必须丢掉的两样按「相对路径」缓存的东西：SQLite 句柄与搜索会话——
 * 两个 root 下的同名相对路径根本不是同一个文件。
 */
function dropRootScopedCaches() {
  searchSessions.clear();
  for (const key of [...sqliteHandles.keys()]) closeSqliteHandle(key);
}

// ── 忽略规则（.gitignore / .ignore 语义子集） ────────────────────────────────
//
// 项目里存在忽略规则文件就按规则隐藏，一个都没有就全部展示。
// 子集支持：空行、# 注释、! 取反、末尾 / 仅目录、前导 / 锚定、* ? ** 通配、
// 无斜杠模式匹配任意层级。不支持 \ 转义与 [a-z] 字符类。

function compileIgnoreLine(rawLine, base) {
  let line = String(rawLine).replace(/\r$/, "");
  if (!line.trim() || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }

  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);

  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (!line) return null;
  const isAnchored = anchored || line.includes("/");

  let source = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "*") {
      if (line[index + 1] === "*") {
        index += 1;
        if (line[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }

  const pattern = isAnchored
    ? `^${source}(?:/.*)?$`
    : `^(?:.*/)?${source}(?:/.*)?$`;
  return { base, regex: new RegExp(pattern), negated, dirOnly };
}

async function readIgnoreFile(rootPath, relDir) {
  const dirAbs = relDir ? path.join(rootPath, relDir.split("/").join(path.sep)) : rootPath;
  const rules = [];
  for (const name of IGNORE_FILE_NAMES) {
    let text;
    try {
      text = await fs.readFile(path.join(dirAbs, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const rule = compileIgnoreLine(line, relDir);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/** 根 → 目标目录这一链上的全部规则（浅的在前，深的在后，深层优先）。 */
async function rulesForDirectory(rootPath, relDir) {
  const parts = segmentsOf(relDir);
  const chain = [""];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(parts.slice(0, index).join("/"));
  }
  const rules = [];
  for (const base of chain) {
    rules.push(...(await readIgnoreFile(rootPath, base)));
  }
  return rules;
}

/**
 * 命中判定。祖先目录被忽略则整体忽略（与 git 一致，取反无法把文件从
 * 被排除的目录里救回来）；否则由最后一条匹配的规则决定。
 */
function matchesRules(relPath, isDirectory, rules) {
  const parts = segmentsOf(relPath);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const target = parts.slice(0, depth).join("/");
    const targetIsDir = depth < parts.length || isDirectory;

    let verdict;
    for (const rule of rules) {
      let local = target;
      if (rule.base) {
        if (!target.startsWith(`${rule.base}/`)) continue;
        local = target.slice(rule.base.length + 1);
      }
      if (!local) continue;
      if (rule.dirOnly && !targetIsDir) continue;
      if (rule.regex.test(local)) verdict = !rule.negated;
    }

    if (verdict === undefined) continue;
    if (verdict) return true;
    if (depth === parts.length) return false;
  }
  return false;
}

// ── 审计 ────────────────────────────────────────────────────────────────────

async function audit(entry) {
  if (!dataPath) return;
  const file = path.join(dataPath, "write-audit.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  try {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size > AUDIT_MAX_BYTES) await fs.writeFile(file, line, "utf8");
    else await fs.appendFile(file, line, "utf8");
  } catch {
    /* 审计失败不应影响主流程 */
  }
}

// ── git 状态（0.7.0） ───────────────────────────────────────────────────────
//
// 文件列表里的「已修改 / 新增」标记，以及单个文件到底改了什么。
//
// 状态**不是自己解析 .git/** 得来的，而是跑工作区里真实存在的 git（只读子命令
// status / diff / rev-parse）。两条理由：
//   ① 索引格式（v2/v3/v4、扩展块、稀疏索引）、工作树状态、rename 检测、
//      .gitattributes 的 filters 与换行归一化，都要复刻一遍。自己算出来的状态
//      迟早和 git 对不上——而「和 git 对不上」正是这个功能的全部价值所在。
//   ② 插件进程跑在宿主给的最小环境里（child-process-env.ts 只放行 PATH 等少量
//      变量），git 就在 PATH 上，spawn 得到；状态也因此跟着用户的 git 版本走。
//
// 边界：
//   · 只跑只读子命令，从不传会写索引 / 联网的开关。GIT_OPTIONAL_LOCKS=0 让
//     status 不为了刷新索引去抢 .git/index.lock；GIT_TERMINAL_PROMPT=0 保证任何
//     意外的交互都变成一次立即失败，而不是把面板挂住。
//   · 每个子命令都有超时（5s）与输出上限，超了直接 kill。面板通道的总预算是 30s，
//     一次列表最多再叠一层 2s 的结果缓存。
//   · 路径仍然先过 resolveInsideRoot（根内包含 + 凭据黑名单）；传给 git 的是
//     **根相对**路径，并配 GIT_LITERAL_PATHSPECS=1——文件名里带 ":(top)" 之类
//     也不会被当成 pathspec 魔法。git 在这里只是被问了一句「这些文件怎么样」。
//   · git 缺失 / 当前文件夹不是仓库 / 超时 / 任何意外，都只是「没有状态」：
//     全部降级成 null，绝不影响列目录与读写。
//   · 子模块只看指针本身变没变（--ignore-submodules=none），不递归进子模块工作区。

const GIT_TIMEOUT_MS = 5000;
/** 同一 root 的结果缓存：一次展开目录往往连带好几次列表调用。 */
const GIT_SNAPSHOT_TTL_MS = 2000;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
/** 未跟踪文件的「全文都是新增」是自己读出来的，单独一个更紧的上限。 */
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_LINES = 20000;
/** PATH 里没有 git 时的兜底（Windows 上 git 常不在 PATH 的前半段）。 */
const GIT_FALLBACK_BINARIES = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "/opt/local/bin/git",
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
];

/** 状态严重度：目录汇总时取子树里最值得注意的那个（冲突 > 新增 > 删除 > …）。 */
const GIT_STATUS_RANK = {
  typechange: 1,
  modified: 2,
  renamed: 3,
  deleted: 4,
  added: 5,
  conflicted: 6,
};

let childSpawn = null;
/**
 * 惰性拿 child_process.spawn：万一这个运行时不给（非 Node 宿主、被裁剪的构建），
 * 用到它的功能各自静默降级（git 变「没有状态」、编辑器探测变「没有候选」），
 * 列目录、读写、保存一律照旧。
 */
function childSpawnFn() {
  if (childSpawn === null) {
    try {
      childSpawn = require("node:child_process").spawn;
    } catch {
      childSpawn = false;
    }
  }
  return childSpawn || null;
}

/** 探测成功的 git 可执行文件；null = 还没试过。 */
let gitBinary = null;

function runGit(rootPath, binary, args, { maxBytes, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const spawn = childSpawnFn();
  if (!spawn) return Promise.reject(fail("GIT_UNAVAILABLE", "child processes are unavailable"));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd: rootPath,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // 只读三件套：别抢索引锁、别开分页器、别弹交互提示。
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          // 文件名里的 pathspec 魔法一律当普通字符。
          GIT_LITERAL_PATHSPECS: "1",
          LC_ALL: "C",
        },
      });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let stderr = "";
    let settled = false;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // 超量就掐掉：面板里没人看得完 8 MiB 的状态，掐掉还少占内存。
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2048) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      finish(resolve, {
        code: code ?? 0,
        stdout: Buffer.concat(chunks),
        truncated,
        timedOut,
        stderr,
      });
    });
  });
}

/**
 * 跑一条 git 命令。第一次用 PATH 里的 `git`；ENOENT 就按常见安装位置挨个试，
 * 找到就记住（每个插件进程一次）。
 */
async function runGitCommand(rootPath, args, options = {}) {
  const candidates = gitBinary ? [gitBinary] : ["git", ...GIT_FALLBACK_BINARIES];
  for (const binary of candidates) {
    let result;
    try {
      result = await runGit(rootPath, binary, args, options);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    gitBinary = binary;
    return result;
  }
  throw fail("GIT_UNAVAILABLE", "git was not found on PATH");
}

/**
 * `git status --porcelain=v1 -z` 的解析。两列状态 + 一个路径，NUL 分隔；重命名 /
 * 复制是**两条**记录：先「新路径」（带 XY 两列），紧跟一条只有原路径的裸记录。
 */
function parsePorcelainV1(stdout) {
  const records = [];
  const fields = stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    // 空字段是结尾的 NUL；长度不足或第三位不是空格的都是裸路径（重命名的原路径）。
    if (!field || field.length < 4 || field[2] !== " ") continue;
    const x = field[0];
    const y = field[1];
    const renamed = x === "R" || x === "C";
    const origPath = renamed ? fields[index + 1] ?? "" : null;
    if (renamed) index += 1;
    records.push({ x, y, path: field.slice(3), origPath });
  }
  return records;
}

/** 两列状态 → 一个用来显示的状态 + 「暂存区里也有没有」+「是不是全新文件」。 */
function classifyRecord(record) {
  const { x, y } = record;
  if (x === "?" || y === "?") return { status: "added", staged: false, untracked: true };
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return { status: "conflicted", staged: true, untracked: false };
  }
  if (x === "R" || x === "C") return { status: "renamed", staged: true, untracked: false };
  if (x === "A") return { status: "added", staged: true, untracked: false };
  if (x === "D") return { status: "deleted", staged: true, untracked: false };
  if (y === "D") return { status: "deleted", staged: false, untracked: false };
  if (x === "T" || y === "T") return { status: "typechange", staged: x === "T", untracked: false };
  if (x === "M" || y === "M") return { status: "modified", staged: x === "M", untracked: false };
  return null;
}

/**
 * `git diff --numstat -z` 的解析：每条 `+行数\t-行数\t路径`，二进制是 `-\t-`。
 * 重命名在 -z 下是 `+行\t-行\t`（路径留空）后面跟两条裸路径，原路径在前、新路径在后。
 */
function parseNumstat(stdout) {
  const stats = new Map();
  const fields = stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const first = field.indexOf("\t");
    const second = first < 0 ? -1 : field.indexOf("\t", first + 1);
    if (second < 0) continue;
    const added = field.slice(0, first);
    const deleted = field.slice(first + 1, second);
    let filePath = field.slice(second + 1);
    if (!filePath) {
      // 重命名：紧跟的两条裸路径是 (原, 新)，统计挂在新路径上。
      filePath = fields[index + 2] ?? "";
      index += 2;
      if (!filePath) continue;
    }
    stats.set(filePath, {
      added: added === "-" ? 0 : Number(added) || 0,
      deleted: deleted === "-" ? 0 : Number(deleted) || 0,
      binary: added === "-" && deleted === "-",
    });
  }
  return stats;
}

/**
 * HEAD → 工作区的增删行数。一次 diff 就覆盖了「已暂存 + 未暂存」两层。
 * 仓库还没有任何提交（unborn HEAD）时 HEAD 不存在，退回「暂存区」与「工作区」
 * 两份再合并。
 */
async function gitNumstat(rootPath) {
  const options = { maxBytes: MAX_STATUS_BYTES };
  const head = await runGitCommand(rootPath, ["diff", "--numstat", "-z", "HEAD", "--"], options);
  if (head && head.code === 0) return parseNumstat(head.stdout);
  const [staged, worktree] = await Promise.all([
    runGitCommand(rootPath, ["diff", "--numstat", "-z", "--cached", "--"], options),
    runGitCommand(rootPath, ["diff", "--numstat", "-z", "--"], options),
  ]);
  const merged = new Map();
  for (const result of [staged, worktree]) {
    if (!result || result.code !== 0) continue;
    for (const [filePath, value] of parseNumstat(result.stdout)) merged.set(filePath, value);
  }
  return merged;
}

/**
 * 一次快照：这个工作区相对当前基点 root 的状态。
 *
 * files 的键是**根相对**路径（git 报的路径相对仓库根，而当前基点可能在仓库的
 * 子目录里，所以先减掉 `rev-parse --show-prefix` 给的前缀）；值是这一行要显示的
 * 状态与增删行数。快照为 null = 这里没有可用的状态（非仓库 / 没有 git / 出错）。
 */
async function buildGitSnapshot(rootPath) {
  const probe = await runGitCommand(rootPath, ["rev-parse", "--show-toplevel", "--show-prefix"], {
    maxBytes: 4096,
  });
  if (!probe || probe.code !== 0) return null;
  const probeLines = probe.stdout.toString("utf8").split("\n");
  if (!probeLines[0]) return null;
  const prefix = (probeLines[1] ?? "").trim();

  const [status, stats, branchResult] = await Promise.all([
    runGitCommand(
      rootPath,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      { maxBytes: MAX_STATUS_BYTES },
    ),
    gitNumstat(rootPath),
    runGitCommand(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"], { maxBytes: 4096 }).catch(
      () => null,
    ),
  ]);
  if (!status || status.code !== 0) return null;

  const files = new Map();
  for (const record of parsePorcelainV1(status.stdout)) {
    if (prefix && !record.path.startsWith(prefix)) continue;
    const rel = prefix ? record.path.slice(prefix.length) : record.path;
    if (!rel) continue;
    const classified = classifyRecord(record);
    if (!classified) continue;
    const stat = stats.get(record.path);
    files.set(rel, {
      ...classified,
      added: stat?.added ?? 0,
      deleted: stat?.deleted ?? 0,
      // 未跟踪的文件没有 numstat（git 不知道它以前长什么样），行数留给差异视图去数。
      binary: Boolean(stat?.binary),
    });
  }

  return {
    rootPath,
    files,
    truncated: status.truncated,
    // unborn 仓库与游离 HEAD 都报 "HEAD"，那不是分支名。
    branch: branchResult?.code === 0 ? branchResult.stdout.toString("utf8").trim() : null,
  };
}

/** rootPath → { at, snapshot }；同一个 root 的并发请求共用一次 git。 */
let gitCache = new Map();

/** 本插件自己改过文件之后立刻作废缓存：状态必须跟着这次保存走。 */
function invalidateGitSnapshots() {
  gitCache = new Map();
}

async function gitSnapshotFor(rootPath) {
  const cached = gitCache.get(rootPath);
  if (cached?.pending) return cached.pending;
  if (cached && Date.now() - cached.at < GIT_SNAPSHOT_TTL_MS) return cached.snapshot;

  const pending = buildGitSnapshot(rootPath)
    // 快照失败只等于「没有状态」：绝不让它把列目录 / 打开文件带崩。
    .catch(() => null)
    .then((snapshot) => {
      gitCache.set(rootPath, { at: Date.now(), snapshot });
      return snapshot;
    });
  gitCache.set(rootPath, { at: cached?.at ?? 0, snapshot: cached?.snapshot ?? null, pending });
  return pending;
}

/**
 * 把子树里的变化汇总到直接子目录上：列目录时每个子目录要一个徽标，不能对每个
 * 目录都重扫一遍全部变化（3000 个条目 × 几万条变化会卡住面板）。这里只把每条
 * 变化归到它**第一段**路径上，一次遍历就够。
 */
function rollupByChildDirectory(snapshot, rel) {
  const prefix = rel ? `${rel}/` : "";
  const groups = new Map();
  for (const [filePath, info] of snapshot.files) {
    if (prefix && !filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // 直接子文件：它自己那行有状态
    const name = rest.slice(0, slash);
    const current = groups.get(name);
    if (!current) {
      groups.set(name, { ...info, changed: 1 });
      continue;
    }
    current.changed += 1;
    current.added += info.added;
    current.deleted += info.deleted;
    current.staged = current.staged || info.staged;
    current.untracked = current.untracked || info.untracked;
    if ((GIT_STATUS_RANK[info.status] ?? 0) > (GIT_STATUS_RANK[current.status] ?? 0)) {
      current.status = info.status;
    }
  }
  // 目录的徽标只显示状态与合计行数，binary 是单文件才有的细节。
  for (const group of groups.values()) delete group.binary;
  return groups;
}

/** 列表响应里那一句「多少处改动」：只算当前基点这个 root 里的变化。 */
function summarizeGit(snapshot) {
  const counts = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 };
  let total = 0;
  for (const info of snapshot.files.values()) {
    if (info.status in counts) counts[info.status] += 1;
    total += 1;
  }
  return {
    available: true,
    branch: snapshot.branch,
    counts,
    total,
    truncated: snapshot.truncated,
  };
}

/** 打开一个文件时问一句「它有没有改动」：列表收起时右侧也要有「变更」可看。 */
async function gitInfoFor(abs, rel) {
  if (!rel) return null;
  const root = await currentRoot();
  // 项目外（宿主自选的会话临时文件 / 附件）没有根内基点，与 git 无关。
  if (!root || !isInside(root.path, abs)) return null;
  const snapshot = await gitSnapshotFor(root.path);
  return snapshot?.files.get(rel) ?? null;
}

/**
 * unified diff → 可直接渲染的段落。返回行类型（add/del/ctx）而不是原始文本，
 * 视图不必再解析一遍，也就能在这里单测。
 */
function parseUnifiedDiff(text) {
  const meta = [];
  const hunks = [];
  let binary = false;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  const rawLines = text.split("\n");
  // git 的输出以换行收尾：split 出来的最后一个空串不是一行内容，丢掉它，
  // 否则每个文件末尾都会多出一行「空白的上下文」。
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!match) {
        hunk = null;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        header: line,
        section: (match[5] ?? "").trim(),
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      // hunk 之前是文件头：diff --git / index / 模式变化 / 二进制提示。
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      else if (line) meta.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "note", text: line.slice(1).trim(), oldLine: null, newLine: null });
    } else {
      hunk.lines.push({ type: "ctx", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { meta, hunks, binary };
}

/**
 * 未跟踪文件的内容全是新增，git 自己不给差异（`--no-index` 还得造一个 /dev/null，
 * 跨平台不牢靠）。这里直接读文件、每行加前缀，语义与 git 的「新文件」一致。
 */
function untrackedDiff(text, truncated) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(0, MAX_DIFF_LINES);
  return {
    meta: ["--- /dev/null", truncated ? "+++ (truncated new file)" : "+++ (new file)"],
    binary: false,
    hunks: [
      {
        header: `@@ -0,0 +1,${kept.length} @@`,
        section: "",
        oldStart: 0,
        newStart: 1,
        lines: kept.map((line, index) => ({
          type: "add",
          text: line,
          oldLine: null,
          newLine: index + 1,
        })),
      },
    ],
  };
}

/**
 * 一个文件到底改了什么。已跟踪文件同时看「暂存区 → 工作区」与「HEAD → 暂存区」
 * 两段：只有一段有内容就只给这一段，两段都有就都列出来（标题写清楚哪来的）。
 */
async function handleGitDiff(payload) {
  // 一次解析就够：包含校验、凭据黑名单、基点都在 resolveInsideRoot 里。
  const { rootPath, abs, rel } = await resolveInsideRoot(payload?.path ?? "");
  if (!rel) throw fail("INVALID_PATH", "the project root has no changes to show");
  const snapshot = await gitSnapshotFor(rootPath);
  if (!snapshot) throw fail("GIT_UNAVAILABLE", "git status is unavailable in this folder");

  const info = snapshot.files.get(rel) ?? null;

  if (info?.untracked) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw fail("NOT_FOUND", "file not found");
    if (stat.size > MAX_UNTRACKED_DIFF_BYTES) {
      return {
        ok: true,
        path: rel,
        kind: "tooLarge",
        untracked: true,
        limit: MAX_UNTRACKED_DIFF_BYTES,
        size: stat.size,
        addedLines: 0,
        deletedLines: 0,
        sections: [],
        truncated: true,
      };
    }
    const buffer = await fs.readFile(abs);
    // 含 NUL 字节 = 二进制：逐行加前缀毫无意义，直接说清楚。
    if (buffer.subarray(0, 4096).includes(0)) {
      return {
        ok: true,
        path: rel,
        kind: "binary",
        untracked: true,
        addedLines: 0,
        deletedLines: 0,
        sections: [],
        truncated: false,
      };
    }
    const parsed = untrackedDiff(buffer.toString("utf8"), buffer.length >= MAX_UNTRACKED_DIFF_BYTES);
    return {
      ok: true,
      path: rel,
      kind: "text",
      untracked: true,
      addedLines: parsed.hunks[0].lines.length,
      deletedLines: 0,
      sections: [{ scope: "worktree", ...parsed }],
      truncated: buffer.length >= MAX_UNTRACKED_DIFF_BYTES,
    };
  }

  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "-U3", "--", rel];
  const [worktree, staged] = await Promise.all([
    runGitCommand(rootPath, diffArgs, { maxBytes: MAX_DIFF_BYTES }),
    runGitCommand(
      rootPath,
      ["diff", "--no-color", "--no-ext-diff", "-U3", "--cached", "--", rel],
      { maxBytes: MAX_DIFF_BYTES },
    ),
  ]);
  if (!worktree || worktree.code !== 0) {
    throw fail("GIT_UNAVAILABLE", worktree?.stderr?.trim() || "git diff failed");
  }

  const sections = [];
  let addedLines = 0;
  let deletedLines = 0;
  // 整个响应的行数预算：超了就把后面的 hunk 丢掉并说清楚「已截断」——界面上那句
  // 「输出已截断」必须名副其实，否则用户会以为差异就这么多。
  let budget = MAX_DIFF_LINES;
  let truncated = false;

  for (const [scope, result] of [
    ["worktree", worktree],
    ["staged", staged],
  ]) {
    if (!result || result.code !== 0 || result.stdout.length === 0) continue;
    const parsed = parseUnifiedDiff(result.stdout.toString("utf8"));
    if (parsed.hunks.length === 0 && !parsed.binary) continue;

    if (parsed.binary) {
      sections.push({ scope, meta: parsed.meta, hunks: [], binary: true, truncated: false });
      continue;
    }

    const hunks = [];
    for (const hunk of parsed.hunks) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const lines = hunk.lines.slice(0, budget);
      budget -= lines.length;
      if (lines.length < hunk.lines.length) truncated = true;
      for (const line of lines) {
        if (line.type === "add") addedLines += 1;
        else if (line.type === "del") deletedLines += 1;
      }
      hunks.push({ ...hunk, lines });
    }
    sections.push({
      scope,
      meta: parsed.meta,
      hunks,
      binary: false,
      truncated: truncated || result.truncated,
    });
  }

  return {
    ok: true,
    path: rel,
    kind:
      sections.length === 0
        ? "none"
        : sections.some((section) => section.binary)
          ? "binary"
          : "text",
    untracked: false,
    status: info,
    addedLines,
    deletedLines,
    sections,
    truncated,
  };
}

// ── 文件监听（0.8.0） ───────────────────────────────────────────────────────
//
// 「文件在编辑器之外被改了」这条链路以前只能靠用户点刷新。现在主进程用 Node 的
// fs.watch 盯着**当前基点 root**（递归），把变化去抖成一串根相对路径，视图低频
// 轮询取走。为什么是「主进程 watch + 视图轮询」而不是别的形状：
//   · 宿主没有给插件「向视图推送」的通道（pi 上只有 ui.showToast / notify 这类
//     单向通知），视图只能自己来取；那就让主进程做监听、视图只取游标增量，
//     免得视图每秒在整棵树上 stat 一遍。
//   · fs.watch 是操作系统的原生通知（macOS FSEvents / Windows
//     ReadDirectoryChangesW / Linux inotify），比轮询便宜得多，也不占通道预算。
//
// 三件必须做对的事：
//   ① **不把自己的写当成外部改动**：保存走的是「临时文件 + rename」，监听一定会
//     报。照单全收的话，用户每按一次 Ctrl+S 就会把自己的文档重新装载一遍（光标
//     与滚动位置一起丢）。所以本插件每次写盘 / 新建 / 改名 / 移动 / 删除都先记一笔
//     （noteSelfWrite），这一笔在 SELF_WRITE_SUPPRESS_MS 内到达的事件被丢掉。
//   ② **不盯噪声**：.git/ 与 node_modules/ 的变化量极大且与本视图无关；凭据类路径
//     （.env* / .ssh / *.pem…）照旧不报——监听不是绕过黑名单的后门。
//   ③ **不丢事件、也不无限增长**：去抖窗口内的事件合并成一次；增量历史有界，
//     视图拿着很旧的游标回来时只可能拿到「最近这些」，它据此做的是保守刷新，
//     不会因为少看到一次就出错。

const WATCH_DEBOUNCE_MS = 250;
const WATCH_HISTORY_LIMIT = 400;
/** 本插件自己的写在这段时间内到达的同名事件被忽略。 */
const SELF_WRITE_SUPPRESS_MS = 1500;
const WATCH_SELF_WRITE_CACHE_LIMIT = 200;
/** 一次轮询最多报多少条变化（再多，视图「刷新所在目录」已经覆盖到了）。 */
const WATCH_MAX_CHANGED = 200;

let watchSupported = true;
let watcher = null;
let watchRevision = 0;
/** 增量历史：{ revision, path }，超过上限丢最旧的。 */
let watchHistory = [];
/** 去抖窗口里收到的事件（路径去重）。 */
let watchPending = new Set();
let watchTimer = null;
/** 根相对路径 → 本插件自己写它的时间戳。 */
const selfWrites = new Map();

let fsWatch = null;
/**
 * 惰性拿 fs.watch：万一这个运行时不给（非 Node 宿主、被裁剪的构建），功能静默
 * 降级成「只有手动刷新」，与 git 缺失是同一种降级方式。
 */
function fsWatchFn() {
  if (fsWatch === null) {
    try {
      fsWatch = require("node:fs").watch;
    } catch {
      fsWatch = false;
    }
  }
  return fsWatch || null;
}

/** 噪声与不该看的东西：.git / node_modules / 凭据路径 / 本插件的临时文件。 */
function isWatchIgnored(rel) {
  if (!rel) return false;
  // 任意一层出现 .git / node_modules 都跳（只看第一段会漏掉嵌套的依赖目录）。
  if (rel.split("/").some((segment) => segment === ".git" || segment === "node_modules")) return true;
  // 原子写的临时文件：`.README.md.1730abcd.ef12.tmp`（见 atomicWrite）。
  if (/^\..+\.[a-z0-9]+\.[a-z0-9]+\.tmp$/i.test(rel.split("/").pop() ?? "")) return true;
  return isDenied(rel, "read");
}

/** 本插件自己写下的这个路径刚被监听到了？ */
function isSelfWrite(rel) {
  const at = selfWrites.get(rel);
  if (at === undefined) return false;
  if (Date.now() - at > SELF_WRITE_SUPPRESS_MS) {
    selfWrites.delete(rel);
    return false;
  }
  return true;
}

/**
 * 本插件自己动了这个路径：接下来这一小段时间里它引起的事件不算「外部改动」。
 *
 * 除了这个路径，还要把它**每一层祖先目录**一起记上：Windows 的递归监听在我们写一个
 * 文件时，会额外给「它所在的每一层目录」各报一次 `change <目录>`——文件名是给了的，
 * 只是名字是目录而不是文件（实测：写 `src/deep/x.ts` 会报 `change src/deep` 与
 * `change src`）。这几笔不记下来，自己按一次 Ctrl+S 就会被这些多余的目录事件判成
 * 「外部改动」，刚保存的文档被重装一遍——正是这一节要防的事。根目录自身不发这种
 * 目录事件（实测），所以只记到最外层目录为止。
 */
function noteSelfWrite(rel) {
  if (!rel) return;
  const stamp = Date.now();
  selfWrites.set(rel, stamp);
  for (let cut = rel.lastIndexOf("/"); cut > 0; cut = rel.lastIndexOf("/", cut - 1)) {
    selfWrites.set(rel.slice(0, cut), stamp);
  }
  if (selfWrites.size > WATCH_SELF_WRITE_CACHE_LIMIT) {
    const now = Date.now();
    for (const [key, at] of selfWrites) {
      if (now - at > SELF_WRITE_SUPPRESS_MS) selfWrites.delete(key);
    }
  }
}

function flushWatchChanges() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watchPending.size === 0) return;
  const batch = [...watchPending];
  watchPending = new Set();
  for (const rel of batch) {
    if (isSelfWrite(rel)) continue;
    watchRevision += 1;
    watchHistory.push({ revision: watchRevision, path: rel });
  }
  if (watchHistory.length > WATCH_HISTORY_LIMIT) {
    watchHistory = watchHistory.slice(-WATCH_HISTORY_LIMIT);
  }
  // 磁盘变了，git 状态与增删行数也就变了：快照当场作废，下一次列表 / 差异现算。
  invalidateGitSnapshots();
}

function noteWatchChange(rel) {
  watchPending.add(rel);
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(flushWatchChanges, WATCH_DEBOUNCE_MS);
}

function stopWatching() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  watchPending = new Set();
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* 已经关掉了 */
    }
    watcher = null;
  }
}

/** 对着基点 root 开一只递归监听。同一时刻只有一只——换基点就是换监听对象。 */
function startWatching(rootPath) {
  if (watcher?.rootPath === rootPath) return true;
  stopWatching();
  const watch = fsWatchFn();
  if (!watch) {
    watchSupported = false;
    return false;
  }
  try {
    const handle = watch(
      rootPath,
      // persistent: false —— 监听不该让插件进程一直活着；没有变化时它可以自然退出。
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        // 有些平台不提供文件名：那就只知道「根底下有东西变了」，把根本身报出去，
        // 视图据此刷新当前目录——宁可多刷一次，也不要漏掉一次。
        if (!filename) {
          noteWatchChange("");
          return;
        }
        const rel = String(filename).replace(/\\/g, "/");
        if (isWatchIgnored(rel)) return;
        noteWatchChange(rel);
      },
    );
    handle.on("error", () => {
      // 监听器自己出错了（例如根目录被删了）：退回手动刷新，不把错误抛给任何通道。
      stopWatching();
      watchSupported = false;
    });
    watcher = { rootPath, close: () => handle.close() };
    return true;
  } catch {
    // 老平台不支持 recursive watch：不假装能用，让视图把自动刷新关掉。
    watchSupported = false;
    return false;
  }
}

/**
 * 视图的轮询：拿「上次游标之后变了哪些路径」。
 *
 * 顺带做两件事——基点换了就换监听；去抖窗口快到点时把这一批现在就发出去（否则用户
 * 会多等一个去抖周期才看到刷新）。
 */
async function handleWatch(payload) {
  const root = await currentRoot();
  if (!root) return { ok: true, available: false, revision: watchRevision, changed: [] };

  if (watchSupported) startWatching(root.path);
  flushWatchChanges();

  const since = Number.isFinite(payload?.since) ? Number(payload.since) : 0;
  const changed = watchHistory
    .filter((entry) => entry.revision > since)
    .map((entry) => entry.path);

  return {
    ok: true,
    available: watchSupported && watcher !== null,
    revision: watchRevision,
    changed: changed.slice(0, WATCH_MAX_CHANGED),
    // 游标已经落到有界历史之外：视图据此也按「可能还有别的变化」做一次保守刷新。
    stale: since > 0 && watchHistory.length > 0 && since < watchHistory[0].revision,
  };
}

// ── 编辑器探测与「通过…打开」（0.9.0） ─────────────────────────────────────
//
// 树里的右键菜单要列出这台机器上**真实存在**的编辑器。探测刻意不遍历目录：
//   ① 注册表 App Paths（HKLM / WOW6432Node / HKCU）——安装器几乎都会在这里留一条
//      `<name>.exe` → 绝对路径，一次 reg query 就能批量读出来；
//   ② 注册表 StartMenuInternet 的 `shell\open\command`——浏览器（Chrome / Edge /
//      Firefox / Zen 这类）只在这里注册，而且这里给的是完整可执行文件；
//   ③ PATH 上按候选命令名找可执行文件（VS Code / Zed 会装 bin 目录）；
//   ④ 少量由用户主目录推导出来的固定安装位置，各一次 stat。
// 四者都是 O(候选数)，没有任何递归列目录——「遍历整个磁盘找软件」是这个功能最
// 容易写出来的那个错误版本，也是最慢的一个。
//
// 结果按**日期**缓存一天，写进插件数据目录（editors.json）：多个 PI-Desktop 实例
// 共享同一次探测，同一天里再打开菜单不会重复跑注册表。写盘失败只是退回「本进程内
// 缓存」，功能不受影响；探测不到时菜单里就只剩「默认应用」一项——绝不摆一个点了
// 没反应的编辑器上去。
//
// 只跑得到 .exe 的才算数（Windows）：.cmd / .bat 这类 shim 需要经 cmd.exe 执行，
// 而把用户项目里的路径拼进命令行是多余的注入面。App Paths 与 PATH 上的编辑器
// 几乎总能给出真正的 .exe，所以这条限制不会漏掉它们。

const EDITOR_CACHE_FILE = "editors.json";
const EDITOR_PROBE_TIMEOUT_MS = 4000;
const EDITOR_PROBE_MAX_BYTES = 512 * 1024;

/** 缓存按「日期」判定（本地时区），不是时间戳：一天只探测一次。 */
function todayStamp() {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 惰性拿同步 fs（探测里只做几次 stat，异步反而更啰嗦）。 */
let fsSync = null;
function fsSyncFn() {
  if (fsSync === null) {
    try {
      fsSync = require("node:fs");
    } catch {
      fsSync = false;
    }
  }
  return fsSync || null;
}

function isFileSync(target) {
  const sync = fsSyncFn();
  if (!sync || !target) return false;
  try {
    return sync.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * PATH 上查一个命令时尝试的文件名，按优先级排列（纯函数，verify-editors 直接断言）。
 * 只有 .exe 会被采纳：见文件头关于 shim 的说明。
 */
function pathLookupOrder(name, platform, pathext) {
  if (platform !== "win32") return [name];
  const extensions = String(pathext || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!extensions.includes(".exe")) extensions.unshift(".exe");
  const ordered = [".exe", ...extensions.filter((entry) => entry !== ".exe")];
  return ordered.map((extension) => `${name}${extension}`);
}

/** PATH 目录列表 + 候选文件名 → 第一个真实存在的文件（不遍历目录，只 stat 候选）。 */
function findOnPath(name) {
  const dirs = String(process.env.PATH || "")
    .split(PLATFORM === "win32" ? ";" : ":")
    .map((entry) => entry.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
  const names = pathLookupOrder(name, PLATFORM, process.env.PATHEXT);
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (isFileSync(full)) return full;
    }
  }
  return null;
}

const PLATFORM = process.platform;

/**
 * 常见编辑器与浏览器。`appPaths` 是注册表里的键名（小写比较），`commands` 是 PATH
 * 上的命令名，`fixed` 是由用户主目录推导出来的固定安装位置。三者按顺序取第一个命中，
 * 命中后再 stat 一次确认文件真的还在（注册表常留下已经卸载的条目）。
 */
function editorCandidates() {
  if (PLATFORM === "darwin") return macEditorCandidates();
  if (PLATFORM === "win32") return windowsEditorCandidates();
  return linuxEditorCandidates();
}

function windowsEditorCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const local = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  const programs = process.env.ProgramFiles || "C:\\Program Files";
  const programsX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const inLocal = (...rest) => (local ? [path.join(local, ...rest)] : []);
  const inPrograms = (...rest) => [
    path.join(programs, ...rest),
    path.join(programsX86, ...rest),
  ];

  return [
    {
      id: "vscode",
      label: "Visual Studio Code",
      appPaths: ["code.exe"],
      commands: ["code"],
      fixed: [
        ...inLocal("Programs", "Microsoft VS Code", "Code.exe"),
        ...inPrograms("Microsoft VS Code", "Code.exe"),
      ],
    },
    {
      id: "vscode-insiders",
      label: "Visual Studio Code Insiders",
      appPaths: ["code - insiders.exe"],
      commands: ["code-insiders"],
      fixed: [...inLocal("Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe")],
    },
    {
      id: "cursor",
      label: "Cursor",
      appPaths: ["cursor.exe"],
      commands: ["cursor"],
      fixed: [...inLocal("Programs", "cursor", "Cursor.exe")],
    },
    {
      id: "windsurf",
      label: "Windsurf",
      appPaths: ["windsurf.exe"],
      commands: ["windsurf"],
      fixed: [...inLocal("Programs", "Windsurf", "Windsurf.exe")],
    },
    {
      id: "trae",
      label: "Trae",
      appPaths: ["trae.exe"],
      commands: ["trae"],
      fixed: [...inLocal("Programs", "Trae", "Trae.exe")],
    },
    {
      id: "zed",
      label: "Zed",
      appPaths: ["zed.exe"],
      commands: ["zed"],
      fixed: [...inLocal("Programs", "Zed", "Zed.exe")],
    },
    {
      id: "sublime",
      label: "Sublime Text",
      appPaths: ["sublime_text.exe", "subl.exe"],
      commands: ["subl"],
      fixed: [...inPrograms("Sublime Text", "sublime_text.exe")],
    },
    {
      id: "notepadpp",
      label: "Notepad++",
      appPaths: ["notepad++.exe"],
      commands: ["notepad++"],
      fixed: [...inPrograms("Notepad++", "notepad++.exe")],
    },
    {
      id: "chrome",
      label: "Google Chrome",
      kind: "browser",
      appPaths: ["chrome.exe"],
      menus: ["google chrome"],
      commands: ["chrome"],
      fixed: [
        ...inPrograms("Google", "Chrome", "Application", "chrome.exe"),
        ...inLocal("Google", "Chrome", "Application", "chrome.exe"),
      ],
    },
    {
      id: "edge",
      label: "Microsoft Edge",
      kind: "browser",
      appPaths: ["msedge.exe"],
      menus: ["microsoft edge"],
      fixed: [...inPrograms("Microsoft", "Edge", "Application", "msedge.exe")],
    },
    {
      id: "firefox",
      label: "Firefox",
      kind: "browser",
      appPaths: ["firefox.exe"],
      menus: ["firefox", "firefox.exe"],
      fixed: [...inPrograms("Mozilla Firefox", "firefox.exe")],
    },
    {
      id: "zen",
      label: "Zen Browser",
      kind: "browser",
      appPaths: ["zen.exe"],
      menus: ["zen", "zen browser", "zen.exe"],
      commands: ["zen"],
      fixed: [
        ...inLocal("Zen", "zen.exe"),
        ...inLocal("Programs", "Zen", "zen.exe"),
        ...inPrograms("Zen Browser", "zen.exe"),
      ],
    },
  ];
}

function macEditorCandidates() {
  const home = process.env.HOME || "";
  const apps = "/Applications";
  return [
    {
      id: "vscode",
      label: "Visual Studio Code",
      commands: ["code", "code-insiders"],
      fixed: [
        path.join(apps, "Visual Studio Code.app", "Contents", "MacOS", "Electron"),
        path.join(home, ".local", "bin", "code"),
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      commands: ["cursor"],
      fixed: [path.join(apps, "Cursor.app", "Contents", "MacOS", "Cursor")],
    },
    {
      id: "windsurf",
      label: "Windsurf",
      commands: ["windsurf"],
      fixed: [path.join(apps, "Windsurf.app", "Contents", "MacOS", "Windsurf")],
    },
    {
      id: "zed",
      label: "Zed",
      commands: ["zed"],
      fixed: [
        path.join(apps, "Zed.app", "Contents", "MacOS", "zed"),
        path.join(home, ".local", "bin", "zed"),
      ],
    },
    {
      id: "sublime",
      label: "Sublime Text",
      commands: ["subl"],
      fixed: [path.join(apps, "Sublime Text.app", "Contents", "SharedSupport", "bin", "subl")],
    },
    {
      id: "nova",
      label: "Nova",
      commands: ["nova"],
      fixed: [path.join(apps, "Nova.app", "Contents", "MacOS", "nova")],
    },
    {
      id: "chrome",
      label: "Google Chrome",
      kind: "browser",
      commands: [],
      fixed: [path.join(apps, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")],
    },
    {
      id: "firefox",
      label: "Firefox",
      kind: "browser",
      commands: [],
      fixed: [path.join(apps, "Firefox.app", "Contents", "MacOS", "firefox")],
    },
    {
      id: "zen",
      label: "Zen Browser",
      kind: "browser",
      commands: ["zen"],
      fixed: [
        path.join(apps, "Zen.app", "Contents", "MacOS", "zen"),
        path.join(apps, "Zen Browser.app", "Contents", "MacOS", "zen"),
      ],
    },
  ];
}

function linuxEditorCandidates() {
  const home = process.env.HOME || "";
  const bin = "/usr/bin";
  const share = [
    path.join(bin, "code"),
    "/usr/share/code/code",
    "/snap/bin/code",
    path.join(home, ".local", "bin", "code"),
  ];
  return [
    { id: "vscode", label: "Visual Studio Code", commands: ["code"], fixed: share },
    {
      id: "cursor",
      label: "Cursor",
      commands: ["cursor"],
      fixed: [path.join(bin, "cursor"), path.join(home, ".local", "bin", "cursor")],
    },
    {
      id: "zed",
      label: "Zed",
      commands: ["zed"],
      fixed: [path.join(bin, "zed"), "/usr/local/bin/zed", path.join(home, ".local", "bin", "zed")],
    },
    {
      id: "sublime",
      label: "Sublime Text",
      commands: ["subl"],
      fixed: [path.join(bin, "subl"), "/opt/sublime_text/sublime_text"],
    },
    {
      id: "notepadqq",
      label: "Notepadqq",
      commands: ["notepadqq"],
      fixed: [path.join(bin, "notepadqq")],
    },
    {
      id: "chrome",
      label: "Google Chrome",
      kind: "browser",
      commands: ["google-chrome", "chromium", "chromium-browser"],
      fixed: [],
    },
    {
      id: "firefox",
      label: "Firefox",
      kind: "browser",
      commands: ["firefox"],
      fixed: [path.join(bin, "firefox")],
    },
    {
      id: "zen",
      label: "Zen Browser",
      kind: "browser",
      commands: ["zen"],
      fixed: [path.join(bin, "zen")],
    },
  ];
}

/** 注册表 App Paths 的 `reg query /s` 输出 → `<name>.exe`（小写）→ 绝对路径。 */
function parseAppPathsRegistry(text) {
  const found = new Map();
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^HKEY_[^\r\n]*?\\App Paths\\([^\\]+)$/.exec(line);
    if (head) {
      current = head[1].toLowerCase();
      continue;
    }
    if (!current) continue;
    const value = /^\(Default\)\s+REG_SZ\s+(.+)$/.exec(line);
    if (value && !found.has(current)) found.set(current, value[1].trim());
  }
  return found;
}

/**
 * StartMenuInternet 的 `reg query /s` 输出 → 子键名（小写）→ 可执行文件路径。
 * 只认 `shell\open\command` 那一条，值形如 `"C:\…\chrome.exe" -- "%1"`。
 */
function parseStartMenuRegistry(text) {
  const found = new Map();
  let current = null;
  let inCommand = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^HKEY_[^\r\n]*?\\StartMenuInternet\\(.+)$/.exec(line);
    if (head) {
      const rest = head[1];
      current = rest.split("\\")[0].toLowerCase();
      inCommand = /\\shell\\open\\command$/i.test(rest);
      continue;
    }
    if (!current || !inCommand) continue;
    const value = /^\(Default\)\s+REG_SZ\s+(.+)$/.exec(line);
    if (!value) continue;
    const executable = executableFromCommand(value[1]);
    if (executable && !found.has(current)) found.set(current, executable);
  }
  return found;
}

/** 从 shell 命令行里剥出可执行文件：`"C:\a b\x.exe" -- "%1"` → `C:\a b\x.exe`。 */
function executableFromCommand(command) {
  const trimmed = String(command).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 1) return trimmed.slice(1, end);
  }
  const match = /^(.*?\.exe)(?:\s|$)/i.exec(trimmed);
  if (match) return match[1].replace(/^"|"$/g, "").trim();
  return null;
}

/** 起一个只读子进程并收它的 stdout；拿不到任何东西就返回空串（探测静默降级）。 */
function runCapture(command, args, timeoutMs = EDITOR_PROBE_TIMEOUT_MS) {
  const spawn = childSpawnFn();
  if (!spawn) return Promise.resolve("");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }

    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
      finish("");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      if (out.length >= EDITOR_PROBE_MAX_BYTES) {
        try {
          child.kill();
        } catch {
          /* 已经退出了 */
        }
        finish(out.slice(0, EDITOR_PROBE_MAX_BYTES));
      }
    });
    child.on("error", () => finish(""));
    child.on("close", () => finish(out));
  });
}

/** reg.exe 的绝对路径（插件进程的 PATH 里通常没有 System32）。 */
function regExePath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const native = path.join(systemRoot, "System32", "reg.exe");
  return isFileSync(native) ? native : "reg";
}

const REG_APP_PATH_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];

const REG_START_MENU_KEYS = [
  "HKLM\\SOFTWARE\\Clients\\StartMenuInternet",
  "HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet",
  "HKCU\\SOFTWARE\\Clients\\StartMenuInternet",
];

/**
 * 注册表两处 + PATH 的探测结果。注册表查询并行发起：6 次 reg.exe 一起跑，
 * 总耗时是一次进程启动的量级（实测 100ms 上下），而不是它们的和。
 * 非 Windows、没有 reg.exe、注册表读不到——一律返回空表，探测退化成 PATH + 固定路径。
 */
async function editorSources() {
  const empty = { appPaths: new Map(), menus: new Map() };
  if (PLATFORM !== "win32") return empty;

  const reg = regExePath();
  const outputs = await Promise.all([
    ...REG_APP_PATH_KEYS.map((key) => runCapture(reg, ["query", key, "/s"])),
    ...REG_START_MENU_KEYS.map((key) => runCapture(reg, ["query", key, "/s"])),
  ]);

  const appPaths = new Map();
  for (const text of outputs.slice(0, REG_APP_PATH_KEYS.length)) {
    for (const [key, value] of parseAppPathsRegistry(text)) {
      if (!appPaths.has(key)) appPaths.set(key, value);
    }
  }

  const menus = new Map();
  for (const text of outputs.slice(REG_APP_PATH_KEYS.length)) {
    for (const [key, value] of parseStartMenuRegistry(text)) {
      if (!menus.has(key)) menus.set(key, value);
    }
  }

  return { appPaths, menus };
}

/**
 * 一个候选的命中位置：注册表 App Paths → StartMenuInternet → PATH → 固定路径。
 *
 * 注册表两种键名都要试**前缀**：StartMenuInternet 下的浏览器子键常带客户端哈希后缀
 * （Firefox 是 `FIREFOX.EXE-308046b0af4a39cb`、Chromium 系是 `Chrome.HTM…`），
 * 精确匹配会一个都命中不了。前缀匹配只在没有精确命中时兜底，且取最短的那个键
 * （`chrome` 优先于 `chromehtml`），避免误配到同前缀的另一款软件。
 */
function lookupRegistryKey(map, key) {
  const wanted = String(key).toLowerCase();
  const exact = map.get(wanted);
  if (exact) return exact;
  let best = null;
  let bestLength = Infinity;
  for (const [name, value] of map) {
    if (!name.startsWith(wanted)) continue;
    if (name.length < bestLength) {
      best = value;
      bestLength = name.length;
    }
  }
  return best;
}

function locateEditor(candidate, sources) {
  for (const key of candidate.appPaths ?? []) {
    const hit = lookupRegistryKey(sources.appPaths, key);
    if (hit && isFileSync(hit)) return hit;
  }
  for (const key of candidate.menus ?? []) {
    const hit = lookupRegistryKey(sources.menus, key);
    if (hit && isFileSync(hit)) return hit;
  }
  for (const name of candidate.commands ?? []) {
    const hit = findOnPath(name);
    if (hit && isOnlyExtension(hit, ".exe")) return hit;
  }
  for (const fixed of candidate.fixed ?? []) {
    if (isFileSync(fixed)) return fixed;
  }
  return null;
}

/** PATH 命中必须是 .exe（Windows）；其它平台命令本身就是可执行文件。 */
function isOnlyExtension(target, extension) {
  if (PLATFORM !== "win32") return true;
  return target.toLowerCase().endsWith(extension);
}

/**
 * 全量探测一次；候选按表里的顺序，去重后返回 { id, label, kind, command }。
 *
 * kind 是「这是什么程序」（editor / browser），不是「能不能打开这个文件」——
 * 后者取决于被点的文件，由视图按扩展名判定（lib/editors.ts）。放在这里是因为
 * 只有探测侧知道 Chrome 是浏览器：一旦写成视图里的 id 名单，加一款浏览器就要改两处。
 */
async function probeEditors() {
  const sources = await editorSources();
  const found = [];
  const seen = new Set();
  for (const candidate of editorCandidates()) {
    const command = locateEditor(candidate, sources);
    if (!command) continue;
    const key = command.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind === "browser" ? "browser" : "editor",
      command,
    });
  }
  return found;
}

/** 缓存文件形状：{ stamp, platform, editors }。任何形状不对都当没有缓存。 */
async function readEditorCacheFile(stamp) {
  if (!dataPath) return null;
  try {
    const raw = await fs.readFile(path.join(dataPath, EDITOR_CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.stamp !== stamp || parsed.platform !== PLATFORM) return null;
    if (!Array.isArray(parsed.editors)) return null;
    const editors = parsed.editors
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.label === "string" &&
          typeof entry.command === "string",
      )
      // 老缓存（0.9.0 之前的版本没写 kind）当作编辑器：宁可少一项「用浏览器打开」，
      // 也不把编辑器误判成浏览器而从普通文件上删掉。
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        kind: entry.kind === "browser" ? "browser" : "editor",
        command: entry.command,
      }));
    return { stamp, platform: PLATFORM, editors };
  } catch {
    return null;
  }
}

async function writeEditorCacheFile(value) {
  if (!dataPath) return;
  try {
    await fs.writeFile(
      path.join(dataPath, EDITOR_CACHE_FILE),
      `${JSON.stringify(value)}\n`,
      "utf8",
    );
  } catch {
    /* 写不进去只是下次重新探测 */
  }
}

/** 本进程内缓存 + 同一天的落盘缓存；并发调用共用同一次探测。 */
let editorCache = null;
let editorProbe = null;

async function detectEditors() {
  const stamp = todayStamp();
  if (editorCache && editorCache.stamp === stamp) return editorCache;

  if (!editorProbe) {
    editorProbe = (async () => {
      const cached = await readEditorCacheFile(stamp);
      if (cached) return cached;
      const editors = await probeEditors();
      const fresh = { stamp, platform: PLATFORM, editors };
      await writeEditorCacheFile(fresh);
      return fresh;
    })();
  }

  try {
    editorCache = await editorProbe;
  } finally {
    editorProbe = null;
  }
  return editorCache;
}

/**
 * 交给外部编辑器的环境变量。插件进程跑在宿主给的最小环境里（只有 PATH / SystemRoot /
 * USERPROFILE 等十来个变量），而编辑器启动时通常要读 APPDATA / LOCALAPPDATA 找自己的
 * 配置与扩展。这两个变量的位置在 Windows 上是固定的，直接从主目录推出来补上；
 * 其余保持沿袭，不伪造。
 */
function editorEnv() {
  const env = { ...process.env };
  const home = env.USERPROFILE || env.HOME || "";
  if (home) {
    if (!env.APPDATA) env.APPDATA = path.join(home, "AppData", "Roaming");
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  return env;
}

/**
 * 用指定编辑器打开一个绝对路径。
 *
 * 走的是 spawn 而不是 shell：编辑器是可执行文件、参数是一个绝对路径，两者之间不需要
 * 命令行这一层（有 shell 就有注入面）。detached + stdio ignore + unref，编辑器是用户
 * 的窗口，不该随面板关闭而消失，也不该把插件进程拖住。
 */
function launchEditor(command, target) {
  const spawn = childSpawnFn();
  if (!spawn) throw fail("EDITOR_UNAVAILABLE", "child processes are unavailable");
  let child;
  try {
    child = spawn(command, [target], {
      cwd: path.dirname(target),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: editorEnv(),
    });
  } catch (error) {
    throw fail("EDITOR_UNAVAILABLE", String(error?.message ?? error));
  }
  child.on("error", () => {
    /* 编辑器起不来只是没反应，面板不该因此报错 */
  });
  child.unref();
}

async function handleEditors() {
  const cache = await detectEditors();
  return {
    ok: true,
    platform: PLATFORM,
    stamp: cache.stamp,
    // kind 一并给视图：它据此决定「这个程序要不要出现在这个文件上」（见 lib/editors.ts）。
    editors: cache.editors.map((entry) => ({ id: entry.id, label: entry.label, kind: entry.kind })),
  };
}

async function handleOpenWith(payload) {
  if (payload?.external === true) {
    // 编辑器 command 绝不由视图指定，只认 id；external 是「宿主自己选定的项目外路径」
    // 那条通道的标记，这里不该出现——与其放行，不如明确拒绝。
    throw fail("INVALID_PATH", "external paths are not accepted here");
  }
  const target = await resolveTarget(payload, "read");
  const cache = await detectEditors();
  const editor = cache.editors.find((entry) => entry.id === payload?.id);
  if (!editor) throw fail("UNKNOWN_EDITOR", "that editor is not available on this machine");

  launchEditor(editor.command, target.abs);
  await audit({ api: "fm.openWith", path: `${editor.id}: ${target.rel}`, result: "ok" });
  return { ok: true, editor: { id: editor.id, label: editor.label, kind: editor.kind } };
}

// ── 读 ──────────────────────────────────────────────────────────────────────

async function handleList(payload) {
  const { rootPath, abs, rel } = await resolveInsideRoot(payload?.path ?? "", {
    allowRoot: true,
  });

  const rules = await rulesForDirectory(rootPath, rel);

  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw fail("NOT_FOUND", "directory not found");
    if (error?.code === "ENOTDIR") throw fail("INVALID_PATH", "not a directory");
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw fail("DENIED_PATH", "permission denied");
    }
    throw error;
  }

  const entries = [];
  let truncated = false;

  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }

    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (isDenied(childRel, "read")) continue;

    const childAbs = path.join(abs, dirent.name);
    const isSymlink = dirent.isSymbolicLink();
    const isDirectory = dirent.isDirectory();

    let size;
    let mtimeMs;
    try {
      const stat = isSymlink ? await fs.lstat(childAbs) : await fs.stat(childAbs);
      mtimeMs = stat.mtimeMs;
      if (!isDirectory) size = stat.size;
    } catch {
      continue;
    }

    let escapes = false;
    if (isSymlink) {
      try {
        const real = await fs.realpath(childAbs);
        escapes = real !== rootPath && !isInside(rootPath, real);
      } catch {
        escapes = true;
      }
    }

    entries.push({
      name: dirent.name,
      path: childRel,
      isDirectory: isDirectory && !isSymlink,
      size,
      mtimeMs,
      ignored: rules.length > 0 && matchesRules(childRel, isDirectory, rules),
      isSymlink,
      outside: escapes,
    });
  }

  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  // git 状态：整个工作区一次算完（2s 缓存），文件各取各的，目录取子树的汇总。
  // 非仓库 / 没有 git 时 snapshot 为 null，整列就是 null——树照旧，只是没有徽标。
  const snapshot = await gitSnapshotFor(rootPath);
  const gitGroups = snapshot ? rollupByChildDirectory(snapshot, rel) : new Map();
  for (const entry of entries) {
    entry.git = snapshot
      ? entry.isDirectory
        ? gitGroups.get(entry.name) ?? null
        : snapshot.files.get(entry.path) ?? null
      : null;
  }

  return {
    ok: true,
    path: rel,
    entries,
    truncated,
    ignoreActive: rules.length > 0,
    git: snapshot ? summarizeGit(snapshot) : { available: false },
  };
}

/** base64 拼成 data URI——视图只能拿到字符串，不能拿到路径。 */
function asDataUri(mime, buffer) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function handleRead(payload) {
  const { abs, rel } = await resolveTarget(payload, "read");

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw fail("NOT_FOUND", "file not found");
  if (stat.isDirectory()) throw fail("INVALID_PATH", "path is a directory");
  // 打开文件时也问一句 git：这个文件有没有改动。左侧列表收起时（宿主请求打开就会
  // 收起）树里没有这一行，右侧的「变更」入口不能跟着一起消失。
  const base = {
    path: rel,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    git: await gitInfoFor(abs, rel),
  };
  const extension = path.extname(rel).toLowerCase();

  // 数据库：只读 100 字节的头部就能认出它，所以这一支**不做体积限制**——
  // 几百 MB 的 .db 也会在这里秒开（真正的取数走 fm.sqlite.*，一次只拿一页）。
  // 扩展名像但魔数不对的（比如 Windows 的 thumbs.db 其实是 OLE 文件）继续按普通文件走。
  if (SQLITE_EXT.test(extension)) {
    const head = await readHead(abs, 100);
    if (isSqliteFile(head)) {
      return {
        ok: true,
        kind: "sqlite",
        available: loadSqlite() !== null,
        info: sqliteInfo(head, stat.size, await exists(`${abs}-wal`), await exists(`${abs}-journal`)),
        ...base,
      };
    }
  }

  // PDF 独立于文本 / 二进制判定；损坏或加密文档由 PDF.js 给出明确提示。
  // 沿用 resolveTarget 的根包含、凭据黑名单和宿主指定外部文件的检查。
  if (extension === ".pdf") {
    if (stat.size > MAX_PDF_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_PDF_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    if (buffer.length > MAX_PDF_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_PDF_BYTES, ...base, size: buffer.length };
    }
    return { ok: true, kind: "pdf", mime: "application/pdf", dataUri: asDataUri("application/pdf", buffer), ...base };
  }

  // 图片与音视频返回 data URI：视图在 file:// 下拿不到项目里的文件，
  // 只能把字节随响应带过去。两类各自先做体积检查，避免读进内存再拒绝。
  const imageMime = IMAGE_MIME.get(extension);
  if (imageMime) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_IMAGE_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    return { ok: true, kind: "image", mime: imageMime, dataUri: asDataUri(imageMime, buffer), ...base };
  }

  const mediaMime = MEDIA_MIME.get(extension);
  if (mediaMime) {
    if (stat.size > MAX_MEDIA_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_MEDIA_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    return { ok: true, kind: "media", mime: mediaMime, dataUri: asDataUri(mediaMime, buffer), ...base };
  }

  // 其余扩展名一律按内容判断：超过上限 → tooLarge，含 NUL 字节 → binary。
  // zip / apk / exe 这类二进制会落到这里，视图只提示「不支持预览」。
  if (stat.size > MAX_READ_BYTES) {
    return { ok: true, kind: "tooLarge", limit: MAX_READ_BYTES, ...base };
  }

  const buffer = await fs.readFile(abs);
  if (buffer.subarray(0, 4096).includes(0)) return { ok: true, kind: "binary", ...base };

  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = (bom ? buffer.subarray(3) : buffer).toString("utf8");
  const eol = text.includes("\r\n") ? "crlf" : "lf";

  return {
    ok: true,
    kind: "text",
    text: eol === "crlf" ? text.split("\r\n").join("\n") : text,
    eol,
    bom,
    ...base,
  };
}

// ── 写 ──────────────────────────────────────────────────────────────────────

async function atomicWrite(abs, serialized, mode) {
  const dir = path.dirname(abs);
  const suffix = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(dir, `.${path.basename(abs)}.${suffix}.tmp`);

  let handle = null;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    // rename 会替换 inode，先把原文件权限位搬到临时文件上。
    if (mode != null) await fs.chmod(tmp, mode).catch(() => {});

    // Windows 上防病毒 / 索引器可能造成瞬态 EPERM / EBUSY。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, abs);
        return;
      } catch (error) {
        const transient =
          error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
        if (!transient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function handleWrite(payload) {
  const { abs, rel } = await resolveTarget(payload, "write");

  const text = typeof payload?.text === "string" ? payload.text : "";
  if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) {
    throw fail("TOO_LARGE", "content exceeds the 8 MiB write limit");
  }

  const stat = await fs.stat(abs).catch(() => null);
  if (stat?.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  // 乐观锁：编辑器之外的改动绝不静默覆盖。
  if (stat && typeof payload?.expectedMtimeMs === "number") {
    const mtimeChanged = Math.abs(stat.mtimeMs - payload.expectedMtimeMs) > 0.5;
    const sizeChanged =
      typeof payload?.expectedSize === "number" && stat.size !== payload.expectedSize;
    if (mtimeChanged || sizeChanged) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "the file changed on disk since it was opened",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    }
  }

  let serialized = text;
  if (payload?.eol === "crlf") serialized = serialized.split("\n").join("\r\n");
  if (payload?.bom) serialized = `\uFEFF${serialized}`;

  await atomicWrite(abs, serialized, stat?.mode ?? null);

  const next = await fs.stat(abs);
  await audit({
    api: "fm.write",
    path: rel,
    bytes: Buffer.byteLength(serialized, "utf8"),
    result: "ok",
  });
  // 刚落盘的内容就是「工作区相对 HEAD 的改动」：状态缓存必须立刻作废，
  // 否则树里的徽标与右侧的差异要等 2s 之后才跟上。
  invalidateGitSnapshots();
  // 监听（0.8.0）会把「临时文件 + rename」报成一次外部改动；记一笔，视图就不会
  // 因为用户自己按的 Ctrl+S 而把文档重新装载一遍（那会丢光标与滚动位置）。
  noteSelfWrite(rel);

  return { ok: true, mtimeMs: next.mtimeMs, size: next.size };
}

// ── 新建 / 重命名 / 移动 / 删除 ────────────────────────────────────────────

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function assertValidName(rawName) {
  if (typeof rawName !== "string") throw fail("INVALID_NAME", "name is required");
  const name = rawName.trim();
function entryFromStat(name, rel, stat) {
  return {
    name,
    path: rel,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    mtimeMs: stat.mtimeMs,
    ignored: false,
    isSymlink: false,
    outside: false,
    // 新建 / 改名 / 移动之后这一行是全新的：状态由下一次列表调用现算。
    git: null,
  };
}
  return {
    name,
    path: rel,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    mtimeMs: stat.mtimeMs,
    ignored: false,
    isSymlink: false,
    outside: false,
  };
}

async function handleCreate(payload) {
  const parent = await resolveInsideRoot(payload?.parent ?? "", { allowRoot: true });
  const name = assertValidName(payload?.name);

  const childAbs = path.join(parent.abs, name);
  const childRel = parent.rel ? `${parent.rel}/${name}` : name;
  if (isDenied(childRel, "write")) throw fail("DENIED_PATH", `refused path: ${childRel}`);
  if (await exists(childAbs)) throw fail("EXISTS", "an entry with that name already exists");

  const isDirectory = Boolean(payload?.isDirectory);
  if (isDirectory) await fs.mkdir(childAbs);
  else await fs.writeFile(childAbs, "", { flag: "wx" });

  await audit({ api: "fm.create", path: childRel, result: "ok" });
  invalidateGitSnapshots(); // 新文件立刻就该有「新增」徽标。
  noteSelfWrite(childRel); // 监听别把这当成「外部新建」。
  return { ok: true, entry: entryFromStat(name, childRel, await fs.stat(childAbs)) };
}

async function handleRename(payload) {
  const source = await resolveInsideRoot(payload?.path ?? "", { mode: "write" });
  const name = assertValidName(payload?.newName);

  const parentRel = path.posix.dirname(source.rel);
  const dirPrefix = parentRel === "." ? "" : parentRel;
  const nextRel = dirPrefix ? `${dirPrefix}/${name}` : name;
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);

  const nextAbs = path.join(path.dirname(source.abs), name);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  await fs.rename(source.abs, nextAbs);
  await audit({ api: "fm.rename", path: `${source.rel} → ${nextRel}`, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(source.rel);
  noteSelfWrite(nextRel);
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

async function handleMove(payload) {
  const source = await resolveInsideRoot(payload?.from ?? "", { mode: "write" });
  const target = await resolveInsideRoot(payload?.toDir ?? "", { mode: "write", allowRoot: true });

  const targetStat = await fs.stat(target.abs).catch(() => null);
  if (!targetStat?.isDirectory()) throw fail("INVALID_PATH", "the destination is not a directory");
  if (source.abs === target.abs) return { ok: true, entry: null };

  // 不能把目录移进它自己的子孙。
  if (isInside(source.abs, target.abs)) {
    throw fail("INVALID_PATH", "cannot move a directory into itself");
  }

  const name = path.posix.basename(source.rel);
  const nextAbs = path.join(target.abs, name);
  const nextRel = target.rel ? `${target.rel}/${name}` : name;
  if (nextAbs === source.abs) return { ok: true, entry: null };
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  try {
    await fs.rename(source.abs, nextAbs);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    // 跨卷：复制 + 删除。
    await fs.cp(source.abs, nextAbs, { recursive: true, errorOnExist: true });
    await fs.rm(source.abs, { recursive: true });
  }

  await audit({ api: "fm.move", path: `${source.rel} → ${nextRel}`, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(source.rel);
  noteSelfWrite(nextRel);
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

/**
 * 删除文件或目录。目录整体递归删除，删之前由视图弹确认框。
 *
 * 路径限制与写 / 新建 / 重命名 / 移动完全一致：resolveTarget(payload, "write")
 * 覆盖了项目内相对路径、组内绝对路径与 external 项目外路径三种形态，凭据黑名单
 * 与 node_modules 拒绝都在里面。根目录本身绝不能删——右键空白处的菜单也能走到
 * 这里，rel 为空就是根。
 */
async function handleDelete(payload) {
  const target = await resolveTarget(payload, "write");
  // 根目录本身绝不能删：右键空白处的菜单也能走到这里。
  if (!target.rel) throw fail("INVALID_PATH", "refusing to delete the project root");

  let stat;
  try {
    stat = await fs.lstat(target.abs);
  } catch {
    throw fail("NOT_FOUND", "entry does not exist");
  }

  await fs.rm(target.abs, { recursive: stat.isDirectory(), force: false });

  await audit({ api: "fm.delete", path: target.rel, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(target.rel);
  return { ok: true };
}

// ── 搜索（分页 + 会话游标） ─────────────────────────────────────────────────

function pruneSessions() {
  while (searchSessions.size > MAX_SEARCH_SESSIONS) {
    const oldest = [...searchSessions.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    )[0];
    if (!oldest) return;
    searchSessions.delete(oldest[0]);
  }
}

async function handleSearch(payload) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;

  const query = String(payload?.query ?? "").trim();
  if (!query) return { ok: true, matches: [], nextCursor: null, done: true, scanned: 0 };

  const cursor = typeof payload?.cursor === "string" ? payload.cursor : null;
  const limit = Math.min(Math.max(Number(payload?.limit) || MAX_SEARCH_MATCHES, 1), 200);

  let session = cursor ? searchSessions.get(cursor) : null;
  if (!session) {
    // 栈里是「目录帧」而不是目录路径：帧被完整扫完才出栈，否则命中上限时
    // 该目录剩余条目会被永久丢掉（分页会漏结果）。
    session = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      needle: query.toLowerCase(),
      stack: [{ dir: "", entries: null, index: 0, rules: [] }],
      scanned: 0,
    };
    searchSessions.set(session.id, session);
    pruneSessions();
  }

  const matches = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const outOfBudget = () =>
    matches.length >= limit || Date.now() > deadline || session.scanned >= MAX_SEARCH_SCANNED;

  while (session.stack.length > 0) {
    if (outOfBudget()) break;

    const frame = session.stack.pop();
    if (!frame.entries) {
      const absDir = frame.dir
        ? path.join(rootPath, frame.dir.split("/").join(path.sep))
        : rootPath;
      frame.rules = await rulesForDirectory(rootPath, frame.dir);
      try {
        frame.entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        frame.entries = [];
      }
      frame.index = 0;
    }

    // 子目录先收集，等本帧处理完再入栈：直接在循环里 push 会让后面的
    // `pop()` 把刚压入的子帧弹掉，父帧则被反复重扫（死循环）。
    const children = [];
    while (frame.index < frame.entries.length) {
      if (outOfBudget()) break;

      const dirent = frame.entries[frame.index];
      frame.index += 1;

      if (dirent.name === ".git") continue;
      const childRel = frame.dir ? `${frame.dir}/${dirent.name}` : dirent.name;
      if (isDenied(childRel, "read")) continue;

      const isDirectory = dirent.isDirectory();
      if (frame.rules.length > 0 && matchesRules(childRel, isDirectory, frame.rules)) continue;

      session.scanned += 1;
      if (isDirectory && !dirent.isSymbolicLink()) {
        children.push({ dir: childRel, entries: null, index: 0, rules: [] });
      }
      if (
        dirent.name.toLowerCase().includes(session.needle) ||
        childRel.toLowerCase().includes(session.needle)
      ) {
        matches.push({ name: dirent.name, path: childRel, isDirectory });
      }
    }

    // 未扫完则原样回栈，下次续扫；扫完才释放目录列表。
    if (frame.index < frame.entries.length) session.stack.push(frame);
    else frame.entries = null;

    for (const child of children) session.stack.push(child);
  }

  const done = session.scanned >= MAX_SEARCH_SCANNED || session.stack.length === 0;
  if (done) searchSessions.delete(session.id);

  return {
    ok: true,
    matches,
    nextCursor: done ? null : session.id,
    done,
    scanned: session.scanned,
  };
}

// ── SQLite（只读浏览 + 查询） ───────────────────────────────────────────────
//
// 用 Node 内置的 node:sqlite。宿主是 Electron 43 / Node 24，模块存在（实测），
// 零依赖规则不破——和用 node:fs 同级。
//
// 为什么不像图片那样把字节搬给视图：.db 动辄几十上百 MB，只能留在主进程里查，
// 每次只把一页行发给视图。这是本插件唯一能打开「大文件」的预览类型。
//
// 只读是三层钉住的：
//   ① 打开时 { readOnly: true }
//   ② 打开后立刻 PRAGMA query_only = 1（实测：DROP / INSERT 都被 SQLite 拒绝，
//      报 "attempt to write a readonly database"）
//   ③ 语句白名单：只放行 SELECT / WITH / VALUES / EXPLAIN 与只读 PRAGMA，且必须是
//      单条语句——node:sqlite 的 prepare 对多语句是**放行**的（实测 "select 1; select 2"
//      只执行第一条、不报错），所以多语句必须自己拦。

const SQLITE_EXT = /\.(?:db|db3|sqlite|sqlite3)$/i;
const SQLITE_MAGIC = "SQLite format 3\u0000";
const SQLITE_MAX_ROWS = 5000;
const SQLITE_MAX_CELL = 4096;
const SQLITE_MAX_SQL = 20000;
const SQLITE_MAX_OFFSET = 100000;
const SQLITE_HANDLE_LIMIT = 2;
const SQLITE_IDLE_MS = 60000;
const ROWID = "rowid";

/** 只放行这些只读 PRAGMA；写性的（journal_mode 带值、writable_schema 等）不进白名单。 */
const READ_ONLY_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "database_list",
  "page_count",
  "page_size",
  "freelist_count",
  "encoding",
  "schema_version",
  "user_version",
  "compile_options",
  "collation_list",
]);

/** 这些词在 SQLite 里都是保留字，只能以关键字出现（列名同名必须加引号，而引号段会被跳过），
 *  所以扫到就是真的写语句，不会误伤。 */
const WRITE_VERBS = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "drop",
  "alter",
  "create",
  "attach",
  "detach",
  "vacuum",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
]);

/**
 * 拆出语句结构：首个关键字、出现的全部关键字、以及是不是多语句。
 * 引号段（'…' / "…" / `…` / […]）与注释整段跳过——不然 SQL 里的分号和关键字会把判定带偏。
 */
function analyzeSql(sql) {
  const keywords = [];
  const length = sql.length;
  let index = 0;
  let multiple = false;

  while (index < length) {
    const char = sql[index];

    if (char === "-" && sql[index + 1] === "-") {
      while (index < length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      while (index < length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "[") {
      while (index < length && sql[index] !== "]") index += 1;
      index += 1;
      continue;
    }
    if (char === ";") {
      index += 1;
      // 分号后面还有非空白内容 → 多语句
      if (sql.slice(index).replace(/[\s;]/g, "").length > 0) multiple = true;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      keywords.push(sql.slice(index, end).toLowerCase());
      index = end;
      continue;
    }
    index += 1;
  }

  return { head: keywords[0] ?? "", keywords, multiple };
}

function assertReadOnlySql(sql) {
  if (!sql.trim()) throw fail("SQLITE_SQL_EMPTY", "the query is empty");
  if (sql.length > SQLITE_MAX_SQL) throw fail("SQLITE_SQL_TOO_LONG", "the query is too long");

  const { head, keywords, multiple } = analyzeSql(sql);
  if (multiple) throw fail("SQLITE_SQL_MULTIPLE", "only a single statement is allowed");
  if (!head) throw fail("SQLITE_SQL_EMPTY", "the query is empty");

  if (head === "select" || head === "values" || head === "explain") return;

  if (head === "with") {
    // WITH 可以给 INSERT/UPDATE/DELETE 当前缀，得再看一遍整句有没有写动词
    if (keywords.some((word) => WRITE_VERBS.has(word))) {
      throw fail("SQLITE_SQL_NOT_READ_ONLY", "only read-only statements are allowed");
    }
    return;
  }

  if (head === "pragma") {
    const name = keywords[1] ?? "";
    if (!READ_ONLY_PRAGMAS.has(name)) {
      throw fail("SQLITE_SQL_NOT_READ_ONLY", `pragma ${name || "?"} is not on the read-only list`);
    }
    return;
  }

  throw fail("SQLITE_SQL_NOT_READ_ONLY", "only select / with / values / explain are allowed");
}

/** 标识符加引号。名字一律来自我们自己读出的 schema，仍然转义一次——不给自己留例外。 */
function quoteIdent(name) {
  return `"${String(name).split('"').join('""')}"`;
}

let sqliteModule;
function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = require("node:sqlite");
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** rel 路径 → { db, mtimeMs, size, usedAt }；按 mtime + 体积判断句柄是否还新鲜。 */
const sqliteHandles = new Map();

function closeSqliteHandle(rel) {
  const entry = sqliteHandles.get(rel);
  if (!entry) return;
  sqliteHandles.delete(rel);
  try {
    entry.db.close();
  } catch {
    /* 关不上就算了，进程退出时会一并释放 */
  }
}

function pruneSqliteHandles() {
  while (sqliteHandles.size > SQLITE_HANDLE_LIMIT) {
    const oldest = [...sqliteHandles.entries()].sort(
      (left, right) => left[1].usedAt - right[1].usedAt,
    )[0];
    if (!oldest) return;
    closeSqliteHandle(oldest[0]);
  }
}

/** 读文件头（默认 100 字节）——只读这么点，所以 .db 再大也能秒开。 */
async function readHead(abs, bytes = 100) {
  let handle = null;
  try {
    handle = await fs.open(abs, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

const isSqliteFile = (head) =>
  head.length >= 16 && head.subarray(0, 16).toString("latin1") === SQLITE_MAGIC;

/** 100 字节头部 → 概览。页大小在偏移 16（大端 u16，值 1 表示 65536）。 */
function sqliteInfo(head, size, hasWal, hasJournal) {
  const u16 = (offset) => head.readUInt16BE(offset);
  const u32 = (offset) => head.readUInt32BE(offset);
  const encoding = u32(56);

  return {
    size,
    pageSize: head.length >= 18 ? (u16(16) === 1 ? 65536 : u16(16)) : 0,
    pageCount: head.length >= 32 ? u32(28) : 0,
    encoding: encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8",
    journalMode: head.length >= 19 && head[18] === 2 ? "wal" : "rollback",
    schemaVersion: head.length >= 44 ? u32(40) : 0,
    libraryVersion: head.length >= 100 ? u32(96) : 0,
    hasWal,
    hasJournal,
  };
}

async function sqliteFileInfo(abs, rel, stat) {
  const head = await readHead(abs, 100);
  if (!isSqliteFile(head)) return null;
  const hasWal = await exists(`${abs}-wal`);
  const hasJournal = await exists(`${abs}-journal`);
  return sqliteInfo(head, stat.size, hasWal, hasJournal);
}

/** 拿到（必要时打开）一个只读句柄。文件在外部被改过就重开，免得看到旧结构。 */
async function sqliteHandle(relPath) {
  const { abs, rel } = await resolveInsideRoot(relPath, { mode: "read" });

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw fail("NOT_FOUND", "file not found");
  if (stat.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  const head = await readHead(abs, 100);
  if (!isSqliteFile(head)) throw fail("NOT_SQLITE", "this file is not a SQLite database");

  const sqlite = loadSqlite();
  if (!sqlite) throw fail("SQLITE_UNAVAILABLE", "this runtime does not provide node:sqlite");

  // 闲置太久就松手：插件进程不该一直攥着别的程序的数据库文件
  const now = Date.now();
  for (const [key, entry] of [...sqliteHandles.entries()]) {
    if (now - entry.usedAt > SQLITE_IDLE_MS) closeSqliteHandle(key);
  }

  const cached = sqliteHandles.get(rel);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cached.usedAt = Date.now();
    return { db: cached.db, rel, abs, stat };
  }
  if (cached) closeSqliteHandle(rel);

  const db = new sqlite.DatabaseSync(abs, { readOnly: true });
  try {
    db.exec("pragma query_only = 1");
    // SQLite 是懒打开：文件头合法但内容损坏时，直到第一次查询才报错。
    // 这里先踹一脚，让失败在 open 阶段就暴露出来。
    db.prepare("select count(*) as n from sqlite_master").get();
  } catch (error) {
    try {
      db.close();
    } catch {
      /* 打不开的句柄只能丢弃 */
    }
    if (error?.code === "ERR_SQLITE_ERROR") {
      throw fail("SQLITE_BROKEN", `SQLite could not read this file: ${error.message}`);
    }
    throw error;
  }

  sqliteHandles.set(rel, { db, mtimeMs: stat.mtimeMs, size: stat.size, usedAt: Date.now() });
  pruneSqliteHandles();
  return { db, rel, abs, stat };
}

function sqliteColumns(db, objectName) {
  const quoted = quoteIdent(objectName);
  let info;
  try {
    info = db.prepare(`pragma table_info(${quoted})`).all();
  } catch {
    return [];
  }
  return info.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    pk: Number(row.pk ?? 0) > 0,
    notNull: Number(row.notnull ?? 0) > 0,
  }));
}

/** 客户端取到的一律是字符串或 null（null 才是 SQL 的 NULL，空字符串是真的空串）。 */
function formatCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > SQLITE_MAX_CELL ? `${value.slice(0, SQLITE_MAX_CELL)}…` : value;
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `[blob ${value.length} B]`;
  return String(value);
}

/** 用 iterate 只取需要的行——同步 API 没有中断接口，唯一能做的就是把取的行数掐死。 */
function takeRows(statement, limit) {
  const rows = [];
  let truncated = false;
  for (const row of statement.iterate()) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    rows.push(row.map(formatCell));
  }
  return { rows, truncated };
}

function statementColumns(statement) {
  try {
    const info = statement.columns() ?? [];
    return info.map((column) => ({
      name: String(column.name ?? ""),
      type: String(column.type ?? ""),
      pk: false,
      notNull: false,
    }));
  } catch {
    return [];
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

async function handleSqliteOpen(payload) {
  const { db, rel, abs, stat } = await sqliteHandle(payload?.path ?? "");

  const rows = db
    .prepare("select type, name, tbl_name, sql from sqlite_master order by type, name")
    .all();

  const objects = rows.map((row) => ({
    type: String(row.type ?? ""),
    name: String(row.name ?? ""),
    tableName: String(row.tbl_name ?? ""),
    sql: typeof row.sql === "string" ? row.sql : null,
  }));

  return {
    ok: true,
    path: rel,
    info: sqliteInfo(
      await readHead(abs, 100),
      stat.size,
      await exists(`${abs}-wal`),
      await exists(`${abs}-journal`),
    ),
    objects,
  };
}

async function handleSqliteRows(payload) {
  const { db, rel } = await sqliteHandle(payload?.path ?? "");

  const requested = typeof payload?.object === "string" ? payload.object : "";
  const objects = db
    .prepare("select type, name from sqlite_master where type in ('table','view')")
    .all();
  // 对象名绝不直接进 SQL：先在 schema 清单里核对，再拼引号
  const target = objects.find((row) => String(row.name) === requested);
  if (!target) throw fail("SQLITE_NO_SUCH_OBJECT", `no such table or view: ${requested}`);

  const name = String(target.name);
  const columns = sqliteColumns(db, name);
  const known = new Set(columns.map((column) => column.name));

  let orderBy = typeof payload?.orderBy === "string" ? payload.orderBy : "";
  if (orderBy && orderBy !== ROWID && !known.has(orderBy)) orderBy = "";
  const direction = payload?.direction === "desc" ? "DESC" : "ASC";

  const pageSize = clampInt(payload?.pageSize, 1, SQLITE_MAX_ROWS, 1000);
  const page = clampInt(payload?.page, 1, 1e6, 1);
  const offset = (page - 1) * pageSize;
  if (offset > SQLITE_MAX_OFFSET) {
    throw fail("SQLITE_OFFSET_LIMIT", "this page is beyond the browsing limit");
  }

  const order = orderBy
    ? ` ORDER BY (${quoteIdent(orderBy)} IS NULL), ${quoteIdent(orderBy)} ${direction}`
    : "";
  const limit = pageSize + 1; // 多取一行，用来判断还有没有下一页

  let statement;
  let withRowid = true;
  try {
    statement = db.prepare(
      `SELECT ${ROWID}, * FROM ${quoteIdent(name)}${order} LIMIT ${limit} OFFSET ${offset}`,
    );
  } catch {
    // 视图或 WITHOUT ROWID 表没有 rowid，退回普通取数
    withRowid = false;
    statement = db.prepare(`SELECT * FROM ${quoteIdent(name)}${order} LIMIT ${limit} OFFSET ${offset}`);
  }
  statement.setReturnArrays(true);

  const { rows } = takeRows(statement, limit);
  const hasMore = rows.length > pageSize;

  let estimate = null;
  if (String(target.type) === "table") {
    try {
      const row = db.prepare(`SELECT max(rowid) AS m FROM ${quoteIdent(name)}`).get();
      estimate = typeof row?.m === "number" ? row.m : null;
    } catch {
      estimate = null;
    }
  }

  const resultColumns = withRowid
    ? [{ name: ROWID, type: "INTEGER", pk: true, notNull: true }, ...columns]
    : columns;

  return {
    ok: true,
    path: rel,
    object: name,
    kind: String(target.type),
    columns: resultColumns,
    rows: rows.slice(0, pageSize),
    page,
    pageSize,
    hasMore,
    estimate,
    hasRowid: withRowid,
  };
}

async function handleSqliteQuery(payload) {
  const { db, rel } = await sqliteHandle(payload?.path ?? "");

  const sql = typeof payload?.sql === "string" ? payload.sql.trim() : "";
  assertReadOnlySql(sql);

  const limit = clampInt(payload?.limit, 1, SQLITE_MAX_ROWS, 500);
  const started = Date.now();

  let statement;
  try {
    statement = db.prepare(sql);
  } catch (error) {
    throw fail("SQLITE_SQL_ERROR", String(error?.message ?? error));
  }

  statement.setReturnArrays(true);
  const columns = statementColumns(statement);

  let rows = [];
  let truncated = false;
  try {
    ({ rows, truncated } = takeRows(statement, limit));
  } catch (error) {
    throw fail("SQLITE_SQL_ERROR", String(error?.message ?? error));
  }

  return {
    ok: true,
    path: rel,
    columns,
    rows,
    truncated,
    elapsedMs: Date.now() - started,
  };
}

// ── 偏好 ────────────────────────────────────────────────────────────────────

function sanitizePrefs(partial) {
  const next = { ...prefs };
  if (partial && typeof partial === "object") {
    if (typeof partial.splitRatio === "number" && Number.isFinite(partial.splitRatio)) {
      next.splitRatio = Math.min(Math.max(partial.splitRatio, 0.15), 0.7);
    }
    if (typeof partial.treeCollapsed === "boolean") next.treeCollapsed = partial.treeCollapsed;
    if (typeof partial.showIgnored === "boolean") next.showIgnored = partial.showIgnored;
    if (typeof partial.watchFiles === "boolean") next.watchFiles = partial.watchFiles;
    if (typeof partial.mdPreview === "boolean") next.mdPreview = partial.mdPreview;
    if (typeof partial.csvTable === "boolean") next.csvTable = partial.csvTable;
    if (typeof partial.jsonTree === "boolean") next.jsonTree = partial.jsonTree;
    // 表格每页行数：夹到 100–5000 并对齐到 100。视图的下拉框只提供几档固定值，
    // 这里不跟着枚举走（main.js 不该知道视图的选项表），夹紧就够了。
    if (typeof partial.tablePageSize === "number" && Number.isFinite(partial.tablePageSize)) {
      const rounded = Math.round(partial.tablePageSize / 100) * 100;
      next.tablePageSize = Math.min(Math.max(rounded, 100), 5000);
    }
    // 项目组里「当前在看哪个 folder root」的记忆：projectKey → 绝对路径。
    // 只收字符串值（不做真值转换）、只收绝对路径，并保持有界（LRU，见上）。
    // 值是不是「宿主当前给的某个 root」不在这里判——那是推导基点时的事
    // （selectedRootOf），这里只保证形状。
    if (
      partial.projectRoots &&
      typeof partial.projectRoots === "object" &&
      !Array.isArray(partial.projectRoots)
    ) {
      for (const [key, value] of Object.entries(partial.projectRoots)) {
        if (!key || typeof value !== "string" || !isAbsolutePath(value)) continue;
        next.projectRoots = rememberProjectRoot(next.projectRoots, key, path.resolve(value));
      }
    }
  }
  return next;
}

async function handlePrefsSet(payload) {
  const partial = payload?.partial;
  // 只有动了 root 记忆才需要知道当前项目是谁（并顺手丢掉按相对路径缓存的
  // 搜索会话与 SQLite 句柄——两个 root 下的同名相对路径不是同一个文件）。
  const touchesRoots = Boolean(partial && typeof partial === "object" && "projectRoots" in partial);
  let key = null;
  let previous;
  if (touchesRoots) {
    const workspace = await pi.workspace.get().catch(() => null);
    key = workspace?.path ? projectKeyOf(workspace) : null;
    if (key) previous = (prefs.projectRoots ?? {})[key];
  }

  prefs = sanitizePrefs(partial);

  if (key && (prefs.projectRoots ?? {})[key] !== previous) dropRootScopedCaches();

  await pi.plugin.setSettings({ fmPrefs: prefs });
  return { ok: true, prefs };
}

async function handleHello() {
  // 组形状（主根）+ 偏好。这里**不是**当前基点：视图按 workspace.get 的同一形状
  // 认这个字段，基点由 prefs.projectRoots 推导（两条投递路径形状一致，
  // 「r:<主根路径>」这个记忆键才是稳的）。
  const root = await projectGroup();
  return {
    ok: true,
    root,
    limits: {
      maxReadBytes: MAX_READ_BYTES,
      maxWriteBytes: MAX_WRITE_BYTES,
      maxListEntries: MAX_LIST_ENTRIES,
    },
    ignoreFiles: IGNORE_FILE_NAMES,
    // 这个运行时能不能监听：不能的话视图把「自动刷新」开关显示成不可用，
    // 而不是让用户开了却永远没反应。
    watch: { available: !isRemoteWorkspace(root) && watchSupported && fsWatchFn() !== null },
    // Older hosts may load this plugin before the built-in Browser action API exists.
    capabilities: { openHtmlInBrowser: !isRemoteWorkspace(root) && typeof pi.fs.openInBrowser === "function" },
    prefs,
  };
}

// ── 通道路由 ────────────────────────────────────────────────────────────────

const CHANNELS = {
  "fm.hello": handleHello,
  "fm.prefs.get": handleHello,
  "fm.prefs.set": handlePrefsSet,
  "fm.list": handleList,
  "fm.read": handleRead,
  "fm.write": handleWrite,
  "fm.create": handleCreate,
  "fm.rename": handleRename,
  "fm.move": handleMove,
  "fm.delete": handleDelete,
  "fm.search": handleSearch,
  "fm.sqlite.open": handleSqliteOpen,
  "fm.sqlite.rows": handleSqliteRows,
  "fm.sqlite.query": handleSqliteQuery,
  "fm.git.diff": handleGitDiff,
  "fm.watch": handleWatch,
  // 编辑器探测与「通过…打开」（0.9.0）。前者一天只真的探一次（落盘缓存，多开共享），
  // 后者只认探测结果里的 id，视图指定不了可执行文件。
  "fm.editors": handleEditors,
  "fm.openWith": handleOpenWith,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    const workspace = await pi.workspace.get();
    if (payload?.workspacePath !== undefined && payload.workspacePath !== workspace?.path) {
      throw fail("WORKSPACE_CHANGED", "The workspace changed while the file was loading");
    }
    if (isRemoteWorkspace(workspace) && !["fm.hello", "fm.prefs.get", "fm.prefs.set"].includes(channel)) {
      return await invokeRemote(pi, workspace, channel, payload ?? {}, { isDenied, maxListEntries: MAX_LIST_ENTRIES });
    }
    return await handler(payload ?? {});
  } catch (error) {
    return toFailure(error);
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function onLoad() {
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null;
  }
  try {
    const settings = await pi.plugin.getSettings();
    prefs = sanitizePrefs(settings?.fmPrefs ?? {});
  } catch {
    /* 保持默认 */
  }
}

async function onUnload() {
  searchSessions.clear();
  for (const key of [...sqliteHandles.keys()]) closeSqliteHandle(key);
  invalidateGitSnapshots();
  // 监听必须随插件一起走：漏关就是一只挂在别人项目上的眼睛（而且是 persistent 的）。
  stopWatching();
  // 编辑器探测的内存缓存跟着插件走；落盘的 editors.json 留着（今天之内别的实例还能用）。
  editorCache = null;
  editorProbe = null;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // 纯解析函数：verify-git.mjs 直接拿它们单测（porcelain / numstat / unified
  // diff 的形态很容易在 git 升级时悄悄变一次，解析必须能被断言）。
  internals: {
    parsePorcelainV1,
    classifyRecord,
    parseNumstat,
    parseUnifiedDiff,
    untrackedDiff,
    rollupByChildDirectory,
    GIT_STATUS_RANK,
    GIT_TIMEOUT_MS,
    GIT_SNAPSHOT_TTL_MS,
    MAX_DIFF_LINES,
    MAX_UNTRACKED_DIFF_BYTES,
    // 监听（0.8.0）的纯判定：噪声过滤与自己写入的抑制，verify-watch.mjs 直接断言。
    isWatchIgnored,
    isSelfWrite,
    noteSelfWrite,
    WATCH_DEBOUNCE_MS,
    SELF_WRITE_SUPPRESS_MS,
    WATCH_HISTORY_LIMIT,
    // 编辑器探测（0.9.0）：输出形态与缓存判定都是纯函数，verify-editors.mjs 直接断言
    // （注册表 / shell 命令行 / PATH 候选名这几种文本解析错了，菜单里就会多出一个
    // 点了没反应的编辑器，甚至漏掉机器上真实存在的那个）。
    parseAppPathsRegistry,
    parseStartMenuRegistry,
    executableFromCommand,
    pathLookupOrder,
    todayStamp,
    lookupRegistryKey,
    editorCandidates,
    detectEditors,
    EDITOR_CACHE_FILE,
  },
};
