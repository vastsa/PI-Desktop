# Unreleased changes

- Upgrade the Pi agent, model adapters, native-session SDK, and MCP client from
  1.1.0 to 1.3.0. Preserve Desktop compatibility patches, omit foreign-model
  thinking from replay, reject malformed final tool JSON before execution, and
  expose the user-run discriminator to trusted extension startup handlers.
- Reduce repeated timing scans in long tool-heavy turns and suspend invisible
  transcript work without losing retained reading positions or disclosures.
- Make Stop settle Grep/Glob traversal and owned search processes before a
  follow-up starts, and prevent delayed history recovery from leaving sessions
  running or overwriting newer turns and structured drafts.
