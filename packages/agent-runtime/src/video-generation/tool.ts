import { Type } from "typebox";

export const videoGenerationDescription =
  "Generate videos directly through the signed-in StarAI account. Defaults to `minimax_h3_768p` (requires 1–9 local reference `images`, optional up to 3 `audio` files, `aspectRatio` in `16:9` | `9:16` | `1:1`, `seconds` 1–15). For text-to-video when the user provides no image, first call `GenerateImages` to create a keyframe image and pass its local path in `images` (or explicitly pass `model: \"grok-imagine-video-1.5（按次）\"` for 0-image generation). Also supports `minimax_h3_480p` and `gk-video-3.5-lk` (1 first-frame image). Video generation incurs a charge and may take 1–5 minutes; do not retry failed or timed-out calls automatically. The desktop renders the generated video player directly from the tool result.";

export const videoGenerationParameters = {
  prompt: Type.String({ minLength: 1, maxLength: 20000 }),
  images: Type.Optional(
    Type.Union([
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 9 }),
      Type.Null(),
    ]),
  ),
  audio: Type.Optional(
    Type.Union([
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 3 }),
      Type.Null(),
    ]),
  ),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  aspectRatio: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
  resolution: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 15 })),
};
