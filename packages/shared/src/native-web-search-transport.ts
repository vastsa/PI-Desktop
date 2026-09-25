/** Published first-party search routes that reuse existing request adapters. */
const SEARCH_ROUTES = [
  { origin: "https://api.deepseek.com", paths: ["", "/v1"], apiStyle: "anthropic_messages", path: "/anthropic" },
  { origin: "https://api.x.ai", paths: ["/v1"], apiStyle: "responses", path: "/v1" },
  { origin: "https://api.openai.com", paths: ["/v1"], apiStyle: "responses", path: "/v1" },
] as const;

/**
 * Resolve a request-only route. Never mutate the saved provider or infer an
 * official origin from a vendor/model name: relay credentials stay on the relay.
 */
export function nativeWebSearchTransport(input: {
  apiStyle: string | undefined;
  baseUrl: string | undefined;
  enabled: boolean;
}): { apiStyle: string | undefined; baseUrl: string | undefined } {
  const unchanged = { apiStyle: input.apiStyle, baseUrl: input.baseUrl };
  if (!input.enabled || !input.baseUrl ||
      !["chat_completions", "openai-completions"].includes(input.apiStyle ?? "")) return unchanged;
  try {
    const url = new URL(input.baseUrl);
    if (url.username || url.password || url.search || url.hash) return unchanged;
    const path = url.pathname.replace(/\/+$/, "");
    const route = SEARCH_ROUTES.find((item) => item.origin === url.origin &&
      (item.paths as readonly string[]).includes(path));
    return route ? { apiStyle: route.apiStyle, baseUrl: `${url.origin}${route.path}` } : unchanged;
  } catch {
    return unchanged;
  }
}
