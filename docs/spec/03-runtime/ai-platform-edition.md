# AI Aggregation Platform edition

This document describes the fork-specific override to the generic provider spec.
The upstream product and LGPL notices are retained.

## Setup and routing

1. Register/sign in at https://ai.yykkj.com, recharge the account and create an API
   token. A dashboard login is not an inference token.
2. Open Settings > Models, add the platform service and enter that token.
3. Discover/select conversation models. The URL is fixed to
   `https://ai.yykkj.com/v1`. Choose Chat Completions, Responses or Anthropic
   Messages as supported by the selected models. Do not infer context/image
   capability from `/v1/models` alone; existing explicit model controls remain.

The platform service includes `gpt-image-2.5-flare`,
`gpt-image-2.5-sunburst` and `MiniMax-H3` automatically, even if discovery omits
them. New/updated provider records retain these built-ins. Existing profiles
derive them on read and can generate immediately without a separate setup or
database migration. The setup panel keeps them selected, labels their media
role rather than fictitious token limits, and does not offer chat-only controls.
They are excluded from chat, scheduled-chat and delegation choices, and the
runtime rejects them on the text transport.

The default image is `gpt-image-2.5-flare`; users may select another image default
in Settings > Models. The compatibility `GenerateImages` tool respects an
explicit image binding, otherwise it uses the current session's platform row
(the app default only for an unpinned session). It never guesses another account
when the selected one is unavailable. `PlatformMedia` uses an explicit requested
model, then the image default on its selected provider, then the built-in default.
Missing credentials or upstream permission/balance failures remain errors;
showing built-in models is not proof of server-side entitlement. A null image
binding means the platform default, not disabling media for a configured account.

The same secret is used for the selected session's media tools. Secrets stay in
the existing host store; there is no Codex/CC Switch credential fallback.
Provider CRUD/discovery and actual inference each check the platform policy.
Authenticated model redirects are rejected. Provider catalog metadata may enrich
capabilities but cannot override the endpoint, headers or chosen API style.
Legacy providers are preserved, not migrated to the platform or deleted.
When multiple platform rows share an ambiguous vendor/display alias, subagent
opt-in models use exact provider-row IDs. An unresolved definition pin is not
silently populated with another account's credentials by that opt-in catalog.
Native Pi history is read-only; listing it does not initialize its separate auth
registry, and both IPC and native prompt execution reject continuation.

## Media

The bundled `pi-desktop/ai-aggregation-platform` Skill is discoverable through
`Skill`/`ToolSearch`. `PlatformMedia` is a formal tool with these operations:

| Operation | Purpose |
| --- | --- |
| `image` | Text-to-image or reference-image editing; count 1–10 |
| `image-download` | Recover output from a receipt without regeneration |
| `video-create` | MiniMax-H3, text/image/video/audio references |
| `video-status` | Query an existing task |
| `video-download` | Download an existing completed task |
| `billing` | Correlate server logs with a task/receipt |

The desktop generates arguments for the shipped CLI, never model-written Python.
macOS/Linux use Python 3; Windows also supports `py -3`. Missing Python yields an
installation instruction without submitting a request. Use Python 3.9 or newer.
Direct independent CLI entry points are shipped with the Skill for use outside
the app; those retain their own documented auth onboarding.

Each upstream image creation requests one image; batches fan out rather than
rely on an upstream `n > 1`. Video duration is 4–15 seconds, resolution 768P/2K,
at most 16 combined reference inputs. Local references are contained to the
session workspace/scratch/attachments, bounded and snapshotted before execution.
Remote references use HTTPS or validated data URLs. Results and durable receipts
are under session scratch. Existing results are not overwritten.

The Rust permission gate authorizes before the Electron handler executes. Creation
is high-risk and may incur a charge. Cancellation stops local work, not guaranteed
upstream execution/billing. An ambiguous POST must not be automatically retried.
Recovery queries/downloads the same task or receipt. Tool/RPC budgets include the
permission wait and processing deadline. Missing/incomplete billing logs are
unverified, not free. Live prices and settlement remain server authoritative.

The original `GenerateImages` interface remains for existing conversations, now
restricted to the platform provider. The platform Skill is preferred for receipts,
multimodal video and billing verification.

### Video delivery

Downloaded videos render inline from both ordinary Markdown video links and image
embed syntax. Absolute session scratch paths remain intact even outside the open
project. Windows drive-letter links survive Markdown sanitization. Local playback
uses an opaque `pi-video` capability, with native controls and byte-range streaming;
no base64 video crosses IPC, and no `file://` or CSP bypass is enabled. The host
rechecks existing workspace/scratch/attachment realpath containment and video
container headers before reads. Leases release on source change/unmount and clear
on main-renderer navigation/destruction. Missing files and decoding errors show a
retry action. Save video uses a native destination dialog and a streamed copy of
the already-downloaded artifact; cancellation is neutral and failures are visible.
No generation request, account credential, server change, or migration is involved.

## Account and payments

`platformTokenUsage` reads `/api/usage/token/` with the selected platform token.
It reports token allowance, not account wallet balance. `/api/status` supplies the
quota conversion; missing conversion stays in raw quota. Failed auth/network or
malformed responses must not appear as a zero balance. Unlimited token allowance
does not mean unlimited account funds.

Recharge opens https://ai.yykkj.com/wallet in the system browser. Payment methods,
authentication, checkout and receipts are owned by the web platform. The desktop
does not create payment orders or infer payment success. Native payment remains
a future integration, requiring an account session independent of API-token auth.

## Verification scope

Run `pnpm test:platform` for deterministic policy, adapter, IPC/account, host bridge,
CLI integration and UI policy tests. Run the normal JS build/typechecks too.
Rust permission tests require Cargo and its registry dependencies. Live model
quality/prices, signed installer delivery and native Windows behavior require
separate acceptance, not a claim based on fixtures.
