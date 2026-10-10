/**
 * Read-only loopback-only app server. NO private data root or PDF paths.
 * Serves allowlisted UI and pinned npm-installed PDF.js ESM assets. No uploads/POST/API.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; " +
  "img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'self'; " +
  "form-action 'none'; base-uri 'none'";
const ALLOWED_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"],
  "/workspace.mjs": ["workspace.mjs", "text/javascript; charset=utf-8"],
  "/review.mjs": ["review.mjs", "text/javascript; charset=utf-8"],
  "/preview.mjs": ["preview.mjs", "text/javascript; charset=utf-8"],
  // These two immutable routes point only to pdfjs-dist 6.2.108 installed by npm ci.
  "/vendor/pdf.mjs": ["../node_modules/pdfjs-dist/build/pdf.mjs", "text/javascript; charset=utf-8"],
  "/vendor/pdf.worker.mjs": ["../node_modules/pdfjs-dist/build/pdf.worker.mjs", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
});
function securityHeaders() {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}
export async function startAnnotationServer() {
  const server = createServer(async (request, response) => {
    const port = server.address()?.port;
    const addr = request.socket.remoteAddress;
    // Restrict Host to prevent DNS rebinding even on a loopback listener.
    const local = addr === "127.0.0.1" || addr === "::ffff:127.0.0.1";
    const hostOk = request.headers.host === "127.0.0.1:" + port;
    response.setHeader("Cache-Control", "no-store");
    if (!local || !hostOk) {
      response.writeHead(403, securityHeaders()); response.end(); return;
    }
    const pathname = request.url?.split("?")[0];
    if (request.method !== "GET" || !Object.hasOwn(ALLOWED_FILES, pathname ?? "")) {
      response.writeHead(404, securityHeaders()); response.end(); return;
    }
    const [filename, type] = ALLOWED_FILES[pathname];
    try {
      const file = await readFile(join(HERE, filename));
      response.writeHead(200, { ...securityHeaders(), "Content-Type": type, "Content-Length": file.length });
      response.end(file);
    } catch {
      response.writeHead(500, securityHeaders()); response.end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("ANNOTATOR_LOOPBACK_ONLY");
  }
  return {
    url: "http://127.0.0.1:" + address.port + "/",
    server,
    close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  };
}
