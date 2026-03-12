export function sseEvent(payload: unknown): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, "utf-8");
}

export function sseDone(): Buffer {
  return Buffer.from("data: [DONE]\n\n", "utf-8");
}

export function createChatCompletionChunk(options: {
  id: string;
  created: number;
  model: string;
  role?: string;
  content?: string;
  finishReason?: string | null;
}): unknown {
  const delta: { role?: string; content?: string } = {};
  if (options.role) delta.role = options.role;
  if (options.content !== undefined) delta.content = options.content;

  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: options.finishReason ?? null,
      },
    ],
  };
}

export function createChatCompletionResponse(options: {
  id: string;
  created: number;
  model: string;
  content: string;
}): unknown {
  return {
    id: options.id,
    object: "chat.completion",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: options.content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function createModelListResponse(): unknown {
  return {
    object: "list",
    data: [
      {
        id: "claude-tmux",
        object: "model",
        created: 0,
        owned_by: "claude_tmux",
      },
    ],
  };
}
