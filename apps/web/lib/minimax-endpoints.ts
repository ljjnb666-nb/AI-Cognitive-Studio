/** Fixed provider-owned addresses shared by the form and server validation. */
export const miniMaxSites = {
  CN: { endpoint: "https://api.minimax.cn/v1/chat/completions", testEndpoint: "https://api.minimax.cn/v1/models" },
  GLOBAL: { endpoint: "https://api.minimax.io/v1/text/chatcompletion_v2", testEndpoint: "https://api.minimax.io/v1/models" },
} as const;

export function miniMaxTestEndpoint(endpoint: string): string | undefined {
  return Object.values(miniMaxSites).find(site => site.endpoint === endpoint)?.testEndpoint;
}

/** HTTP success alone cannot establish that the credential was accepted. */
export function validMiniMaxModelList(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return body.object === "list" && Array.isArray(body.data) && body.data.every(model => model && typeof model === "object" && typeof model.id === "string" && model.id.length > 0);
}
