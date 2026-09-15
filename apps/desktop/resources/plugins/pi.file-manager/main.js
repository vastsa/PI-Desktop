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
 *   ⑥ 上限：文本预览 2 MiB / 图片 8 MiB / 音视频 24 MiB / 写入 8 MiB /
 *      单目录 3000 条 / 搜索分页（后两类要走 base64，所以单独设限）
 *   ⑦ 宿主请求打开：宿主可以要求视图打开项目之外的文件（会话临时目录 / 附件，
 *      路径由宿主自己选定）。视图带 external: true 时才放行绝对路径，这条路径
 *      不做根内包含校验（它本来就在根外），黑名单与 realpath 检查照旧全量生效。
 *   ⑧ 项目组（0.5.0）：宿主可以把一个项目注册成多个本地文件夹（roots）。本插件
 *      同一时刻**只认一个** root 作为包含基点——当前选中的那个（记忆在
 *      prefs.projectRoots，按 projectId 记忆、缺 projectId 时按主根路径）。基点
 *      绝不放大成「整个组的并集」：换基点只是换一扇门，门后的规则一条不变。
 *
 * 通道：视图 window.pluginBridge.invoke("fm.*", payload) → onPanelInvoke。
 *   宿主对自定义通道的转发超时是 30s（plugin-runtime.ts PLUGIN_PANEL_TIMEOUT_MS），
 *   所以任何遍历类操作都必须分页，绝不整树递归返回。
 */

const fs = require("node:fs/promises");
const path = require("node:path");

// ── 上限 ────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
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

  return {
    ok: true,
    path: rel,
    entries,
    truncated,
    ignoreActive: rules.length > 0,
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

  const base = { path: rel, size: stat.size, mtimeMs: stat.mtimeMs };
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

  return { ok: true, mtimeMs: next.mtimeMs, size: next.size };
}

// ── 新建 / 重命名 / 移动 ────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function assertValidName(rawName) {
  if (typeof rawName !== "string") throw fail("INVALID_NAME", "name is required");
  const name = rawName.trim();
  if (!name) throw fail("INVALID_NAME", "name is required");
  if (name === "." || name === "..") throw fail("INVALID_NAME", "invalid name");
  if (/[\\/:*?"<>|]/.test(name)) throw fail("INVALID_NAME", "name contains an illegal character");
  if (WINDOWS_RESERVED.test(name)) throw fail("INVALID_NAME", "name is reserved by the system");
  if (name.length > 200) throw fail("INVALID_NAME", "name is too long");
  return name;
}

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
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
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
  "fm.search": handleSearch,
  "fm.sqlite.open": handleSqliteOpen,
  "fm.sqlite.rows": handleSqliteRows,
  "fm.sqlite.query": handleSqliteQuery,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
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
}

module.exports = { onLoad, onUnload, onPanelInvoke };
