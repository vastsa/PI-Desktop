// The model chooser owns its dialog and any in-flight selection.
"use strict";

(() => {
  const { el, icon } = window.LanKit;

  window.createLanModelPicker = ({ t, errorText, load, save, refresh, onSavingChange }) => {
    let current = null;
    const saving = new Set();
    const isSaving = (sessionId) => saving.has(sessionId);

    function dismiss(restoreFocus = false) {
      if (!current) return;
      const { dialog } = current;
      current = null;
      dialog.close();
      dialog.remove();
      if (restoreFocus) document.getElementById("model-trigger")?.focus({ preventScroll: true });
    }

    function open(sessionId) {
      if (current || isSaving(sessionId)) return;
      let catalog = null;
      let failure = null;
      let restriction = null;
      let loading = true;
      const title = el("h2", { id: "model-picker-title", text: t("selectModel") });
      const close = el("button", {
        type: "button", class: "icon-btn", "aria-label": t("cancel"), onclick: () => dismiss(true),
      }, icon("close"));
      const search = el("input", {
        class: "model-search", type: "search", placeholder: t("searchModels"), "aria-label": t("searchModels"), autocomplete: "off", enterkeyhint: "search",
      });
      const status = el("p", { class: "model-picker-status", role: "status" });
      const retry = el("button", { type: "button", class: "secondary", text: t("retry"), onclick: () => void reload() });
      const list = el("ul", { class: "model-options", "aria-label": t("selectModel") });
      const dialog = el("dialog", { class: "model-picker", "aria-labelledby": title.id }, el("div", { class: "model-picker-body" }, [
        el("div", { class: "model-picker-header" }, [title, close]),
        search, status, retry, list,
      ]));
      const isOpen = () => current?.dialog === dialog;

      function paintStatus() {
        const blocked = restriction || failure;
        const busy = isSaving(sessionId);
        const message = busy ? t("savingModel") : loading ? t("loadingModels") : blocked ? errorText(blocked) :
          !catalog?.items.length ? t("noModels") : !list.children.length ? t("noMatches") : "";
        if (status.textContent !== message) status.textContent = message;
        status.hidden = !message;
        retry.hidden = !failure || Boolean(restriction) || busy || loading;
        search.hidden = !catalog?.items.length;
        for (const button of list.querySelectorAll("button")) button.disabled = busy || Boolean(blocked);
      }

      function paintOptions() {
        const query = search.value.trim().toLowerCase();
        const selected = catalog?.selected;
        list.replaceChildren(...(catalog?.items ?? []).filter((item) =>
          [item.label, item.modelId, item.providerLabel].some((value) => value.toLowerCase().includes(query)),
        ).map((item) => {
          const checked = selected?.providerId === item.providerId && selected?.modelId === item.modelId;
          return el("li", {}, el("button", {
            type: "button", "aria-current": checked ? "true" : null,
            onclick: () => checked ? dismiss(true) : void choose(item),
          }, [
            el("span", { class: "model-option-copy" }, [
              el("span", { class: "model-option-name", text: item.label }),
              el("span", { class: "model-option-provider", text: item.providerLabel }),
            ]),
            checked ? icon("check", "sm") : null,
          ]));
        }));
        paintStatus();
      }

      async function reload() {
        loading = true;
        failure = null;
        catalog = null;
        paintOptions();
        try {
          catalog = await load(sessionId);
        } catch (error) {
          failure = error.code || "FAILED";
        } finally {
          loading = false;
          if (isOpen()) paintOptions();
        }
      }

      async function choose({ providerId, modelId }) {
        if (!isOpen() || !catalog || failure || restriction || isSaving(sessionId)) return;
        saving.add(sessionId);
        paintStatus();
        onSavingChange();
        let saved = false;
        try {
          await save(sessionId, { providerId, modelId, revision: catalog.revision });
          saved = true;
        } catch (error) {
          if (isOpen()) failure = error.code || "FAILED";
        } finally {
          await refresh(sessionId);
          saving.delete(sessionId);
          onSavingChange();
          if (isOpen()) {
            if (saved) dismiss(true);
            else paintStatus();
          }
        }
      }

      current = { sessionId, dialog, sync: (code) => { restriction = code; paintStatus(); } };
      search.addEventListener("input", paintOptions);
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(true); });
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dismiss(true); });
      document.body.append(dialog);
      dialog.showModal();
      void reload();
    }

    return {
      dismiss,
      isSaving,
      sync(sessionId, restriction) {
        if (current?.sessionId === sessionId) current.sync(restriction);
      },
      trigger(sessionId, label) {
        return el("button", {
          id: "model-trigger", type: "button", class: "model-trigger", "aria-haspopup": "dialog",
          "aria-label": label ? t("selectModelCurrent", { name: label }) : t("selectModel"),
          onclick: () => open(sessionId),
        }, [el("span", { text: label || t("selectModel") }), icon("chevron", "xs")]);
      },
    };
  };
})();
