// Runs API server (tsx watch) and Vite dev server together, relaying output.
import { spawn } from "node:child_process";

const procs = [];
function run(name, cmd, args, color) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) console.log(`${tag} ${l}`);
    });
  };
  pipe(p.stdout);
  pipe(p.stderr);
  p.on("exit", (code) => console.log(`${tag} exited with code ${code}`));
  procs.push(p);
  return p;
}

const api = run("api", "npx", ["tsx", "watch", "server/index.ts"], "36");
const web = run("web", "npx", ["vite", "--host", "0.0.0.0"], "35");

function shutdown() {
  for (const p of procs) {
    if (!p.killed) p.kill("SIGTERM");
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
api.on("exit", () => {
  if (web && !web.killed) web.kill("SIGTERM");
});
