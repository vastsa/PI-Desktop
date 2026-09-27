---
name: AI Aggregation Platform
description: Generate or edit images, create MiniMax-H3 videos from text and image/video/audio references, recover media downloads, and inspect task billing on ai.yykkj.com.
---

# AI Aggregation Platform

Built-in skill ID: `pi-desktop/ai-aggregation-platform`.

Use the native `PlatformMedia` tool for platform media work in PI-Desktop.
The platform service automatically includes both image models and MiniMax-H3,
including for existing profiles and when discovery omits them. A saved platform
key is enough; do not ask for separate image/video setup. For an image request
without an explicit model, respect a configured image default on this provider,
otherwise use `gpt-image-2.5-flare`. Listing a model does not guarantee that the
user's token has permission or balance; report actual server errors.
The host resolves the selected session's platform provider and its stored API key.
If setup is missing, direct the user to Settings > Models: register or sign in at
https://ai.yykkj.com, recharge the account, create a platform API token, and save
that token in the platform service. Never obtain another provider's credential,
ask the agent to read a secret file, or put a key in tool arguments.

## Native operations

All calls use `operation`. No output path, base URL, credentials or arbitrary
CLI flags are accepted. The tool saves artifacts and receipts in session scratch.
Use the absolute returned file paths to deliver actual artifacts. After a successful
`video-download`, embed the returned local MP4 as `![Video](</absolute/path.mp4>)`.
The desktop renders a native inline player with playback/seek controls and a
Save video action. Do not deliver only a prose claim or an upstream URL requiring
authentication, and never regenerate a video to fix a display/download problem.
Existing ordinary Markdown MP4 links also render inline.

- `image`: required `prompt`; optional `model`, `count` (1–10), `images` and
  `ratio`. The default image model is `gpt-image-2.5-flare`; use
  `gpt-image-2.5-sunburst` when high quality is requested. Image references select
  the edit endpoint automatically. Each image is an independent billed request
  with upstream `n=1`; partial failures retain successful images and receipts.
- `image-download`: required `receipt` from an earlier call in this session.
  Restores saved image responses only, without a new generation POST.
- `video-create`: required `prompt`; optional `images`, `videos`, `audios`,
  `seconds` (integer 4–15, default 4), `resolution` (`768P` or `2K`, default
  `768P`), `ratio` (default `16:9`), and `model` (`MiniMax-H3` only). Returns an
  accepted task and receipt promptly. Acceptance does not mean completion.
- `video-status`: `taskId` or `receipt`; query the same task for terminal status.
- `video-download`: `taskId` or `receipt`; download a completed task and validate
  its MP4 container. An installed `ffprobe` additionally verifies streams and
  duration; `media.verified: false` must not be described as decoder validation.
- `billing`: `taskId` or `receipt`. Image billing requires an image receipt.
  `billing.verified` refers only to matching recent task/request records, not a
  complete wallet audit. Missing records do not imply a free request or refund.

Video ratios: `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`.
Image ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`.
Image ratio is a prompt composition instruction, not a pixel-size guarantee.

References are arrays of local file paths, HTTPS URLs without URL credentials,
or correctly typed base64 data URLs. Local paths must resolve within the session
project, session scratch, or attachments. There are at most 16 references total;
image/video/audio file limits are 30/50/15 MiB and the combined limit is 180 MiB.
The tool snapshots local files before running the CLI. Actual upstream format
and reference-combination support may be narrower; report rejections as returned.
Do not reject H3 because `/v1/models` omits a task-plugin model.

## Recovery and cost

Never automatically repeat a generation POST after an error, timeout or cancel.
The server may already have accepted and charged it. Preserve `result.receipt`
or `recovery.receipt`, the task ID, and any child receipts. A receipt with no
task ID or saved image response has an unknown outcome: inspect the platform
record rather than promising recovery or submitting again. A repeated tool-call
ID is refused to avoid duplicate charges. Receipts are scoped to their original
session and provider row; do not use a different account to recover them.

For video: create once, query status at reasonable intervals, then download when
complete. A failed task is not a delivered video. For images: preserve successful
members of a partial batch and use `image-download` only for existing responses.
Billing evidence comes from server usage facts and logs, never container duration.

## Bundled standalone CLI

The same stdlib-only Python implementation ships in
`ai-aggregation-platform/scripts/` next to this document. Its standalone
instructions are in [the packaged skill](ai-aggregation-platform/SKILL.md).
Use `PlatformMedia` in desktop sessions; standalone commands retain independent
authentication for use outside PI-Desktop and do not read Codex credentials.

Python 3.9+ is required: macOS/Linux use `python3`; Windows uses `py -3` or
`python`. If missing, ask the user to install Python from https://www.python.org/
and restart PI-Desktop (enable Add Python to PATH on Windows). Do not install
packages automatically. No pip dependencies or ffmpeg are required.
