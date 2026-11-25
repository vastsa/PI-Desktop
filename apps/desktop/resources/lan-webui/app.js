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
  };

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
  // DOM replaceChildren() turns null into the text "null"; drop empty slots first.
  const show = (...nodes) => app.replaceChildren(...nodes.filter(Boolean));
  let toastTimer = null;
  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 4000);
  }
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

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
      if (response.status === 401 && path.startsWith("/v1/")) {
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
  const go = (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };
  window.addEventListener("hashchange", () => {
    state.route = parseRoute();
    render();
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
        offline.hidden = true;
        scheduleRefresh();
      } catch (error) {
        if (state.events === source) fail(error);
      }
    });
    source.addEventListener("error", () => {
      offline.textContent = t("offline");
      offline.hidden = false;
    });
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
  function openSheet(title, actions) {
    const list = document.getElementById("sheet-actions");
    document.getElementById("sheet-title").textContent = title;
    list.replaceChildren(
      ...actions.map((action) => el("button", { type: "button", class: action.danger ? "danger" : "", text: action.label, onclick: () => { closeSheet(); action.run(); } })),
      el("button", { type: "button", text: t("cancel"), onclick: closeSheet }),
    );
    sheet.hidden = false;
    list.querySelector("button")?.focus();
  }
  function closeSheet() {
    sheet.hidden = true;
  }
  sheet.addEventListener("click", (event) => { if (event.target === sheet) closeSheet(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !sheet.hidden) closeSheet(); });

  function organizeActions(kind, item) {
    const path = `/v1/${kind}/${encodeURIComponent(item.id)}/organize`;
    const send = (patch) => api("POST", path, { revision: item.revision, ...patch }, newKey()).then(() => render({ refresh: true }), (error) => { fail(error); render({ refresh: true }); });
    const label = kind === "projects" ? item.label : item.title || t("untitled");
    return [
      { label: t("rename"), run: () => { const name = window.prompt(t("renamePrompt"), label); if (name && name.trim() && name.trim() !== label) send({ name: name.trim() }); } },
      { label: item.pinned ? t("unpin") : t("pin"), run: () => send({ pinned: !item.pinned }) },
      { label: item.archived ? t("restore") : t("archive"), danger: !item.archived, run: () => send({ archived: !item.archived }) },
    ];
  }

  // ---------- views ----------
  function header(title, back) {
    return el("header", { class: "header" }, [
      back ? el("button", { type: "button", "aria-label": t("back"), text: "‹", onclick: () => (history.length > 1 ? history.back() : go(back)) }) : null,
      el("h1", { text: title }),
    ]);
  }

  function toolbar(onSearch, filters) {
    const search = el("input", { type: "search", placeholder: t("search"), "aria-label": t("search"), value: filters.q });
    let timer = null;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => onSearch({ q: search.value }), 250); });
    const archived = el("input", { type: "checkbox", checked: filters.archived });
    archived.addEventListener("change", () => onSearch({ archived: archived.checked }));
    return el("div", { class: "toolbar" }, [search, el("label", { class: "toggle" }, [archived, document.createTextNode(t("showArchived"))])]);
  }

  function row({ title, meta, onOpen, actions, moreLabel }) {
    return el("li", { class: "row" }, [
      el("button", { type: "button", class: "row-main", onclick: onOpen }, [
        el("span", { class: "row-title", text: title }),
        meta.length ? el("span", { class: "row-meta" }, meta.map((text) => el("span", { text }))) : null,
      ]),
      actions.length ? el("button", { type: "button", class: "row-more", "aria-label": moreLabel, text: "⋯", onclick: () => openSheet(title, actions) }) : null,
    ]);
  }

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
    if (token !== state.renderToken) return;
    for (const item of items) state.projects.set(item.id, item.label);
    const list = el("ul", { class: "list" });
    if (!filters.archived && !filters.q) {
      list.append(row({ title: t("temporary"), meta: [], actions: [], onOpen: () => go(`#/p/${TEMP}`) }));
    }
    for (const item of items) {
      list.append(row({
        title: item.label,
        meta: [item.pinned ? t("pinned") : "", item.archived ? t("archived") : ""].filter(Boolean),
        onOpen: () => go(`#/p/${encodeURIComponent(item.id)}`),
        actions: organizeActions("projects", item),
        moreLabel: t("more", { name: item.label }),
      }));
    }
    const empty = !list.children.length ? el("p", { class: "empty", text: filters.q ? t("noMatches") : t("noProjects") }) : null;
    show(
      header(t("projects")),
      toolbar((patch) => { Object.assign(filters, patch); render(); }, filters),
      list,
      empty,
      el("button", { type: "button", class: "link", text: t("signOut"), onclick: signOut }),
    );
  }

  async function renderSessions(token, projectId) {
    const filters = listFilters.sessions;
    const query = `?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(filters.q)}${filters.archived ? "&archived=1" : ""}`;
    const items = await loadAll(`/v1/sessions${query}`);
    if (token !== state.renderToken) return;
    const title = projectId === TEMP ? t("temporary") : state.projects.get(projectId) || t("projects");
    const list = el("ul", { class: "list" });
    for (const item of items) {
      const status = item.status === "running" ? t("running") : item.status === "waiting" ? t("waiting") : "";
      list.append(row({
        title: item.title || t("untitled"),
        meta: [status, item.pinned ? t("pinned") : "", item.archived ? t("archived") : "", item.readOnly ? t("readOnly") : ""].filter(Boolean),
        onOpen: () => go(`#/s/${encodeURIComponent(item.id)}`),
        actions: organizeActions("sessions", item),
        moreLabel: t("more", { name: item.title || t("untitled") }),
      }));
    }
    const create = el("button", {
      type: "button",
      class: "primary",
      text: t("newSession"),
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
    });
    show(
      header(title, "#/projects"),
      toolbar((patch) => { Object.assign(filters, patch); render(); }, filters),
      create,
      list,
      !items.length ? el("p", { class: "empty", text: filters.q ? t("noMatches") : t("noSessions") }) : null,
    );
  }

  const roleLabel = { user: "you", assistant: "assistant", tool: "tool" };
  function message(item, extraClass = "") {
    return el("div", { class: `msg ${item.role} ${extraClass}` }, [
      el("span", { class: "msg-role", text: t(roleLabel[item.role] || "assistant") }),
      document.createTextNode(item.text),
    ]);
  }

  const chatState = { sessionId: null, older: [], olderCursor: undefined };

  async function renderChat(token, sessionId, refresh) {
    if (chatState.sessionId !== sessionId) Object.assign(chatState, { sessionId, older: [], olderCursor: undefined });
    const conversation = await api("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
    if (token !== state.renderToken) return;
    const { session } = conversation;
    const nextCursor = chatState.olderCursor === undefined ? conversation.messages.nextCursor : chatState.olderCursor;
    const scroller = document.scrollingElement;
    const atBottom = !refresh || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;

    const messages = el("div", { class: "messages" });
    if (nextCursor) {
      messages.append(el("button", {
        type: "button",
        class: "link",
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

    const notices = [];
    if (conversation.waiting === "approval") notices.push(el("p", { class: "banner", role: "status", text: t("waitingApproval") }));
    if (conversation.waiting === "input") notices.push(el("p", { class: "banner", role: "status", text: t("waitingInput") }));
    if (session.archived) notices.push(el("p", { class: "banner", text: t("archivedSession") }));
    if (session.readOnly) notices.push(el("p", { class: "banner", text: t("readOnlySession") }));

    const queue = conversation.queue.length
      ? el("div", { class: "queue" }, conversation.queue.map((entry) => el("div", { class: "row" }, [
          el("span", { class: "row-main" }, [el("span", { class: "row-meta", text: t("queued") }), el("span", { class: "row-title", text: entry.text })]),
          el("button", { type: "button", "aria-label": t("cancelQueued"), text: "×", onclick: () => api("POST", `/v1/turns/${encodeURIComponent(entry.id)}:cancel`, { sessionId }, newKey()).then(() => render({ refresh: true }), fail) }),
        ])))
      : null;

    const canChat = !session.readOnly && !session.archived;
    const composer = canChat ? buildComposer(sessionId, conversation) : null;
    const actions = organizeActions("sessions", session);
    const head = header(session.title || t("untitled"), session.projectId ? `#/p/${encodeURIComponent(session.projectId)}` : `#/p/${TEMP}`);
    if (actions.length) head.append(el("button", { type: "button", "aria-label": t("more", { name: session.title || t("untitled") }), text: "⋯", onclick: () => openSheet(session.title || t("untitled"), actions) }));

    // Preserve focus and the unsent draft across live refreshes.
    const focused = document.activeElement?.id === "composer-input";
    const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    show(head, conversation.modelLabel ? el("p", { class: "row-meta", text: conversation.modelLabel }) : null, messages, ...notices, queue, composer);
    if (focused) {
      const input = document.getElementById("composer-input");
      input?.focus();
      if (input && selection) input.setSelectionRange(selection[0], selection[1]);
    }
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  function buildComposer(sessionId, conversation) {
    const running = Boolean(conversation.activeTurnId);
    const input = el("textarea", { id: "composer-input", rows: "2", "aria-label": t("composer"), placeholder: t("composer"), enterkeyhint: "send" });
    input.value = state.drafts.get(sessionId) || "";
    const fit = () => { input.style.height = "auto"; input.style.height = `${input.scrollHeight}px`; };
    input.addEventListener("input", () => { state.drafts.set(sessionId, input.value); fit(); });
    const submit = async (queue) => {
      const text = input.value.trim();
      if (!text || state.sending) return;
      state.sending = true;
      try {
        await api("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, { text, queue }, newKey());
        state.drafts.delete(sessionId);
        input.value = "";
        await render({ refresh: true });
      } catch (error) {
        fail(error);
      } finally {
        state.sending = false;
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (!window.matchMedia("(pointer: fine)").matches && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void submit(running);
    });
    setTimeout(fit, 0);
    const buttons = el("div", { class: "actions" }, [
      running
        ? el("button", { type: "button", text: t("stop"), onclick: () => api("POST", `/v1/turns/${encodeURIComponent(conversation.activeTurnId)}:interrupt`, { sessionId }, newKey()).then(() => render({ refresh: true }), fail) })
        : null,
      el("button", { type: "button", class: "primary", text: running ? t("queue") : t("send"), onclick: () => void submit(running) }),
    ]);
    return el("div", { class: "composer" }, [input, buttons]);
  }

  async function render(options = {}) {
    if (!state.me) return;
    const token = ++state.renderToken;
    const route = state.route;
    try {
      if (route.view === "projects") await renderProjects(token);
      else if (route.view === "sessions") await renderSessions(token, route.projectId);
      else await renderChat(token, route.sessionId, options.refresh === true);
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
  function showPair(message) {
    closeEvents();
    const code = el("input", { id: "pair-code", class: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", required: true });
    const label = el("input", { id: "pair-label", maxlength: "60", value: /iPhone|iPad|Android/.exec(navigator.userAgent)?.[0] || "Browser" });
    const status = el("p", { class: "hint", role: "status", text: message || "" });
    const submit = el("button", { type: "submit", class: "primary", text: t("pairSubmit") });
    const form = el("form", { class: "pair" }, [
      el("h1", { text: t("pairTitle") }),
      el("p", { text: t("pairHint") }),
      el("label", { for: "pair-code", text: t("codeLabel") }), code,
      el("label", { for: "pair-label", text: t("deviceLabel") }), label,
      submit, status,
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = t("pairConnecting");
      try {
        await api("POST", "/pair", { code: code.value.trim(), label: label.value.trim() });
        await start();
      } catch (error) {
        submit.disabled = false;
        const codeName = error instanceof ApiError ? error.code : "FAILED";
        status.textContent = codeName === "PAIRING_CLOSED" ? t("pairClosed") : codeName === "PAIRING_FAILED" ? t("pairFailed") : errorText(codeName);
      }
    });
    show(form);
    code.focus();
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

  async function start() {
    try {
      state.me = await api("GET", "/v1/me");
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "UNAUTHORIZED")) showPair(errorText(error instanceof ApiError ? error.code : "FAILED"));
      else showPair();
      return;
    }
    state.route = parseRoute();
    openEvents();
    await render();
  }

  document.title = t("appTitle");
  void start();
})();
