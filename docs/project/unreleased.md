# Unreleased changes

- Upgrade the Pi agent, model adapters, native-session SDK, and MCP client from
  1.1.0 to 1.3.0. Preserve Desktop compatibility patches, omit foreign-model
  thinking from replay, reject malformed final tool JSON before execution, and
  expose the user-run discriminator to trusted extension startup handlers.
- Render inline interactive visualizations in the transcript. Local sessions
  get a builtin `visualize` skill; the model writes an HTML fragment to the
  session's visualization directory and references it with a `::visualize`
  line, which the transcript shows as a sandboxed, theme-aware card with an
  expanded view. The feature is opt-in behind Settings → AI → Inline
  visualizations (`AppSettings.inlineVisualizations`, off by default): while it
  is off the prompt advertises no directory, the skill is withheld from the
  catalog, `/` menu, and `Skill` tool, and existing reference lines are hidden
  without loading a card. Visualization writes and cleanup reject redirected
  roots; document responses enforce an opaque sandbox, inline and expanded
  frames share a bounded pool, and forks retain their cards after data
  relocation.
- Keep each session's side-panel browser available while the panel is collapsed,
  another conversation or Settings is visible, or the renderer reloads. Browser
  actions stay on their connected page without stealing focus. Hidden pages use
  an invisible sandboxed backing host; explicit page/session closure and plugin
  disable still release resources. Browser page-count indicators are not part of
  this change.
