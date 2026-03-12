import { ConfigOptions } from "./types";

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export class Config {
  readonly host: string;
  readonly port: number;
  readonly tmuxSession: string;
  readonly tmuxWindow: string;
  readonly claudeCmd: string;
  readonly paneHistoryLines: number;
  readonly pollIntervalSec: number;
  readonly idleTimeoutSec: number;
  readonly startTimeoutSec: number;
  readonly hardTimeoutSec: number;
  readonly promptMode: "last_user" | "full";
  readonly debug: boolean;
  readonly debugLogBodyMax: number;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.host = env.HOST ?? "127.0.0.1";
    this.port = parseInt(env.PORT ?? "8000", 10);
    this.tmuxSession = env.TMUX_SESSION ?? "claude-bridge";
    this.tmuxWindow = env.TMUX_WINDOW ?? "claude";
    this.claudeCmd = env.CLAUDE_CMD ?? "claude";
    this.paneHistoryLines = parseInt(env.PANE_HISTORY_LINES ?? "200", 10);
    this.pollIntervalSec = parseFloat(env.POLL_INTERVAL_SEC ?? "0.15");
    this.idleTimeoutSec = parseFloat(env.IDLE_TIMEOUT_SEC ?? "1.5");
    this.startTimeoutSec = parseFloat(env.START_TIMEOUT_SEC ?? "10");
    this.hardTimeoutSec = parseFloat(env.HARD_TIMEOUT_SEC ?? "180");
    this.promptMode = (env.PROMPT_MODE as "last_user" | "full") ?? "last_user";
    this.debug = parseBoolean(env.DEBUG, false);
    this.debugLogBodyMax = parseInt(env.DEBUG_LOG_BODY_MAX ?? "4000", 10);
  }

  tmuxTarget(): string {
    return `${this.tmuxSession}:${this.tmuxWindow}`;
  }

  static fromEnv(): Config {
    return new Config(process.env);
  }
}

export const CFG = Config.fromEnv();
