# Fetch Redirect Probe

A minimal plugin for issue #1475, confined to `127.0.0.1`. It does not use
`net.anyHost`, credentials, raw network calls, or background requests.

1. Run `node examples/plugins/fetch-redirect/fixture.mjs` from the repository.
2. Load this directory through the plugin developer load-path workflow and
   grant `net.fetch` and `ui.panel`. Run **Fetch Redirect: Open Probe** from
   the command palette (or open it from the plugin launcher).
3. Paste the fixture URL, choose `error`, and run: expect
   `REDIRECT_DISALLOWED` and **zero** target requests in the fixture terminal.
4. Choose `manual`: expect the original 302, Location and body, still zero
   target requests. Choose `follow`: expect 200 and exactly one target request.
5. Repeat with /301, /303, /307 and /308. Stop the fixture with Ctrl+C.

The plugin queries `pi.net.getCapabilities()` before sending anything; an old
host without this capability refuses the probe instead of silently following.
The current unreleased host implements these capabilities; released 0.17.0
and older must not be assumed to support them.

Automated protocol E2E (real plugin child process and loopback HTTP, no desktop
profile or paid provider):

```sh
pnpm test:e2e:plugin-fetch-redirect
```

The automated suite exercises the same `probe.fetch` operation and production
plugin bridge. It does not claim to drive the panel's native window.
