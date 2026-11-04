import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FetchProviderHttpTransport } from "../src/adapters/http-transport.js";

// Real TLS sockets; only the test DNS resolver is substituted. Production policy remains closed.
describe("provider transport over real TLS", () => {
  let directory: string, server: Server, url: string, certificate: string;
  const originalRoots = getCACertificates("default");
  const observations: Array<{ host?: string; sni?: string; body: string; path?: string }> = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "acs-transport-tls-"));
    const keyPath = join(directory, "server.key"), certPath = join(directory, "server.pem");
    execFileSync(process.env.OPENSSL_PATH ?? "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=provider.test", "-addext", "subjectAltName=DNS:provider.test", "-keyout", keyPath, "-out", certPath], { stdio: "pipe", timeout: 15_000 });
    certificate = await readFile(certPath, "utf8");
    setDefaultCACertificates([...originalRoots, certificate]);
    server = createServer({ key: await readFile(keyPath), cert: certificate }, (request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk.toString(); });
      request.on("end", () => {
        observations.push({ host: request.headers.host, sni: (request.socket as TLSSocket & { servername?: string }).servername, body, path: request.url });
        if (request.url === "/wait") return;
        if (request.url === "/redirect") { response.writeHead(302, { location: "https://127.0.0.1/private" }); response.end("redirect"); return; }
        if (request.url === "/large") { response.end(Buffer.alloc(4 * 1024 * 1024 + 1)); return; }
        response.setHeader("content-type", "application/json"); response.end('{"answer":"verified"}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("TLS_LISTEN_FAILED");
    url = `https://provider.test:${address.port}`;
  }, 20_000);
  afterAll(async () => {
    setDefaultCACertificates(originalRoots);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const transport = () => new FetchProviderHttpTransport({ environment: "test", allowPrivateEndpoints: true, dns: { lookup: async () => ["127.0.0.1"] } });
  const request = (path = "/ok", signal = AbortSignal.timeout(3000)) => ({ url: url + path, method: "POST" as const, body: '{"input":"grounded"}', headers: { "content-type": "application/json" }, signal });
  it("pins the validated address without a second DNS lookup, retaining Host and TLS SNI", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(["127.0.0.1"]).mockResolvedValue(["127.0.0.2"]);
    const pinned = new FetchProviderHttpTransport({ environment: "test", allowPrivateEndpoints: true, dns: { lookup } });
    await expect(pinned.execute(request())).resolves.toMatchObject({ status: 200, body: '{"answer":"verified"}' });
    expect(lookup).toHaveBeenCalledExactlyOnceWith("provider.test");
    expect(observations.at(-1)).toMatchObject({ host: new URL(url).host, sni: "provider.test", body: '{"input":"grounded"}' });
  });
  it("rejects private answers in production even with the development opt-in", async () => {
    const before = observations.length;
    const production = new FetchProviderHttpTransport({ environment: "production", allowPrivateEndpoints: true, dns: { lookup: async () => ["93.184.216.34", "127.0.0.1"] } });
    await expect(production.execute(request())).rejects.toMatchObject({ code: "NETWORK_POLICY_REJECTED" });
    expect(observations).toHaveLength(before);
  });
  it("validates the TLS hostname against the original URL", async () => {
    const before = observations.length;
    await expect(transport().execute({ ...request(), url: url.replace("provider.test", "wrong.test") })).rejects.toMatchObject({ code: "TRANSIENT_UPSTREAM" });
    expect(observations).toHaveLength(before);
  });
  it("rejects a certificate without a trusted issuer", async () => {
    setDefaultCACertificates(originalRoots);
    try { await expect(transport().execute(request())).rejects.toMatchObject({ code: "TRANSIENT_UPSTREAM" }); }
    finally { setDefaultCACertificates([...originalRoots, certificate]); }
  });
  it("returns redirects without following them into private endpoints", async () => {
    const before = observations.length;
    await expect(transport().execute(request("/redirect"))).resolves.toMatchObject({ status: 302, body: "redirect" });
    expect(observations).toHaveLength(before + 1);
  });
  it("enforces the response byte limit on an actual streaming response", async () => {
    await expect(transport().execute(request("/large"))).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });
  it("aborts an in-flight TLS request", async () => {
    const controller = new AbortController();
    const result = transport().execute(request("/wait", controller.signal));
    const assertion = expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    await vi.waitFor(() => expect(observations.at(-1)?.path).toBe("/wait"));
    controller.abort();
    await assertion;
  });
});
