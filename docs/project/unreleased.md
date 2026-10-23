# Unreleased changes

- Add OpenAI Fast mode (#1657). Allow it per model in Settings → Models for a
  ChatGPT subscription or an OpenAI Responses connection, then type `/fast` to
  turn it on for the current conversation. Requests ask for the priority
  service tier, which replies faster and spends plan limits faster or bills
  more per token; the Composer model chip shows a Fast mark while it is on.
- Upgrade the Pi agent, model adapters, native-session SDK, and MCP client from
  1.1.0 to 1.3.0. Preserve Desktop compatibility patches, omit foreign-model
  thinking from replay, reject malformed final tool JSON before execution, and
  expose the user-run discriminator to trusted extension startup handlers.
