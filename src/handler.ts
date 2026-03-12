import * as crypto from "crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { Config, CFG } from "./config";
import { ensureTmuxSession, capturePane, sendPrompt, createTmuxLock } from "./tmux";
import {
  extractLatestAssistantText,
  extractDelta,
  appendUnique,
  isPromptEcho,
  buildMessagesPrompt,
} from "./text-utils";
import { sseEvent, sseDone, createChatCompletionChunk, createChatCompletionResponse, createModelListResponse } from "./sse";
import { ChatCompletionRequest } from "./types";

const tmuxLock = createTmuxLock();

export function debugLog(message: string): void {
  if (!CFG.debug) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[debug ${ts}] ${message}`);
}

function generateCompletionId(): string {
  return `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectResponseText(cfg: Config, baseline: string): Promise<string> {
  let baselineReply = extractLatestAssistantText(baseline);
  let prevReply = baselineReply;
  let emitted = "";
  const parts: string[] = [];
  let started = false;
  const startWaitDeadline = Date.now() + cfg.startTimeoutSec * 1000;
  const hardDeadline = Date.now() + cfg.hardTimeoutSec * 1000;
  let lastChange = Date.now();

  while (Date.now() < hardDeadline) {
    const cur = await capturePane(cfg);
    const curReply = extractLatestAssistantText(cur);
    const delta = extractDelta(prevReply, curReply);
    prevReply = curReply;
    const [unique, newEmitted] = appendUnique(emitted, delta);
    emitted = newEmitted;

    if (unique) {
      parts.push(unique);
      started = true;
      lastChange = Date.now();
      debugLog(`non-stream delta chars=${unique.length}`);
    } else if (started && Date.now() - lastChange >= cfg.idleTimeoutSec * 1000) {
      debugLog("non-stream stop: idle timeout");
      break;
    } else if (!started && Date.now() >= startWaitDeadline) {
      const cur2 = await capturePane(cfg);
      const cur2Reply = extractLatestAssistantText(cur2);
      const fallback = extractDelta(baselineReply, cur2Reply);
      const [unique2, newEmitted2] = appendUnique(emitted, fallback);
      emitted = newEmitted2;
      if (unique2) {
        parts.push(unique2);
        debugLog(`non-stream fallback delta chars=${unique2.length}`);
      } else {
        debugLog("non-stream stop: start timeout");
      }
      break;
    }

    await sleep(cfg.pollIntervalSec * 1000);
  }

  return parts.join("").trim();
}

async function handleStreamingChat(
  cfg: Config,
  completionId: string,
  created: number,
  model: string,
  baseline: string,
  prompt: string,
  res: Response
): Promise<string> {
  const emittedParts: string[] = [];
  let baselineReply = extractLatestAssistantText(baseline);
  let prevReply = baselineReply;
  let emitted = "";
  let firstChunk = "";
  const startWaitDeadline = Date.now() + cfg.startTimeoutSec * 1000;

  while (Date.now() < startWaitDeadline) {
    const cur = await capturePane(cfg);
    const curReply = extractLatestAssistantText(cur);
    const delta = extractDelta(prevReply, curReply);
    prevReply = curReply;
    const [unique, newEmitted] = appendUnique(emitted, delta);
    emitted = newEmitted;

    if (unique.trim()) {
      if (isPromptEcho(unique, prompt)) {
        debugLog("stream skipping prompt echo chunk");
        continue;
      }
      firstChunk = unique;
      debugLog(`stream first chunk chars=${firstChunk.length}`);
      break;
    }
    await sleep(cfg.pollIntervalSec * 1000);
  }

  if (!firstChunk) {
    const cur2 = await capturePane(cfg);
    const cur2Reply = extractLatestAssistantText(cur2);
    const fallback = extractDelta(baselineReply, cur2Reply);
    const [unique2, newEmitted] = appendUnique(emitted, fallback);
    emitted = newEmitted;

    if (unique2 && !isPromptEcho(unique2, prompt)) {
      firstChunk = unique2;
      debugLog(`stream fallback first chunk chars=${firstChunk.length}`);
    } else {
      debugLog("stream start timeout: no response content detected");
      throw new Error("no response content from claude before start timeout");
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "close");
  res.flushHeaders();

  const write = (data: Buffer): boolean => {
    try {
      res.write(data);
      return true;
    } catch {
      return false;
    }
  };

  if (!write(sseEvent(createChatCompletionChunk({ id: completionId, created, model, role: "assistant" })))) {
    debugLog("stream aborted: client disconnected before first chunk");
    return emittedParts.join("").trim();
  }

  if (!write(sseEvent(createChatCompletionChunk({ id: completionId, created, model, content: firstChunk })))) {
    debugLog("stream aborted: client disconnected on first content");
    return emittedParts.join("").trim();
  }

  debugLog(`stream chunk sent: chars=${firstChunk.length}`);
  emittedParts.push(firstChunk);

  let started = true;
  const hardDeadline = Date.now() + cfg.hardTimeoutSec * 1000;
  let lastChange = Date.now();

  while (Date.now() < hardDeadline) {
    const cur = await capturePane(cfg);
    const curReply = extractLatestAssistantText(cur);
    const delta = extractDelta(prevReply, curReply);
    prevReply = curReply;
    const [unique, newEmitted] = appendUnique(emitted, delta);
    emitted = newEmitted;

    if (unique) {
      if (isPromptEcho(unique, prompt)) {
        debugLog("stream skipping prompt echo chunk");
        continue;
      }
      started = true;
      lastChange = Date.now();
      if (!write(sseEvent(createChatCompletionChunk({ id: completionId, created, model, content: unique })))) {
        debugLog("stream aborted: client disconnected mid-stream");
        return emittedParts.join("").trim();
      }
      debugLog(`stream chunk sent: chars=${unique.length}`);
      emittedParts.push(unique);
    } else if (started && Date.now() - lastChange >= cfg.idleTimeoutSec * 1000) {
      debugLog("stream stop: idle timeout");
      break;
    } else if (!started && Date.now() >= startWaitDeadline) {
      debugLog("stream stop: start timeout");
      break;
    }

    await sleep(cfg.pollIntervalSec * 1000);
  }

  write(sseEvent(createChatCompletionChunk({ id: completionId, created, model, finishReason: "stop" })));
  write(sseDone());
  res.end();
  debugLog("stream finished: sent stop + [DONE]");

  return emittedParts.join("").trim();
}

export const healthHandler: RequestHandler = (req, res) => {
  res.json({ ok: true });
};

export const modelsHandler: RequestHandler = (req, res) => {
  res.json(createModelListResponse());
};

export const chatCompletionsHandler: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as ChatCompletionRequest;
    const model = body.model ?? "claude-tmux";
    const stream = Boolean(body.stream ?? false);
    const messages = body.messages;

    debugLog(
      `chat request parsed: model=${model} stream=${stream} messages=${Array.isArray(messages) ? messages.length : "invalid"}`
    );

    if (!Array.isArray(messages)) {
      res.status(400).json({ error: "messages must be a list" });
      return;
    }

    const prompt = buildMessagesPrompt(messages, CFG.promptMode);
    if (!prompt) {
      res.status(400).json({ error: "empty prompt" });
      return;
    }
    debugLog(`built prompt chars=${prompt.length}`);

    const completionId = generateCompletionId();
    const created = Math.floor(Date.now() / 1000);

    const release = await tmuxLock.acquire();
    try {
      await ensureTmuxSession(CFG);
      const baseline = await capturePane(CFG);
      await sendPrompt(prompt, CFG);

      if (stream) {
        debugLog("handling stream response");
        await handleStreamingChat(CFG, completionId, created, model, baseline, prompt, res);
        return;
      }

      const text = await collectResponseText(CFG, baseline);
      debugLog(`non-stream response chars=${text.length}`);

      res.json(createChatCompletionResponse({ id: completionId, created, model, content: text }));
    } finally {
      release();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      res.status(504).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
};

export function requestLogger(cfg: Config): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.debug) {
      next();
      return;
    }
    const redactedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "authorization") {
        redactedHeaders[key] = "<redacted>";
      } else {
        redactedHeaders[key] = Array.isArray(value) ? value.join(", ") : (value ?? "");
      }
    }
    debugLog(`request ${req.method} ${req.url} headers=${JSON.stringify(redactedHeaders)}`);
    next();
  };
}
