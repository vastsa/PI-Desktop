# Prompt Enhancement for PI-Desktop

An optional PI-Desktop plugin that adds an **Enhance prompt** action to the
Composer. It is not bundled with PI-Desktop and is never enabled by the app by
default. Install it only if you want this feature.

When clicked, the plugin sends the current draft text to the selected model
provider through the host's `agent.complete` service. It does not read the
conversation history or file attachments. The host keeps file-reference chips
out of the request and preserves them when applying the returned text. One
undo action restores the previous draft.

## Settings panel

Everything is configured in the plugin's own panel, opened from the command
**Prompt Enhancement: Settings** (command palette) or from the plugin's panel
button. The plugin declares no host-rendered settings, so there is no second
settings surface to keep in sync.

- **Enhancement model** — a drop-down of the host's own ready models, read
  through `pi.models.list()`, plus **Follow the Composer model** (the default).
  A pick pins the enhancement to that model whatever the Composer uses; a pin
  the host no longer reports falls back to the Composer model instead of
  failing the action.
- **Reasoning effort** — `off` … `max`; a level the chosen model does not
  support falls back to `off`.
- **User template** — the built-in template is shown in the editor, the same
  text the model actually receives. Edit it to override; **Insert {{draft}}**
  drops the placeholder at the caret and **Restore built-in** puts the default
  back. Submitting the built-in template unchanged stores "use the built-in
  one" rather than a second copy.

The panel reaches the host only through its own `settings.load` /
`settings.save` bridge channels, which the plugin's `onPanelInvoke` answers.
The copy follows the host's active language (`en` / `zh-CN`).

## Permissions

- `composer.transform` lets the host show a plugin-owned Composer action and
  apply its result only while the draft has not changed.
- `agent.complete` lets the plugin request a one-shot completion using a model
  already configured in PI-Desktop. API keys remain in the host.
- `models.list` lets the settings panel read the host's ready provider/model
  rows (names and capabilities only — never credentials).
- `ui.panel` lets the plugin open its own settings panel.

The draft text is sent to the configured provider after you click **Enhance
prompt**. The plugin does not send anything automatically.

## Install from this repository

1. Clone this repository.
2. In PI-Desktop, open **Plugins** and choose **Load local plugin** from the
   top-right actions menu.
3. Select the cloned repository folder and review the requested permissions.
   Grant `composer.transform`, `agent.complete`, `models.list`, and `ui.panel`
   to use prompt enhancement.

## Development

This repository contains the plugin source independently of PI-Desktop and its
marketplace distribution repository. Marketplace installation can be offered
as an opt-in only after publishing a tagged release through the PI-Desktop
plugin center.

Two entry points, no build step:

- `main.js` — the plugin process: the Composer transform, the command that
  opens the panel, and the panel's two channels (`settings.load`,
  `settings.save`). It reads the host's ready models with `pi.models.list()`
  and stores its settings through `pi.plugin.getSettings` / `setSettings`
  (modelKey, thinkingLevel, userTemplate).
- `panel/index.html` — the settings panel: a plain HTML page using
  `window.pluginBridge`, localized from the host's `app.getAppearance().locale`.

The system prompt and the built-in user template are the same text the former
host-owned feature used, so an enhanced prompt keeps its established contract;
the transform's tests pin that behavior.

The manifest requires PI-Desktop 0.1.0 or later.

## License

GNU Lesser General Public License v3.0. See `LICENSE`.
