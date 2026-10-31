import { isIP } from "node:net";
import { ProviderGatewayError } from "../errors.js";
export type DnsResolver = { lookup(hostname: string): Promise<readonly string[]> };
export type ValidatedEndpoint = { url: URL; addresses: readonly string[] };
function ipv4Private(ip: string): boolean { const parts = ip.split(".").map(Number); const [a, b] = parts; return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b !== undefined && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b !== undefined && b >= 64 && b <= 127 || a !== undefined && a >= 224; }
export function privateAddress(address: string): boolean {
  let normalized = address.toLowerCase();
  if (isIP(normalized) === 6) normalized = new URL(`https://[${normalized}]/`).hostname.slice(1, -1);
  normalized = normalized.replace(/^::ffff:/, "");
  if (isIP(normalized) === 4) return ipv4Private(normalized);
  if (isIP(normalized) !== 6) return true;
  return normalized.startsWith("::") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
}
export function parseProviderEndpoint(input: string): URL {
  let url: URL; try { url = new URL(input); } catch { throw new ProviderGatewayError("NETWORK_POLICY_REJECTED", "Invalid provider endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new ProviderGatewayError("NETWORK_POLICY_REJECTED", "Provider endpoint must be a canonical HTTPS URL");
  return url;
}
export async function validateProviderEndpoint(input: string, options: { environment: string; allowPrivateEndpoints?: boolean; dns: DnsResolver }): Promise<ValidatedEndpoint> { const url = parseProviderEndpoint(input); const localAllowed = options.environment !== "production" && options.allowPrivateEndpoints === true; const hostname=url.hostname.replace(/^\[|\]$/g, ""); const addresses = isIP(hostname) ? [hostname] : await options.dns.lookup(hostname); if (!addresses.length || (!localAllowed && addresses.some(privateAddress))) throw new ProviderGatewayError("NETWORK_POLICY_REJECTED", "Provider endpoint resolved to a non-public address"); return Object.freeze({ url, addresses: Object.freeze([...addresses]) }); }
