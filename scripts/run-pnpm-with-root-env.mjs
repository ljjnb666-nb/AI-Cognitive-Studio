import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "pnpm";
const commandArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", `pnpm ${args.join(" ")}`]
  : args;
const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
