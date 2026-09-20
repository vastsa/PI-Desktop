# Session References

Load this folder using Plugins → Development → Load Folder, then review the
trusted UI entry. In a local Desktop conversation, type `@`, search a title,
and accept a candidate. It appears as an inline chip. Sending expands a bounded
snapshot of completed Q&A for the model; the transcript keeps the short label.

The renderer module is self-contained. `main.js` preserves the existing required
main-entry contract and has no behavior. Disable the plugin to remove its
completion provider. Existing references fall back to their labels when sent.

The SDK contract and limits are documented in
[Composer references](../../../docs/spec/07-plugins/17-composer-references.md).
