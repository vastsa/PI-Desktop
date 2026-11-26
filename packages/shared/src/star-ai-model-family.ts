export const STARAI_MODEL_FAMILIES = [
  "GPT", "Claude", "Gemini", "DeepSeek", "Kimi", "GLM", "Grok", "Qwen", "MiniMax", "Doubao", "Llama", "MiMo", "Hunyuan",
] as const;

const vendorFamilies = new Map<string, string>([
  ["openai", "GPT"], ["anthropic", "Claude"], ["google", "Gemini"], ["google deepmind", "Gemini"],
  ["deepseek", "DeepSeek"], ["moonshot", "Kimi"], ["moonshotai", "Kimi"], ["智谱", "GLM"], ["zhipu", "GLM"], ["zai", "GLM"], ["z.ai", "GLM"],
  ["xai", "Grok"], ["x.ai", "Grok"], ["grok", "Grok"], ["qwen", "Qwen"], ["minimax", "MiniMax"],
  ["doubao", "Doubao"], ["meta", "Llama"], ["xiaomi", "MiMo"], ["tencent", "Hunyuan"],
]);

/** Prefer the served model family; resolve opaque deployment IDs with the site's vendor metadata. */
export function starAiModelFamily(modelId: string, vendorName?: string): string {
  const leaf = modelId.trim().toLowerCase().split("/").pop() ?? "";
  const token = leaf.replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, "").split(/[-_.:@]/)[0];
  if (/^(?:o[1-9]\d*|chatgpt|codex|gpt\d*)$/.test(token)) return "GPT";
  const stem = token.replace(/\d+$/, "");
  if (stem === "hy") return "Hunyuan";
  const family = STARAI_MODEL_FAMILIES.find((name) => name.toLowerCase() === stem);
  if (family) return family;
  const siteName = vendorName?.trim();
  return siteName ? vendorFamilies.get(siteName.toLowerCase()) ?? siteName : "other";
}
