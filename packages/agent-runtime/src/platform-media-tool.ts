import { Type } from "@earendil-works/pi-ai";

export const platformMediaDescription =
  "Use the bundled AI Aggregation Platform skill for image creation/editing, MiniMax-H3 video creation from text/images/videos/audio, downloading existing outputs, and checking server billing. Each creation may charge the user's platform account. Generate only the requested count. Never retry a create on unknown response or timeout: retain the receipt and resume the same task. No API key or arbitrary URL/command configuration is accepted. Load the ai-aggregation-platform skill first for exact operations. Return local output paths and billing verification state without estimating a settled charge.";

const references = Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 }));
export const platformMediaParameters = {
  operation: Type.Union(["image", "image-download", "video-create", "video-status", "video-download", "billing"].map((op) => Type.Literal(op))),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  images: references,
  videos: references,
  audios: references,
  seconds: Type.Optional(Type.Integer({ minimum: 4, maximum: 15 })),
  resolution: Type.Optional(Type.Union([Type.Literal("768P"), Type.Literal("2K")])),
  ratio: Type.Optional(Type.String({ maxLength: 16 })),
  taskId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,160}$" })),
  receipt: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
};
