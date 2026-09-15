import "../styles/model-icons.css";
import { IconBot } from "../components/icons";

type ProviderIconDefinition = {
  symbol: string;
};

/** Provider ids used by pi-ai, models.dev, and common compatible gateways. */
const PROVIDER_ICONS: Readonly<Record<string, ProviderIconDefinition>> = {
  anthropic: { symbol: "anthropic" },
  openai: { symbol: "openai" },
  "openai-codex": { symbol: "openai" },
  google: { symbol: "google" },
  "google-vertex": { symbol: "google" },
  "ant-ling": { symbol: "antgroup" },
  deepseek: { symbol: "deepseek" },
  groq: { symbol: "groq" },
  mistral: { symbol: "mistral" },
  moonshotai: { symbol: "moonshot" },
  "moonshotai-cn": { symbol: "moonshot" },
  moonshot: { symbol: "moonshot" },
  minimax: { symbol: "minimax" },
  "minimax-cn": { symbol: "minimax" },
  fireworks: { symbol: "fireworks" },
  huggingface: { symbol: "huggingface" },
  cerebras: { symbol: "cerebras" },
  openrouter: { symbol: "openrouter" },
  xai: { symbol: "xai" },
  "cloudflare-ai-gateway": { symbol: "cloudflare" },
  "cloudflare-workers-ai": { symbol: "cloudflare" },
  "vercel-ai-gateway": { symbol: "vercel" },
  "github-copilot": { symbol: "githubcopilot" },
  "amazon-bedrock": { symbol: "aws" },
  "azure-openai-responses": { symbol: "azure" },
  "kimi-coding": { symbol: "kimi" },
  nvidia: { symbol: "nvidia" },
  opencode: { symbol: "opencode" },
  "opencode-go": { symbol: "opencode" },
  qwen: { symbol: "qwen" },
  xiaomi: { symbol: "xiaomimimo" },
  "xiaomi-token-plan-ams": { symbol: "xiaomimimo" },
  "xiaomi-token-plan-cn": { symbol: "xiaomimimo" },
  "xiaomi-token-plan-sgp": { symbol: "xiaomimimo" },
  zai: { symbol: "zai" },
  "zai-coding-cn": { symbol: "zai" },
  zhipu: { symbol: "zhipu" },
  cohere: { symbol: "cohere" },
  perplexity: { symbol: "perplexity" },
  together: { symbol: "together" },
  grok: { symbol: "grok" },
};

const MODEL_ICON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:claude|anthropic)\b/i, "anthropic"],
  [/\b(?:gpt|chatgpt|codex|o[1-9](?:[-.]\d+)?)\b/i, "openai"],
  [/\b(?:gemini|gemma)\b/i, "google"],
  [/\bdeepseek\b/i, "deepseek"],
  [/\b(?:grok|xai)\b/i, "grok"],
  [/(?:\bqwen(?:\d+(?:\.\d+)*)?\b|通义)/i, "qwen"],
  [/(?:\b(?:glm|chatglm)\b|智谱)/i, "zhipu"],
  [/\b(?:mistral|mixtral)\b/i, "mistral"],
  [/\b(?:kimi|moonshot)\b/i, "moonshot"],
  [/\bminimax\b/i, "minimax"],
];

/** Resolve a sprite symbol from model text first, then from the provider id. */
export function resolveModelIconSymbol(
  provider: string,
  modelId: string,
  modelName?: string,
): string | undefined {
  const text = `${modelId} ${modelName ?? ""}`;
  return (
    MODEL_ICON_RULES.find(([pattern]) => pattern.test(text))?.[1] ??
    PROVIDER_ICONS[provider.trim().toLowerCase()]?.symbol
  );
}

function SpriteIcon({ symbol, size }: { symbol: string; size: number }) {
  return (
    <svg
      aria-hidden="true"
      className="model-icon-sprite"
      data-symbol={symbol}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ flexShrink: 0 }}
    >
      <use href={`./provider-icons.svg#${symbol}`} />
    </svg>
  );
}

/** Model-aware monochrome icon with the existing bot glyph as the fallback. */
export function ModelIcon({
  provider,
  modelId,
  modelName,
  size = 14,
}: {
  provider: string;
  modelId: string;
  modelName?: string;
  size?: number;
}) {
  const symbol = resolveModelIconSymbol(provider, modelId, modelName);
  if (!symbol) return <IconBot size={size} aria-hidden="true" />;
  return <SpriteIcon symbol={symbol} size={size} />;
}
