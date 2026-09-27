---
name: ai-aggregation-platform
description: Standalone Python commands for ai.yykkj.com text, image generation/editing, MiniMax-H3 multimodal video, receipt recovery and billing checks; use the native PlatformMedia tool inside PI-Desktop.
---

# AI Aggregation Platform CLI

Inside PI-Desktop use the native `PlatformMedia` tool described in the built-in
skill `pi-desktop/ai-aggregation-platform`. Desktop supplies the selected platform
row's secret only through the child process environment and forces
`https://ai.yykkj.com/v1`. The desktop adapter never reads standalone credentials.

For standalone usage, execute the provided scripts directly. They require Python
3.9+ and its standard library; no pip installation is needed. macOS/Linux use
`python3`; Windows uses `py -3` (or an installed `python`). `ffprobe` is optional
for decoder validation. Do not claim decoded validity when it is unavailable.

## Standalone authentication

Run `scripts/auth.py status` first. If unconfigured, register or sign in at
https://ai.yykkj.com, recharge the account, then create a platform API key.
Store it interactively with `python3 scripts/auth.py set`, or supply the key via
stdin. Installation is free; media generation consumes the platform balance.
Do not reuse OPENAI_API_KEY, Codex, CC Switch, or another product's credentials.

The independent credential file is under
`${XDG_CONFIG_HOME:-~/.config}/ai-aggregation-platform/credentials` on Unix or
`%APPDATA%\ai-aggregation-platform\credentials` on Windows. `auth.py path`
prints its location, `auth.py check` validates it without generation, and
`auth.py clear` removes it. Environment `AI_AGG_API_KEY` overrides the saved key;
`AI_AGG_BASE_URL` overrides the standalone base. When both are supplied, the file
is not read. The private desktop entry additionally pins the base to the platform.

## Commands

Run from this package directory; quote paths containing spaces. Replace `python3`
with `py -3` on Windows. Existing `scripts/newapi.sh` and `scripts/newapi.ps1`
wrappers remain available.

```sh
python3 scripts/image.py 'A blue toy boat on a white background' --out '/path/boat.png'
python3 scripts/image.py edit 'Make the boat red' --ref '/path/boat.png' --out '/path/red.png'
python3 scripts/image.py 'A toy boat' --n 3 --quality high --out '/path/batch.png'
python3 scripts/image.py download '/path/batch.png.request.json'
python3 scripts/image.py billing '/path/batch.png.request.json'
python3 scripts/video.py create 'A boat floating gently' --image '/path/boat.png' --video '/path/motion.mp4' --audio '/path/sound.wav' --seconds 4 --resolution 768P --out '/path/boat.mp4'
python3 scripts/video.py status TASK_ID
python3 scripts/video.py wait TASK_ID --receipt '/path/boat.mp4.task.json'
python3 scripts/video.py download TASK_ID --out '/path/boat.mp4'
python3 scripts/video.py billing TASK_ID
python3 scripts/text.py 'Write a short introduction' --model deepseek-v4.1-flash
python3 scripts/newapi.py models
```

Image `--ref`/`--image` repeats; references automatically select `/images/edits`.
`--mask` requires a reference and support from the selected upstream model.
`--quality fast` defaults to `gpt-image-2.5-flare`; `high` defaults to
`gpt-image-2.5-sunburst`; `--model` selects another available image model.
`--n 1..10` means independent billed requests, each with upstream `n=1`.
Concurrency is 1–4, default 2. Partial failures preserve successful files and
individual receipts. `--ratio` guides composition rather than exact dimensions.

Video supports only `MiniMax-H3`, integer seconds 4–15, resolution `768P|2K`,
and ratio `adaptive|21:9|16:9|4:3|1:1|3:4|9:16`. Repeat `--image`, `--video`,
and `--audio` for local, HTTP(S), or typed base64 data references. Desktop
narrows remote references to HTTPS. Local material is uploaded as multipart;
URLs are passed in task metadata. At most 16 references, 30/50/15 MiB per
image/video/audio, 180 MiB local total. Upstream limitations still apply.

Without `create`, video.py submits, polls, downloads and checks billing.
`--timeout` defaults to 1800 seconds and polling to 5 seconds. A timeout does
not cancel the server task. Recover the same task with `wait` or `download`.
Prompt stdin and `--prompt-file` support multiline content without shell quoting
tricks. `--dry-run` validates locally without network or spending; it is not
proof that actual generation succeeded.

POST requests are never retried automatically. Existing outputs/receipts block
new generation. Errors and `error_or_unknown` may still mean acceptance and
charges. Recover saved responses only; never regenerate successful batch items.
Deliver actual files and the final video state. Billing checks match recent
records, not a complete wallet audit; unavailable logs do not mean free or
refunded work. Task usage facts and server logs determine charges, not MP4
container duration. Never send a paid test request without explicit authorization.
