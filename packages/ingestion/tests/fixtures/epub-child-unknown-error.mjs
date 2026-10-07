import process from "node:process";
process.stdout.write(JSON.stringify({ type: "error", code: "TRANSIENT_CHILD_SURPRISE" }) + "\n");
