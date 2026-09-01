export function requiredAuthBaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.BETTER_AUTH_URL?.trim();
  if (!value) throw new Error("BETTER_AUTH_URL_REQUIRED");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("BETTER_AUTH_URL_INVALID"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BETTER_AUTH_URL_INVALID");
  const testOnlyLocalHttp = environment.BETTER_AUTH_ALLOW_LOCALHOST_HTTP_FOR_TESTS === "true" && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (environment.NODE_ENV === "production" && url.protocol !== "https:" && !testOnlyLocalHttp) throw new Error("BETTER_AUTH_URL_HTTPS_REQUIRED");
  return value;
}
