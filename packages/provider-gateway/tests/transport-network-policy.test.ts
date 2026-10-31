import { createServer } from "node:net";
import type { LookupAddress } from "node:dns";
import { expect, it, vi } from "vitest";
import { FetchProviderHttpTransport } from "../src/adapters/http-transport.js";
import { validateProviderEndpoint } from "../src/safety/endpoint-policy.js";
import { publicProviderLookup } from "../src/safety/public-lookup.js";

function lookupResult(addresses: LookupAddress[]) {
  return new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[] }>(resolve => {
    publicProviderLookup(async () => addresses)("provider.test", { all: true }, (error, address) => resolve({ error, address }));
  });
}

it("rejects DNS rebinding at the real socket lookup before credentials reach loopback", async () => {
  const endpoint = await validateProviderEndpoint("https://rebind.invalid", { environment: "production", dns: { lookup: async () => ["93.184.216.34"] } });
  expect(endpoint.addresses).toEqual(["93.184.216.34"]);
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const transport = new FetchProviderHttpTransport(async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    await expect(transport.execute({ url: `https://rebind.invalid:${port}/v1`, method: "POST", headers: { authorization: "Bearer synthetic-only" }, body: "private-synthetic-input", signal: AbortSignal.timeout(2000) })).rejects.toMatchObject({ code: "NETWORK_POLICY_REJECTED", retryable: false });
    expect(connections).toBe(0);
  } finally { await transport.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["::1", "0:0:0:0:0:0:0:1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::127.0.0.1"])("rejects a private IPv6 result %s even beside a public A record", async address => {
  const result = await lookupResult([{ address: "93.184.216.34", family: 4 }, { address, family: 6 }]);
  expect(result.error).toMatchObject({ code: "NETWORK_POLICY_REJECTED" });
});

it("returns only the validated public addresses to the socket without another resolution", async () => {
  const addresses = [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }];
  expect(await lookupResult(addresses)).toEqual({ error: null, address: addresses });
});

it.each(["http://public.example/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://169.254.169.254/v1"])("rejects forbidden literal endpoint %s before fetch", async url => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await expect(new FetchProviderHttpTransport().execute({ url, method: "POST", headers: {}, body: "{}", signal: new AbortController().signal })).rejects.toMatchObject({ code: "NETWORK_POLICY_REJECTED" });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
