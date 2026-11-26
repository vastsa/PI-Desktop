// PI-Desktop LAN WebUI. Plain DOM only: every value is set with textContent.
"use strict";

(() => {
  const TEMP = "__temporary__";
  const locales = window.LAN_LOCALES || {};
  const lang = (navigator.languages || [navigator.language || "en"]).find((code) => code && code.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
  const copy = { ...locales.en, ...(locales[lang] || {}), errors: { ...(locales.en || {}).errors, ...((locales[lang] || {}).errors || {}) } };
  document.documentElement.lang = lang;
  const t = (key, values) => String(copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ""));
  const errorText = (code) => copy.errors[code] || copy.errors.FAILED;

  const app = document.getElementById("app");
  const toast = document.getElementById("toast");
  const offline = document.getElementById("offline");
  const announcer = document.getElementById("announcer");
  const sheet = document.getElementById("sheet");

  const state = {
    me: null,
    route: { view: "projects" },
    drafts: new Map(),
    projects: new Map(),
    events: null,
    refreshTimer: null,
    renderToken: 0,
    sending: false,
    syncComposer: null,
    // Scroll offsets per list route, restored when the browser goes back.
    scroll: new Map(),
    forward: false,
  };
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  // ---------- helpers ----------
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  // Lucide outlines (ISC) on a 24px grid — the icon set Desktop ships.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    back: [["path", { d: "m15 18-6-6 6-6" }]],
    more: [["circle", { cx: 12, cy: 12, r: 1 }], ["circle", { cx: 19, cy: 12, r: 1 }], ["circle", { cx: 5, cy: 12, r: 1 }]],
    close: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
    search: [["circle", { cx: 11, cy: 11, r: 8 }], ["path", { d: "m21 21-4.3-4.3" }]],
    check: [["path", { d: "M20 6 9 17l-5-5" }]],
    send: [["path", { d: "m5 12 7-7 7 7" }], ["path", { d: "M12 19V5" }]],
    stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
    folder: [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
    temporary: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 6v6l4 2" }]],
    chat: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
    newChat: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }], ["path", { d: "M12 7v6" }], ["path", { d: "M9 10h6" }]],
    pin: [["path", { d: "M12 17v5" }], ["path", { d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" }]],
    unpin: [["path", { d: "M12 17v5" }], ["path", { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" }], ["path", { d: "m2 2 20 20" }], ["path", { d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" }]],
    pencil: [["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }], ["path", { d: "m15 5 4 4" }]],
    archive: [["rect", { width: 20, height: 5, x: 2, y: 3, rx: 1 }], ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }], ["path", { d: "M10 12h4" }]],
    restore: [["rect", { width: 20, height: 5, x: 2, y: 3, rx: 1 }], ["path", { d: "M4 8v11a2 2 0 0 0 2 2h2" }], ["path", { d: "M20 8v11a2 2 0 0 1-2 2h-2" }], ["path", { d: "m9 15 3-3 3 3" }], ["path", { d: "M12 12v9" }]],
    laptop: [["path", { d: "M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" }]],
    tool: [["path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" }]],
    logout: [["path", { d: "m16 17 5-5-5-5" }], ["path", { d: "M21 12H9" }], ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }]],
    pair: [["path", { d: "M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" }], ["path", { d: "M10 19v-3.96 3.15" }], ["path", { d: "M7 19h5" }], ["rect", { width: 6, height: 10, x: 16, y: 12, rx: 2 }]],
  };
  function icon(name, size = "") {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", size ? `icon ${size}` : "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const [tag, attrs] of ICONS[name]) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      svg.append(node);
    }
    return svg;
  }

  // DOM replaceChildren() turns null into the text "null"; drop empty slots first.
  // Re-rendering the same view keeps the focused field, its caret and its draft.
  function show(view, ...nodes) {
    const same = app.dataset.view === view;
    const active = document.activeElement;
    const keep = same && active instanceof HTMLElement && active.id && app.contains(active) ? active.id : "";
    const range = keep && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    app.replaceChildren(...nodes.filter(Boolean));
    app.dataset.view = view;
    const next = keep ? document.getElementById(keep) : null;
    if (next) {
      next.focus({ preventScroll: true });
      if (range && typeof next.setSelectionRange === "function") {
        try {
          next.setSelectionRange(range[0], range[1]);
        } catch {
          // Some input types do not expose a selection.
        }
      }
    }
    return !same;
  }
  let toastTimer = null;
  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 4000);
  }
  const announce = (message) => {
    if (message) announcer.textContent = message;
  };
  function setOffline(lost) {
    if (lost) offline.replaceChildren(el("span", { class: "dot offline" }), el("span", { text: t("offline") }));
    offline.hidden = !lost;
  }
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

  const clock = {
    time: new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit" }),
    weekday: new Intl.DateTimeFormat(lang, { weekday: "short" }),
    day: new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }),
    full: new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" }),
  };
  /** Compact last-activity label, like the Desktop sidebar: time, weekday or date. */
  function when(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (date.getTime() >= today) return clock.time.format(date);
    if (date.getTime() >= today - 6 * 86_400_000) return clock.weekday.format(date);
    if (date.getFullYear() === now.getFullYear()) return clock.day.format(date);
    return clock.full.format(date);
  }

  class ApiError extends Error {
    constructor(status, code) {
      super(code);
      this.status = status;
      this.code = code;
    }
  }

  async function api(method, path, body, key) {
    const headers = { Accept: "application/json" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      if (state.me?.csrf) headers["X-CSRF-Token"] = state.me.csrf;
      if (key) headers["Idempotency-Key"] = key;
    }
    let response;
    try {
      response = await fetch(path, { method, headers, credentials: "same-origin", body: method === "POST" ? JSON.stringify(body || {}) : undefined });
    } catch {
      throw new ApiError(0, "NETWORK");
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const code = data?.code || "FAILED";
      if (response.status === 401 && path.startsWith("/v1/") && state.me) {
        state.me = null;
        closeEvents();
        showPair();
      }
      throw new ApiError(response.status, code);
    }
    return data;
  }

  function fail(error) {
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") return;
    notify(errorText(error instanceof ApiError ? error.code : "FAILED"));
  }

  // ---------- routing ----------
  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    const [kind, raw] = hash.split("/");
    const id = raw ? decodeURIComponent(raw) : "";
    if (kind === "p" && id) return { view: "sessions", projectId: id };
    if (kind === "s" && id) return { view: "chat", sessionId: id };
    return { view: "projects" };
  }
  const routeKey = (hash) => (hash && hash !== "#" ? hash : "#/projects");
  const go = (hash) => {
    if (location.hash === hash) render();
    else {
      state.forward = true;
      location.hash = hash;
    }
  };
  window.addEventListener("hashchange", (event) => {
    const prefill = takePairingCode();
    if (prefill && !state.me) {
      showPair("", prefill);
      return;
    }
    state.scroll.set(routeKey(new URL(event.oldURL).hash), window.scrollY);
    const restoreScroll = !state.forward;
    state.forward = false;
    state.route = parseRoute();
    render({ restoreScroll });
  });

  // ---------- events ----------
  function openEvents() {
    closeEvents();
    const source = new EventSource("/v1/events");
    source.addEventListener("open", async () => {
      try {
        // Revalidate the credential and refresh the view
        // when the browser reconnects with the same device credential.
        const me = await api("GET", "/v1/me");
        if (state.events !== source) return;
        state.me = me;
        setOffline(false);
        scheduleRefresh();
      } catch (error) {
        if (state.events === source) fail(error);
      }
    });
    source.addEventListener("error", () => setOffline(true));
    source.addEventListener("change", (event) => {
      let data = {};
      try {
        data = JSON.parse(event.data || "{}");
      } catch {
        data = {};
      }
      const route = state.route;
      if (route.view === "chat" && data.sessionId && data.sessionId !== route.sessionId) return;
      scheduleRefresh();
    });
    state.events = source;
  }
  function closeEvents() {
    state.events?.close();
    state.events = null;
  }
  function scheduleRefresh() {
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      render({ refresh: true });
    }, 250);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.me) scheduleRefresh();
  });

  // ---------- sheet ----------
  let sheetReturn = null;
  function presentSheet(title, children, opener) {
    if (opener) sheetReturn = opener;
    document.getElementById("sheet-title").textContent = title;
    document.getElementById("sheet-actions").replaceChildren(...children);
    sheet.hidden = false;
  }
  function openSheet(title, actions, opener) {
    presentSheet(title, [
      ...actions.map((action) => el("button", {
        type: "button",
        class: action.danger ? "danger" : "",
        onclick: () => { closeSheet(false); action.run(); },
      }, [icon(action.icon), el("span", { text: action.label })])),
      el("button", { type: "button", class: "cancel", text: t("cancel"), onclick: () => closeSheet() }),
    ], opener || document.activeElement);
    document.querySelector("#sheet-actions button")?.focus();
  }
  function closeSheet(restoreFocus = true) {
    sheet.hidden = true;
    if (!restoreFocus) return;
    if (sheetReturn?.isConnected) sheetReturn.focus({ preventScroll: true });
    sheetReturn = null;
  }
  sheet.addEventListener("click", (event) => { if (event.target === sheet) closeSheet(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !sheet.hidden) closeSheet(); });

  function organize(kind, item, patch) {
    const path = `/v1/${kind}/${encodeURIComponent(item.id)}/organize`;
    return api("POST", path, { revision: item.revision, ...patch }, newKey())
      .then(() => render({ refresh: true }), (error) => { fail(error); render({ refresh: true }); });
  }

  function openRename(kind, item, current) {
    const input = el("input", { id: "rename-input", value: current, "aria-label": t("renamePrompt"), enterkeyhint: "done", autocomplete: "off" });
    const form = el("form", { class: "sheet-form" }, [
      input,
      el("div", { class: "sheet-buttons" }, [
        el("button", { type: "button", class: "secondary", text: t("cancel"), onclick: () => closeSheet() }),
        el("button", { type: "submit", class: "primary", text: t("save") }),
      ]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      closeSheet();
      if (name && name !== current) void organize(kind, item, { name });
    });
    presentSheet(t("rename"), [form]);
    input.focus();
    input.select();
  }

  function organizeActions(kind, item) {
    const label = kind === "projects" ? item.label : item.title || t("untitled");
    return [
      { icon: "pencil", label: t("rename"), run: () => openRename(kind, item, label) },
      { icon: item.pinned ? "unpin" : "pin", label: item.pinned ? t("unpin") : t("pin"), run: () => void organize(kind, item, { pinned: !item.pinned }) },
      { icon: item.archived ? "restore" : "archive", label: item.archived ? t("restore") : t("archive"), danger: !item.archived, run: () => void organize(kind, item, { archived: !item.archived }) },
    ];
  }

  // ---------- views ----------
  /** One status/flag entry: a dot or a small icon, always with its text. */
  function metaItem(entry) {
    return el("span", { class: "meta-item" }, [
      entry.dot ? el("span", { class: `dot ${entry.dot}` }) : entry.icon ? icon(entry.icon, "xs") : null,
      el("span", { class: "meta-text", text: entry.text }),
    ]);
  }
  function flags(item) {
    return [
      item.pinned ? { icon: "pin", text: t("pinned") } : null,
      item.archived ? { icon: "archive", text: t("archived") } : null,
    ].filter(Boolean);
  }
  function sessionStatus(status) {
    if (status === "running") return { dot: "running", text: t("running") };
    if (status === "waiting") return { dot: "waiting", text: t("waiting") };
    return null;
  }

  function header({ title, back, subtitle = [], actions = [], root = false }) {
    return el("header", { class: root ? "header root" : "header" }, [
      back
        ? el("button", { type: "button", class: "icon-btn", "aria-label": t("back"), onclick: () => (history.length > 1 ? history.back() : go(back)) }, icon("back"))
        : null,
      el("div", { class: "header-title" }, [
        el("h1", { id: "view-title", tabindex: "-1", text: title }),
        subtitle.length ? el("p", { class: "header-sub" }, subtitle.map(metaItem)) : null,
      ]),
      ...actions,
    ]);
  }
  const moreButton = (name, actions) => el("button", {
    type: "button",
    class: "icon-btn",
    "aria-label": t("more", { name }),
    "aria-haspopup": "dialog",
    onclick: (event) => openSheet(name, actions, event.currentTarget),
  }, icon("more"));

  function toolbar(filters, onChange) {
    const search = el("input", {
      id: "list-search", type: "search", placeholder: t("search"), "aria-label": t("search"),
      value: filters.q, enterkeyhint: "search", autocomplete: "off",
    });
    let timer = null;
    search.addEventListener("input", () => {
      // Keep the latest text in the filter so a re-render never drops keystrokes.
      filters.q = search.value;
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    });
    const archived = el("button", {
      id: "filter-archived",
      type: "button",
      class: "chip",
      "aria-pressed": filters.archived ? "true" : "false",
      onclick: () => { filters.archived = !filters.archived; onChange(); },
    }, [icon(filters.archived ? "check" : "archive", "sm"), el("span", { text: t("showArchived") })]);
    return el("div", { class: "toolbar" }, [el("div", { class: "search" }, [icon("search", "sm"), search]), archived]);
  }

  function row({ icon: iconName, title, meta = [], time = "", onOpen, actions = [], moreLabel }) {
    return el("li", { class: "row" }, [
      el("button", { type: "button", class: "row-main", onclick: onOpen }, [
        iconName ? el("span", { class: "row-icon" }, icon(iconName)) : null,
        el("span", { class: "row-text" }, [
          el("span", { class: "row-title", text: title }),
          meta.length ? el("span", { class: "row-meta" }, meta.map(metaItem)) : null,
        ]),
        time ? el("span", { class: "row-time", text: time }) : null,
      ]),
      actions.length
        ? el("button", { type: "button", class: "row-more icon-btn", "aria-label": moreLabel, "aria-haspopup": "dialog", onclick: (event) => openSheet(title, actions, event.currentTarget) }, icon("more"))
        : null,
    ]);
  }
  const emptyState = (text, iconName) => el("div", { class: "empty" }, [icon(iconName, "lg"), el("p", { text })]);

  const listFilters = { projects: { q: "", archived: false }, sessions: { q: "", archived: false } };

  async function loadAll(path) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await api("GET", cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path);
      items.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  async function renderProjects(token) {
    const filters = listFilters.projects;
    const query = `?q=${encodeURIComponent(filters.q)}${filters.archived ? "&archived=1" : ""}`;
    const items = await loadAll(`/v1/projects${query}`);
    if (token !== state.renderToken) return undefined;
    for (const item of items) state.projects.set(item.id, item.label);
    const temporary = !filters.archived && !filters.q
      ? el("ul", { class: "list group" }, row({ icon: "temporary", title: t("temporary"), onOpen: () => go(`#/p/${TEMP}`) }))
      : null;
    const list = items.length
      ? el("ul", { class: "list" }, items.map((item) => row({
          icon: "folder",
          title: item.label,
          meta: flags(item),
          onOpen: () => go(`#/p/${encodeURIComponent(item.id)}`),
          actions: organizeActions("projects", item),
          moreLabel: t("more", { name: item.label }),
        })))
      : emptyState(filters.q ? t("noMatches") : t("noProjects"), filters.q ? "search" : "folder");
    return show(
      "projects",
      header({ title: t("projects"), root: true }),
      toolbar(filters, () => render()),
      temporary,
      list,
      el("button", { type: "button", class: "link signout", onclick: signOut }, [icon("logout", "sm"), el("span", { text: t("signOut") })]),
    );
  }

  async function renderSessions(token, projectId) {
    const filters = listFilters.sessions;
    const query = `?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(filters.q)}${filters.archived ? "&archived=1" : ""}`;
    const items = await loadAll(`/v1/sessions${query}`);
    if (token !== state.renderToken) return undefined;
    const title = projectId === TEMP ? t("temporary") : state.projects.get(projectId) || t("projects");
    const list = items.length
      ? el("ul", { class: "list" }, items.map((item) => row({
          title: item.title || t("untitled"),
          meta: [sessionStatus(item.status), ...flags(item), item.readOnly ? { icon: "laptop", text: t("readOnly") } : null].filter(Boolean),
          time: when(item.updatedAt),
          onOpen: () => go(`#/s/${encodeURIComponent(item.id)}`),
          actions: organizeActions("sessions", item),
          moreLabel: t("more", { name: item.title || t("untitled") }),
        })))
      : emptyState(filters.q ? t("noMatches") : t("noSessions"), filters.q ? "search" : "chat");
    const create = el("button", {
      type: "button",
      class: "primary fab",
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const created = await api("POST", "/v1/sessions", { projectId: projectId === TEMP ? null : projectId }, newKey());
          go(`#/s/${encodeURIComponent(created.id)}`);
        } catch (error) {
          fail(error);
          button.disabled = false;
        }
      },
    }, [icon("newChat"), el("span", { text: t("newSession") })]);
    return show(
      `sessions:${projectId}`,
      header({ title, back: "#/projects" }),
      toolbar(filters, () => render()),
      create,
      list,
      el("div", { class: "fab-spacer", "aria-hidden": "true" }),
    );
  }

  const roleLabel = { user: "you", assistant: "assistant", tool: "tool" };
  function message(item, extraClass = "") {
    const role = roleLabel[item.role] ? item.role : "assistant";
    const body = [el("span", { class: "sr-only", text: `${t(roleLabel[role])}: ` })];
    if (role === "tool") body.push(icon("tool", "sm"), el("span", { text: item.text }));
    else body.push(document.createTextNode(item.text));
    return el("div", { class: extraClass ? `msg ${role} ${extraClass}` : `msg ${role}` }, body);
  }

  function notice({ dot, icon: iconName, text, action }) {
    return el("div", { class: "notice" }, [
      dot ? el("span", { class: `dot ${dot}` }) : icon(iconName, "sm"),
      el("span", { class: "notice-text", text }),
      action ? el("button", { type: "button", class: "secondary", text: action.label, onclick: action.run }) : null,
    ]);
  }

  const chatState = { sessionId: null, older: [], olderCursor: undefined, phase: null };
  const phaseText = { running: "running", "waiting-approval": "waitingApproval", "waiting-input": "waitingInput", idle: "replyDone" };

  async function renderChat(token, sessionId, refresh) {
    if (chatState.sessionId !== sessionId) Object.assign(chatState, { sessionId, older: [], olderCursor: undefined, phase: null });
    const conversation = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
    if (token !== state.renderToken) return undefined;
    const { session } = conversation;
    const nextCursor = chatState.olderCursor === undefined ? conversation.messages.nextCursor : chatState.olderCursor;
    const scroller = document.scrollingElement;
    const atBottom = !refresh || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;

    const messages = el("div", { class: "messages" });
    if (nextCursor) {
      messages.append(el("button", {
        type: "button",
        class: "link load-older",
        text: t("loadOlder"),
        onclick: async () => {
          try {
            const before = scroller.scrollHeight;
            const page = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/history?cursor=${encodeURIComponent(nextCursor)}`);
            chatState.older = [...page.items, ...chatState.older];
            chatState.olderCursor = page.nextCursor;
            await render({ refresh: true });
            scroller.scrollTop += scroller.scrollHeight - before;
          } catch (error) {
            fail(error);
          }
        },
      }));
    }
    const seen = new Set();
    for (const item of [...chatState.older, ...conversation.messages.items]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      messages.append(message(item));
    }
    if (conversation.liveText) messages.append(message({ role: "assistant", text: conversation.liveText }, "live"));

    // Announce actionable state changes, not every streamed token.
    const phase = conversation.waiting ? `waiting-${conversation.waiting}` : conversation.activeTurnId ? "running" : "idle";
    if (chatState.phase && chatState.phase !== phase) announce(t(phaseText[phase]));
    chatState.phase = phase;

    const notices = [];
    if (conversation.waiting === "approval") notices.push(notice({ dot: "waiting", text: t("waitingApproval") }));
    if (conversation.waiting === "input") notices.push(notice({ dot: "waiting", text: t("waitingInput") }));
    if (session.archived) {
      notices.push(notice({ icon: "archive", text: t("archivedSession"), action: { label: t("restore"), run: () => void organize("sessions", session, { archived: false }) } }));
    }
    if (session.readOnly) notices.push(notice({ icon: "laptop", text: t("readOnlySession") }));

    const queue = conversation.queue.length
      ? el("div", { class: "queue" }, conversation.queue.map((entry) => el("div", { class: "queue-item" }, [
          el("span", { class: "queue-text" }, [el("span", { class: "queue-label", text: t("queued") }), el("span", { class: "queue-body", text: entry.text })]),
          el("button", {
            type: "button",
            class: "icon-btn",
            "aria-label": t("cancelQueued"),
            onclick: () => api("POST", `/v1/turns/${encodeURIComponent(entry.id)}:cancel`, { sessionId }, newKey()).then(() => render({ refresh: true }), fail),
          }, icon("close", "sm")),
        ])))
      : null;

    const canChat = !session.readOnly && !session.archived;
    const composer = canChat ? buildComposer(sessionId, conversation) : null;
    const title = session.title || t("untitled");
    const subtitle = [
      conversation.modelLabel ? { text: conversation.modelLabel } : null,
      sessionStatus(conversation.waiting ? "waiting" : conversation.activeTurnId ? "running" : session.status),
    ].filter(Boolean);
    const head = header({
      title,
      back: session.projectId ? `#/p/${encodeURIComponent(session.projectId)}` : `#/p/${TEMP}`,
      subtitle,
      actions: [moreButton(title, organizeActions("sessions", session))],
    });
    const dockItems = [...notices, queue, composer].filter(Boolean);
    const changed = show(`chat:${sessionId}`, head, messages, dockItems.length ? el("div", { class: "chat-dock" }, dockItems) : null);
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    return changed;
  }

  function buildComposer(sessionId, conversation) {
    const running = Boolean(conversation.activeTurnId);
    const input = el("textarea", { id: "composer-input", rows: "1", "aria-label": t("composer"), placeholder: t("composer"), enterkeyhint: "send" });
    input.value = state.drafts.get(sessionId) || "";
    const send = el("button", {
      type: "button",
      class: running ? "primary send is-queue" : "primary send",
      "aria-label": running ? null : t("send"),
      onclick: () => void submit(running),
    }, running ? el("span", { text: t("queue") }) : icon("send"));
    const sync = () => { send.disabled = state.sending || !input.value.trim(); };
    state.syncComposer = sync;
    const fit = () => { input.style.height = "auto"; input.style.height = `${input.scrollHeight}px`; };
    input.addEventListener("input", () => { state.drafts.set(sessionId, input.value); fit(); sync(); });
    const submit = async (queue) => {
      const text = input.value.trim();
      if (!text || state.sending) return;
      state.sending = true;
      sync();
      try {
        await api("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, { text, queue }, newKey());
        state.drafts.delete(sessionId);
        input.value = "";
        await render({ refresh: true });
      } catch (error) {
        fail(error);
      } finally {
        state.sending = false;
        state.syncComposer?.();
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (!window.matchMedia("(pointer: fine)").matches && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void submit(running);
    });
    setTimeout(fit, 0);
    sync();
    const actions = el("div", { class: "actions" }, [
      running
        ? el("button", {
            type: "button",
            class: "stop",
            "aria-label": t("stop"),
            onclick: () => api("POST", `/v1/turns/${encodeURIComponent(conversation.activeTurnId)}:interrupt`, { sessionId }, newKey()).then(() => render({ refresh: true }), fail),
          }, icon("stop"))
        : null,
      send,
    ]);
    return el("div", { class: "composer" }, [input, actions]);
  }

  async function render(options = {}) {
    if (!state.me) return;
    const token = ++state.renderToken;
    const route = state.route;
    try {
      let changed;
      if (route.view === "projects") changed = await renderProjects(token);
      else if (route.view === "sessions") changed = await renderSessions(token, route.projectId);
      else changed = await renderChat(token, route.sessionId, options.refresh === true);
      if (changed === undefined) return;
      if (route.view !== "chat" && !options.refresh) {
        const saved = options.restoreScroll ? state.scroll.get(routeKey(location.hash)) : undefined;
        window.scrollTo(0, saved ?? 0);
      }
      // Move screen-reader focus to the new page title, never into a field.
      if (changed) document.getElementById("view-title")?.focus({ preventScroll: true });
    } catch (error) {
      if (token !== state.renderToken) return;
      if (error instanceof ApiError && error.code === "NOT_FOUND" && route.view !== "projects") {
        notify(errorText("NOT_FOUND"));
        go("#/projects");
        return;
      }
      fail(error);
    }
  }

  // ---------- pairing ----------
  function takePairingCode() {
    if (!location.hash.startsWith("#pair=")) return "";
    const value = /^#pair=([0-9]{6})$/.exec(location.hash)?.[1] ?? "";
    history.replaceState(history.state, "", location.pathname + location.search);
    return value;
  }

  function showPair(message, prefill = "") {
    closeEvents();
    setOffline(false);
    const code = el("input", {
      id: "pair-code", class: "code", inputmode: "numeric", autocomplete: "one-time-code",
      maxlength: "32", required: true, value: prefill, "aria-describedby": "pair-status",
    });
    const label = el("input", { id: "pair-label", maxlength: "60", autocomplete: "off", value: /iPhone|iPad|Android/.exec(navigator.userAgent)?.[0] || "Browser" });
    const status = el("p", { id: "pair-status", class: "pair-status", role: "status", text: message || "" });
    const submit = el("button", { type: "submit", class: "primary", text: t("pairSubmit") });
    const form = el("form", { class: "pair" }, [
      icon("pair", "lg"),
      el("h1", { text: t("pairTitle") }),
      el("p", { class: "pair-hint", text: t("pairHint") }),
      el("label", { for: "pair-code", text: t("codeLabel") }), code,
      el("label", { for: "pair-label", text: t("deviceLabel") }), label,
      submit, status,
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const value = code.value.normalize("NFKC").replace(/[\s-]+/g, "");
      if (!/^[0-9]{6}$/.test(value)) {
        status.textContent = t("pairFormat");
        code.focus();
        return;
      }
      code.value = value;
      submit.disabled = true;
      status.textContent = t("pairConnecting");
      try {
        const result = await api("POST", "/pair", { code: value, label: label.value.trim() });
        if (result?.state !== "paired") {
          status.textContent = t("pairRestart");
          submit.disabled = false;
          return;
        }
        await start("", true);
      } catch (error) {
        submit.disabled = false;
        const codeName = error instanceof ApiError ? error.code : "FAILED";
        status.textContent = codeName === "PAIRING_CLOSED" ? t("pairClosed") : codeName === "PAIRING_FAILED" ? t("pairFailed") : errorText(codeName);
      }
    });
    show("pair", form);
    if (prefill) submit.focus();
    else code.focus();
  }

  async function signOut() {
    try {
      await api("POST", "/v1/logout", {});
    } catch {
      // Signed out either way.
    }
    state.me = null;
    showPair();
  }

  async function start(prefill = "", justPaired = false) {
    try {
      state.me = await api("GET", "/v1/me");
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "FAILED";
      const message = code === "UNAUTHORIZED" ? justPaired ? t("pairCookieBlocked") : "" : errorText(code);
      showPair(message, prefill);
      return;
    }
    state.route = parseRoute();
    openEvents();
    await render();
  }

  document.title = t("appTitle");
  void start(takePairingCode());
})();
