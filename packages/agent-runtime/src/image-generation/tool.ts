import { Type } from "@earendil-works/pi-ai";

export const imageGenerationDescription =
  "Generate raster images using the image model configured in Settings > Models. items supports distinct prompts and count variants; at most 10 images total. Each image may incur a charge. Generate only the requested number, report partial failures, and do not retry without the user's request. Results contain local image paths: display successful images with Markdown image links. For edits, provide images as local paths from the session, attachments, or project. Use previous result paths to refine generated images; preserve originals.";
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
    }),
    { minItems: 1, maxItems: 10 },
  ),
};
