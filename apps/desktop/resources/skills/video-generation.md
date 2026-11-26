---
name: videogen
description: Generate AI videos directly with `GenerateVideo` using the signed-in StarAI account (defaults to `minimax_h3_768p`). Supports image-to-video, keyframe-first text-to-video, and audio references.
---

# Video generation

Use the built-in `GenerateVideo` tool directly whenever the user asks to generate, create, or animate a video.

- When signed in to StarAI, `GenerateVideo` works automatically with no API key setup and defaults to **`minimax_h3_768p`**.
- Do not install an SDK, run curl/API scripts, or ask the user for an API key.

## Choosing model & workflow

1. **Default (`minimax_h3_768p`)**:
   - Supports 1–9 local reference images (`images`), up to 3 optional audio references (`audio`), `aspectRatio` in `16:9` | `9:16` | `1:1` (default `16:9`), and `seconds` from 1 to 15 (default 10).
   - **Important for pure text-to-video**: `minimax_h3_768p` requires at least 1 reference image. If the user did not provide an image, **first call `GenerateImages`** (using the requested aspect ratio) to create a clean starting keyframe image, then pass that local image path in `GenerateVideo`'s `images: [path]` parameter!
   - If the user already attached or referenced local image(s), pass those paths directly in `images`.
2. **Other available StarAI video models** (only when explicitly requested by the user):
   - `minimax_h3_480p`: faster 480p H3 variant (1–9 images, 1–15s, `16:9`/`9:16`/`1:1`).
   - `gk-video-3.5-lk`: single first-frame image-to-video (exactly 1 image, 480p/720p, 1–15s).
   - `grok-imagine-video-1.5（按次）`: supports 0–7 images (4–15s, fixed 720p, omit `aspectRatio`).

## Prompting & delivery

- Describe clear subject motion, camera movement, lighting, pacing, and transitions concisely.
- Video generation incurs account quota and can take 1–5 minutes. Never retry a failed or timed-out video call automatically.
- The desktop renders a native video player directly from the tool result and saves the MP4 locally. Briefly summarize the generated clip and report the local file path if the user wants to save or copy it elsewhere.
