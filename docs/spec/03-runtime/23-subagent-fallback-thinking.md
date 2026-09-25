# 23. Subagent Fallback Thinking

Fallback model entries may append `|off`, `|minimal`, `|low`, `|medium`, `|high`, `|xhigh`, or `|max` to a `provider/model` pin. The fallback editor exposes only these fixed levels; it does not offer `omit`. A missing suffix inherits the subagent definition's thinking setting, or the parent selection when the definition has none. Existing `|omit` pins remain readable for compatibility but cannot be selected in the UI.

At execution, the runtime clamps each requested level to the selected model's supported thinking capability. The suffix is a request, not a promise that every provider accepts that exact level.
