/**
 * Loopback-only allowlisted static server. The existing GT pages stay static.
 * Opt-in P127 bridge requires an ephemeral token: three fixed private source
 * files and one bounded draft only. No general filesystem API or uploads.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { readPrivateP127Bundle, readPrivateP127Draft, writePrivateP127Draft, PrivateGraphError } from "./private-graph-local.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; " +
  "img-src blob: data:; font-src blob: data:; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'self'; " +
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
  "/graph-review.html": ["graph-review.html", "text/html; charset=utf-8"],
  "/graph-review.mjs": ["graph-review.mjs", "text/javascript; charset=utf-8"],
  "/graph-review-app.mjs": ["graph-review-app.mjs", "text/javascript; charset=utf-8"],
  "/graph-review.css": ["graph-review.css", "text/css; charset=utf-8"],
});
function securityHeaders(graphPage = false) {
  return {
    "Content-Security-Policy": graphPage ? CONTENT_SECURITY_POLICY.replace("connect-src 'none'","connect-src 'self'") : CONTENT_SECURITY_POLICY,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}
const PRIVATE_BUNDLE = "/api/private-graph/p127/bundle";
const PRIVATE_DRAFT = "/api/private-graph/p127/draft";
const TOKEN = /^[0-9a-f]{64}$/u;
export async function startAnnotationServer({ privateGraphRoot = null, graphAccessToken = null } = {}) {
  const enabled = privateGraphRoot !== null;
  if (enabled && (typeof privateGraphRoot !== "string" || !privateGraphRoot ||
      typeof graphAccessToken !== "string" || !TOKEN.test(graphAccessToken))) {
    throw new Error("PRIVATE_GRAPH_BRIDGE_CONFIG_INVALID");
  }
  if (!enabled && graphAccessToken !== null) throw new Error("PRIVATE_GRAPH_BRIDGE_CONFIG_INVALID");
  // Serializes private draft writes and prevents stale revision check races.
  let writer = Promise.resolve();
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
    if (pathname === PRIVATE_BUNDLE || pathname === PRIVATE_DRAFT) {
      const headers = securityHeaders(true);
      const reply = (status, value) => {
        const body = Buffer.from(JSON.stringify(value),"utf8");
        response.writeHead(status,{...headers,"Content-Type":"application/json; charset=utf-8","Content-Length":body.length});
        response.end(body);
      };
      if (!enabled) { reply(404,{code:"PRIVATE_IMPORT_DISABLED"}); return; }
      const origin=request.headers.origin;
      const fetchSite=request.headers["sec-fetch-site"];
      const presented=request.headers["x-acs-review-token"];
      const okToken=typeof presented==="string" && TOKEN.test(presented) &&
        timingSafeEqual(Buffer.from(presented,"ascii"),Buffer.from(graphAccessToken,"ascii"));
      if (!okToken ||
          (origin && origin!=="http://127.0.0.1:"+port) ||
          (fetchSite && !["same-origin","none"].includes(fetchSite))) {
        reply(403,{code:"PRIVATE_IMPORT_ACCESS_DENIED"}); return;
      }
      if ((pathname === PRIVATE_BUNDLE && request.method !== "GET") ||
          (pathname === PRIVATE_DRAFT && !["GET","PUT"].includes(request.method)) ||
          (pathname === PRIVATE_DRAFT && request.method === "PUT" &&
           (!/^application\/json(?:;|$)/iu.test(request.headers["content-type"]??"") ||
            !["none"].includes(request.headers["x-acs-draft-revision"]) &&
            !TOKEN.test(request.headers["x-acs-draft-revision"]??"")))) {
        reply(405,{code:"PRIVATE_IMPORT_METHOD_REJECTED"}); return;
      }
      try {
        if (pathname === PRIVATE_BUNDLE) {
          const bundle=await readPrivateP127Bundle(privateGraphRoot);
          reply(200,{...bundle.data,authority:bundle.authority});
          return;
        }
        if (request.method === "GET") {
          const bundle=await readPrivateP127Bundle(privateGraphRoot);
          const draft=await readPrivateP127Draft(privateGraphRoot,bundle.view);
          reply(200,draft); return;
        }
        // This is the only mutable private route. No arbitrary filename/API.
        const rawLength=request.headers["content-length"];
        if (!rawLength || !/^[0-9]{1,6}$/u.test(rawLength) ||
            Number(rawLength)>100_000) {
          reply(413,{code:"PRIVATE_DRAFT_BODY_TOO_LARGE"}); return;
        }
        const parts=[];let total=0;
        for await (const part of request) {
          total+=part.length;
          if (total>100_000) throw new PrivateGraphError("PRIVATE_DRAFT_BODY_TOO_LARGE");
          parts.push(part);
        }
        const bytes=Buffer.concat(parts);
        if (bytes.length !== Number(rawLength)) throw new PrivateGraphError("PRIVATE_DRAFT_LENGTH_CHANGED");
        let raw;
        try {raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
        catch {throw new PrivateGraphError("PRIVATE_DRAFT_JSON_INVALID");}
        const expectRevision=request.headers["x-acs-draft-revision"]==="none" ? null : request.headers["x-acs-draft-revision"];
        const work = async () => {
          const bundle=await readPrivateP127Bundle(privateGraphRoot);
          return writePrivateP127Draft(privateGraphRoot,bundle.view,raw,expectRevision);
        };
        const next=writer.then(work,work);
        writer=next.catch(()=>{});
        reply(200,await next);
      } catch(e) {
        const code=e instanceof PrivateGraphError ? e.code : "PRIVATE_IMPORT_INTERNAL_ERROR";
        reply(code==="PRIVATE_DRAFT_CONFLICT"?409:
          code==="PRIVATE_DRAFT_BODY_TOO_LARGE"?413:
          code==="PRIVATE_EVIDENCE_NOT_READY"?404:422,{code});
      }
      return;
    }
    if (request.method !== "GET" || !Object.hasOwn(ALLOWED_FILES, pathname ?? "")) {
      response.writeHead(404, securityHeaders()); response.end(); return;
    }
    const [filename, type] = ALLOWED_FILES[pathname];
    try {
      const file = await readFile(join(HERE, filename));
      response.writeHead(200, { ...securityHeaders(pathname === "/graph-review.html"), "Content-Type": type, "Content-Length": file.length });
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
