// PI-Desktop LAN WebUI. Plain DOM only: every value is set with textContent.
"use strict";

(() => {
  const { el, icon, copyText } = window.LanKit;
  const TEMP = "__temporary__";
  const RECENT_LIMIT = 5;
  const PENDING_TTL = 30_000;
  const locales = window.LAN_LOCALES || {};
  const lang = (navigator.languages || [navigator.language || "en"]).find((code) => code && code.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
  const copy = { ...locales.en, ...(locales[lang] || {}), errors: { ...(locales.en || {}).errors, ...((locales[lang] || {}).errors || {}) } };
  document.documentElement.lang = lang;
  const t = (key, values) => String(copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ""));
  const errorText = (code) => copy.errors[code] || copy.errors.FAILED;
  const enc = encodeURIComponent;

  const app = document.getElementById("app");
  const toast = document.getElementById("toast");
  const offline = document.getElementById("offline");
  const announcer = document.getElementById("announcer");
  const sheet = document.getElementById("sheet");

  const state = {
    me: null,
    route: { view: "home", archived: false },
    online: true,
    drafts: new Map(),
    /** Optimistic user turns per session, shown until the Host records them. */
    pending: new Map(),
    projects: new Map(),
    /** The last unfiltered list of active projects, for the New conversation picker. */
    catalog: null,
    query: { home: "", sessions: "", project: null },
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
  // DOM replaceChildren() turns null into the text "null"; drop empty slots first.
  // Re-rendering the same view keeps the focused field, its caret and its draft.
  function show(view, ...nodes) {
    const same = app.dataset.view === view;
    const active = document.activeElement;
    const keep = same && active instanceof HTMLElement && active.id && app.contains(active) ? active.id : "";
    const range = keep && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    app.replaceChildren(...nodes.flat().filter(Boolean));
    app.dataset.view = view;
    trackDock();
    if (!same && view !== "loading") enterPage();
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
  // Toasts rise above the composer dock, whose height changes as a prompt grows.
  const dockObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(([entry]) => {
        if (entry?.target.isConnected) document.documentElement.style.setProperty("--dock", `${Math.round(entry.target.getBoundingClientRect().height)}px`);
      })
    : null;
  function trackDock() {
    dockObserver?.disconnect();
    const dock = app.querySelector(".chat-dock");
    if (dock) dockObserver?.observe(dock);
    else document.documentElement.style.removeProperty("--dock");
  }
  /** A new page slides in from the side it was reached from; refreshes never move. */
  let direction = "push";
  function enterPage() {
    app.classList.remove("enter-push", "enter-pop");
    void app.offsetWidth;
    app.classList.add(`enter-${direction}`);
  }
  app.addEventListener("animationend", (event) => {
    if (event.animationName.startsWith("page-")) app.classList.remove("enter-push", "enter-pop");
  });
  // Safari only paints :active feedback once the page listens for touches.
  document.addEventListener("touchstart", () => {}, { passive: true });
  // The bar gains its hairline once content scrolls beneath it. On list pages
  // the compact bar title takes over when the large title passes under the bar.
  function syncScrolled() {
    const root = document.documentElement;
    root.classList.toggle("scrolled", window.scrollY > 2);
    const bar = app.querySelector(".header");
    const large = app.querySelector(".large-title h1");
    root.classList.toggle("collapsed", Boolean(bar && large && large.getBoundingClientRect().bottom <= bar.getBoundingClientRect().bottom + 1));
  }
  let scrollFrame = 0;
  window.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      syncScrolled();
      syncJump();
    });
  }, { passive: true });
  let toastTimer = null;
  function notify(message, duration = 4000) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), duration);
  }
  // Clear first so a repeated message (“Copied” twice) is announced again.
  const announce = (message) => {
    if (!message) return;
    announcer.textContent = "";
    setTimeout(() => (announcer.textContent = message), 30);
  };
  function setOffline(lost) {
    state.online = !lost;
    if (lost) offline.replaceChildren(el("span", { class: "dot offline" }), el("span", { text: t("offline") }));
    offline.hidden = !lost;
    // Mutations wait for the connection; drafts stay where they are.
    for (const button of app.querySelectorAll("[data-mutation]")) button.disabled = lost;
    state.syncComposer?.();
  }
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

  async function copyWithFeedback(text, button) {
    if (!(await copyText(text))) {
      notify(t("copyFailed"));
      return;
    }
    announce(t("copied"));
    // The control confirms the copy in place; a toast only when it is gone.
    if (!button?.isConnected) {
      notify(t("copied"), 1500);
      return;
    }
    button.classList.add("copied");
    button.replaceChildren(icon("check", "sm"));
    setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove("copied");
      button.replaceChildren(icon("copy", "sm"));
    }, 1500);
  }
  const markdownOptions = { labels: { copyCode: t("copyCode"), image: t("imagePlaceholder") }, onCopy: copyWithFeedback };

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

  const modelPicker = window.createLanModelPicker({
    t, errorText,
    load: (sessionId) => api("GET", `/v1/sessions/${enc(sessionId)}/models`),
    save: (sessionId, choice) => api("POST", `/v1/sessions/${enc(sessionId)}/model`, choice, newKey()),
    refresh: (sessionId) => state.route.view === "chat" && state.route.sessionId === sessionId ? render({ refresh: true }) : undefined,
    onSavingChange: () => state.syncComposer?.(),
  });

  async function loadAll(path) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await api("GET", cursor ? `${path}&cursor=${enc(cursor)}` : path);
      items.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  // ---------- routing ----------
  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    const [kind, raw, tail] = hash.split("/");
    const id = raw ? decodeURIComponent(raw) : "";
    if (kind === "archived") return { view: "home", archived: true };
    if (kind === "p" && id) return { view: "sessions", projectId: id, archived: tail === "archived" };
    if (kind === "s" && id) return { view: "chat", sessionId: id };
    return { view: "home", archived: false };
  }
  const routeKey = (hash) => (hash && hash !== "#" ? hash : "#/projects");
  const projectHash = (projectId) => `#/p/${enc(projectId ?? TEMP)}`;
  const go = (hash) => {
    if (location.hash === hash) render();
    else {
      state.forward = true;
      location.hash = hash;
    }
  };
  const back = (fallback) => (history.length > 1 ? history.back() : go(fallback));
  window.addEventListener("hashchange", (event) => {
    // Menus belong to the page that opened them; Back must not carry them along.
    modelPicker.dismiss();
    if (!sheet.hidden) closeSheet(false);
    const prefill = takePairingCode();
    if (prefill && !state.me) {
      showPair("", prefill);
      return;
    }
    state.scroll.set(routeKey(new URL(event.oldURL).hash), window.scrollY);
    const restoreScroll = !state.forward;
    direction = state.forward ? "push" : "pop";
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
    sheetPanel.style.translate = "";
    sheet.hidden = false;
  }
  function openSheet(title, actions, opener) {
    presentSheet(title, [
      ...actions.map((action) => el("button", {
        type: "button",
        class: action.danger ? "danger" : "",
        onclick: () => { closeSheet(false); action.run(); },
      }, [icon(action.icon), el("span", { class: "sheet-label", text: action.label })])),
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
  // Pull the sheet down from its top to dismiss it, like a native action sheet.
  const sheetPanel = sheet.querySelector(".sheet-panel");
  let drag = null;
  sheetPanel.addEventListener("touchstart", (event) => {
    drag = sheetPanel.scrollTop <= 0 && event.touches.length === 1 ? { y: event.touches[0].clientY, dy: 0 } : null;
  }, { passive: true });
  sheetPanel.addEventListener("touchmove", (event) => {
    if (!drag) return;
    drag.dy = Math.max(0, event.touches[0].clientY - drag.y);
    sheetPanel.style.transition = "none";
    sheetPanel.style.translate = `0 ${drag.dy}px`;
  }, { passive: true });
  const endDrag = () => {
    if (!drag) return;
    const { dy } = drag;
    drag = null;
    sheetPanel.style.transition = "";
    if (dy <= 72) {
      sheetPanel.style.translate = "";
      return;
    }
    // A dismissed sheet keeps travelling from where the finger let go as it fades.
    sheetPanel.style.translate = `0 ${dy + 32}px`;
    closeSheet();
    setTimeout(() => { if (sheet.hidden) sheetPanel.style.translate = ""; }, 260);
  };
  sheetPanel.addEventListener("touchend", endDrag);
  sheetPanel.addEventListener("touchcancel", endDrag);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !sheet.hidden) closeSheet(); });

  function organize(kind, item, patch) {
    if (!state.online) return notify(errorText("NETWORK"));
    const path = `/v1/${kind}/${enc(item.id)}/organize`;
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

  async function createSession(projectId, button) {
    if (!state.online) return notify(errorText("NETWORK"));
    if (button) button.disabled = true;
    try {
      const created = await api("POST", "/v1/sessions", { projectId: projectId === TEMP ? null : projectId }, newKey());
      go(`#/s/${enc(created.id)}`);
    } catch (error) {
      fail(error);
      if (button?.isConnected) button.disabled = false;
    }
  }

  /** From Home, one tap asks only where the conversation should live. */
  async function pickNewConversation(opener) {
    try {
      const projects = state.catalog ?? await loadAll("/v1/projects?q=");
      openSheet(t("newIn"), [
        { icon: "temporary", label: t("temporary"), run: () => void createSession(TEMP) },
        ...projects.map((project) => ({ icon: "folder", label: project.label, run: () => void createSession(project.id) })),
      ], opener);
    } catch (error) {
      fail(error);
    }
  }

  // ---------- shared view parts ----------
  /** One status/flag entry: a dot or a small icon, always with its text. */
  function metaItem(entry) {
    return el("span", { class: entry.class ? `meta-item ${entry.class}` : "meta-item" }, [
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
  function scopeMeta(session) {
    if (session.projectId === null) return { icon: "temporary", text: t("temporary"), class: "scope" };
    const label = session.projectLabel || state.projects.get(session.projectId);
    return label ? { icon: "folder", text: label, class: "scope" } : null;
  }

  /**
   * A conversation keeps its title in the bar. List pages lead with a large
   * title in the page that hands over to a compact bar title on scroll.
   */
  function header({ title, backTo, subtitle = [], actions = [], large = false }) {
    const backButton = backTo ? el("button", { type: "button", class: "icon-btn back", "aria-label": t("back"), onclick: () => back(backTo) }, icon("back")) : null;
    const heading = el("h1", { id: "view-title", tabindex: "-1", text: title });
    const sub = subtitle.length ? el("p", { class: large ? "large-sub" : "header-sub" }, subtitle.map(metaItem)) : null;
    if (!large) return el("header", { class: "header" }, [backButton, el("div", { class: "header-title" }, [heading, sub]), ...actions]);
    return [
      el("header", { class: "header large" }, [
        backButton,
        el("div", { class: "header-compact", "aria-hidden": "true" }, el("span", { text: title })),
        el("span", { class: "header-spacer" }),
        ...actions,
      ]),
      el("div", { class: "large-title" }, [heading, sub]),
    ];
  }
  const moreButton = (name, actions) => el("button", {
    type: "button",
    class: "icon-btn",
    "aria-label": t("more", { name }),
    "aria-haspopup": "dialog",
    onclick: (event) => openSheet(name, actions, event.currentTarget),
  }, icon("more"));

  function searchField(key) {
    const search = el("input", {
      id: "list-search", type: "search", placeholder: t("search"), "aria-label": t("search"),
      value: state.query[key], enterkeyhint: "search", autocomplete: "off",
    });
    const clear = el("button", {
      type: "button", class: "icon-btn search-clear", "aria-label": t("clearSearch"), hidden: !state.query[key],
      onclick: () => {
        search.value = "";
        search.dispatchEvent(new Event("input"));
        search.focus();
      },
    }, icon("close", "sm"));
    let timer = null;
    search.addEventListener("input", () => {
      // Keep the latest text in the query so a re-render never drops keystrokes.
      state.query[key] = search.value;
      clear.hidden = !search.value;
      clearTimeout(timer);
      timer = setTimeout(() => render(), 250);
    });
    return el("div", { class: "toolbar" }, el("div", { class: "search" }, [icon("search", "sm"), search, clear]));
  }

  function row({ icon: iconName, title, meta = [], time = "", onOpen, actions = [], moreLabel }) {
    const more = actions.length
      ? el("button", { type: "button", class: "row-more icon-btn", "aria-label": moreLabel, "aria-haspopup": "dialog", onclick: (event) => openSheet(title, actions, event.currentTarget) }, icon("more"))
      : null;
    const item = el("li", { class: "row" }, [
      el("button", { type: "button", class: "row-main", onclick: onOpen }, [
        iconName ? el("span", { class: "row-icon" }, icon(iconName)) : null,
        el("span", { class: "row-text" }, [
          el("span", { class: "row-head" }, [
            el("span", { class: "row-title", text: title }),
            time ? el("span", { class: "row-time", text: time }) : null,
          ]),
          meta.length ? el("span", { class: "row-meta" }, meta.map(metaItem)) : null,
        ]),
      ]),
      more,
    ]);
    // A long press (Android) or secondary click opens the same labeled menu.
    if (more) item.addEventListener("contextmenu", (event) => { event.preventDefault(); openSheet(title, actions, more); });
    return item;
  }
  function sessionRow(item, showScope) {
    const title = item.title || t("untitled");
    return row({
      title,
      meta: [sessionStatus(item.status), showScope ? scopeMeta(item) : null, ...flags(item), item.readOnly ? { icon: "laptop", text: t("readOnly") } : null].filter(Boolean),
      time: when(item.updatedAt),
      onOpen: () => go(`#/s/${enc(item.id)}`),
      actions: organizeActions("sessions", item),
      moreLabel: t("more", { name: title }),
    });
  }
  function projectRow(item) {
    return row({
      icon: "folder",
      title: item.label,
      meta: flags(item),
      onOpen: () => go(projectHash(item.id)),
      actions: organizeActions("projects", item),
      moreLabel: t("more", { name: item.label }),
    });
  }
  const section = (id, label, children) => el("section", { id, class: "section", "aria-label": label }, [el("h2", { class: "section-label", text: label }), ...children]);
  const emptyState = (text, iconName) => el("div", { class: "empty" }, [icon(iconName, "lg"), el("p", { text })]);
  const archivedLink = (hash) => el("button", { type: "button", class: "footer-link", onclick: () => go(hash) }, [
    icon("archive", "sm"), el("span", { text: t("archivedView") }), icon("chevron", "sm"),
  ]);
  function newConversationButton(onClick) {
    return el("button", {
      type: "button",
      class: "primary fab",
      "data-mutation": "",
      disabled: !state.online,
      onclick: (event) => onClick(event.currentTarget),
    }, [icon("newChat"), el("span", { text: t("newSession") })]);
  }

  async function ensureProjectLabel(projectId) {
    if (projectId === TEMP || state.projects.has(projectId)) return;
    const [active, archived] = await Promise.all([loadAll("/v1/projects?q="), loadAll("/v1/projects?q=&archived=1")]);
    for (const item of [...active, ...archived]) state.projects.set(item.id, item.label);
  }

  // ---------- home ----------
  async function renderHome(token, archived) {
    const q = state.query.home.trim();
    const flag = archived ? "&archived=1" : "";
    const browsing = !archived && !q;
    const [projects, sessions] = await Promise.all([
      loadAll(`/v1/projects?q=${enc(q)}${flag}`),
      browsing ? api("GET", "/v1/sessions?q=").then((page) => page.items) : loadAll(`/v1/sessions?q=${enc(q)}${flag}`),
    ]);
    if (token !== state.renderToken) return undefined;
    for (const item of projects) state.projects.set(item.id, item.label);
    if (browsing) state.catalog = projects;

    // Running work always stays visible; otherwise show a short recent list.
    const running = sessions.filter((item) => item.status === "running").length;
    const recent = browsing ? sessions.slice(0, Math.max(RECENT_LIMIT, running)) : sessions;
    const projectRows = projects.map(projectRow);
    if (browsing) projectRows.unshift(row({ icon: "temporary", title: t("temporary"), onOpen: () => go(projectHash(TEMP)) }));

    const parts = [];
    if (recent.length) parts.push(section("section-recent", browsing ? t("recent") : t("conversations"), [el("ul", { class: "list" }, recent.map((item) => sessionRow(item, true)))]));
    if (projectRows.length) {
      parts.push(section("section-projects", t("projects"), [
        el("ul", { class: "list" }, projectRows),
        browsing && !projects.length ? el("p", { class: "hint", text: t("noProjects") }) : null,
      ]));
    }
    if (!parts.length) parts.push(emptyState(archived ? t("noArchived") : t("noMatches"), archived ? "archive" : "search"));

    return show(
      archived ? "home:archived" : "home",
      header(archived ? { title: t("archivedView"), backTo: "#/projects", large: true } : { title: t("appTitle"), large: true }),
      searchField("home"),
      ...parts,
      browsing ? el("div", { class: "footer" }, [
        archivedLink("#/archived"),
        el("div", { class: "device" }, [
          state.me?.label ? el("p", { class: "device-name" }, [icon("pair", "xs"), el("span", { text: t("thisDevice", { name: state.me.label }) })]) : null,
          el("button", {
            type: "button",
            class: "link signout",
            onclick: (event) => openSheet(t("signOutConfirm"), [{ icon: "logout", label: t("signOut"), danger: true, run: signOut }], event.currentTarget),
          }, [icon("logout", "sm"), el("span", { text: t("signOut") })]),
        ]),
      ]) : null,
      browsing ? newConversationButton((button) => void pickNewConversation(button)) : null,
      browsing ? el("div", { class: "fab-spacer", "aria-hidden": "true" }) : null,
    );
  }

  // ---------- project sessions ----------
  async function renderSessions(token, projectId, archived) {
    // A search belongs to the project it was typed in.
    if (state.query.project !== projectId) Object.assign(state.query, { sessions: "", project: projectId });
    const q = state.query.sessions.trim();
    const [items] = await Promise.all([
      loadAll(`/v1/sessions?projectId=${enc(projectId)}&q=${enc(q)}${archived ? "&archived=1" : ""}`),
      ensureProjectLabel(projectId),
    ]);
    if (token !== state.renderToken) return undefined;
    const name = projectId === TEMP ? t("temporary") : state.projects.get(projectId) || t("projects");
    const list = items.length
      ? el("ul", { class: "list" }, items.map((item) => sessionRow(item, false)))
      : emptyState(q ? t("noMatches") : archived ? t("noArchived") : t("noSessions"), q ? "search" : archived ? "archive" : "chat");
    return show(
      `sessions:${projectId}${archived ? ":archived" : ""}`,
      archived
        ? header({ title: t("archivedView"), backTo: projectHash(projectId), subtitle: [{ icon: projectId === TEMP ? "temporary" : "folder", text: name }], large: true })
        : header({ title: name, backTo: "#/projects", large: true }),
      searchField("sessions"),
      archived ? null : newConversationButton((button) => void createSession(projectId, button)),
      list,
      archived || q ? null : el("div", { class: "footer" }, archivedLink(`${projectHash(projectId)}/archived`)),
      archived ? null : el("div", { class: "fab-spacer", "aria-hidden": "true" }),
    );
  }

  // ---------- conversation ----------
  const roleLabel = { user: "you", assistant: "assistant", tool: "tool" };
  function message(item, extraClass = "") {
    const role = roleLabel[item.role] ? item.role : "assistant";
    const classes = ["msg", role, extraClass].filter(Boolean).join(" ");
    const label = el("span", { class: "sr-only", text: `${t(roleLabel[role])}: ` });
    if (role === "assistant") return el("div", { class: `${classes} md` }, [label, window.LanMarkdown.render(item.text, markdownOptions)]);
    if (role === "tool") return el("div", { class: classes }, [label, icon("tool", "sm"), el("span", { text: item.text })]);
    return el("div", { class: classes }, [label, document.createTextNode(item.text)]);
  }
  /** Consecutive tool calls fold into one quiet step summary. */
  function steps(run, open) {
    if (run.length === 1) return message(run[0]);
    const names = [...new Set(run.map((item) => item.text).filter(Boolean))];
    const details = el("details", { class: "steps", open: open.has(run[0].id) }, [
      el("summary", {}, [
        icon("tool", "sm"),
        el("span", { class: "steps-count", text: t("steps", { count: run.length }) }),
        el("span", { class: "steps-names", text: names.join(", ") }),
        icon("chevron", "sm"),
      ]),
      el("div", { class: "steps-list" }, run.map((item) => message(item))),
    ]);
    details.addEventListener("toggle", () => (details.open ? open.add(run[0].id) : open.delete(run[0].id)));
    return details;
  }
  const copyButton = (text) => el("div", { class: "msg-actions" }, el("button", {
    type: "button",
    class: "icon-btn",
    "aria-label": t("copy"),
    onclick: (event) => void copyWithFeedback(text, event.currentTarget),
  }, icon("copy", "sm")));

  function transcript(items, open, running, mark) {
    const nodes = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.role === "tool") {
        const run = [item];
        while (items[i + 1]?.role === "tool") run.push(items[++i]);
        nodes.push(mark(steps(run, open), `tool:${run[0].id}`));
        continue;
      }
      nodes.push(mark(message(item), item.id, item));
      // Copy sits under the last answer of each exchange.
      const next = items.slice(i + 1).find((candidate) => candidate.role !== "tool");
      if (item.role === "assistant" && item.text && (next ? next.role === "user" : !running)) nodes.push(mark(copyButton(item.text), `copy:${item.id}`));
    }
    return nodes;
  }

  function notice({ dot, icon: iconName, text, action }) {
    return el("div", { class: "notice" }, [
      dot ? el("span", { class: `dot ${dot}` }) : icon(iconName, "sm"),
      el("span", { class: "notice-text", text }),
      action ? el("button", { type: "button", class: "secondary", text: action.label, onclick: action.run }) : null,
    ]);
  }

  const userCount = (items, text) => items.filter((item) => item.role === "user" && item.text.trim() === text).length;
  /**
   * Drop optimistic turns the Host has recorded (or queued), or that went stale.
   * `items` is the same merged transcript the send-time baseline was counted in.
   */
  function reconcilePending(sessionId, items, queue) {
    const list = state.pending.get(sessionId);
    if (!list) return [];
    const count = (text) => userCount(items, text);
    const queued = new Set(queue.map((entry) => entry.text.trim()));
    const now = Date.now();
    const left = list.filter((entry) => !(count(entry.text) > entry.seen || queued.has(entry.text) || (entry.acked && now - entry.acked > PENDING_TTL)));
    if (left.length) state.pending.set(sessionId, left);
    else state.pending.delete(sessionId);
    return left;
  }

  const freshChat = () => ({ older: [], olderCursor: undefined, phase: null, open: new Set(), items: [], keys: null, pendingTexts: new Set(), hadLive: false });
  const chatState = { sessionId: null, ...freshChat() };
  const phaseText = { running: "running", "waiting-approval": "waitingApproval", "waiting-input": "waitingInput", idle: "replyDone" };
  const nearBottom = () => {
    const scroller = document.scrollingElement;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  };
  function syncJump() {
    const jump = document.getElementById("jump-latest");
    if (jump) jump.hidden = nearBottom();
  }

  async function renderChat(token, sessionId, refresh) {
    if (chatState.sessionId !== sessionId) Object.assign(chatState, { sessionId, ...freshChat() });
    const conversation = await api("GET", `/v1/sessions/${enc(sessionId)}`);
    if (token !== state.renderToken) return undefined;
    const { session } = conversation;
    if (session.projectId && session.projectLabel) state.projects.set(session.projectId, session.projectLabel);
    const nextCursor = chatState.olderCursor === undefined ? conversation.messages.nextCursor : chatState.olderCursor;
    const scroller = document.scrollingElement;
    const atBottom = !refresh || nearBottom();

    const seen = new Set();
    const items = [];
    for (const item of [...chatState.older, ...conversation.messages.items]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    chatState.items = items;
    const pending = reconcilePending(sessionId, items, conversation.queue);
    const running = Boolean(conversation.activeTurnId);

    const messages = el("div", { class: "messages" });
    if (nextCursor) {
      // A background refresh keeps the route object. Navigating away and back replaces it.
      const route = state.route;
      const stillOnPage = () => state.me && state.route === route;
      messages.append(el("button", {
        type: "button",
        class: "link load-older",
        text: t("loadOlder"),
        onclick: async () => {
          try {
            const before = scroller.scrollHeight;
            const page = await api("GET", `/v1/sessions/${enc(sessionId)}/history?cursor=${enc(nextCursor)}`);
            if (!stillOnPage()) return;
            chatState.older = [...page.items, ...chatState.older];
            chatState.olderCursor = page.nextCursor;
            await render({ refresh: true });
            if (stillOnPage()) scroller.scrollTop += scroller.scrollHeight - before;
          } catch (error) {
            if (stillOnPage()) fail(error);
          }
        },
      }));
    }
    // Only what arrives while the reader watches fades in. The first paint,
    // refreshes, a pending turn yielding to its Host record and a streamed
    // answer settling into its record all stay still.
    const previous = chatState.keys;
    const keys = new Set();
    const mark = (node, key, item) => {
      keys.add(key);
      const settled = item && ((item.role === "user" && chatState.pendingTexts.has(item.text.trim())) || (item.role === "assistant" && chatState.hadLive));
      if (previous && !previous.has(key) && !settled) node.classList.add("enter");
      return node;
    };
    messages.append(...transcript(items, chatState.open, running, mark));
    for (const entry of pending) messages.append(mark(message({ role: "user", text: entry.text }, "pending"), `pending:${entry.text}`));
    if (conversation.liveText) messages.append(mark(message({ role: "assistant", text: conversation.liveText }, "live"), "live"));
    else if (running && !conversation.waiting) {
      messages.append(mark(el("div", { class: "working" }, el("span", { class: "shimmer", text: t("working") })), "working"));
    }
    Object.assign(chatState, { keys, pendingTexts: new Set(pending.map((entry) => entry.text)), hadLive: Boolean(conversation.liveText) });
    if (!items.length && !pending.length && !conversation.liveText && !running) {
      messages.append(el("div", { class: "chat-empty" }, [
        icon(session.projectId ? "folder" : "temporary", "lg"),
        el("p", { class: "chat-empty-title", text: session.projectId ? session.projectLabel || state.projects.get(session.projectId) || "" : t("temporary") }),
        conversation.modelLabel ? el("p", { class: "chat-empty-sub", text: conversation.modelLabel }) : null,
      ]));
    }

    // Announce actionable state changes, not every streamed token.
    const phase = conversation.waiting ? `waiting-${conversation.waiting}` : running ? "running" : "idle";
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
            onclick: () => api("POST", `/v1/turns/${enc(entry.id)}:cancel`, { sessionId }, newKey()).then(() => render({ refresh: true }), fail),
          }, icon("close", "sm")),
        ])))
      : null;

    const canChat = !session.readOnly && !session.archived;
    if (!conversation.canSelectModel || !canChat) modelPicker.dismiss();
    if (!canChat) state.syncComposer = null;
    const composer = canChat ? buildComposer(sessionId, conversation) : null;
    const title = session.title || t("untitled");
    const head = header({
      title,
      backTo: projectHash(session.projectId),
      subtitle: [
        scopeMeta(session),
        !conversation.canSelectModel && conversation.modelLabel ? { text: conversation.modelLabel, class: "model" } : null,
        sessionStatus(conversation.waiting ? "waiting" : running ? "running" : session.status),
      ].filter(Boolean),
      actions: [moreButton(title, organizeActions("sessions", session))],
    });
    const jump = el("button", {
      id: "jump-latest",
      type: "button",
      class: "icon-btn jump",
      hidden: true,
      "aria-label": t("jumpLatest"),
      onclick: () => window.scrollTo({ top: scroller.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }),
    }, icon("down", "sm"));
    const dock = el("div", { class: "chat-dock" }, [jump, ...notices, queue, composer]);
    const changed = show(`chat:${sessionId}`, head, messages, dock);
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    syncJump();
    return changed;
  }

  function buildComposer(sessionId, conversation) {
    const running = Boolean(conversation.activeTurnId);
    const modelTrigger = conversation.canSelectModel ? modelPicker.trigger(sessionId, conversation.modelLabel) : null;
    const input = el("textarea", {
      id: "composer-input", rows: "1", "aria-label": t("composer"),
      placeholder: running ? t("composerFollowUp") : t("composer"), enterkeyhint: "send", autocapitalize: "sentences",
    });
    input.value = state.drafts.get(sessionId) || "";
    const send = el("button", {
      type: "button",
      class: "primary send",
      "aria-label": running ? t("queueMessage") : t("send"),
      onclick: () => void submit(),
    }, icon("send"));
    const stop = running
      ? el("button", {
          type: "button",
          class: "stop",
          "aria-label": t("stop"),
          onclick: () => api("POST", `/v1/turns/${enc(conversation.activeTurnId)}:interrupt`, { sessionId }, newKey()).then(() => render({ refresh: true }), fail),
        }, icon("stop"))
      : null;
    // One obvious action: Stop while a reply runs, Send (or queue) once there is text.
    const sync = () => {
      const hasText = Boolean(input.value.trim());
      send.hidden = running && !hasText;
      const savingModel = modelPicker.isSaving(sessionId);
      send.disabled = state.sending || savingModel || !hasText || !state.online;
      if (modelTrigger) {
        const busy = running || conversation.waiting || conversation.queue.length || state.sending;
        const restriction = !state.online ? "NETWORK" : busy ? "MODEL_BUSY" : null;
        modelTrigger.disabled = Boolean(restriction) || savingModel;
        modelPicker.sync(sessionId, restriction);
      }
    };
    state.syncComposer = sync;
    const fit = () => { input.style.height = "auto"; input.style.height = `${input.scrollHeight}px`; };
    input.addEventListener("input", () => { state.drafts.set(sessionId, input.value); fit(); sync(); });
    // Opening the keyboard shrinks the viewport; keep the latest reply in view.
    input.addEventListener("focus", () => {
      const viewport = window.visualViewport;
      if (!viewport || !nearBottom()) return;
      const pin = () => { document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight; };
      viewport.addEventListener("resize", pin, { once: true });
      setTimeout(() => viewport.removeEventListener("resize", pin), 800);
    });
    const submit = async () => {
      const text = input.value.trim();
      if (!text || state.sending || modelPicker.isSaving(sessionId) || !state.online) return;
      state.sending = true;
      // Show the message at once; the Host record replaces it when it lands.
      const entry = { text, seen: userCount(chatState.items, text), acked: 0 };
      state.pending.set(sessionId, [...(state.pending.get(sessionId) ?? []), entry]);
      state.drafts.delete(sessionId);
      input.value = "";
      fit();
      sync();
      document.querySelector(".chat-empty")?.remove();
      document.querySelector(".messages")?.append(message({ role: "user", text }, "pending enter"));
      chatState.keys?.add(`pending:${text}`);
      document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
      try {
        await api("POST", `/v1/sessions/${enc(sessionId)}/turns`, { text, queue: running }, newKey());
        entry.acked = Date.now();
      } catch (error) {
        state.pending.set(sessionId, (state.pending.get(sessionId) ?? []).filter((candidate) => candidate !== entry));
        // Never lose what was typed: put it back for another try.
        const current = state.drafts.get(sessionId) ?? "";
        state.drafts.set(sessionId, current ? `${text}\n${current}` : text);
        fail(error);
      } finally {
        state.sending = false;
      }
      await render({ refresh: true });
    };
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (!window.matchMedia("(pointer: fine)").matches && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void submit();
    });
    setTimeout(fit, 0);
    sync();
    return el("div", { class: modelTrigger ? "composer has-model-picker" : "composer" }, [input, modelTrigger, el("div", { class: "actions" }, [stop, send])]);
  }

  async function render(options = {}) {
    if (!state.me) return;
    const token = ++state.renderToken;
    const route = state.route;
    // A slow first load shows the page's shape instead of a blank screen.
    const key = route.view === "home" ? `home${route.archived ? ":archived" : ""}`
      : route.view === "sessions" ? `sessions:${route.projectId}${route.archived ? ":archived" : ""}` : `chat:${route.sessionId}`;
    const skeletonTimer = options.refresh || app.dataset.view === key ? null : setTimeout(() => {
      if (token === state.renderToken) show("loading", skeleton(route));
    }, 160);
    try {
      let changed;
      if (route.view === "home") changed = await renderHome(token, route.archived);
      else if (route.view === "sessions") changed = await renderSessions(token, route.projectId, route.archived);
      else changed = await renderChat(token, route.sessionId, options.refresh === true);
      if (changed === undefined) return;
      if (route.view !== "chat" && !options.refresh) {
        const saved = options.restoreScroll ? state.scroll.get(routeKey(location.hash)) : undefined;
        window.scrollTo(0, saved ?? 0);
      }
      // Move screen-reader focus to the new page title, never into a field.
      if (changed) document.getElementById("view-title")?.focus({ preventScroll: true });
      syncScrolled();
    } catch (error) {
      if (token !== state.renderToken) return;
      if (error instanceof ApiError && error.code === "NOT_FOUND" && route.view !== "home") {
        notify(errorText("NOT_FOUND"));
        go("#/projects");
        return;
      }
      fail(error);
    } finally {
      clearTimeout(skeletonTimer);
    }
  }

  function skeleton(route) {
    const block = (cls) => el("span", { class: `skeleton ${cls}` });
    const backButton = route.view === "home" && !route.archived
      ? null
      : el("button", { type: "button", class: "icon-btn back", "aria-label": t("back"), onclick: () => back("#/projects") }, icon("back"));
    const parts = route.view === "chat"
      ? [
          el("div", { class: "header" }, [backButton, el("div", { class: "header-title" }, [block("heading"), block("sub")])]),
          el("div", { class: "messages skeleton-chat" }, [block("bubble"), block("line wide"), block("line"), block("line short"), block("bubble narrow"), block("line wide"), block("line")]),
        ]
      : [
          el("div", { class: "header large" }, backButton),
          el("div", { class: "large-title" }, block("title-lg")),
          el("div", { class: "toolbar" }, block("field")),
          el("ul", { class: "list skeleton-list" }, Array.from({ length: 6 }, () => el("li", { class: "skeleton-row" }, [block("title"), block("meta")]))),
        ];
    return el("div", { class: "skeleton-page", "aria-busy": "true", "aria-label": t("loading") }, parts);
  }

  // ---------- pairing ----------
  function takePairingCode() {
    if (!location.hash.startsWith("#pair=")) return "";
    const value = /^#pair=([0-9]{6})$/.exec(location.hash)?.[1] ?? "";
    history.replaceState(history.state, "", location.pathname + location.search);
    return value;
  }

  function showPair(message, prefill = "") {
    modelPicker.dismiss();
    closeEvents();
    setOffline(false);
    const code = el("input", {
      id: "pair-code", class: "code", inputmode: "numeric", autocomplete: "one-time-code",
      maxlength: "32", required: true, value: prefill, placeholder: "000000", "aria-describedby": "pair-status",
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
    } catch (error) {
      // A failed revocation must not look like a successful sign-out.
      fail(error);
      return;
    }
    state.me = null;
    state.pending.clear();
    state.catalog = null;
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
