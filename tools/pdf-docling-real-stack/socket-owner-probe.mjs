/**
 * Only the opted-in synthetic Windows acceptance proof may load this tracer.
 * Categorizes TCP native resource origins without emitting stack frames,
 * private paths, peer addresses or credentials. No connection is altered.
 */
import { createHook } from "node:async_hooks";

if (process.platform === "win32" &&
    process.env.ACS_DOCLING_REAL_STACK_E2E === "1") {
  const owners = new WeakMap();
  const classify = (stack) => {
    if (/ioredis|bullmq|redis\.js|docling-layout\.js/i.test(stack)) return "REDIS_BULLMQ";
    if (/@aws-sdk|@smithy|packages[\\/]storage/i.test(stack)) return "S3_SDK";
    if (/@prisma|node_modules[\\/]pg[\\/]|postgres/i.test(stack)) return "POSTGRES";
    if (/docling-layout-child|packages[\\/]ingestion/i.test(stack)) return "DOC_MODEL";
    if (/tsx|esbuild/i.test(stack)) return "TSX_LOADER";
    if (/node:net|node:tls/i.test(stack)) return "NODE_CORE";
    if (/node_modules/i.test(stack)) return "THIRD_PARTY";
    return "UNKNOWN";
  };
  createHook({
    init(_id, type, _trigger, resource) {
      if ((type !== "TCPWRAP" && type !== "PIPEWRAP") ||
          !resource || typeof resource !== "object") return;
      // The hook stores a small label, not the stack or address.
      owners.set(resource, classify(new Error().stack ?? ""));
    },
  }).enable();
  Object.defineProperty(globalThis, "__acsSocketOwner", {
    configurable: false,
    value(socket) {
      const native = socket?._handle;
      return native && typeof native === "object"
        ? owners.get(native) ?? "UNTRACED"
        : "UNTRACED";
    },
  });
}
