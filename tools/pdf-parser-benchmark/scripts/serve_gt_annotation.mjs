/**
 * Start a loopback-only static annotator, or opt in to a single P127 auto
 * import / private draft persistence via an ephemeral URL-fragment capability.
 * NEVER opens arbitrary files or sends content to a model or external host.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { startAnnotationServer } from "../annotation/server.mjs";

const argv=process.argv.slice(2);
const auto=argv.length===1 && argv[0]==="--auto-import-p127";
if(argv.length>0&&!auto) {
  process.stderr.write("ACS_GT_ANNOTATOR_ARGUMENT_BLOCKED\n");
  process.exitCode=2;
} else try {
  const token=auto?randomBytes(32).toString("hex"):null;
  const privateRoot=auto?join("D:\\ai-cognitive-pdf-benchmark-data","reports","real-mineru-39440805765-1"):null;
  const app=await startAnnotationServer({
    privateGraphRoot:privateRoot,graphAccessToken:token,
  });
  process.stdout.write("ACS_GT_ANNOTATOR_LOCAL_ONLY="+app.url+"\n");
  process.stdout.write("ACS_GT_ANNOTATOR_AUTO_IMPORT="+(auto?"ENABLED":"DISABLED")+"\n");
  if(auto) {
    // Fragment is never transmitted as HTTP URL or Referer. Use only locally.
    process.stdout.write("ACS_P127_GRAPH_REVIEW_LOCAL_URL="+
      app.url+"graph-review.html#review-token="+token+"\n");
    process.stdout.write("已授权本机自动读取固定 P127 证据及保存未认证草稿。关闭此终端即可停止本机服务。\n");
  } else {
    process.stdout.write("静态标注服务已启动。若要 P127 自动导入，请以 --auto-import-p127 重新启动。\n");
  }
  const stop=async()=>{
    try {await app.close();}
    finally{process.exitCode=0;}
  };
  process.once("SIGINT",()=>{void stop();});
  process.once("SIGTERM",()=>{void stop();});
} catch {
  process.stderr.write("ACS_GT_ANNOTATOR_START_BLOCKED\n");
  process.exitCode=2;
}
