import express from "express";
import { Command } from "commander";
import { Config, CFG } from "./config";
import { healthHandler, modelsHandler, chatCompletionsHandler, requestLogger } from "./handler";

const program = new Command();

program
  .option("-p, --port <number>", "port to listen on", parseInt)
  .option("-h, --host <string>", "host to bind to")
  .option("--debug", "enable debug logging")
  .parse(process.argv);

const opts = program.opts();

if (opts.port) process.env.PORT = String(opts.port);
if (opts.host) process.env.HOST = opts.host;
if (opts.debug) process.env.DEBUG = "1";

const cfg = new Config(process.env);

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(requestLogger(cfg));

app.get("/health", healthHandler);
app.get(["/v1/models", "/models"], modelsHandler);
app.post(["/v1/chat/completions", "/chat/completions"], chatCompletionsHandler);

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`tmux-claude OpenAI bridge listening on http://${cfg.host}:${cfg.port}`);
  console.log(`tmux target: ${cfg.tmuxTarget()} | claude cmd: ${cfg.claudeCmd}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Error: Port ${cfg.port} is already in use. Use -p <port> or PORT=<port> to specify a different port.`);
    process.exit(1);
  }
  throw err;
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
