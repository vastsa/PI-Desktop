/**
 * The trusted renderer host (spec 07-plugins/16).
 *
 * A plugin that declares `manifest.renderer` may register React components into
 * slots the host owns. The entry is fetched and evaluated lazily — the first
 * time one of its slots is really rendered — and it only runs at all when the
 * plugin was granted the `renderer.extension` permission.
 *
 * The host draws every registered component with its own React instance, in the
 * same JavaScript realm as the host UI. A plugin that ships its own React is
 * refused at load, because two React copies break hooks and context. Write
 * components against the types here instead of importing React: this module
 * deliberately carries no React dependency so the SDK stays renderer-agnostic.
 *
 * A plugin may also register pure synchronous functions (`pi.functions`) that
 * the host calls directly while it renders — the positions that cannot wait
 * for an async round trip (ADR 0294 decision 6).
 */


/**
 * Scheme the host serves plugin renderer bundles over. It is deliberately
 * separate from `plugin-asset`, whose MIME allowlist is images and fonts only:
 * widening that allowlist would turn every already-issued theme asset URL into
 * a script URL.
 */
export const PLUGIN_RENDERER_SCHEME = "plugin-renderer";
/**
 * Slots that draw a component inside the host's own React tree. `.`-free ids
 * are part of the plugin contract: they appear in diagnostics and in
 * `data-pi-plugin` containers. Non-component capabilities (attachment sources,
 * draft rewriting, Markdown transforms, plugin copy) are separate APIs.
 */
export const PLUGIN_RENDERER_SLOTS = [
  /** Whole-message rendering: a message that is an object, not a paragraph. */
  "entry",
  /** Turn / tool card body for the plugin's own tools. */
  "toolCard",
  /** Fenced code-block renderer for one language. */
  "codeBlock",
  /** Extra block appended below one transcript entry. */
  "entryExtra",
  /** Controls in the composer's control rows, including the region left of Send. */
  "composerControl",
  /** Candidate source for the composer's completion popover. */
  "completionSource",
  /** Inline confirmation card above the composer. */
  "inlineConfirm",
  /** Blocking, app-level dialog. */
  "modal",
  /** In-window overlay layer, independent of the current view. */
  "overlay",
  /** Composer reference chips and their resolve() contract. */
  "composerReference",
] as const;

export type PluginRendererSlot = (typeof PLUGIN_RENDERER_SLOTS)[number];

/**
 * Data the host can hand a renderer component when the plugin declares
 * `manifest.rendererData`. A name is a whole slice whose shape the host owns,
 * not a free-form string. Omitted means the plugin declares no data at all,
 * which is what every manifest written before this field means.
 *
 * Two roles (ADR 0294 D7, narrowed):
 * - Install-review / declaration metadata for every name in this list.
 * - Ambient props the host actually injects when the value already exists:
 *   only `theme` and `locale` (PLUGIN_RENDERER_AMBIENT_DATA). Slot-contract
 *   props (draft, entry, references, …) always arrive from the slot's own
 *   mount and are not gated by this list. `selection` is declarable but not
 *   served this cycle — the host reports `PLUGIN_DATA_UNSERVED` rather than
 *   silently ignoring the declaration.
 */
export const PLUGIN_RENDERER_DATA = [
  /**
   * The transcript entry a component is mounted for. In a replace position
   * (`entry`) this is the entry *with its display data*: `id`, `role`,
   * `pluginId?`, and the message the host's own row would have drawn — its
   * `text`, `attachments`, `createdAt`, `command`, `streaming` state and the
   * host `actions` the position stands in for. The additive `entryExtra`
   * position keeps the identity-only shape, so a component may feature-detect
   * the wider one.
   */
  "entry",
  /** Facts about the session that entry belongs to. */
  "session",
  /** The fenced source a code-block component was handed. */
  "code",
  /** The host's current light/dark theme. */
  "theme",
  /** The user's current text selection inside the host UI. */
  "selection",
  /** A read-only copy of the composer draft. */
  "draft",
  /** The attachment chips currently on the composer. */
  "attachments",
  /** The locale the host UI is showing. */
  "locale",
] as const;

export type PluginRendererDataKey = (typeof PLUGIN_RENDERER_DATA)[number];

/**
 * Ambient keys the host injects at `SlotOutlet` when the plugin declared them
 * and the host already holds the value. Narrow on purpose: this is not a
 * live subscription engine.
 */
export const PLUGIN_RENDERER_AMBIENT_DATA = ["theme", "locale"] as const;

export type PluginRendererAmbientDataKey = (typeof PLUGIN_RENDERER_AMBIENT_DATA)[number];

/**
 * Declarable data keys the host does not serve yet. Declaration stays valid
 * for install review; the runtime answers with `PLUGIN_DATA_UNSERVED`.
 */
export const PLUGIN_RENDERER_UNSERVED_DATA = ["selection"] as const;

/**
 * Component slots that *replace* a host surface: at most one registration
 * holds the position (first claim wins). Additive slots may stack in
 * registration order (D8). `codeBlock` uses language claims instead of a
 * whole-slot claim.
 */
export const PLUGIN_RENDERER_REPLACE_SLOTS = [
  "entry",
  "toolCard",
  "inlineConfirm",
  "modal",
] as const;

export function isPluginRendererReplaceSlot(
  slot: PluginRendererSlot,
): slot is (typeof PLUGIN_RENDERER_REPLACE_SLOTS)[number] {
  return (PLUGIN_RENDERER_REPLACE_SLOTS as readonly string[]).includes(slot);
}

/**
 * The composer positions a `composerControl` registration can be asked for
 * (spec 07-plugins/16 §2A.5).
 *
 * `left` and `right` are the composer's two control rows: additive positions
 * that stack in registration order (D8). `beforeSend` is the region immediately
 * left of the send/stop control, and it is handed over whole — it holds the
 * host's own model picker, context display, and prompt-enhancement control — so
 * exactly one registration holds it.
 */
export const PLUGIN_RENDERER_COMPOSER_POSITIONS = ["left", "right", "beforeSend"] as const;

export type PiRendererComposerControlPosition =
  (typeof PLUGIN_RENDERER_COMPOSER_POSITIONS)[number];

/**
 * The positions a `composerControl` registration that declares none is asked
 * for: the two control rows, which is what every registration written before
 * `beforeSend` existed means. Declaring `positions` opts into another set.
 */
export const PLUGIN_RENDERER_COMPOSER_DEFAULT_POSITIONS = ["left", "right"] as const;

/**
 * Public design tokens a renderer slot may use. Host-maintained aliases of
 * internal `--ds-*` values, defined on `.pi-plugin-slot` only. The stability
 * contract is this prefix + this list: additions only; renames or removals
 * require a spec + ADR change. Internal host tokens and host class names are
 * not part of the plugin contract.
 */
export const PLUGIN_SLOT_DESIGN_TOKENS = [
  "--pi-slot-bg",
  "--pi-slot-bg-elevated",
  "--pi-slot-text",
  "--pi-slot-text-muted",
  "--pi-slot-text-faint",
  "--pi-slot-border",
  "--pi-slot-accent",
  "--pi-slot-success",
  "--pi-slot-warning",
  "--pi-slot-error",
  "--pi-slot-radius-sm",
  "--pi-slot-radius-md",
  "--pi-slot-text-xs",
  "--pi-slot-text-sm",
  "--pi-slot-text-base",
  "--pi-slot-shadow",
  "--pi-slot-font",
] as const;

export type PluginSlotDesignToken = (typeof PLUGIN_SLOT_DESIGN_TOKENS)[number];

/** Ambient props the host may merge into a slot component. All optional. */
export type PiRendererAmbientProps = {
  /** Host light/dark theme, when the plugin declared `theme`. */
  theme?: "light" | "dark";
  /** Host UI locale (e.g. `zh-CN`), when the plugin declared `locale`. */
  locale?: string;
};

/**
 * Diagnostic codes owned by the slot/style contract (registry + style injection).
 * Kept here so the SDK is the single place plugin authors and host code look.
 */
export type PluginRendererSlotDiagnosticCode =
  | "PLUGIN_SLOT_DUPLICATE"
  | "PLUGIN_SLOT_INVALID_POSITION"
  | "PLUGIN_DATA_UNSERVED"
  | "PLUGIN_STYLE_REFUSED"
  | "PLUGIN_STYLE_SCOPED"
  | "PLUGIN_STYLE_PRIVATE_TOKEN";

/**
 * Actions a renderer component may ask the host to run. The vocabulary is
 * host-owned, so a plugin declares intent instead of inventing verbs, and the
 * declaration is what an install review reads.
 *
 * Eight are implemented in this release and say so below. The remaining two are
 * declarable but have no host handler yet: calling one rejects with a coded
 * `PLUGIN_ACTION_UNROUTED` refusal rather than resolving `undefined`.
 */
export const PLUGIN_RENDERER_ACTIONS = [
  /**
   * Runs a method inside the plugin's own headless entry (`onRendererCall`) and
   * resolves with its answer. Payload `{ method: string, args?: unknown }`.
   * Refused with a coded error when the plugin's manifest does not declare this
   * action, when the plugin has no entry or no such handler, or when the call
   * times out.
   */
  "plugin.call",
  /**
   * Replaces the active session's whole composer draft. Payload
   * `{ text: string, expectedGeneration?: number, fileReferences?: "preserve" |
   * Array<{ path: string; name: string; kind?: "image" | "file"; mimeType?: string }> }`.
   * Resolves with `{ ok: true, generation, previous }` once a mounted composer
   * consumed the write; refuses with `PLUGIN_ACTION_DRAFT_UNCONSUMED` when none
   * did, or `DRAFT_CONFLICT` on generation mismatch.
   */
  "composer.replaceDraft",
  /**
   * Reads a snapshot of the active session composer draft for the calling
   * plugin. Payload `{}`. Resolves with `{ sessionId, generation, text,
   * fileReferences }`, where each reference is the composer's own chip shape
   * (`{ path, name, kind?, mimeType? }`) — the host holds no plugin-owned id, so
   * `path` is the identity. Refused with a coded error when no session is
   * active.
   */
  "composer.readDraft",
  /**
   * Inserts text at the composer's current selection. Not implemented yet:
   * calling it rejects with a coded `PLUGIN_ACTION_UNROUTED` refusal.
   */
  "composer.insertText",
  /**
   * Attaches a path as a composer attachment chip. Not implemented yet: calling
   * it rejects with a coded `PLUGIN_ACTION_UNROUTED` refusal.
   */
  "composer.attachPath",
  /**
   * Restores this plugin's own in-window overlay layer. A layer's appearance is
   * its registration, so this makes the `overlay` component this plugin already
   * registered visible again after `ui.closeOverlay` — or the host's own Escape
   * — withdrew it; it never creates a layer, and it cannot reach another
   * plugin's. No payload (the layer draws the registered component). Resolves
   * with `{ ok: true, slot: "overlay", visible: true }`. Refused with a coded
   * `PLUGIN_ACTION_LAYER_NOT_REGISTERED` when this plugin holds no `overlay`
   * registration of its own.
   */
  "ui.openOverlay",
  /**
   * Withdraws this plugin's own in-window overlay layer. The component stays
   * registered: `ui.openOverlay` shows the same one again, and so does
   * registering the `overlay` slot once more. No payload. Resolves with
   * `{ ok: true, slot: "overlay", visible: false }`, and is a success when the
   * layer is already withdrawn; refused with
   * `PLUGIN_ACTION_LAYER_NOT_REGISTERED` when this plugin holds no `overlay`
   * registration of its own.
   */
  "ui.closeOverlay",
  /**
   * Restores this plugin's own app-level modal layer, exactly as
   * `ui.openOverlay` restores its overlay: the `modal` component this plugin
   * registered becomes visible again after `ui.closeModal` — or the host's own
   * Escape — withdrew it. No payload. Resolves with
   * `{ ok: true, slot: "modal", visible: true }`; refused with
   * `PLUGIN_ACTION_LAYER_NOT_REGISTERED` when this plugin holds no `modal`
   * registration of its own.
   */
  "ui.openModal",
  /**
   * Withdraws this plugin's own app-level modal layer, leaving the component
   * that draws it registered. No payload. Resolves with
   * `{ ok: true, slot: "modal", visible: false }`, and is a success when the
   * layer is already withdrawn; refused with
   * `PLUGIN_ACTION_LAYER_NOT_REGISTERED` when this plugin holds no `modal`
   * registration of its own.
   */
  "ui.closeModal",
  /**
   * Shows the shell's toast. Payload
   * `{ message: string, variant?: "info" | "success" | "error" }`; omitted
   * variant uses the host default (`info`). A blank message or an unknown
   * variant is refused with `PLUGIN_ACTION_INVALID_PAYLOAD`.
   */
  "ui.toast",
] as const;

export type PluginRendererActionName = (typeof PLUGIN_RENDERER_ACTIONS)[number];

/**
 * The host method a slot component calls to act (ADR 0294). It arrives as the
 * `dispatch` prop on every render, bound to exactly one plugin: an action that
 * plugin did not declare in `manifest.rendererActions` is refused with a
 * `PLUGIN_ACTION_UNDECLARED` error, and a declared action the host has no
 * handler for yet is refused with `PLUGIN_ACTION_UNROUTED` rather than resolving
 * `undefined`. It is a contract for plugins that behave, not a security
 * boundary.
 */
export type PiRendererDispatch = (
  action: PluginRendererActionName,
  payload?: unknown,
) => Promise<unknown>;

/**
 * A React component, typed structurally: the host renders it, and the plugin
 * must not assume which React version or module instance it came from.
 */
export type PiRendererComponent<Props = Record<string, unknown>> = (props: Props) => unknown;

/** Handle returned by `pi.slots.register`. The host also revokes it on unload. */
export type PiRendererRegistration = {
  readonly slot: PluginRendererSlot;
  /** Removes this one registration; the slot stops rendering immediately. */
  remove(): void;
};

/** Handle returned by `pi.ui.injectStyle`; the host removes the sheet on unload. */
export type PiRendererStyleHandle = {
  remove(): void;
};
/**
 * A function a plugin hands the host to call *while it renders* (ADR 0294
 * decision 6). Some positions cannot wait for an async round trip — a
 * per-message block whose height the transcript has to know, a code-block
 * decoration, a value read while a composer control is computed — so these
 * functions are called directly, in the host's realm, synchronously. They must
 * be pure and synchronous: no I/O, no network, no DOM mutation, no long work.
 * The host may call one on any render of the position that registered it, and
 * stops calling it if it misbehaves.
 */
export type PiRendererHostFunction = (input: unknown) => unknown;

/** Handle returned by `pi.functions.register`; the host also revokes it on unload. */
export type PiRendererFunctionHandle = {
  readonly name: string;
  /** Removes this one function; the host stops calling the name immediately. */
  remove(): void;
};

/** Why a host call of a registered function produced no value. */
export type PiRendererFunctionFailureCode =
  | "PLUGIN_FUNCTION_MISSING"
  | "PLUGIN_FUNCTION_THREW"
  | "PLUGIN_FUNCTION_OVER_BUDGET"
  | "PLUGIN_FUNCTION_DISABLED";

/**
 * The answer to one host call. `ok: true` carries the function's value
 * unchanged; a failure carries the code the host refused the call under and a
 * human-readable `detail`. `PLUGIN_FUNCTION_OVER_BUDGET` means the function
 * returned, but past the host's one-frame budget, so its value was discarded:
 * a render that needed a synchronous answer cannot wait another frame for it.
 * Three consecutive throwing or over-budget calls disable the function for the
 * rest of that plugin's loaded lifetime.
 */
export type PiRendererFunctionCallResult =
  | { ok: true; value: unknown }
  | { ok: false; code: PiRendererFunctionFailureCode; detail?: string };

/**
 * The object handed to a renderer module's `onLoad`. It is the whole host API a
 * renderer plugin is handed, kept per-plugin by the `onLoad` argument. It is a
 * contract, not a boundary: the module shares the host's realm (ADR 0291), so
 * `window.piDesktop` and the host DOM both stay reachable from plugin code.
 */
export type PiRendererApi = {
  readonly plugin: {
    readonly id: string;
    readonly version: string;
  };
  readonly slots: {
    /**
     * Registers one component for a slot. The host renders it with the slot's
     * data as props plus a `dispatch` prop (`PiRendererDispatch`) bound to this
     * plugin. The same function object is handed over on every render, so it is
     * safe to list as a `useEffect` dependency.
     *
     * A registration the host refuses throws a coded error naming the reason —
     * `PLUGIN_SLOT_DUPLICATE` when another plugin already holds that replace
     * position, `PLUGIN_SLOT_INVALID_COMPONENT` for a component that is not a
     * function, and the `codeBlock` language codes for a bad claim — rather
     * than answering with a handle nobody can withdraw. The same refusal is
     * recorded as a diagnostic on the plugin's own row.
     */
    register<Props>(
      slot: PluginRendererSlot,
      component: PiRendererComponent<Props>,
      options?: PiRendererSlotOptions,
    ): PiRendererRegistration;
  };
  readonly functions: {
    /**
     * Registers one host-callable function under a name that is unique inside
     * this plugin. The host may call it *while it renders* — synchronously, in
     * this realm, on any render — so the function must be pure and synchronous:
     * no I/O, no network, no DOM mutation, no long work. A throwing call, or an
     * answer past the host's one-frame budget, is discarded and reported; three
     * consecutive such calls disable the function for the rest of that
     * plugin's loaded lifetime.
     *
     * A name must match `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` and be at most
     * 64 characters; a name that does not, or one this plugin already
     * registered, is refused with a coded error rather than silently replaced.
     * Names are per plugin, and registration only ever goes through this `pi`
     * object: the host calls the function directly, with no ambient handle and
     * no channel.
     */
    register(name: string, fn: PiRendererHostFunction): PiRendererFunctionHandle;
  };
  readonly ui: {
    /**
     * Injects a stylesheet owned by the host, which removes it on unload.
     *
     * The host auto-scopes every selector under this plugin's
     * `data-pi-plugin` container before the sheet is served. Top-level `html`,
     * `body`, or `*` (including nested in any block at-rule) are refused with
     * `PLUGIN_STYLE_REFUSED`. `:root` is rewritten to the plugin container so
     * theme branches stay writable. Public design tokens are the
     * `--pi-slot-*` names in `PLUGIN_SLOT_DESIGN_TOKENS`; host-internal
     * `--ds-*` names are not part of the contract.
     */
    injectStyle(css: string): PiRendererStyleHandle;
  };
};

/**
 * The module shape `manifest.renderer` must export. `onLoad` is required — a
 * module that never registers anything is a manifest mistake rather than a
 * quiet no-op, and the loader refuses it with a diagnostic.
 */
export type PiRendererModule = {
  onLoad(pi: PiRendererApi): void | Promise<void>;
  onUnload?(): void | Promise<void>;
};

/**
 * Selectors the host refuses entirely when they appear as a top-level selector
 * in an injected sheet. `:root` is not listed: the host rewrites it to the
 * plugin's own `[data-pi-plugin="<id>"]` container so theme branches stay
 * writable without reaching the document root.
 */
export const PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS = ["html", "body", "*"] as const;

/**
 * Scope every selector in `css` under the plugin's own container, descending
 * into every block at-rule body except the descriptor / keyframe-step ones
 * (`@keyframes`, `@font-face`, `@page`, …). An at-rule this host has never
 * heard of — `@starting-style` today, whatever ships next — is therefore
 * scoped exactly like `@media`, never passed through. `:root` becomes the
 * container (and `:root[data-theme=…]` becomes the container carrying
 * `data-pi-theme`). Selectors already prefixed with this plugin's container are
 * left alone. `@keyframes` / `@font-face` names are rewritten once per sheet,
 * wherever they sit.
 *
 * Throws `PLUGIN_STYLE_REFUSED` for forbidden root selectors or `@import`.
 * This is the author-facing preview helper; the host runs the same rewrite at
 * inject time, so the served CSS is always scoped.
 */
export function scopePluginStyle(pluginId: string, css: string): string {
  return scopePluginStyleImpl(pluginId, css);
}

/**
 * Implementation lives behind this indirection only so the pure rewrite can be
 * unit-tested without pulling the desktop app. Two passes, in this order:
 * rewrite `@keyframes` / `@font-face` names and the `animation*` values that
 * reference them exactly once for the whole sheet, then let
 * `scopeRuleSelectors` walk in and scope selectors only. Keeping the name
 * rewrite out of the recursion is what stops a keyframe or font-face nested in
 * a conditional group from being prefixed twice.
 */
function scopePluginStyleImpl(pluginId: string, css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import\b/i.test(withoutComments)) {
    throw styleRefused("@import is not allowed in an injected plugin sheet");
  }
  const container = containerSelector(pluginId);
  const keyframePrefix = `pi-${pluginId.replace(/[^a-zA-Z0-9_-]/g, "_")}-`;

  // Rename keyframes / font-faces first so later selector work cannot touch them.
  let working = withoutComments.replace(
    /@(?:-webkit-)?keyframes\s+([A-Za-z_][\w-]*)/gi,
    (_match, name: string) => `@keyframes ${keyframePrefix}${name}`,
  );
  working = working.replace(
    /@(?:-webkit-)?font-face\s*\{[\s\S]*?font-family\s*:\s*(['"]?)([^'";]+)\1/gi,
    (match, quote: string, family: string) =>
      match.replace(new RegExp(`font-family\\s*:\\s*(['"]?)${escapeRegExp(family)}\\1`, "i"), `font-family: ${quote || '"'}${keyframePrefix}${family}${quote || '"'}`),
  );
  // Rewrite animation-name / animation shorthands that referenced the old names.
  working = working.replace(
    /(animation(?:-name)?\s*:\s*)([^;}]+)/gi,
    (match, prop: string, value: string) => {
      const rewritten = value.replace(
        /(^|[\s,])([A-Za-z_][\w-]*)/g,
        (part: string, lead: string, name: string) => {
          if (/^(infinite|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|forwards|backwards|both|none|normal|reverse|alternate|alternate-reverse|paused|running|\d|\.)/i.test(name)) {
            return part;
          }
          if (name.startsWith(keyframePrefix)) return part;
          return `${lead}${keyframePrefix}${name}`;
        },
      );
      return `${prop}${rewritten}`;
    },
  );
  return scopeRuleSelectors(working, pluginId, container);
}

/**
 * At-rules whose body is a list of descriptors or keyframe steps rather than a
 * rule list: their bodies are copied verbatim, because entering them would
 * rewrite something that is not a selector. Every other block at-rule body is
 * entered, so an at-rule this host has never heard of is scoped like `@media`
 * instead of passing its selectors through unscoped.
 */
const VERBATIM_AT_RULE_BODIES =
  /^@(?:-webkit-)?(?:keyframes|font-face|page|property|counter-style|font-feature-values|color-profile|viewport)\b/i;

/**
 * Pass 2: scope the selectors of an already renamed sheet. Every block at-rule
 * body is entered except `VERBATIM_AT_RULE_BODIES`; at-rules without a block
 * (`@charset`, `@namespace`, …) are left as written. Recursion goes through
 * this function, never through `scopePluginStyleImpl`, so the name rewrite
 * cannot run a second time on nested content. Trimmed at every level, exactly
 * as the recursive call to `scopePluginStyleImpl` used to be.
 */
function scopeRuleSelectors(css: string, pluginId: string, container: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < css.length) {
    const brace = css.indexOf("{", index);
    if (brace < 0) {
      out.push(css.slice(index));
      break;
    }
    const start = Math.max(
      css.lastIndexOf("}", brace - 1),
      css.lastIndexOf("{", brace - 1),
      css.lastIndexOf(";", brace),
    );
    const selectorText = css.slice(start + 1, brace);
    const blockStart = brace;
    const blockEnd = findBlockEnd(css, brace);
    const body = css.slice(blockStart, blockEnd + 1);

    if (!selectorText.trim() || selectorText.trimStart().startsWith("@")) {
      // At-rule with a block: recurse into its body unless that body is
      // descriptors or keyframe steps.
      const at = selectorText.trimStart();
      if (!VERBATIM_AT_RULE_BODIES.test(at) && blockEnd > blockStart) {
        const inner = css.slice(blockStart + 1, blockEnd);
        const scopedInner = scopeRuleSelectors(inner, pluginId, container);
        out.push(css.slice(index, start + 1), selectorText, "{", scopedInner, "}");
      } else {
        out.push(css.slice(index, blockEnd + 1));
      }
      index = blockEnd + 1;
      continue;
    }

    const scopedSelector = selectorText
      .split(",")
      .map((part) => scopeSelector(part.trim(), pluginId, container))
      .filter((part) => part.length > 0)
      .join(", ");
    out.push(css.slice(index, start + 1), scopedSelector, body);
    index = blockEnd + 1;
  }
  return out.join("").trim();
}

function scopeSelector(selector: string, pluginId: string, container: string): string {
  if (!selector) return "";
  const forbidden = forbiddenRootSelector(selector);
  if (forbidden) {
    throw styleRefused(`${JSON.stringify(forbidden)} targets a host root`);
  }
  if (selector === container || selector.startsWith(`${container} `) || selector.startsWith(`${container}:`) || selector.startsWith(`${container}.`) || selector.startsWith(`${container}[`) || selector.startsWith(`${container}>`) || selector.startsWith(`${container}+`) || selector.startsWith(`${container}~`)) {
    return selector;
  }
  // `:root` / `:root[data-theme=light]` → container (+ theme attribute).
  if (selector === ":root" || selector.startsWith(":root[") || selector.startsWith(":root:") || selector.startsWith(":root ") || selector.startsWith(":root>") || selector.startsWith(":root.") || selector.startsWith(":root#")) {
    return container + selector.slice(":root".length);
  }
  return `${container} ${selector}`;
}

function forbiddenRootSelector(selector: string): string | null {
  for (const root of PLUGIN_STYLE_FORBIDDEN_ROOT_SELECTORS) {
    const pattern = new RegExp(`^${root.replace(/[*:]/g, "\\$&")}(?![\\w-])`, "i");
    if (pattern.test(selector)) return selector;
  }
  return null;
}

function containerSelector(pluginId: string): string {
  return `[data-pi-plugin="${pluginId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

function styleRefused(detail: string): Error & { code?: string } {
  const error = new Error(`PLUGIN_STYLE_REFUSED: ${detail}`) as Error & { code?: string };
  error.code = "PLUGIN_STYLE_REFUSED";
  return error;
}

function findBlockEnd(css: string, openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length - 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extra registration data a slot needs. `codeBlock` uses it to declare the
 * fenced language it claims — the name must carry the plugin's own prefix so a
 * plugin cannot shadow `json`, `ts` or `mermaid`; `composerControl` uses it to
 * declare the composer positions it wants to be asked for (spec 07-plugins/16
 * §2A.5).
 */
export type PiRendererReferenceSendInput = {
  text: string;
  sessionId?: string;
  contextWindow: number;
  usedTokens: number;
  maxOutputTokens?: number;
  hasAttachments: boolean;
  steering: boolean;
  signal: AbortSignal;
  dispatch: PiRendererDispatch;
};

export type PiRendererSlotOptions = {
  /** composerReference only. Validate before clearing/enqueuing; never rewrite the draft.
   * Throwing, timing out, or unloading refuses this send. Actual rewrites use input.
   */
  validateSend?: (input: PiRendererReferenceSendInput) =>
    Promise<{ ok: true } | { ok: false; reason: string }> | { ok: true } | { ok: false; reason: string };
  /** `codeBlock` only: the fenced language this component renders. */
  language?: string;
  /**
   * `composerControl` only: the composer positions this registration is asked
   * for. Omitted means `PLUGIN_RENDERER_COMPOSER_DEFAULT_POSITIONS` — the two
   * control rows, which is what every registration written before `beforeSend`
   * existed means. `beforeSend` is one claim: a second registration that
   * declares it is refused with `PLUGIN_SLOT_DUPLICATE`, and a value that is
   * not a non-empty subset of `PLUGIN_RENDERER_COMPOSER_POSITIONS` is refused
   * with `PLUGIN_SLOT_INVALID_POSITION`.
   */
  positions?: readonly PiRendererComposerControlPosition[];
};

/**
 * What the host hands a `codeBlock` renderer. The three protections the issue
 * asks for are visible here: a block whose fence is still open never reaches a
 * component, an oversized block is degraded to source text before this runs,
 * and a component that throws falls back to the host's own code block.
 */
export type PiRendererCodeBlockProps = {
  /** The fenced language as written, e.g. `acme:chart`. */
  language: string;
  /** The block's source, exactly as the model wrote it. */
  code: string;
  /** True while the fence is still open; the host does not render these. */
  isIncomplete: boolean;
  /** The host's current theme, so a diagram can match its surroundings. */
  theme: "light" | "dark";
};

/** The identity of one transcript entry, as every transcript position hands it over. */
export type PiRendererEntryIdentity = {
  id: string;
  role: "user" | "assistant" | "system";
  /** Set when the host attributes this entry to a plugin (D14). */
  pluginId?: string;
};

/**
 * What the host hands an `entryExtra` renderer: the entry it is appended to, so
 * a plugin can decide for itself whether it has anything to add. The entry id is
 * the identity the transcript is keyed by, which is also what lets a failed
 * component be reported against the row the user is looking at.
 *
 * This additive position is handed the entry's identity only. The `entry`
 * replace position hands over the same identity plus the message the host's own
 * row would have drawn (`PiRendererEntryProps`), because that is the data the
 * position it takes over was going to display.
 */
export type PiRendererEntryExtraProps = {
  entry: PiRendererEntryIdentity;
  sessionId: string;
};

/**
 * One attachment of a transcript entry, as a replace position reads it.
 * Display data, deliberately not the host's own attachment record: the
 * sidecar-only hydrated image bytes (`data`) never leave the host.
 */
export type PiRendererEntryAttachment = {
  /** Workspace-relative path, or an absolute session-scratch path. */
  ref: string;
  /** Display name, the way the host's own chip writes it. */
  name: string;
  kind: "file" | "image";
  mimeType?: string;
  size?: number;
};

/**
 * The host's own row actions a replace position stands in for.
 *
 * Facts, not callables: a replace component is handed the list so its card can
 * say which of the host's controls it covers, and it cannot trigger one — the
 * row's copy, edit, delete and revision controls stay host-owned.
 */
export type PiRendererEntryAction = "copy" | "edit" | "delete" | "revisions";

/**
 * The message a transcript entry carries, as the `entry` replace position is
 * handed it: what the host's own row would have drawn for that entry.
 */
export type PiRendererEntryMessage = {
  /** The entry's text, exactly as the host's own row draws it. */
  text: string;
  /** Files and images the entry carries, in the host's own order. */
  attachments: PiRendererEntryAttachment[];
  /** True while the host is still receiving this entry's text. */
  streaming: boolean;
  /** ISO-8601 creation time of the entry, when the host holds one. */
  createdAt?: string;
  /** The typed slash invocation, when the entry came from one (D123). */
  command?: string;
  /** The host's own row actions this position stands in for. */
  actions: PiRendererEntryAction[];
};

/**
 * What the host hands an `entry` renderer: the entry's identity plus the
 * message the host's own row would have drawn for it.
 *
 * Taking the position over and re-rendering this data in the component's own
 * form — with the component's own controls *beside* it — is what the slot is
 * for (ADR 0291). A card that hides the text it was handed is concealing the
 * position's data rather than presenting it. The additive `entryExtra`
 * position keeps the identity-only shape (`PiRendererEntryExtraProps`), so a
 * component may feature-detect the wider one.
 */
export type PiRendererEntryProps = {
  entry: PiRendererEntryIdentity;
  message: PiRendererEntryMessage;
  sessionId: string;
};

/**
 * The tool call a `toolCard` position stands in for: the row the host would
 * have built its own detail blocks from.
 */
export type PiRendererToolCall = {
  /**
   * The tool's own name as the transcript holds it; a plugin's tool keeps the
   * host's forced prefix (D015).
   */
  name: string;
  /** The call's arguments, exactly as the transcript holds them. */
  args: unknown;
  /** The call's result; absent while the call is still running. */
  result?: unknown;
  status?: "running" | "success" | "error" | "denied";
  /** The host's own measured duration for the call, when it has one. */
  durationMs?: number;
};

/**
 * What the host hands a `toolCard` renderer: the row's identity — with
 * `entry.pluginId` set to the tool's owner (D14) — plus the tool call whose
 * card body the component draws. The mount offers the position only to the
 * owner, and the component re-renders the call's name, arguments and result in
 * its own form rather than hiding them.
 */
export type PiRendererToolCardProps = {
  entry: PiRendererEntryIdentity;
  tool: PiRendererToolCall;
  sessionId: string;
};

/**
 * The confirmation the host's own inline card would have shown: the pending
 * permission request the position is asking about.
 */
export type PiRendererInlineConfirmRequest = {
  requestId: string;
  /** The tool the request is about. */
  toolName: string;
  /** The call's arguments, as the request carries its preview of them. */
  args: unknown;
  risk: "low" | "medium" | "high";
  /** The host's own sentence explaining why it is asking. */
  reason: string;
  /** Further requests waiting behind this one in the same session. */
  queued: number;
  /** The subagent that asked, when the call came from a delegate (ADR 0062). */
  agentName?: string;
};

/**
 * What the host hands an `inlineConfirm` renderer: the confirmation the
 * position stands in for.
 *
 * The position exists only while a permission request is pending, and the
 * host's own card is not drawn while a plugin holds it — so the claim is a
 * re-render of the request, never a blank card. Deciding the request stays
 * host-owned: there is no action for allow or deny, and removing the
 * registration is how the host's own card comes back.
 */
export type PiRendererInlineConfirmProps = {
  /** The session the confirmation belongs to. */
  sessionId?: string;
  /** The pending confirmation, when the host has one to hand over. */
  confirm?: PiRendererInlineConfirmRequest;
};

/**
 * What the host hands a `composerControl` renderer: which composer position this
 * mount is, the draft those controls act on, and — at `beforeSend` — the region
 * the host built for it.
 *
 * The slot is mounted three times: at the end of the composer's left control
 * row, at the end of its right one, and at `beforeSend`, the region immediately
 * left of the send/stop control. A registration is asked only for the positions
 * it declares (`PiRendererSlotOptions.positions`); declaring none keeps the two
 * rows, which is what a registration written before `beforeSend` existed means.
 * The component decides for itself what it draws in each position it asked for
 * and returns `null` for the others; that leaves no hole, because the host's own
 * controls in the two rows sit outside the mount, and at `beforeSend` the host's
 * own drawing of the region is the mount's fallback.
 *
 * `beforeSend` is one claim (the first registration that declares it; a later
 * one is refused with `PLUGIN_SLOT_DUPLICATE`), because the host hands the
 * position over whole: `modelControl`, `contextControl`, and `enhanceControl`
 * are the host's *own nodes* — the elements the host would draw itself, not
 * copies — together with the data behind them. The component decides the order
 * of those pieces inside the region, may add controls of its own, and may leave
 * a piece out; a piece it does not render is not drawn at all, and the host
 * draws no second copy of a piece the component renders. With nobody holding the
 * claim the host draws exactly its own three pieces, in its own order, and a
 * component that crashes gives the region back to them (D10).
 *
 * A component that wants to change the draft dispatches an action; the props are
 * read-only.
 */
export type PiRendererComposerControlProps = {
  /** Which composer position this mount fills. */
  position: PiRendererComposerControlPosition;
  /**
   * The session the composer is drafting for. Absent for a draft that has no
   * session yet (a new-task composer), rather than an empty id.
   */
  sessionId?: string;
  /**
   * The draft as the host currently holds it, exactly as typed and including
   * the sentinel characters that stand for attachment chips. Read-only: a
   * component that wants to change the draft dispatches an action.
   */
  draft: string;
  /**
   * `beforeSend` only: the host's own model picker, as a node to render
   * unchanged. Absent at `left` / `right`.
   */
  modelControl?: PiRendererNode;
  /** `beforeSend` only: what that picker is showing and acting on. */
  modelSelection?: PiRendererComposerModelSelection;
  /**
   * `beforeSend` only: the host's own context display, or `null` when the host
   * has no measured turn to draw it from — there is nothing to hand over then.
   */
  contextControl?: PiRendererNode | null;
  /** `beforeSend` only: the figures that display is drawn from, or `null`. */
  contextUsage?: PiRendererComposerContextUsage | null;
  /**
   * `beforeSend` only: the host's own prompt-enhancement control, including its
   * undo control when there is something to undo.
   */
  enhanceControl?: PiRendererNode;
  /** `beforeSend` only: the state those controls are in. */
  enhancement?: PiRendererComposerEnhancement;
};

/**
 * A React node the host built, handed to a slot component unchanged. The host
 * and the plugin share one React instance (ADR 0291), so the node renders as
 * the host's own component wherever the plugin puts it.
 */
export type PiRendererNode = unknown;

/**
 * What the host's model picker is showing, for a `beforeSend` component that
 * draws its own version of the control. Deliberately flat display data: the
 * picker's menu, search, keyboard handling, and the session write behind a
 * selection stay host-owned.
 */
export type PiRendererComposerModelSelection = {
  /** The provider the session is bound to, when it is bound to one. */
  providerId?: string;
  /** The model id the session is bound to, when it is bound to one. */
  modelId?: string;
  /** The model label the host's own picker chip shows. */
  label: string;
  /**
   * The reasoning level id the session runs at, as the host's own
   * `ThinkingLevel` vocabulary spells it (`"off"` when there is none).
   */
  thinkingLevel: string;
  /** That level as the host's own chip writes it. */
  thinkingLabel: string;
  /** True when the host holds a usable provider/model for this session. */
  ready: boolean;
};

/**
 * What the host's context display is drawing, for a `beforeSend` component that
 * draws its own version of it. The figures are the host's own computation over
 * the newest measured turn and the session's context window.
 */
export type PiRendererComposerContextUsage = {
  /** Tokens the newest measured turn occupies. */
  usedTokens: number;
  remainingTokens: number;
  /** The window both are measured against. */
  contextWindow: number;
  usedRatio: number;
  remainingRatio: number;
  /** `usedRatio` / `remainingRatio` as whole percentages. */
  usedPercent: number;
  remainingPercent: number;
};

/**
 * The state of the host's prompt-enhancement control, for a `beforeSend`
 * component that draws its own version of it. Enhancing a draft is the host's
 * own call to the model: the node is what starts it, and this is what the
 * component can say about it.
 */
export type PiRendererComposerEnhancement = {
  /** True when the host's own control would run for the draft it was handed. */
  enabled: boolean;
  /** True while the host's own enhancement call is running. */
  busy: boolean;
  /** The draft text the host's undo would restore; `null` with nothing to undo. */
  undoText: string | null;
};
/**
 * What the host hands a `completionSource` renderer: the query the completion
 * popover is open for.
 *
 * The slot is mounted inside the popover, below the host's own candidate rows,
 * and only while the popover is open — a closed popover asks a plugin for
 * nothing. It is a candidate source, not a filter: the host's own command and
 * file rows keep their own order and are never hidden or reordered by a plugin,
 * and a plugin contributes its rows after them (D8). The keyboard highlight,
 * `Enter`/`Tab` acceptance, and the accept mapping stay host-owned and cover
 * the host's rows; a plugin's own row carries its own activation.
 */
export type PiRendererCompletionSourceProps = {
  /** Draft session identity, absent until the first send materializes a session. */
  sessionId?: string;
  /** Replace this trigger with literal text. False means the draft/selection changed. */
  acceptText?: (text: string) => boolean;
  /** Which trigger opened the popover: `/` commands, or `@` file paths. */
  mode: "slash" | "file";
  /**
   * The text typed after the trigger, as the host tokenizes it; empty when the
   * user has typed the trigger alone. A component should answer with candidates
   * for this query and render nothing when it has none.
   */
  query: string;
};

/**
 * One reference chip the composer already holds, as a `composerReference`
 * component reads it. Deliberately not the host's own reference record: the
 * sentinel token and MIME details a chip is painted from stay host-owned.
 */
export type PiRendererComposerReference = {
  /** Workspace-relative path, as the chip's own title uses it. */
  path: string;
  /** Display name shown on the host's chip. */
  name: string;
  /** `file` for a text/document chip, `image` for an image attachment chip. */
  kind: "file" | "image";
};

/**
 * What the host hands a `composerReference` renderer: the chips the composer
 * holds for the current draft, plus the draft itself.
 *
 * The host's reference chips are painted inside the editor, so the slot is
 * mounted in the composer's input surface directly after the editor: a plugin
 * chip follows every host chip, and no host chip is moved or rewritten (D8).
 * The list is read-only — a component may draw its own chip for the draft and
 * dispatch the actions its manifest declares, but it cannot add a reference to
 * the draft from here, remove a host chip, or change what the draft sends.
 * A component that has no chip for the current draft renders nothing.
 */
export type PiRendererComposerReferenceProps = {
  /** The host's own chips, in the order the draft shows them. Read-only. */
  references: PiRendererComposerReference[];
  /**
   * The draft as the host currently holds it, including the editor's sentinel
   * characters. Read-only; a component derives what it needs from it.
   */
  draft: string;
  /**
   * The session the composer is drafting for. Absent for a draft that has no
   * session yet (a new-task composer), rather than an empty id.
   */
  sessionId?: string;
};
