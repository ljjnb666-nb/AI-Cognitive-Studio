/**
 * Manual local-only entry point. No browser auto-launch or private book read.
 * Start only after the user has separately authorized working with D: data.
 */
import { startAnnotationServer } from "../annotation/server.mjs";

try {
  const app = await startAnnotationServer();
  process.stdout.write("ACS_GT_ANNOTATOR_LOCAL_ONLY=" + app.url + "\n");
  process.stdout.write("ACS_GT_ANNOTATOR_STATIC_ONLY=TRUE\n");
  process.stdout.write("请在本机浏览器打开上面的地址，完成后按 Ctrl+C 关闭。\n");
  const stop = async () => {
    try { await app.close(); }
    finally { process.exitCode = 0; }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
} catch {
  process.stderr.write("ACS_GT_ANNOTATOR_START_BLOCKED\n");
  process.exitCode = 2;
}
