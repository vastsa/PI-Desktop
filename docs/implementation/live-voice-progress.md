# Live Voice v1 Progress

- Implemented public settings/IPC DTOs, validation, error codes and the
  `voice-runtime/live` pure PCM and wire-protocol entry.
- Implemented Main authentication/provider resolution, Codex WebRTC
  negotiation, Gemini and Realtime WebSocket adapters, bounded PCM bridge,
  capture lease, owner checks, settings/provider invalidation and lifecycle
  cleanup.
- Implemented renderer window-lifetime controller, Codex WebRTC and PCM media
  paths, mute/end/resume controls, transient transcript display, and Voice
  settings for all three bindings.
- Local implementation and fixture coverage are complete. The feature
  remains `IMPLEMENTED_LIVE_VERIFICATION_PENDING` until real provider/account,
  microphone-permission and hardware-playback acceptance is authorized and run.
- Focused automated coverage exercises the Codex user path, PCM Main service
  path, owner-bound microphone permissions, SDP bounds, accessible disabled
  entry point, and protocol/PCM runtime behavior.
- Full workspace tests ran. 2,980 desktop tests passed; three unrelated
  plugin tests fail during Node source-module resolution because they import
  `packages/i18n/src/locales/{en,index}.js`, which does not exist beside the
  TypeScript source. The same trace is recorded in the delivery report.
- Provider endpoints, entitlement, real device capture and audible playback
  remain unverified. No live provider request or microphone prompt was started.
