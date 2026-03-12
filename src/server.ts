import * as http from "http";
import { Config, CFG } from "./config";
import { createHandler } from "./handler";

function parseArgs(): { port?: number } {
  const args = process.argv.slice(2);
  const result: { port?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--port") {
      result.port = parseInt(args[++i], 10);
    } else if (args[i].startsWith("--port=")) {
      result.port = parseInt(args[i].split("=")[1], 10);
    }
  }
  return result;
}

function main(): void {
  const cliArgs = parseArgs();
  if (cliArgs.port) {
    process.env.PORT = String(cliArgs.port);
  }
  const cfg = cliArgs.port ? new Config(process.env) : CFG;

  const server = http.createServer(createHandler(cfg));
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${cfg.port} is already in use. Use -p <port> or PORT=<port> to specify a different port.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`tmux-claude OpenAI bridge listening on http://${cfg.host}:${cfg.port}`);
    console.log(`tmux target: ${cfg.tmuxTarget()} | claude cmd: ${cfg.claudeCmd}`);
  });

  process.on("SIGINT", () => {
    server.close(() => {
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

main();
