import { Type } from "typebox";

export const imageGenerationDescription =
  "Generate or edit raster images directly. When signed in to StarAI, this works out of the box using the default model `gpt-image-2.6-sunburst` (no manual API key needed); otherwise uses the image model configured in Settings > Models. `items` supports distinct prompts, `count` variants (at most 10 images total), optional `aspectRatio` (e.g. `1:1`, `16:9`, `9:16`, `4:3`, `3:4`), `resolution` (`1K`/`2K`/`4K`), `model`, and `images` local paths for edits. Each image may incur a charge. Generate only the requested number, report partial failures, and do not retry automatically. Results contain local image paths rendered directly in the chat UI — do not repeat them as Markdown image links.";
export const imageGenerationParameters = {
  items: Type.Array(
    Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 32000 }),
      images: Type.Optional(
        Type.Union([
          Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 4 }),
          Type.Null(),
        ]),
      ),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      aspectRatio: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
      resolution: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
    { minItems: 1, maxItems: 10 },
  ),
};
