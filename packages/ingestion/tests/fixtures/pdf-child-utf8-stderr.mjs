import process from "node:process";
process.stderr.write("中文中文");
setTimeout(() => {}, 60_000);
