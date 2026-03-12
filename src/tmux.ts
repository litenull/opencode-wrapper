import { spawn, SpawnResult } from "./spawn";
import { Config } from "./config";

export class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

export async function ensureTmuxSession(cfg: Config): Promise<void> {
  const rc = await spawn(["tmux", "has-session", "-t", cfg.tmuxSession], false);
  if (rc === 0) return;

  const result = await spawn(
    ["tmux", "new-session", "-d", "-s", cfg.tmuxSession, "-n", cfg.tmuxWindow, cfg.claudeCmd],
    true
  );
  if (result.code !== 0) {
    throw new TmuxError(`failed to create tmux session: ${result.stderr.trim()}`);
  }
}

export async function capturePane(cfg: Config): Promise<string> {
  const result = await spawn(
    ["tmux", "capture-pane", "-p", "-S", `-${cfg.paneHistoryLines}`, "-t", cfg.tmuxTarget()],
    true
  );
  if (result.code !== 0) {
    throw new TmuxError(`failed to capture pane: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function sendPrompt(prompt: string, cfg: Config): Promise<void> {
  let result = await spawn(["tmux", "set-buffer", "--", prompt], true);
  if (result.code !== 0) {
    throw new TmuxError(`failed to set tmux buffer: ${result.stderr.trim()}`);
  }

  result = await spawn(["tmux", "paste-buffer", "-t", cfg.tmuxTarget()], true);
  if (result.code !== 0) {
    throw new TmuxError(`failed to paste tmux buffer: ${result.stderr.trim()}`);
  }

  result = await spawn(["tmux", "send-keys", "-t", cfg.tmuxTarget(), "Enter"], true);
  if (result.code !== 0) {
    throw new TmuxError(`failed to send Enter: ${result.stderr.trim()}`);
  }
}

export function createTmuxLock(): {
  acquire: () => Promise<() => void>;
} {
  let promise: Promise<void> = Promise.resolve();

  return {
    acquire: async () => {
      const prev = promise;
      let release: () => void;
      promise = new Promise((resolve) => {
        release = resolve;
      });
      await prev;
      return () => release();
    },
  };
}
