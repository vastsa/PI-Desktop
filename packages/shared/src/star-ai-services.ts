/** Service order and channel classification used by the site's API key selector. */
export const STARAI_SERVICES = ["gpt", "claude", "gemini", "domestic", "grok", "media", "other"] as const;
export type StarAiService = (typeof STARAI_SERVICES)[number];

export function starAiGroupService(groupId: string): StarAiService {
  const name = groupId.toLowerCase();
  if (/生图|绘图|图像|视频|image|video|media/.test(name)) return "media";
  if (/claude|anthropic/.test(name)) return "claude";
  if (/gemini/.test(name)) return "gemini";
  if (/gpt|openai|codex/.test(name)) return "gpt";
  if (/grok|xai/.test(name)) return "grok";
  if (/deepseek|glm|kimi|qwen|doubao|minimax|国产|通义|智谱|豆包|文心|混元|hunyuan|ernie/.test(name)) return "domestic";
  return "other";
}

export function sortStarAiGroupsByRatio<T extends { ratio?: number | string }>(groups: readonly T[]): T[] {
  const rank = (group: T) => Number.isFinite(Number(group.ratio)) ? Number(group.ratio) : -Infinity;
  return [...groups].sort((a, b) => rank(a) === rank(b) ? 0 : rank(b) - rank(a));
}
