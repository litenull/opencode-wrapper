import * as http from "http";
import * as crypto from "crypto";
import { URL } from "url";
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

function debugLog(message: string): void {
  if (!CFG.debug) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[debug ${ts}] ${message}`);
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    Connection: "close",
  });
  res.end(body);
}

function readJsonBody<T>(req: http.IncomingMessage, maxLog: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (CFG.debug) {
        let rawText = raw.toString("utf-8");
        if (rawText.length > maxLog) {
          rawText = rawText.slice(0, maxLog) + "...<truncated>";
        }
        debugLog(`request raw body: ${rawText}`);
      }
      try {
        resolve(JSON.parse(raw.toString("utf-8")));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function generateCompletionId(): string {
  return `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/health") {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (path === "/v1/models" || path === "/models") {
    jsonResponse(res, 200, createModelListResponse());
    return;
  }

  jsonResponse(res, 404, { error: "not found" });
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
  res: http.ServerResponse
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

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "close",
  });

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

export async function handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path !== "/v1/chat/completions" && path !== "/chat/completions") {
    jsonResponse(res, 404, { error: "not found" });
    return;
  }

  try {
    const body = await readJsonBody<ChatCompletionRequest>(req, CFG.debugLogBodyMax);
    const model = body.model ?? "claude-tmux";
    const stream = Boolean(body.stream ?? false);
    const messages = body.messages;

    debugLog(
      `chat request parsed: model=${model} stream=${stream} messages=${Array.isArray(messages) ? messages.length : "invalid"}`
    );

    if (!Array.isArray(messages)) {
      jsonResponse(res, 400, { error: "messages must be a list" });
      return;
    }

    const prompt = buildMessagesPrompt(messages, CFG.promptMode);
    if (!prompt) {
      jsonResponse(res, 400, { error: "empty prompt" });
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

      jsonResponse(res, 200, createChatCompletionResponse({ id: completionId, created, model, content: text }));
    } finally {
      release();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      jsonResponse(res, 504, { error: err.message });
    } else {
      jsonResponse(res, 500, { error: String(err) });
    }
  }
}

export function createHandler(cfg: Config): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const redactedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "authorization") {
        redactedHeaders[key] = "<redacted>";
      } else {
        redactedHeaders[key] = Array.isArray(value) ? value.join(", ") : (value ?? "");
      }
    }
    if (cfg.debug) {
      debugLog(`request ${req.method} ${req.url} headers=${JSON.stringify(redactedHeaders)}`);
    }

    if (req.method === "GET") {
      handleGet(req, res).catch((err) => {
        jsonResponse(res, 500, { error: String(err) });
      });
    } else if (req.method === "POST") {
      handlePost(req, res);
    } else {
      jsonResponse(res, 405, { error: "method not allowed" });
    }
  };
}
