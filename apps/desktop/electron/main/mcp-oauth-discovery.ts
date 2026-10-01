/** MCP authorization discovery rules, independent of network and login state. */
export function authorizationMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  const paths = path
    ? [
        `/.well-known/oauth-authorization-server${path}`,
        `/.well-known/openid-configuration${path}`,
        `${path}/.well-known/openid-configuration`,
      ]
    : ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"];
  return paths.map((candidate) => {
    const url = new URL(issuer.origin);
    url.pathname = candidate;
    return url.toString();
  });
}

/** Read one Bearer challenge without borrowing parameters from another scheme. */
export function parseBearerChallenge(header: string): {
  resourceMetadataUrl?: string;
  scope?: string;
} {
  const params = new Map<string, string>();
  let bearer = false;
  // Commas inside quoted strings delimit neither parameters nor challenges.
  for (const part of header.match(/(?:[^",]|"(?:\\.|[^"\\])*")+/g) ?? []) {
    let value = part.trim();
    const scheme = value.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:[ \t]+(?![ \t]*=)|$)/);
    if (scheme) {
      if (bearer) break;
      bearer = scheme[1].toLowerCase() === "bearer";
      value = value.slice(scheme[0].length);
    }
    if (!bearer) continue;
    const param = value.match(/^([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s,]+))\s*$/);
    if (param) {
      const key = param[1].toLowerCase();
      if (!params.has(key)) params.set(key, param[2]?.replace(/\\(.)/g, "$1") ?? param[3]);
    }
  }
  return { resourceMetadataUrl: params.get("resource_metadata"), scope: params.get("scope") };
}

// RFC 6749 scope-token excludes whitespace, double quotes and backslashes.
function isScopeToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value);
}

export function selectOAuthScope(challengeScope: string | undefined, resourceScopes: unknown): string | undefined {
  if (challengeScope) {
    const tokens = challengeScope.split(" ").filter(Boolean);
    if (tokens.length > 0 && tokens.every(isScopeToken)) return tokens.join(" ");
  }
  if (!Array.isArray(resourceScopes)) return undefined;
  return resourceScopes.filter(isScopeToken).join(" ") || undefined;
}
