# Pi 0.99.1 release qualification and follow-ups

The pi-ai/pi-agent-core migration passes the local candidate gates documented in
[adoption](pi-0991-adoption.md). The following are not claimed complete:

| Surface | Remaining work |
| --- | --- |
| Installed artifacts | Exercise installed Electron loading, native Host and packaged OAuth/image modules across supported platform/architecture lanes. Local standalone bundles and sidecar E2E passed. |
| Real account integration | Real OAuth and paid requests were not authorized or used; offline flows prove contracts, not current vendor service availability. |
| Cross-version rollback | Qualify the prior released version against retained data. Optional provenance fields and the existing usage JSON require no new schema, but that alone is not an executed rollback test. |
| Dependency removal | pi-coding-agent remains the pre-existing compaction/file utility compatibility dependency. Removing it is a separate refactor. |
| Design follow-ups | Tool inventory separation, an independent Codemode sandbox adapter, and physical/virtual routing contracts are evaluated in the design review. They are outside this migration and are not enabled. |

No MCP migration, coding-agent session integration, classifier/router feature,
plugin conversion or new Codemode feature is promised by this scoped candidate.
The display-only operation metadata supplement remains explicit compatibility
data until Pi publishes equivalent non-chat settings metadata.
