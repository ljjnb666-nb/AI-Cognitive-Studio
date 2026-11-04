import { isIP } from "node:net";
import { ProviderGatewayError } from "../errors.js";
export type DnsResolver = { lookup(hostname: string): Promise<readonly string[]> };
export type ValidatedEndpoint = { url: URL; addresses: readonly string[] };
function ipv4Private(ip: string): boolean { const parts = ip.split(".").map(Number); const [a, b] = parts; return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b !== undefined && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 198 && (b === 18 || b === 19) || a === 100 && b !== undefined && b >= 64 && b <= 127 || a !== undefined && a >= 224; }
// Fail-closed IPv6 allowlist from the 2026-10-26 audit remediation: only globally
// routable 2000::/3 unicast may pass. This also excludes mapped IPv4, NAT64,
// unspecified, loopback, unique-local, link-local and multicast addresses.
export function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return ipv4Private(normalized);
  if (isIP(normalized) !== 6) return true;
  if (!/^[23][0-9a-f]{3}:/.test(normalized)) return true;
  const groups = normalized.split(":");
  const second = Number.parseInt(groups[1] || "0", 16);
  return groups[0] === "2001" && (second <= 0x1ff || second === 0xdb8) || groups[0] === "2002";
}
export function parseProviderEndpoint(input: string): URL {
  let url: URL; try { url = new URL(input); } catch { throw new ProviderGatewayError("NETWORK_POLICY_REJECTED", "Invalid provider endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new ProviderGatewayError("NETWORK_POLICY_REJECTED", "Provider endpoint must be a canonical HTTPS URL");
  return url;
}
export async function validateProviderEndpoint(input: string, options: { environment: string; allowPrivateEndpoints?: boolean; dns: DnsResolver; dnsTimeoutMs?: number }): Promise<ValidatedEndpoint> { const url = parseProviderEndpoint(input); const localAllowed = options.environment !== "production" && options.allowPrivateEndpoints === true; const hostname = url.hostname.replace(/^\[|\]$/g, ""); const addresses = isIP(hostname) ? [hostname] : await boundedDnsLookup(hostname, options.dns, options.dnsTimeoutMs ?? 5000); if (!addresses.length || (!localAllowed && addresses.some(privateAddress))) throw new ProviderGatewayError("NETWORK_POLICY_REJECTED", "Provider endpoint resolved to a non-public address"); return Object.freeze({ url, addresses: Object.freeze([...addresses]) }); }

async function boundedDnsLookup(hostname: string, dns: DnsResolver, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([dns.lookup(hostname), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderGatewayError("NETWORK_POLICY_REJECTED", "Provider DNS lookup timed out")), timeoutMs);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
